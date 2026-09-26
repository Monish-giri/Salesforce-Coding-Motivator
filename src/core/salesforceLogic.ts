export type SalesforceContext = 'apex' | 'apex-test' | 'trigger' | 'soql' | 'lwc' | 'metadata' | 'deployment' | 'unknown';

export type MotivationMessage = {
  text: string;
  minActiveMinutes: number;
  minCooldownMinutes: number;
  contexts?: SalesforceContext[];
};

export const motivationMessages: MotivationMessage[] = [
  { text: '⚡ Apex time. Keep those governor limits in mind.', minActiveMinutes: 0, minCooldownMinutes: 1, contexts: ['apex'] },
  { text: '🧪 Apex tests in motion. One assertion at a time.', minActiveMinutes: 0, minCooldownMinutes: 2, contexts: ['apex-test'] },
  { text: '🔥 Trigger detected. Think bulkification.', minActiveMinutes: 0, minCooldownMinutes: 1, contexts: ['trigger'] },
  { text: '🔎 SOQL focus: keep queries efficient and intentional.', minActiveMinutes: 0, minCooldownMinutes: 1, contexts: ['soql'] },
  { text: '💡 LWC focus: keep it clean, reusable, and easy to reason about.', minActiveMinutes: 0, minCooldownMinutes: 1, contexts: ['lwc'] },
  { text: '🧩 Metadata work is moving the project forward.', minActiveMinutes: 0, minCooldownMinutes: 1, contexts: ['metadata'] },
  { text: '🚀 Deployment is part of the journey. Validate the result and keep learning.', minActiveMinutes: 0, minCooldownMinutes: 5, contexts: ['deployment'] },
  { text: '✅ Before deploy, verify the metadata and test coverage are in a good state.', minActiveMinutes: 0, minCooldownMinutes: 6, contexts: ['deployment'] },
  { text: '🛠️ Deploy calm, verify fast, and fix one issue at a time.', minActiveMinutes: 0, minCooldownMinutes: 7, contexts: ['deployment'] },
  { text: '⚡ Nice work. Keep the momentum going.', minActiveMinutes: 0, minCooldownMinutes: 1 },
  { text: '💪 You are in the flow. Stay with it.', minActiveMinutes: 0, minCooldownMinutes: 2 },
  { text: '🔥 Keep pushing. One focused task at a time.', minActiveMinutes: 0, minCooldownMinutes: 3 },
  { text: '🎯 Progress is progress. Keep going.', minActiveMinutes: 0, minCooldownMinutes: 4 },
  { text: '🚀 You are making steady Salesforce progress.', minActiveMinutes: 15, minCooldownMinutes: 5 },
  { text: '😌 A short pause can sharpen the next fix.', minActiveMinutes: 25, minCooldownMinutes: 10 },
];

export function detectSalesforceContextFromFilePath(filePath: string | undefined): SalesforceContext {
  if (!filePath) {
    return 'unknown';
  }

  const fileName = filePath.toLowerCase();
  const pathSegments = filePath.split(/[\\/]/).map((segment) => segment.toLowerCase());
  const isInsideSalesforceDxPath = pathSegments.some((segment) => ['force-app', 'manifest', 'objects', 'classes', 'triggers', 'lwc', 'aura', 'staticresources'].includes(segment));
  const isApexTestFile = fileName.endsWith('.cls') && /test/.test(fileName);
  const isDeploymentArtifact = /(^|[\\/])(package\.xml|destructivechanges\.xml)$/.test(fileName)
    || (pathSegments.includes('manifest') && /(^|[\\/])(package\.xml|destructivechanges\.xml)$/.test(fileName));
  const isDeploymentFile = isDeploymentArtifact;

  if (isDeploymentFile) {
    return 'deployment';
  }

  if (fileName.endsWith('.trigger')) {
    return 'trigger';
  }

  if (fileName.endsWith('.soql')) {
    return 'soql';
  }

  if (fileName.endsWith('.cls')) {
    return isApexTestFile ? 'apex-test' : 'apex';
  }

  if (pathSegments.includes('lwc') || pathSegments.includes('aura')) {
    return 'lwc';
  }

  if (fileName.endsWith('.js') || fileName.endsWith('.html') || fileName.endsWith('.css') || fileName.endsWith('.svg')) {
    if (pathSegments.includes('lwc')) {
      return 'lwc';
    }
  }

  if (fileName.endsWith('.xml') && isInsideSalesforceDxPath) {
    return 'metadata';
  }

  return 'unknown';
}

export function pickMotivationMessage(
  context: SalesforceContext,
  activeMinutes: number,
  debugMode: boolean = false
): MotivationMessage | undefined {
  const effectiveMinutes = debugMode ? Math.min(activeMinutes, 3) : activeMinutes;

  const contextMessages = motivationMessages.filter((message) => {
    if (!message.contexts) {
      return true;
    }

    return message.contexts.includes(context);
  });

  return contextMessages
    .filter((message) => effectiveMinutes >= message.minActiveMinutes)
    .sort((a, b) => b.minActiveMinutes - a.minActiveMinutes)[0];
}

export function resolveSessionState(elapsedSinceActivityMs: number, idleThresholdMs: number): 'active' | 'idle' {
  return elapsedSinceActivityMs >= idleThresholdMs ? 'idle' : 'active';
}

export function calculateActiveMinutes(
  sessionStartMs: number,
  lastActivityMs: number,
  nowMs: number,
  idleThresholdMs: number
): number {
  const lastMeaningfulActivityMs = Math.max(sessionStartMs, Math.min(lastActivityMs, nowMs));
  const idleDurationMs = Math.max(0, nowMs - lastMeaningfulActivityMs);
  const activeWindowMs = idleDurationMs > idleThresholdMs
    ? Math.max(0, lastMeaningfulActivityMs - sessionStartMs)
    : Math.max(0, Math.min(nowMs, lastMeaningfulActivityMs) - sessionStartMs);

  return Math.max(0, Math.floor(activeWindowMs / 60_000));
}
