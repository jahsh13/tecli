'use strict';

// Runs server.js against the mock and checks that the web UI only answers
// its own page: loopback listener, per-launch token, Host/Origin checks.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { startMock } = require('./mock-helper');

const SERVER = path.join(__dirname, '..', 'server.js');
const EVIL = 'https://evil.example';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function nonLoopbackIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

async function startWeb(mock) {
  const port = await freePort();
  // cwd and HOME in a temp dir: no .env from the repo, no real cache file
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-web-'));
  const child = spawn(process.execPath, [SERVER], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TECLI_MOCK: '1',
      COSTPOINT_URL: mock.url,
      COSTPOINT_USERNAME: 'mock',
      COSTPOINT_PASSWORD: 'mock',
      COSTPOINT_DIRECT: 'true',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));
  const web = {
    port,
    base: 'http://127.0.0.1:' + port,
    log: () => log,
    stop: () =>
      new Promise(resolve => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        child.kill();
      }).then(() => fs.rmSync(home, { recursive: true, force: true })),
  };
  const deadline = Date.now() + 15000;
  while (!/running at/.test(log)) {
    if (child.exitCode !== null) throw new Error('server.js exited: ' + log);
    if (Date.now() > deadline) throw new Error('server.js did not start: ' + log);
    await new Promise(r => setTimeout(r, 50));
  }
  return web;
}

async function mockState(mock) {
  const res = await fetch('http://127.0.0.1:' + mock.port + '/__mock/state');
  return res.json();
}

async function pageToken(web) {
  const html = await (await fetch(web.base + '/')).text();
  const m = html.match(/name="tecli-token" content="([0-9a-f]+)"/);
  return m ? m[1] : null;
}

async function waitForData(web, token) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const res = await fetch(web.base + '/api/status', { headers: { 'X-Tecli-Token': token || '' } });
    if (res.ok && (await res.json()).hasData) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('web UI never loaded data: ' + web.log());
}

describe('web UI request guard', () => {
  let mock;
  let web;
  let token;

  before(async () => {
    mock = await startMock();
    web = await startWeb(mock);
    token = await pageToken(web);
    await waitForData(web, token);
  });
  after(async () => {
    if (web) await web.stop();
    if (mock) await mock.stop();
  });

  test('listens on 127.0.0.1 only', async () => {
    assert.match(web.log(), /running at http:\/\/127\.0\.0\.1:\d+/);
    const ip = nonLoopbackIPv4();
    if (!ip) return;
    await assert.rejects(
      () => fetch('http://' + ip + ':' + web.port + '/api/status', { signal: AbortSignal.timeout(2000) }),
      /fetch failed|aborted|timeout/i
    );
  });

  test('a cross-site text/plain POST to /api/sign is refused and signs nothing', async () => {
    const res = await fetch(web.base + '/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: EVIL },
    });
    assert.ok(res.status >= 400 && res.status < 500, 'status ' + res.status);
    assert.equal((await mockState(mock)).periods[0].status, 'O');
  });

  for (const [method, route] of [
    ['POST', '/api/save'],
    ['DELETE', '/api/cache'],
    ['GET', '/api/refresh'],
  ]) {
    test(`${method} ${route} from a foreign Origin is refused`, async () => {
      const res = await fetch(web.base + route, { method, headers: { Origin: EVIL } });
      assert.ok(res.status >= 400 && res.status < 500, 'status ' + res.status);
    });

    test(`${method} ${route} without the page token is refused`, async () => {
      const res = await fetch(web.base + route, { method });
      assert.ok(res.status >= 400 && res.status < 500, 'status ' + res.status);
    });
  }

  test('a foreign Origin is refused even with the token', async () => {
    const res = await fetch(web.base + '/api/status', { headers: { 'X-Tecli-Token': token, Origin: EVIL } });
    assert.equal(res.status, 403);
  });

  test('a foreign Host (DNS rebinding) cannot read the page', async () => {
    // fetch() does not let the caller set Host
    const { status, body } = await new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: web.port, path: '/', headers: { Host: 'evil.example:' + web.port } },
        res => {
          let body = '';
          res.on('data', d => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
    });
    assert.equal(status, 403);
    assert.doesNotMatch(body, /tecli-token/);
  });

  test('POST /api/sign without a period is a 400 and signs nothing', async () => {
    const res = await fetch(web.base + '/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tecli-Token': token, Origin: web.base },
      body: '{}',
    });
    assert.equal(res.status, 400);
    assert.equal((await mockState(mock)).periods[0].status, 'O');
  });

  test("the page's own requests work: token header, same Origin", async () => {
    const headers = { 'Content-Type': 'application/json', 'X-Tecli-Token': token, Origin: web.base };
    const refresh = await fetch(web.base + '/api/refresh', { headers });
    assert.equal(refresh.status, 200);
    const save = await fetch(web.base + '/api/save', { method: 'POST', headers });
    assert.equal(save.status, 200);
    const sign = await fetch(web.base + '/api/sign', { method: 'POST', headers, body: '{"period":0}' });
    assert.equal(sign.status, 200, await sign.text());
    assert.equal((await mockState(mock)).periods[0].status, 'S');
  });

  test('the token in the page differs per launch', async () => {
    const other = await startWeb(mock);
    try {
      const second = await pageToken(other);
      assert.ok(token && second);
      assert.notEqual(second, token);
    } finally {
      await other.stop();
    }
  });
});
