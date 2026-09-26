import * as vscode from 'vscode';

import {
  detectSalesforceContextFromFilePath,
  motivationMessages,
  pickMotivationMessage,
} from './core/salesforceLogic';
import type { MotivationMessage, SalesforceContext } from './core/salesforceLogic';
import { SessionManager } from './core/sessionManager';
import { buildMascotSvg } from './mascot';

type SessionState = 'stopped' | 'active' | 'idle';
type CompanionState = 'ready' | 'focused' | 'streak' | 'idle' | 'break';
type DeploymentStage = 'pre-deploy' | 'validate' | 'post-deploy';

type HistoryEntry = {
  text: string;
  timestamp: string;
  context: SalesforceContext;
};

const defaultIdleThresholdMs = 60_000;
const maxHistoryEntries = 100;
const historyStorageKey = 'salesforceCodingMotivator.chatHistory';

const deploymentChecklistByStage: Record<DeploymentStage, string[]> = {
  'pre-deploy': [
    'Confirm the target org and metadata package.',
    'Review destructive changes before scheduling the deploy.',
    'Run the relevant validation or test suite.',
    'Check for deployment blockers in manifest or package files.'
  ],
  validate: [
    'Validate the metadata in the target sandbox or org.',
    'Review all test failures and fix them before continuing.',
    'Double-check Apex limits, dependencies, and access rules.',
    'Confirm the deployment set is intentional and minimal.'
  ],
  'post-deploy': [
    'Verify the deployed metadata is alive in the target org.',
    'Run the highest-value smoke tests or manual checks.',
    'Capture any post-deploy issues and note follow-up work.',
    'Celebrate the win and document what changed.'
  ]
};

let isRunning = false;
let currentState: SessionState = 'stopped';
let statusBarItem: vscode.StatusBarItem | undefined;
let sessionStart: Date | null = null;
let lastActivityAt: Date | null = null;
let idleTimer: NodeJS.Timeout | undefined;
let sessionManager: SessionManager | undefined;
let lastMotivationAt: Date | null = null;
let lastMotivationContext: SalesforceContext | null = null;
let currentSalesforceContext: SalesforceContext = 'unknown';
let historyChannel: vscode.OutputChannel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let messageHistory: HistoryEntry[] = [];
let touchedFiles = new Set<string>();
let lastBreakReminderAt: Date | null = null;
let dashboardPanel: vscode.WebviewPanel | undefined;
let sessionMilestones = new Set<string>();
let deployStage: DeploymentStage = 'pre-deploy';

function getIdleThresholdMs(): number {
  const config = vscode.workspace.getConfiguration('salesforceCodingMotivator');
  const idleMinutes = config.get<number>('idleThresholdMinutes', 1);
  return Math.max(30_000, idleMinutes * 60_000);
}

function getCurrentSessionSummary(): string {
  const activeMinutes = getActiveMinutes();
  const contextLabel = describeSalesforceContext(currentSalesforceContext);
  const stageLabel = currentSalesforceContext === 'deployment' ? `; Deploy stage: ${describeDeploymentStage(deployStage)}` : '';
  const statusLabel = currentState === 'active' ? 'active' : currentState === 'idle' ? 'idle' : 'stopped';

  return `Status: ${statusLabel}; Context: ${contextLabel}${stageLabel}; Active minutes: ${activeMinutes}; Files touched: ${touchedFiles.size};`;
}

function getCompanionState(): CompanionState {
  if (!isRunning) {
    return 'ready';
  }

  if (currentState === 'idle') {
    return 'idle';
  }

  if (getActiveMinutes() >= 15 || touchedFiles.size >= 5) {
    return 'streak';
  }

  if (currentSalesforceContext === 'apex-test' || currentSalesforceContext === 'trigger' || currentSalesforceContext === 'soql') {
    return 'focused';
  }

  return 'ready';
}

