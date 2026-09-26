import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import {
  detectSalesforceContextFromFilePath,
  motivationMessages,
  pickMotivationMessage,
} from './core/salesforceLogic';
import type { MotivationMessage, SalesforceContext } from './core/salesforceLogic';
import { SessionManager } from './core/sessionManager';
import { getDialogueTextForContext, pickDialogueMessage, type DialogueContext } from './dialogue';

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
let companionView: vscode.WebviewView | undefined;
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
let sessionMilestones = new Set<string>();
let deployStage: DeploymentStage = 'pre-deploy';
let activeDialogueKey: string | null = null;
let lastDialogueContext: DialogueContext | null = null;
let lastDialogueAt: number | null = null;
let currentDialogueText = '';
let deploymentErrorMessage: string | null = null;
let deploymentOutput: vscode.OutputChannel | undefined;
let companionMessage = 'Ready when you are!';
let companionMessageTimer: NodeJS.Timeout | undefined;
let lastDiagnosticSignature = '';

function getMascotStateForView(): string {
  if (getSalesforceSourceErrors().length > 0) return 'sad';
  if (currentSalesforceContext === 'deployment') return deploymentErrorMessage ? 'sad' : 'deployment';
  if (currentState === 'idle') return 'sleep';
  if (currentState === 'active') return getCompanionState() === 'focused' ? 'focused' : 'happy';
  return 'idle';
}

function updateCompanionView(): void {
  if (!companionView) return;
  void companionView.webview.postMessage({
    type: 'update',
    state: getMascotStateForView(),
    message: companionMessage,
    context: describeSalesforceContext(currentSalesforceContext),
    session: currentState,
    errorCount: getSalesforceSourceErrors().length,
  });
}

class MotivatorCompanionViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    companionView = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.getHtml(view.webview);
    view.onDidDispose(() => {
      if (companionView === view) companionView = undefined;
    });
    view.webview.onDidReceiveMessage((message: { command?: string }) => {
      if (message.command === 'start') void vscode.commands.executeCommand('salesforce-coding-motivator.start');
      if (message.command === 'stop') void vscode.commands.executeCommand('salesforce-coding-motivator.stop');
      if (message.command === 'errors') void showSalesforceErrorPicker();
    });
    updateCompanionView();
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = Date.now().toString(36);
    const assets = ['idle', 'focused', 'happy', 'success', 'deployment', 'sleep', 'sad'];
    const imageUris = Object.fromEntries(assets.map((state) => [
      state,
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'mascot', `${state}.png`)).toString(),
    ]));
    const csp = `default-src 'none'; img-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
  body { margin:0; padding:12px; color:var(--vscode-foreground); background:var(--vscode-sideBar-background); font-family:var(--vscode-font-family); }
  .stage { display:flex; align-items:flex-end; justify-content:center; gap:10px; min-height:180px; }
  .mascot { width:min(58%, 180px); max-height:190px; object-fit:contain; }
  .bubble { position:relative; align-self:center; max-width:65%; padding:11px 13px; border:1px solid var(--vscode-widget-border); border-radius:14px; background:var(--vscode-editorWidget-background); color:var(--vscode-editorWidget-foreground); box-shadow:0 3px 12px #0002; font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
  .bubble:after { content:''; position:absolute; left:-7px; bottom:22px; width:12px; height:12px; transform:rotate(45deg); background:var(--vscode-editorWidget-background); border-left:1px solid var(--vscode-widget-border); border-bottom:1px solid var(--vscode-widget-border); }
  .meta { display:flex; justify-content:center; gap:6px; flex-wrap:wrap; margin:8px 0 12px; font-size:11px; color:var(--vscode-descriptionForeground); }
  .pill { border:1px solid var(--vscode-widget-border); border-radius:20px; padding:4px 8px; }
  .actions { display:flex; justify-content:center; gap:8px; }
  button { border:1px solid var(--vscode-button-border, transparent); border-radius:4px; padding:6px 10px; color:var(--vscode-button-foreground); background:var(--vscode-button-background); cursor:pointer; }
  button.secondary { color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
  button:hover { background:var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <main>
    <div class="stage">
      <div id="bubble" class="bubble" role="status" aria-live="polite">Ready when you are!</div>
      <img id="mascot" class="mascot" src="${imageUris.idle}" alt="Salesforce coding mascot">
    </div>
    <div class="meta"><span id="context" class="pill">Context: General</span><span id="session" class="pill">Session: stopped</span><span id="errors" class="pill">Errors: 0</span></div>
    <div class="actions"><button id="toggle">Start session</button><button id="errorsButton" class="secondary">View errors</button></div>
  </main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const images = ${JSON.stringify(imageUris)};
  const mascot = document.getElementById('mascot');
  const bubble = document.getElementById('bubble');
  const toggle = document.getElementById('toggle');
  window.addEventListener('message', event => {
    const data = event.data;
    if (data.type !== 'update') return;
    mascot.src = images[data.state] || images.idle;
    bubble.textContent = data.message || 'Ready when you are!';
    document.getElementById('context').textContent = 'Context: ' + data.context;
    document.getElementById('session').textContent = 'Session: ' + data.session;
    document.getElementById('errors').textContent = 'Errors: ' + data.errorCount;
    toggle.textContent = data.session === 'active' || data.session === 'idle' ? 'Stop session' : 'Start session';
  });
  toggle.addEventListener('click', () => vscode.postMessage({ command: toggle.textContent.startsWith('Stop') ? 'stop' : 'start' }));
  document.getElementById('errorsButton').addEventListener('click', () => vscode.postMessage({ command: 'errors' }));
</script>
</body>
</html>`;
  }
}

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
  const companionProvider = new MotivatorCompanionViewProvider(context.extensionUri);
  const companionViewRegistration = vscode.window.registerWebviewViewProvider('salesforceCodingMotivator.companionView', companionProvider, { webviewOptions: { retainContextWhenHidden: true } });
  const openCompanionViewCommand = vscode.commands.registerCommand('salesforce-coding-motivator.openCompanionView', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.salesforceCodingMotivator');
  });
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
  storeHistory();
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

