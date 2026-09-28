# Salesforce Coding Motivator

A lightweight motivational companion for Salesforce developers working in VS Code.

Salesforce Coding Motivator brings a small developer companion into your VS Code workspace, giving contextual encouragement while you work with Apex, LWC, Salesforce metadata, and Salesforce CLI deployments.

## ✨ Features

### 🧑‍💻 Salesforce-aware motivation

Recognizes common Salesforce development contexts, including:

- Apex classes
- Apex tests
- Triggers
- SOQL-related work
- LWC and Aura paths
- Salesforce metadata
- Deployment workflows

### 🐾 Interactive mascot companion

The Motivator lives in VS Code's Secondary Sidebar and reacts to your coding activity with different mascot states.

The companion can respond to:

- Active development
- Focused coding
- Successful deployments
- Deployment failures
- Idle periods
- Session activity

### 🚀 Salesforce CLI deployment awareness

When you run supported Salesforce CLI deployment commands in the VS Code integrated terminal, the Motivator can recognize the deployment result and react accordingly.

Successful deployments can trigger a success reaction, while genuine deployment failures can trigger a failure reaction with contextual information.

### ⏱️ Coding session tracking

Tracks active and idle periods to provide contextual motivation throughout your development session.

### 💾 Local-first

The extension is designed to operate locally.

It does not require:

- AI services
- Paid APIs
- Backend infrastructure
- Telemetry
- External databases

Session information is stored using VS Code's local extension state.

## 🚀 Getting Started

1. Install **Salesforce Coding Motivator** from the VS Code Marketplace.
2. Open a Salesforce project.
3. Open the **Motivator** view in the VS Code Secondary Sidebar.
4. Start your coding session.
5. Work normally with your Salesforce project and Salesforce CLI.

## ⚙️ Commands

Available commands include:

- Salesforce Coding Motivator: Start
- Salesforce Coding Motivator: Stop
- Salesforce Coding Motivator: Show Old Chat
- Salesforce Coding Motivator: Show Session Summary
- Salesforce Coding Motivator: Clear Chat History
- Salesforce Coding Motivator: Open Companion
- Salesforce Coding Motivator: Trigger Deployment Message
- Salesforce Coding Motivator: Show Deployment Checklist
- Salesforce Coding Motivator: Deploy Active Source and Monitor

## ⚙️ Configuration

Settings are available under `salesforceCodingMotivator`.

| Setting | Description |
|---|---|
| `enabled` | Enable or disable motivational notifications |
| `debugTestMode` | Use shorter thresholds for local testing |
| `messageCooldownMinutes` | Cooldown between repeated motivational messages |
| `idleThresholdMinutes` | Time before the session is considered idle |
| `breakReminderMinutes` | Idle time before a break reminder |

## 🔒 Privacy

Salesforce Coding Motivator is designed as a local-first extension.

It does not require an external AI service, telemetry backend, or cloud database for its motivational features.

It stores small local session information using VS Code extension state.

## ⚠️ Limitations

Salesforce context detection is heuristic and based on local project and file information.

Deployment monitoring depends on supported Salesforce CLI commands executed through the VS Code integrated terminal and does not attempt to monitor every Salesforce operation.

The extension does not automatically access Salesforce org data.

## 🛠️ Local Development

For local development:

```bash
npm install
npm run compile
npm test
```

To run the extension from source in VS Code:

1. Open the project in VS Code.
2. Press `F5` to launch the Extension Development Host.
3. Open a Salesforce-related file or use the Command Palette.

## 📋 License

See the included `LICENSE` file for the terms governing use, modification, and redistribution.

## 🗺️ Roadmap

Future improvements may include:

- richer Salesforce context detection
- additional mascot interactions
- further companion UX improvements
- additional deployment workflow support
