export type DialogueContext = 'general' | 'apex' | 'lwc' | 'testing' | 'debugging' | 'deployment';

export type DialogueMessage = {
  key: string;
  text: string;
  context: DialogueContext;
};

const generalMessages: DialogueMessage[] = [
  { key: 'general-hello', text: 'Ready to cook up some code? ⚡', context: 'general' },
  { key: 'general-flow', text: 'Nice flow. One focused task at a time.', context: 'general' },
  { key: 'general-focus', text: 'Keep the momentum steady. The next fix is already on the way.', context: 'general' }
];

const apexMessages: DialogueMessage[] = [
  { key: 'apex-bulk', text: 'Bulk-safe and brilliant. Let’s make this trigger proud!', context: 'apex' },
  { key: 'apex-governor', text: 'Governor limits are real. Keep it clean and efficient.', context: 'apex' },
  { key: 'apex-logic', text: 'Apex logic check: simplify the path, then crush the bug.', context: 'apex' }
];

const lwcMessages: DialogueMessage[] = [
  { key: 'lwc-ui', text: 'Component mode activated! Let’s make this UI shine.', context: 'lwc' },
  { key: 'lwc-clean', text: 'Keep the component clean and the DOM happy.', context: 'lwc' },
  { key: 'lwc-flow', text: 'LWC energy: focused, polished, and easy to follow.', context: 'lwc' }
];

const testingMessages: DialogueMessage[] = [
  { key: 'testing-energetic', text: 'Test time. Validate the assumptions and trust the flow.', context: 'testing' },
  { key: 'testing-debug', text: 'A quick test pass can reveal the next move instantly.', context: 'testing' },
  { key: 'testing-focus', text: 'Tiny checks now, big confidence later.', context: 'testing' }
];

const debuggingMessages: DialogueMessage[] = [
  { key: 'debug-hit', text: 'One bug at a time. We’ve got this.', context: 'debugging' },
  { key: 'debug-focus', text: 'Pause, inspect, isolate. The root cause is close.', context: 'debugging' },
  { key: 'debug-calm', text: 'Debugging is just a puzzle in disguise. Stay calm and narrow it down.', context: 'debugging' }
];

const deploymentMessages: DialogueMessage[] = [
  { key: 'deploy-prep', text: 'Steady now. Let’s check everything before launch.', context: 'deployment' },
  { key: 'deploy-validate', text: 'Validate the metadata and test the critical paths before you deploy.', context: 'deployment' },
  { key: 'deploy-clear', text: 'Deployment mode is calm, controlled, and intentional. Keep it crisp.', context: 'deployment' }
];

const allMessages: Record<DialogueContext, DialogueMessage[]> = {
  general: generalMessages,
  apex: apexMessages,
  lwc: lwcMessages,
  testing: testingMessages,
  debugging: debuggingMessages,
  deployment: deploymentMessages,
};

export function getDialogueMessages(context: DialogueContext): DialogueMessage[] {
  return [...allMessages[context]];
}

export function pickDialogueMessage(context: DialogueContext, previousKey?: string): DialogueMessage {
  const messages = getDialogueMessages(context);
  const available = previousKey
    ? messages.filter((entry) => entry.key !== previousKey)
    : messages;

  const fallback = messages[0] ?? generalMessages[0];
  return available[Math.floor(Math.random() * available.length)] ?? fallback;
}

export function getDialogueTextForContext(context: DialogueContext, previousKey?: string): string {
  return pickDialogueMessage(context, previousKey).text;
}

export function buildSpeechBubbleHtml(message: string): string {
  return `
    <div class="speech-bubble" role="status" aria-live="polite" aria-atomic="true">
      <div class="speech-bubble__tail" aria-hidden="true"></div>
      <span>${message}</span>
    </div>
  `;
}
