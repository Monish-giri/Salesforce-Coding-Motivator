# Salesforce Coding Motivator

A lightweight, local-first VS Code extension for Salesforce developers who want a small motivational companion while they work in Apex, LWC, metadata, and deployment workflows.

## What it does

- Detects common Salesforce file contexts such as Apex, Apex tests, triggers, SOQL, LWC/Aura paths, and deployment metadata
- Tracks active coding time and idle periods
- Shows contextual encouragement based on the active Salesforce workload
- Keeps a small local history of session activity
- Shows a persistent status-bar companion with brief messages and quick actions
- Reports Salesforce source diagnostics and can navigate directly to the affected file and line
- Operates without external AI services or cloud dependencies

## Current implementation status

The project is currently at the core reliability and local UX stage.

Implemented features include:
- extension activation and command registration
- start/stop session lifecycle
- idle and active session tracking
- local history storage using VS Code global state
- persistent status-bar companion and actionable VS Code notifications
- Salesforce context detection for key file patterns
- deployment workflow prompts and checklist guidance
- automated tests for core logic and session transitions

## Privacy and constraints

This extension is intentionally local-first and does not require:
- paid APIs
- external services
- AI integrations
- telemetry
- backend infrastructure

It stores small local session information in VS Code state only.

## Installation and local development

```bash
npm install
npm run compile
npm test
```

## Run in VS Code

1. Open this project in VS Code.
2. Press `F5` to launch the Extension Development Host.
3. Open a Salesforce-related file or use the command palette.
4. Run one of the available commands:
   - Salesforce Coding Motivator: Start
   - Salesforce Coding Motivator: Stop
   - Salesforce Coding Motivator: Show Old Chat
   - Salesforce Coding Motivator: Show Session Summary
   - Salesforce Coding Motivator: Open Companion
   - Salesforce Coding Motivator: Trigger Deployment Message
   - Salesforce Coding Motivator: Show Deployment Checklist

## Configuration

The extension exposes a small set of settings under the namespace `salesforceCodingMotivator`:

- `enabled` — enable or disable motivational notifications
- `debugTestMode` — shorter thresholds for local validation
- `messageCooldownMinutes` — cooldown between repeated messages
- `idleThresholdMinutes` — minutes of inactivity before session is marked idle
- `breakReminderMinutes` — reminder interval for idle breaks

## Known limitations

- Context detection is heuristic and based on local file paths and project structure
- It does not claim to monitor every Salesforce operation with guaranteed certainty
- VS Code's extension API does not allow arbitrary image overlays over the editor; the companion currently uses the status bar and native notifications rather than a floating mascot image
- It is not yet a public Marketplace release
- It does not attempt to execute Salesforce CLI commands or access org data automatically

## Roadmap

- strengthen the core session lifecycle and guardrails
- improve context detection reliability
- review mascot and companion UX direction
- refine the persistent companion and notification experience
- prepare packaging and public release documentation
