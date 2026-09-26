import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  detectSalesforceContextFromFilePath,
  motivationMessages,
  pickMotivationMessage,
} from './core/salesforceLogic';
import type { MotivationMessage, SalesforceContext } from './core/salesforceLogic';
import { SessionManager } from './core/sessionManager';
import { buildMascotSvg } from './mascot';
import { buildSpeechBubbleHtml, getDialogueTextForContext, pickDialogueMessage, type DialogueContext } from './dialogue';

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
let activeDialogueKey: string | null = null;
let lastDialogueContext: DialogueContext | null = null;
let lastDialogueAt: number | null = null;
let currentDialogueText = '';
let deploymentErrorMessage: string | null = null;
let deploymentOutput: vscode.OutputChannel | undefined;

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

function resolveDialogueContext(): DialogueContext {
  switch (currentSalesforceContext) {
    case 'apex':
    case 'apex-test':
    case 'trigger':
    case 'soql':
      return 'apex';
    case 'lwc':
      return 'lwc';
    case 'deployment':
      return 'deployment';
    case 'metadata':
      return 'testing';
    default:
      return 'general';
  }
}

export function getCurrentDialogueText(): string {
  const now = Date.now();
  const dialogueContext = resolveDialogueContext();
  const contextChanged = lastDialogueContext !== dialogueContext;
  const cooldownElapsed = lastDialogueAt === null || (now - lastDialogueAt) >= 45_000;

  // Change the bubble immediately when the active Salesforce context changes.
  // Only avoid repeating the previous message when staying in the same context.
  if (!currentDialogueText || !activeDialogueKey || contextChanged || cooldownElapsed) {
    const previousKey = contextChanged ? undefined : activeDialogueKey ?? undefined;
    const nextMessage = pickDialogueMessage(dialogueContext, previousKey);
    activeDialogueKey = nextMessage.key;
    lastDialogueContext = dialogueContext;
    currentDialogueText = nextMessage.text;
    lastDialogueAt = now;
  }

  return currentDialogueText;
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

function isSalesforceSourceDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic): boolean {
  const segments = uri.fsPath.replace(/\\/g, '/').toLowerCase().split('/');
  const defaultIndex = segments.findIndex((segment, index) => segment === 'main' && segments[index + 1] === 'default');
  const isSalesforceSource = defaultIndex > 0 &&
    (segments[defaultIndex - 1] === 'force-app' || segments[defaultIndex - 2] === 'packages');

  if (!isSalesforceSource) {
    return false;
  }

  // Ignore Apex language-server startup/configuration problems. They describe the
  // local Java/runtime setup, not a defect in the Salesforce source code.
  const message = diagnostic.message.toLowerCase();
  const isLanguageServerSetupIssue =
    message.includes('unable to activate the apex language server') ||
    (message.includes('java runtime') && (message.includes('could not be located') || message.includes('not found'))) ||
    message.includes('set one using the salesforcedx-vscode-apex.java.home');

  return !isLanguageServerSetupIssue;
}

interface SalesforceSourceError {
  uri: string;
  fileName: string;
  line: number;
  character: number;
  message: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function getSalesforceSourceErrors(): SalesforceSourceError[] {
  const errors: SalesforceSourceError[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity !== vscode.DiagnosticSeverity.Error || !isSalesforceSourceDiagnostic(uri, diagnostic)) continue;
      errors.push({ uri: uri.toString(), fileName: vscode.workspace.asRelativePath(uri, false),
        line: diagnostic.range.start.line + 1, character: diagnostic.range.start.character, message: diagnostic.message });
    }
  }
  return errors.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.line - b.line);
}