function storeHistory(): void {
  if (!extensionContext) {
    return;
  }

  void extensionContext.globalState.update(historyStorageKey, messageHistory.slice(-maxHistoryEntries));
}

function renderHistory(): void {
  if (!historyChannel) {
    historyChannel = vscode.window.createOutputChannel('Salesforce Coding Motivator');
  }

  historyChannel.clear();
  for (const entry of messageHistory) {
    historyChannel.appendLine(`[${entry.timestamp}] ${describeSalesforceContext(entry.context)} • ${entry.text}`);
  }
}

function appendToHistory(message: string): void {
  if (!historyChannel) {
    historyChannel = vscode.window.createOutputChannel('Salesforce Coding Motivator');
  }

  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  messageHistory.push({
    text: message,
    timestamp,
    context: currentSalesforceContext,
  });

  messageHistory = messageHistory.slice(-maxHistoryEntries);
  renderHistory();
  updateDashboard();
  storeHistory();
}

function getDeploymentChecklistHtml(): string {
  const activeStage = currentSalesforceContext === 'deployment' ? deployStage : 'pre-deploy';
  const checklist = deploymentChecklistByStage[activeStage] ?? deploymentChecklistByStage['pre-deploy'];

  return checklist
    .map((item, index) => `<li>${index + 1}. ${item}</li>`)
    .join('');
}

