import { calculateActiveMinutes, resolveSessionState } from './salesforceLogic';

export type SessionState = 'stopped' | 'active' | 'idle';

export class SessionManager {
  private sessionStartMs: number | null = null;
  private lastActivityMs: number | null = null;
  private currentState: SessionState = 'stopped';
  private readonly idleThresholdMs: number;

  constructor(idleThresholdMs: number) {
    this.idleThresholdMs = idleThresholdMs;
  }

  start(): void {
    const now = Date.now();
    this.sessionStartMs = now;
    this.lastActivityMs = now;
    this.currentState = 'active';
  }

  stop(): void {
    this.sessionStartMs = null;
    this.lastActivityMs = null;
    this.currentState = 'stopped';
  }

  markActivity(now: number = Date.now()): void {
    if (!this.sessionStartMs) {
      this.sessionStartMs = now;
    }

    this.lastActivityMs = now;
    if (this.currentState === 'idle') {
      this.currentState = 'active';
    }
  }

  getState(): SessionState {
    return this.currentState;
  }

  setState(state: SessionState): void {
    this.currentState = state;
  }

  getSessionStartMs(): number | null {
    return this.sessionStartMs;
  }

  getLastActivityMs(): number | null {
    return this.lastActivityMs;
  }

  tick(now: number = Date.now()): SessionState {
    if (!this.lastActivityMs) {
      return this.currentState;
    }

    const elapsedSinceActivity = now - this.lastActivityMs;
    this.currentState = resolveSessionState(elapsedSinceActivity, this.idleThresholdMs);
    return this.currentState;
  }

  getActiveMinutes(now: number = Date.now()): number {
    if (!this.sessionStartMs) {
      return 0;
    }

    const lastMeaningfulActivity = this.lastActivityMs ?? this.sessionStartMs;
    return calculateActiveMinutes(
      this.sessionStartMs,
      lastMeaningfulActivity,
      now,
      this.idleThresholdMs
    );
  }
}
