'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { launchForPeriod, isSessionError, createSessionManager } = require('../session');

function fakeLauncher() {
  const launched = [];
  const launch = async period => {
    const client = {
      period,
      closed: false,
      close: async function () {
        this.closed = true;
      },
    };
    launched.push(client);
    return client;
  };
  return { launch, launched };
}

test('reuses the client for the same period', async () => {
  const { launch, launched } = fakeLauncher();
  const m = createSessionManager({ launch });
  const a = await m.getClient(0);
  const b = await m.getClient(0);
  assert.strictEqual(a, b);
  assert.strictEqual(launched.length, 1);
  await m.releaseClient();
});

test('relaunches and closes the old client on period change', async () => {
  const { launch, launched } = fakeLauncher();
  const m = createSessionManager({ launch });
  const a = await m.getClient(0);
  const b = await m.getClient(2);
  assert.notStrictEqual(a, b);
  assert.ok(a.closed);
  assert.strictEqual(m.period, 2);
  assert.strictEqual(m.current(), b);
  await m.releaseClient();
});

test('fires hooks', async () => {
  const { launch } = fakeLauncher();
  const events = [];
  const m = createSessionManager({
    launch,
    onLaunch: p => events.push(`launch ${p}`),
    onLaunched: p => events.push(`launched ${p}`),
    onReuse: () => events.push('reuse'),
    onRelease: () => events.push('release'),
  });
  await m.getClient(1);
  await m.getClient(1);
  await m.releaseClient();
  assert.deepStrictEqual(events, ['launch 1', 'launched 1', 'reuse', 'release']);
});

test('withClient retries once on a session error', async () => {
  const { launch, launched } = fakeLauncher();
  const retried = [];
  const m = createSessionManager({ launch, onRetry: e => retried.push(e.message) });
  let calls = 0;
  const result = await m.withClient(async () => {
    calls++;
    if (calls === 1) throw new Error('Session expired');
    return 'ok';
  });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 2);
  assert.strictEqual(launched.length, 2);
  assert.ok(launched[0].closed);
  assert.deepStrictEqual(retried, ['Session expired']);
  await m.releaseClient();
});

test('withClient rethrows non-session errors without retry', async () => {
  const { launch, launched } = fakeLauncher();
  const m = createSessionManager({ launch });
  let calls = 0;
  await assert.rejects(
    m.withClient(async () => {
      calls++;
      throw new Error('boom');
    }),
    /boom/
  );
  assert.strictEqual(calls, 1);
  assert.strictEqual(launched.length, 1);
  await m.releaseClient();
});

test('withClient propagates a second session failure', async () => {
  const { launch } = fakeLauncher();
  const m = createSessionManager({ launch });
  let calls = 0;
  await assert.rejects(
    m.withClient(async () => {
      calls++;
      throw new Error('session gone');
    }),
    /session gone/
  );
  assert.strictEqual(calls, 2);
  await m.releaseClient();
});

test('releaseClient closes the client', async () => {
  const { launch } = fakeLauncher();
  const m = createSessionManager({ launch });
  const a = await m.getClient();
  await m.releaseClient();
  assert.ok(a.closed);
  assert.strictEqual(m.current(), null);
});

test('idle timer releases the client', async () => {
  const { launch } = fakeLauncher();
  const m = createSessionManager({ launch, idleMs: 20 });
  const a = await m.getClient();
  await new Promise(r => setTimeout(r, 80));
  assert.ok(a.closed);
  assert.strictEqual(m.current(), null);
});

test('launchForPeriod rejects past weeks outside direct mode', async () => {
  await assert.rejects(launchForPeriod({ useDirect: false, system: 'x' }, 1), /requires direct mode/);
});

test('isSessionError matches known messages, any case', () => {
  const msgs = ['session', 'not valid', 'econnreset', 'econnrefused', 'socket hang up', 'onservletexception'];
  for (const m of msgs) {
    assert.ok(isSessionError(new Error(m)), m);
    assert.ok(isSessionError(new Error(`x ${m.toUpperCase()} y`)), m.toUpperCase());
  }
  assert.ok(!isSessionError(new Error('boom')));
  assert.ok(!isSessionError({}));
});

test('launchForPeriod rejects a period beyond the loaded weeks, with the CLI message', async () => {
  const { startMock } = require('./mock-helper');
  const mock = await startMock();
  try {
    const creds = { url: mock.url, username: 'mock', password: 'mock', useDirect: true };
    await assert.rejects(() => launchForPeriod(creds, 25), /Cannot go back 25 weeks. Costpoint offers 19 past weeks./);
    const cp = await launchForPeriod(creds, 19);
    assert.equal(cp.getData().dates[6].fullDate, '2026-06-07');
    await cp.close();
  } finally {
    await mock.stop();
  }
});