function getSalesforceSourceErrors(): SalesforceSourceError[] {
  const errors: SalesforceSourceError[] = [];

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    for (const diagnostic of diagnostics) {
      if (
        diagnostic.severity !== vscode.DiagnosticSeverity.Error ||
        !isSalesforceSourceDiagnostic(uri, diagnostic)
      ) {
        continue;
      }

      errors.push({
        uri: uri.toString(),
        fileName: path.basename(uri.fsPath),
        line: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character,
        message: diagnostic.message,
      });
    }
  }

  return errors;
}

async function openSalesforceSourceError(error: SalesforceSourceError): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(error.uri));
  const position = new vscode.Position(error.line - 1, error.character);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function showSalesforceErrorPicker(): Promise<void> {
  const errors = getSalesforceSourceErrors();
  if (!errors.length) {
    void vscode.window.showInformationMessage('No Salesforce source errors detected.');
    return;
  }
  const selected = await vscode.window.showQuickPick(errors.map((error) => ({
    label: `${error.fileName} • Line ${error.line}`,
    description: error.message,
    error,
  })), { placeHolder: 'Select a Salesforce source error to open it' });
  if (selected) await openSalesforceSourceError(selected.error);
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
  showCompanionMessage(candidate.text);
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
  showCompanionMessage(candidate.text);
}

function checkForMotivation(): void {
  if (!isRunning || !sessionStart || !lastActivityAt || currentState !== 'active') {
    return;
  }

  const activeMinutes = getActiveMinutes();
  triggerMotivation(activeMinutes);
}

function showCompanionMessage(message: string, durationMs = 8_000): void {
  companionMessage = message;
  if (companionMessageTimer) clearTimeout(companionMessageTimer);
  updateStatusBar(true);
  updateCompanionView();
  companionMessageTimer = setTimeout(() => {
    companionMessage = 'Ready when you are!';
    companionMessageTimer = undefined;
    updateStatusBar();
    updateCompanionView();
  }, durationMs);
}

function updateStatusBar(showMessage = false): void {
  if (!statusBarItem) {
    return;
  }

  const contextLabel = describeSalesforceContext(currentSalesforceContext);
  const companionState = getCompanionState();
  const deploymentSuffix = currentSalesforceContext === 'deployment' ? ` • ${describeDeploymentStage(deployStage)}` : '';
  const pet = '🐣';
  const baseLabel = currentState === 'stopped' ? 'Motivator' : currentState === 'idle' ? 'Motivator • idle' : `Motivator • ${contextLabel}${deploymentSuffix}`;
  statusBarItem.text = showMessage ? `${pet} ${companionMessage.slice(0, 42)}` : `${pet} ${baseLabel}`;
  statusBarItem.tooltip = `${companionMessage}\nClick to open companion actions.\nStatus: ${currentState}; mood: ${companionState}`;
  statusBarItem.command = 'salesforce-coding-motivator.openCompanionView';
  statusBarItem.show();
  updateCompanionView();
}