function getDashboardHtml(): string {
  const statusLabel = currentState === 'active' ? 'Active' : currentState === 'idle' ? 'Idle' : 'Stopped';
  const contextLabel = describeSalesforceContext(currentSalesforceContext);
  const deployStageLabel = currentSalesforceContext === 'deployment' ? ` • ${describeDeploymentStage(deployStage)}` : '';
  const activeMinutes = getActiveMinutes();
  const companionState = getCompanionState();
  const mascotState = companionState === 'focused' ? 'focused' : companionState === 'streak' ? 'success' : companionState === 'idle' ? 'idle' : 'happy';
  const recentMessages = [...messageHistory].slice(-6).reverse();

  const historyHtml = recentMessages.length > 0
    ? recentMessages.map((entry) => `<li><strong>[${entry.timestamp}]</strong> ${entry.text}</li>`).join('')
    : '<li>No recent messages yet.</li>';

  const deploymentChecklistHtml = currentSalesforceContext === 'deployment'
    ? `<div class="card"><h3>Deployment checklist</h3><ul>${getDeploymentChecklistHtml()}</ul></div>`
    : '<div class="card"><h3>Deployment checklist</h3><ul><li>Open a deployment or metadata file to activate deploy guidance.</li></ul></div>';

  const mascotSvg = buildMascotSvg(mascotState);

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 16px;
            margin: 0;
          }
          .card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 12px 14px;
            margin-bottom: 12px;
            background: var(--vscode-sideBar-background);
          }
          h2 { margin: 0 0 10px; }
          .row { display: flex; gap: 8px; flex-wrap: wrap; }
          .pill {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 999px;
            padding: 4px 10px;
            font-size: 12px;
          }
          .mascot-wrap {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 12px 0 20px;
          }
          .mascot-wrap svg {
            width: 180px;
            height: 200px;
            filter: drop-shadow(0 10px 18px rgba(79, 124, 255, 0.2));
          }
          ul { margin: 8px 0 0 16px; padding: 0; }
          li { margin-bottom: 6px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Salesforce Coding Motivator</h2>
          <div class="row">
            <span class="pill">Status: ${statusLabel}</span>
            <span class="pill">Mood: ${companionState}</span>
            <span class="pill">Context: ${contextLabel}${deployStageLabel}</span>
          </div>
        </div>

        <div class="card mascot-wrap">
          ${mascotSvg}
        </div>

        <div class="card">
          <h3>Session</h3>
          <div class="row">
            <span class="pill">Active minutes: ${activeMinutes}</span>
            <span class="pill">Files touched: ${touchedFiles.size}</span>
          </div>
        </div>

        ${deploymentChecklistHtml}

        <div class="card">
          <h3>Recent messages</h3>
          <ul>${historyHtml}</ul>
        </div>
      </body>
    </html>
  `;
}

function updateDashboard(): void {
  if (!dashboardPanel) {
    return;
  }

  dashboardPanel.webview.html = getDashboardHtml();
}

function describeDeploymentStage(stage: DeploymentStage): string {
  switch (stage) {
    case 'pre-deploy':
      return 'Pre-deploy';
    case 'validate':
      return 'Validate';
    case 'post-deploy':
      return 'Post-deploy';
    default:
      return 'Pre-deploy';
  }
}

export function detectSalesforceContext(document: vscode.TextDocument | undefined): SalesforceContext {
  return detectSalesforceContextFromFilePath(document?.fileName);
}

function describeSalesforceContext(context: SalesforceContext): string {
  switch (context) {
    case 'apex':
      return 'Apex';
    case 'apex-test':
      return 'Apex Test';
    case 'trigger':
      return 'Trigger';
    case 'soql':
      return 'SOQL';
    case 'lwc':
      return 'LWC';
    case 'metadata':
      return 'Metadata';
    case 'deployment':
      return 'Deployment';
    default:
      return 'General';
  }
}

function updateDeploymentStageFromContext(context: SalesforceContext): void {
  if (context !== 'deployment') {
    return;
  }

  const fileName = vscode.window.activeTextEditor?.document?.fileName.toLowerCase() ?? '';
  if (fileName.endsWith('destructivechanges.xml')) {
    deployStage = 'validate';
    return;
  }

  if (fileName.includes('package.xml') || fileName.includes('manifest')) {
    deployStage = 'pre-deploy';
    return;
  }

  deployStage = 'post-deploy';
}

function setState(nextState: SessionState): void {
  currentState = nextState;
  updateStatusBar();
  updateDashboard();
}

function refreshCurrentContext(): void {
  currentSalesforceContext = detectSalesforceContext(vscode.window.activeTextEditor?.document);
  updateStatusBar();
}

function recordFileActivity(document: vscode.TextDocument | undefined): void {
  if (!document || !document.fileName) {
    return;
  }

  touchedFiles.add(document.fileName);
}

function markActivity(): void {
  if (!isRunning) {
    return;
  }

  const now = new Date();
  sessionStart ??= now;
  lastActivityAt = now;
  sessionManager?.markActivity(now.getTime());
  recordFileActivity(vscode.window.activeTextEditor?.document);
  maybePublishMilestone();

  if (currentState === 'idle') {
    setState('active');
  }
}

function triggerBreakReminder(): void {
  const config = vscode.workspace.getConfiguration('salesforceCodingMotivator');
  const breakReminderMinutes = config.get<number>('breakReminderMinutes', 20);

  if (!isRunning || !sessionStart || !lastActivityAt || currentState !== 'idle') {
    return;
  }

  const now = new Date();
  const idleMinutes = (now.getTime() - lastActivityAt.getTime()) / 60_000;

  if (idleMinutes < breakReminderMinutes) {
    return;
  }

  if (lastBreakReminderAt && (now.getTime() - lastBreakReminderAt.getTime()) < breakReminderMinutes * 60_000) {
    return;
  }

  lastBreakReminderAt = now;
  appendToHistory('⏸️ You have been idle for a while. Consider a short break.');
  void vscode.window.showInformationMessage('⏸️ You have been idle for a while. Consider a short break.');
}

function startTracking(): void {
  if (idleTimer) {
    return;
  }

  const now = new Date();
  sessionStart = now;
  lastActivityAt = now;
  sessionManager = new SessionManager(getIdleThresholdMs());
  sessionManager.start();
  lastBreakReminderAt = null;

  idleTimer = setInterval(() => {
    if (!isRunning || !lastActivityAt || !sessionManager) {
      return;
    }

    const nowMs = Date.now();
    const nextState: SessionState = sessionManager.tick(nowMs);

    if (currentState !== nextState) {
      setState(nextState);
    }

    if (nextState === 'idle') {
      triggerBreakReminder();
    }

    checkForMotivation();
  }, 15_000);
}

function maybePublishMilestone(): void {
  if (!sessionStart || !isRunning) {
    return;
  }

  const activeMinutes = getActiveMinutes();

  if (activeMinutes >= 5 && !sessionMilestones.has('five-min')) {
    sessionMilestones.add('five-min');
    appendToHistory('🏆 Five-minute Salesforce focus streak reached.');
    void vscode.window.showInformationMessage('🏆 Five-minute Salesforce focus streak reached.');
  }

  if (touchedFiles.size >= 5 && !sessionMilestones.has('five-files')) {
    sessionMilestones.add('five-files');
    appendToHistory('📁 Five files touched in this session. Strong momentum.');
    void vscode.window.showInformationMessage('📁 Five files touched in this session. Strong momentum.');
  }
}

function stopTracking(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = undefined;
  }

  sessionManager?.stop();
  sessionManager = undefined;
  sessionStart = null;
  lastActivityAt = null;
  lastMotivationAt = null;
  lastMotivationContext = null;
  lastBreakReminderAt = null;
  touchedFiles.clear();
  sessionMilestones.clear();
  setState('stopped');
}

function getActiveMinutes(): number {
  if (!sessionStart || !sessionManager) {
    return 0;
  }

  return sessionManager.getActiveMinutes();
}

function getContextualMessage(activeMinutes: number): MotivationMessage | undefined {
  const config = vscode.workspace.getConfiguration('salesforceCodingMotivator');
  const debugMode = config.get<boolean>('debugTestMode', false);

  return pickMotivationMessage(currentSalesforceContext, activeMinutes, debugMode);
}

function triggerMotivation(activeMinutes: number): void {
  const config = vscode.workspace.getConfiguration('salesforceCodingMotivator');
  const isEnabled = config.get<boolean>('enabled', true);
  const cooldownMinutes = config.get<number>('messageCooldownMinutes', 1);

  if (!isEnabled || !isRunning || !sessionStart || !lastActivityAt || currentState !== 'active') {
    return;
  }

  const now = new Date();
  const candidate = getContextualMessage(activeMinutes);

  if (!candidate || currentSalesforceContext === 'unknown') {
    return;
  }

  const isDeploymentContext = currentSalesforceContext === 'deployment';

  if (lastMotivationAt && lastMotivationContext === currentSalesforceContext) {
    const elapsedMinutes = (now.getTime() - lastMotivationAt.getTime()) / 60_000;
    if (elapsedMinutes < Math.max(candidate.minCooldownMinutes, cooldownMinutes)) {
      return;
    }
  }

  lastMotivationAt = now;
  lastMotivationContext = currentSalesforceContext;
  appendToHistory(`${candidate.text} (${describeSalesforceContext(currentSalesforceContext)})`);
  void vscode.window.showInformationMessage(candidate.text);
}

function triggerDeploymentMotivation(): void {
  const config = vscode.workspace.getConfiguration('salesforceCodingMotivator');
  const isEnabled = config.get<boolean>('enabled', true);

  if (!isEnabled) {
    return;
  }

  const deploymentMessages = motivationMessages.filter((message) => message.contexts?.includes('deployment'));
  const candidate = deploymentMessages[Math.floor(Math.random() * deploymentMessages.length)] ?? {
    text: '🚀 Deployment is part of the journey. Validate the result and keep learning.',
    minActiveMinutes: 0,
    minCooldownMinutes: 5,
  };

  currentSalesforceContext = 'deployment';
  const now = new Date();
  const previousMessageRecent = lastMotivationAt && ((now.getTime() - lastMotivationAt.getTime()) / 60_000) < 5;
  if (previousMessageRecent) {
    return;
  }

  lastMotivationAt = now;
  lastMotivationContext = 'deployment';
  appendToHistory(`${candidate.text} (${describeSalesforceContext('deployment')})`);
  void vscode.window.showInformationMessage(candidate.text);
}

function checkForMotivation(): void {
  if (!isRunning || !sessionStart || !lastActivityAt || currentState !== 'active') {
    return;
  }

  const activeMinutes = getActiveMinutes();
  triggerMotivation(activeMinutes);
}

function updateStatusBar(): void {
  if (!statusBarItem) {
    return;
  }

  const contextLabel = describeSalesforceContext(currentSalesforceContext);
  const companionState = getCompanionState();
  const moodIcon = companionState === 'streak' ? '$(flame)' : companionState === 'focused' ? '$(zap)' : companionState === 'idle' ? '$(watch)' : '$(rocket)';
  const deploymentSuffix = currentSalesforceContext === 'deployment' ? ` • ${describeDeploymentStage(deployStage)}` : '';

  switch (currentState) {
    case 'active':
      statusBarItem.text = `${moodIcon} Salesforce Motivator • ${contextLabel}${deploymentSuffix}`;
      statusBarItem.tooltip = `Salesforce Coding Motivator is active: ${contextLabel}${deploymentSuffix} (${companionState})`;
      statusBarItem.command = 'salesforce-coding-motivator.stop';
      break;
    case 'idle':
      statusBarItem.text = `$(watch) Salesforce Motivator • ${contextLabel}${deploymentSuffix}`;
      statusBarItem.tooltip = `Salesforce Coding Motivator is idle: ${contextLabel}${deploymentSuffix} (${companionState})`;
      statusBarItem.command = 'salesforce-coding-motivator.start';
      break;
    default:
      statusBarItem.text = '$(debug-pause) Salesforce Motivator';
      statusBarItem.tooltip = 'Salesforce Coding Motivator is stopped';
      statusBarItem.command = 'salesforce-coding-motivator.start';
      break;
  }

  statusBarItem.show();
}

function handleContextChange(document: vscode.TextDocument | undefined): void {
  const nextContext = detectSalesforceContext(document);
  currentSalesforceContext = nextContext;
  updateDeploymentStageFromContext(currentSalesforceContext);
  recordFileActivity(document);
  updateStatusBar();

  if (!isRunning) {
    return;
  }

  markActivity();

  if (currentSalesforceContext === 'unknown') {
    return;
  }

  if (currentSalesforceContext === 'deployment') {
    triggerDeploymentMotivation();
  } else {
    triggerMotivation(0);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  historyChannel = vscode.window.createOutputChannel('Salesforce Coding Motivator');
  messageHistory = context.globalState.get<HistoryEntry[]>(historyStorageKey, []);
  renderHistory();
  refreshCurrentContext();
  updateStatusBar();

  const startCommand = vscode.commands.registerCommand('salesforce-coding-motivator.start', () => {
    isRunning = true;
    currentSalesforceContext = detectSalesforceContext(vscode.window.activeTextEditor?.document);
    setState('active');
    startTracking();
    markActivity();
    appendToHistory('Salesforce Coding Motivator started.');
    void vscode.window.showInformationMessage('⚡ Salesforce Coding Motivator is ready. Let\'s code!');
  });

  const stopCommand = vscode.commands.registerCommand('salesforce-coding-motivator.stop', () => {
    isRunning = false;
    stopTracking();
    appendToHistory('Salesforce Coding Motivator stopped.');
    void vscode.window.showInformationMessage('🛑 Salesforce Coding Motivator stopped.');
  });

  const showHistoryCommand = vscode.commands.registerCommand('salesforce-coding-motivator.showHistory', () => {
    if (!historyChannel) {
      historyChannel = vscode.window.createOutputChannel('Salesforce Coding Motivator');
    }
    renderHistory();
    historyChannel.show(true);
  });

  const showSessionSummaryCommand = vscode.commands.registerCommand('salesforce-coding-motivator.showSessionSummary', () => {
    if (!historyChannel) {
      historyChannel = vscode.window.createOutputChannel('Salesforce Coding Motivator');
    }

    const summary = getCurrentSessionSummary();
    historyChannel.appendLine(`Session summary: ${summary}`);
    historyChannel.show(true);
    void vscode.window.showInformationMessage(summary);
  });

  const clearHistoryCommand = vscode.commands.registerCommand('salesforce-coding-motivator.clearHistory', async () => {
    messageHistory = [];
    renderHistory();
    updateDashboard();
    await context.globalState.update(historyStorageKey, messageHistory);
    void vscode.window.showInformationMessage('🧹 Salesforce Coding Motivator history cleared.');
  });

  const showDashboardCommand = vscode.commands.registerCommand('salesforce-coding-motivator.openDashboard', () => {
    if (!dashboardPanel) {
      dashboardPanel = vscode.window.createWebviewPanel(
        'salesforceCodingMotivatorDashboard',
        'Salesforce Coding Motivator',
        vscode.ViewColumn.Two,
        { enableScripts: false }
      );

      dashboardPanel.onDidDispose(() => {
        dashboardPanel = undefined;
      });
    }

    dashboardPanel.webview.html = getDashboardHtml();
    dashboardPanel.reveal(vscode.ViewColumn.Two, true);
  });

  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    handleContextChange(editor?.document);
  });

  const openDocumentListener = vscode.workspace.onDidOpenTextDocument((document) => {
    if (vscode.window.activeTextEditor?.document === document) {
      handleContextChange(document);
    }
  });

  const textChangeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    handleContextChange(event.document);
  });

  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    handleContextChange(document);
  });

  const focusListener = vscode.window.onDidChangeWindowState(() => {
    const activeEditor = vscode.window.activeTextEditor;
    currentSalesforceContext = detectSalesforceContext(activeEditor?.document);
    updateDeploymentStageFromContext(currentSalesforceContext);
    updateStatusBar();

    if (isRunning && currentSalesforceContext !== 'unknown') {
      if (currentSalesforceContext === 'deployment') {
        triggerDeploymentMotivation();
      } else {
        triggerMotivation(0);
      }
    }

    if (vscode.window.state.focused) {
      markActivity();
    }
  });

  const deploymentListener = vscode.commands.registerCommand('salesforce-coding-motivator.triggerDeploymentMessage', () => {
    triggerDeploymentMotivation();
  });

  const deploymentChecklistCommand = vscode.commands.registerCommand('salesforce-coding-motivator.showDeploymentChecklist', () => {
    const activeStage = currentSalesforceContext === 'deployment' ? deployStage : 'pre-deploy';
    const checklist = deploymentChecklistByStage[activeStage] ?? deploymentChecklistByStage['pre-deploy'];
    const message = checklist.map((item, index) => `${index + 1}. ${item}`).join('\n');

    appendToHistory(`Deployment checklist for ${describeDeploymentStage(activeStage)}: ${checklist[0]}`);
    void vscode.window.showInformationMessage(message);

    if (dashboardPanel) {
      dashboardPanel.webview.html = getDashboardHtml();
      dashboardPanel.reveal(vscode.ViewColumn.Two, true);
    }
  });

  context.subscriptions.push(
    startCommand,
    stopCommand,
    showHistoryCommand,
    showSessionSummaryCommand,
    showDashboardCommand,
    clearHistoryCommand,
    activeEditorListener,
    openDocumentListener,
    textChangeListener,
    saveListener,
    focusListener,
    deploymentListener,
    deploymentChecklistCommand,
    statusBarItem,
    historyChannel,
  );
}

export function deactivate(): void {
  isRunning = false;
  stopTracking();
}
