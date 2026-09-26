import test from 'node:test';
import assert from 'node:assert/strict';

import { detectSalesforceContextFromFilePath, pickMotivationMessage, resolveSessionState, calculateActiveMinutes } from '../core/salesforceLogic';
import { SessionManager } from '../core/sessionManager';
import { buildMascotSvg } from '../mascot';

test('detectSalesforceContext identifies Apex classes and test classes', () => {
  const apexDoc = { fileName: 'C:/workspace/force-app/main/default/classes/AccountService.cls' } as any;
  const testDoc = { fileName: 'C:/workspace/force-app/main/default/classes/AccountServiceTest.cls' } as any;

  assert.equal(detectSalesforceContextFromFilePath(apexDoc.fileName), 'apex');
  assert.equal(detectSalesforceContextFromFilePath(testDoc.fileName), 'apex-test');
});

test('detectSalesforceContext identifies deployment metadata files', () => {
  const manifestPath = 'C:/workspace/manifest/package.xml';
  const destructivePath = 'C:/workspace/destructiveChanges.xml';

  assert.equal(detectSalesforceContextFromFilePath(manifestPath), 'deployment');
  assert.equal(detectSalesforceContextFromFilePath(destructivePath), 'deployment');
});

test('detectSalesforceContext avoids false positives in unrelated manifest or JS paths', () => {
  const unrelatedManifest = 'C:/workspace/app/manifest/config.json';
  const unrelatedJs = 'C:/workspace/src/index.js';

  assert.equal(detectSalesforceContextFromFilePath(unrelatedManifest), 'unknown');
  assert.equal(detectSalesforceContextFromFilePath(unrelatedJs), 'unknown');
});

test('pickMotivationMessage respects context and active time thresholds', () => {
  const apexMessage = pickMotivationMessage('apex', 0, false);
  const deploymentMessage = pickMotivationMessage('deployment', 0, false);

  assert.ok(apexMessage);
  assert.match(apexMessage!.text, /Apex/);
  assert.ok(deploymentMessage);
  assert.match(deploymentMessage!.text, /Deployment|deploy/i);
});

test('resolveSessionState respects idle thresholds', () => {
  assert.equal(resolveSessionState(59_000, 60_000), 'active');
  assert.equal(resolveSessionState(60_000, 60_000), 'idle');
  assert.equal(resolveSessionState(120_000, 60_000), 'idle');
});

test('calculateActiveMinutes excludes idle time from the session total', () => {
  const sessionStart = 0;
  const lastActivity = 15 * 60_000;
  const now = 25 * 60_000;

  assert.equal(calculateActiveMinutes(sessionStart, lastActivity, now, 60_000), 15);
});

test('SessionManager keeps a stopped session stopped and ignores accidental activity', () => {
  const session = new SessionManager(60_000);

  session.stop();
  session.markActivity(1_000);

  assert.equal(session.getState(), 'stopped');
  assert.equal(session.getSessionStartMs(), null);
  assert.equal(session.getLastActivityMs(), null);
  assert.equal(session.tick(10_000), 'stopped');
});

test('SessionManager resumes from idle to active when activity is recorded', () => {
  const session = new SessionManager(60_000);

  session.start();
  session.markActivity(1_000);
  session.tick(120_000);
  assert.equal(session.getState(), 'idle');

  session.markActivity(121_000);
  assert.equal(session.getState(), 'active');
  assert.equal(session.getActiveMinutes(121_000), 0);
});

test('SessionManager start is idempotent while an active session already exists', () => {
  const session = new SessionManager(60_000);

  session.start();
  const firstStart = session.getSessionStartMs();

  session.start();

  assert.equal(session.getState(), 'active');
  assert.equal(session.getSessionStartMs(), firstStart);
});

test('buildMascotSvg renders a local anime-inspired male protagonist mascot', () => {
  const svg = buildMascotSvg('focused');

  assert.match(svg, /<svg/);
  assert.match(svg, /class="mascot.*focused/);
  assert.match(svg, /hair|face|body/);
});