function handleContextChange(document: vscode.TextDocument | undefined): void {
  // Webview focus can leave VS Code with no active text editor. Keep the last
  // text-file context rather than incorrectly resetting the Salesforce context.
  if (!document) {
    return;
  }

  const nextContext = detectSalesforceContext(document);
  currentSalesforceContext = nextContext;
  updateDeploymentStageFromContext(currentSalesforceContext);
  recordFileActivity(document);
  updateStatusBar();

  // Refresh the companion status item for the most recently activated editor,
  // even when notifications are suppressed by their cooldown.

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
    showCompanionMessage('Let\'s code! I\'m here with you.');
  });

  const stopCommand = vscode.commands.registerCommand('salesforce-coding-motivator.stop', () => {
    isRunning = false;
    stopTracking();
    appendToHistory('Salesforce Coding Motivator stopped.');
    showCompanionMessage('Taking a break? I\'ll be here when you return.');
  });

  const companionMenuCommand = vscode.commands.registerCommand('salesforce-coding-motivator.openCompanionMenu', async () => {
    const action = await vscode.window.showQuickPick([
      { label: '$(comment-discussion) Show companion message', description: companionMessage, value: 'message' },
      { label: isRunning ? '$(debug-stop) Stop motivator session' : '$(play) Start motivator session', value: 'toggle' },
      { label: `$(bug) Show Salesforce source errors (${getSalesforceSourceErrors().length})`, value: 'errors' },
    ], { placeHolder: 'Salesforce Coding Motivator' });
    if (!action) return;
    if (action.value === 'toggle') {
      await vscode.commands.executeCommand(isRunning ? 'salesforce-coding-motivator.stop' : 'salesforce-coding-motivator.start');
    } else if (action.value === 'errors') {
      await showSalesforceErrorPicker();
    } else {
      void vscode.window.showInformationMessage(companionMessage);
    }
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
    await context.globalState.update(historyStorageKey, messageHistory);
    void vscode.window.showInformationMessage('🧹 Salesforce Coding Motivator history cleared.');
  });

  const diagnosticsListener = vscode.languages.onDidChangeDiagnostics(async () => {
    const errors = getSalesforceSourceErrors();
    const signature = errors.map((error) => `${error.uri}:${error.line}:${error.message}`).join('|');
    if (signature === lastDiagnosticSignature) return;
    const hadErrors = lastDiagnosticSignature.length > 0;
    lastDiagnosticSignature = signature;
    updateCompanionView();
    if (errors.length > 0) {
      const first = errors[0];
      showCompanionMessage(`Found ${errors.length} Salesforce source error${errors.length === 1 ? '' : 's'}. Click for details.`);
      const action = await vscode.window.showErrorMessage(`Salesforce issue: ${first.fileName}, line ${first.line}: ${first.message}`, 'Go to Error', 'View All Errors');
      if (action === 'Go to Error') await openSalesforceSourceError(first);
      else if (action === 'View All Errors') await showSalesforceErrorPicker();
    } else if (hadErrors) {
      showCompanionMessage('Source errors cleared. Nice work!');
      void vscode.window.showInformationMessage('Salesforce source errors cleared. Nice work!');
    }
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
      showCompanionMessage(`Deployment could not start: ${error.message}`, 15_000);
      void vscode.window.showErrorMessage(`Deployment could not start: ${error.message}`);
    });
    child.on('close', (code) => {
      if (code === 0) {
        deploymentErrorMessage = null;
        deploymentOutput?.appendLine('\nDeployment command completed successfully.');
        appendToHistory(`Deployment succeeded: ${sourceLabel}`);
        showCompanionMessage('Deployment succeeded! Nice work.');
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
        showCompanionMessage(`Deployment failed: ${deploymentErrorMessage}. Click for details.`, 15_000);
        void vscode.window.showErrorMessage(`Salesforce deployment failed: ${deploymentErrorMessage}`, 'Show Deployment Output').then((choice) => { if (choice) deploymentOutput?.show(true); });
      }
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

  });

  context.subscriptions.push(
    startCommand,
    companionViewRegistration,
    openCompanionViewCommand,
    stopCommand,
    companionMenuCommand,
    showHistoryCommand,
    showSessionSummaryCommand,
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
