import * as vscode from 'vscode';

let isRunning = false;

export function activate(context: vscode.ExtensionContext): void {
  const startCommand = vscode.commands.registerCommand('salesforce-coding-motivator.start', () => {
    isRunning = true;
    void vscode.window.showInformationMessage('⚡ Salesforce Coding Motivator is ready. Let\'s code!');
  });

  const stopCommand = vscode.commands.registerCommand('salesforce-coding-motivator.stop', () => {
    isRunning = false;
    void vscode.window.showInformationMessage('🛑 Salesforce Coding Motivator stopped.');
  });

  context.subscriptions.push(startCommand, stopCommand);
}

export function deactivate(): void {
  isRunning = false;
}