function getDashboardHtml(): string {
  const statusLabel = currentState === 'active' ? 'Active' : currentState === 'idle' ? 'Idle' : 'Stopped';
  const contextLabel = describeSalesforceContext(currentSalesforceContext);
  const deployStageLabel = currentSalesforceContext === 'deployment' ? ` • ${describeDeploymentStage(deployStage)}` : '';
  const activeMinutes = getActiveMinutes();
  const companionState = getCompanionState();
  const sourceErrors = getSalesforceSourceErrors();
  const workspaceErrorCount = sourceErrors.length;
  const hasError = workspaceErrorCount > 0 || deploymentErrorMessage !== null;
  const mascotState = hasError ? 'sad' : companionState === 'focused' ? 'focused' : companionState === 'streak' ? 'success' : companionState === 'idle' ? 'idle' : 'happy';
  const recentMessages = [...messageHistory].slice(-6).reverse();

  const historyHtml = recentMessages.length > 0
    ? recentMessages.map((entry) => `<li><strong>[${entry.timestamp}]</strong> ${entry.text}</li>`).join('')
    : '<li>No recent messages yet.</li>';

  const deploymentChecklistHtml = currentSalesforceContext === 'deployment'
    ? `<div class="card"><h3>Deployment checklist</h3><ul>${getDeploymentChecklistHtml()}</ul></div>`
    : '<div class="card"><h3>Deployment checklist</h3><ul><li>Open a deployment or metadata file to activate deploy guidance.</li></ul></div>';

  const mascotAssetUri = dashboardPanel
    ? dashboardPanel.webview.asWebviewUri(vscode.Uri.joinPath(extensionContext!.extensionUri, 'media', 'mascot', `${mascotState}.png`)).toString()
    : `media/mascot/${mascotState}.png`;
  const mascotSvg = buildMascotSvg(mascotState, mascotAssetUri);
  const bubbleText = deploymentErrorMessage
    ? `Deployment failed: ${deploymentErrorMessage}`
    : workspaceErrorCount > 0
      ? `I spotted ${workspaceErrorCount} workspace error${workspaceErrorCount === 1 ? '' : 's'}. Take them one at a time—you’ve got this!`
      : getCurrentDialogueText();
  const speechBubbleMarkup = bubbleText ? buildSpeechBubbleHtml(bubbleText) : '';
  const nonce = randomBytes(16).toString('base64');
  const shownErrors = sourceErrors.slice(0, 8);
  const sourceErrorsHtml = shownErrors.map((error, index) =>
    '<div class="error-item"><div class="error-heading"><strong>' + escapeHtml(error.fileName) + '</strong><span>Line ' + error.line + '</span></div>' +
    '<p>' + escapeHtml(error.message) + '</p><button type="button" class="go-to-error" data-error-index="' + index + '">Go to Error</button></div>'
  ).join('');
  const sourceErrorData = JSON.stringify(shownErrors).replace(/</g, '\\u003c');

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${dashboardPanel?.webview.cspSource ?? ''} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
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
            gap: 0;
            padding: 12px 0 20px;
            flex-wrap: nowrap;
          }
          .mascot-wrap img {
            width: 180px;
            height: auto;
            max-height: 220px;
            object-fit: contain;
            display: block;
            flex: 0 0 auto;
            margin: 0;
            /* Compensate for transparent padding around the character in the PNG. */
            transform: translateX(-12px);
            filter: drop-shadow(0 10px 18px rgba(79, 124, 255, 0.18));
          }
          .speech-bubble {
            position: relative;
            display: inline-block;
            flex: 0 0 auto;
            width: min(150px, 28vw);
            max-width: 150px;
            background: #ffffff;
            color: #1f2937;
            border: 2px solid #334155;
            border-radius: 14px;
            padding: 7px 9px;
            font-size: 12px;
            line-height: 1.35;
            box-shadow: 0 8px 18px rgba(15, 23, 42, 0.12);
            margin: 0;
            word-break: break-word;
            overflow-wrap: anywhere;
            white-space: normal;
          }
          .speech-bubble__tail {
            position: absolute;
            right: -10px;
            top: 50%;
            width: 15px;
            height: 15px;
            background: #ffffff;
            border-right: 2px solid #334155;
            border-bottom: 2px solid #334155;
            transform: translateY(-50%) rotate(-45deg);
          }
          @media (max-width: 520px) {
            .mascot-wrap {
              flex-direction: column;
              gap: 8px;
            }
            .mascot-wrap img {
              transform: none;
            }
            .speech-bubble {
              width: min(170px, 72vw);
              max-width: 170px;
              margin: 0 0 8px;
            }
            .speech-bubble__tail {
              left: 50%;
              right: auto;
              top: auto;
              bottom: -11px;
              transform: translateX(-50%) rotate(45deg);
            }
          }
          ul { margin: 8px 0 0 16px; padding: 0; }
          li { margin-bottom: 6px; }
          .error-item { border-top: 1px solid var(--vscode-panel-border); padding: 12px 0; }
          .error-heading { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
          .error-item p { margin: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
          .go-to-error { padding: 6px 10px; border: 0; border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
          .go-to-error:hover { background: var(--vscode-button-hoverBackground); }
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
          ${speechBubbleMarkup}
          ${mascotSvg}
        </div>

        <div class="card">
          <h3>Session</h3>
          <div class="row">
            <span class="pill">Active minutes: ${activeMinutes}</span>
            <span class="pill">Files touched: ${touchedFiles.size}</span>
          </div>
        </div>

        ${workspaceErrorCount > 0 ? `<div class="card"><h3>Salesforce source errors (${workspaceErrorCount})</h3>${sourceErrorsHtml}${workspaceErrorCount > 8 ? `<p>Showing first 8 of ${workspaceErrorCount} errors.</p>` : ''}</div>` : ''}

        ${deploymentChecklistHtml}

        <div class="card">
          <h3>Recent messages</h3>
          <ul>${historyHtml}</ul>
        </div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const sourceErrors = ${sourceErrorData};
          document.querySelectorAll('[data-error-index]').forEach((button) => {
            button.addEventListener('click', () => {
              const error = sourceErrors[Number(button.dataset.errorIndex)];
              if (error) vscode.postMessage({ type: 'openError', uri: error.uri, line: error.line, character: error.character });
            });
          });
        </script>
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
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument) {
    currentSalesforceContext = detectSalesforceContext(activeDocument);
    updateDeploymentStageFromContext(currentSalesforceContext);
  }
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
  // Webview focus can leave VS Code with no active text editor. Keep the last
  // text-file context rather than incorrectly resetting the dashboard to General.
  if (!document) {
    return;
  }

  const nextContext = detectSalesforceContext(document);
  currentSalesforceContext = nextContext;
  updateDeploymentStageFromContext(currentSalesforceContext);
  recordFileActivity(document);
  updateStatusBar();

  // Always refresh the dashboard for the most recently activated editor,
  // even when notifications are suppressed by their cooldown.
  updateDashboard();

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
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (activeDocument) {
      currentSalesforceContext = detectSalesforceContext(activeDocument);
      updateDeploymentStageFromContext(currentSalesforceContext);
    }
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
        { enableScripts: true }
      );

      dashboardPanel.webview.onDidReceiveMessage(async (message: { type?: string; uri?: string; line?: number; character?: number }) => {
        if (message.type !== 'openError' || !message.uri) return;
        try {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(message.uri));
          const line = Math.max(0, Math.min((message.line ?? 1) - 1, document.lineCount - 1));
          const character = Math.min(Math.max(0, message.character ?? 0), document.lineAt(line).text.length);
          const position = new vscode.Position(line, character);
          const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        } catch (error) {
          void vscode.window.showErrorMessage(`Unable to open source error: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      dashboardPanel.onDidDispose(() => {
        dashboardPanel = undefined;
      });
    }

    dashboardPanel.webview.html = getDashboardHtml();
    dashboardPanel.reveal(vscode.ViewColumn.Two, true);
  });

  const diagnosticsListener = vscode.languages.onDidChangeDiagnostics(() => {
    // React to editor diagnostics only; terminal output and deployment logs are not diagnostics.
    updateDashboard();
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
    if (vscode.window.activeTextEditor?.document === event.document) {
      handleContextChange(event.document);
    }
  });

  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    if (vscode.window.activeTextEditor?.document === document) {
      handleContextChange(document);
    }
  });

  const focusListener = vscode.window.onDidChangeWindowState(() => {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor?.document) {
      currentSalesforceContext = detectSalesforceContext(activeEditor.document);
      updateDeploymentStageFromContext(currentSalesforceContext);
    }
    updateStatusBar();
    updateDashboard();

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

  const deployAndMonitorCommand = vscode.commands.registerCommand('salesforce-coding-motivator.deployAndMonitor', async () => {
    const editor = vscode.window.activeTextEditor;
    const workspaceFolder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!editor || !workspaceFolder || editor.document.isUntitled) {
      void vscode.window.showWarningMessage('Open a saved Salesforce source file inside your project before deploying.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const parent = path.dirname(filePath);
    const sourcePath = path.basename(path.dirname(parent)) === 'lwc' ? parent : filePath;
    const sourceLabel = path.relative(workspaceFolder.uri.fsPath, sourcePath);
    const confirmation = await vscode.window.showWarningMessage(
      `Deploy ${sourceLabel} to the org currently selected in Salesforce CLI?`,
      { modal: true, detail: 'This runs an actual Salesforce deployment using the authenticated org configured in your Salesforce CLI.' },
      'Deploy'
    );
    if (confirmation !== 'Deploy') return;

    if (!deploymentOutput) deploymentOutput = vscode.window.createOutputChannel('Salesforce Deployment Monitor');
    deploymentOutput.clear();
    deploymentOutput.show(true);
    deploymentOutput.appendLine(`Running: sf project deploy start --source-dir "${sourcePath}" --json`);
    deploymentErrorMessage = null;
    currentSalesforceContext = 'deployment';
    updateDashboard();

    const args = ['project', 'deploy', 'start', '--source-dir', sourcePath, '--json'];
    const commandLine = process.platform === 'win32'
      ? `sf ${args.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(' ')}`
      : 'sf';
    const child = spawn(commandLine, process.platform === 'win32' ? [] : args, {
      cwd: workspaceFolder.uri.fsPath,
      shell: process.platform === 'win32',
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const value = chunk.toString();
      stdout += value;
      deploymentOutput?.append(value);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const value = chunk.toString();
      stderr += value;
      deploymentOutput?.append(value);
    });
    child.on('error', (error) => {
      deploymentErrorMessage = error.message;
      deploymentOutput?.appendLine(`\nCould not start Salesforce CLI: ${error.message}`);
      updateDashboard();
      void vscode.window.showErrorMessage(`Deployment could not start: ${error.message}`);
    });
    child.on('close', (code) => {
      if (code === 0) {
        deploymentErrorMessage = null;
        deploymentOutput?.appendLine('\nDeployment command completed successfully.');
        appendToHistory(`Deployment succeeded: ${sourceLabel}`);
        void vscode.window.showInformationMessage('Salesforce deployment succeeded.');
      } else {
        const combined = `${stdout}\n${stderr}`.trim();
        let summary = `Salesforce CLI exited with code ${code ?? 'unknown'}.`;
        try {
          const parsed = JSON.parse(stdout);
          summary = parsed?.message || parsed?.result?.details?.componentFailures?.[0]?.problem || summary;
        } catch { /* CLI output may include non-JSON text. */ }
        deploymentErrorMessage = summary.slice(0, 180);
        deploymentOutput?.appendLine(`\nDeployment failed: ${summary}`);
        appendToHistory(`Deployment failed: ${summary}`);
        void vscode.window.showErrorMessage('Salesforce deployment failed. See Salesforce Deployment Monitor output for details.');
      }
      updateDashboard();
    });
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
    diagnosticsListener,
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
