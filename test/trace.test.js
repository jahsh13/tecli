'use strict';

// Servlet traffic is traced to a file on request, so a failed live write can
// leave evidence. Tracing is opt-in: COSTPOINT_TRACE must be set.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DirectClient = require('../direct');

let dir;
let saved;

function stubClient() {
  const client = Object.create(DirectClient.prototype);
  client.baseUrl = 'https://example.com';
  client._http = async () => ({ status: 200, body: 'var responses=[];' });
  return client;
}

const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const defaultFile = () => path.join(dir, '.tecli-trace.jsonl');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-trace-'));
  saved = { trace: process.env.COSTPOINT_TRACE, home: process.env.HOME };
  delete process.env.COSTPOINT_TRACE;
  process.env.HOME = dir;
});

afterEach(() => {
  for (const [key, value] of [['COSTPOINT_TRACE', saved.trace], ['HOME', saved.home]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing is traced while COSTPOINT_TRACE is unset', async () => {
  await stubClient()._postServlet('REQ');
  assert.deepEqual(fs.readdirSync(dir), []);
});

for (const value of ['off', '0', 'false', '']) {
  test(`COSTPOINT_TRACE=${JSON.stringify(value)} traces nothing`, async () => {
    process.env.COSTPOINT_TRACE = value;
    await stubClient()._postServlet('REQ');
    assert.deepEqual(fs.readdirSync(dir), []);
  });
}

for (const value of ['1', 'on', 'true', 'ON']) {
  test(`COSTPOINT_TRACE=${value} traces to ~/.tecli-trace.jsonl`, async () => {
    process.env.COSTPOINT_TRACE = value;
    await stubClient()._postServlet('REQ');
    assert.equal(lines(defaultFile()).length, 1);
  });
}

test('COSTPOINT_TRACE=<file> set after load still traces, owner-only', async () => {
  const file = path.join(dir, 'env.jsonl');
  process.env.COSTPOINT_TRACE = file;
  await stubClient()._postServlet('REQ');
  assert.deepEqual(lines(file).map(e => [e.request, e.response]), [['REQ', 'var responses=[];']]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a full trace file rotates to .1 before the next entry', async () => {
  const file = path.join(dir, 'big.jsonl');
  fs.writeFileSync(file, 'x'.repeat(DirectClient.TRACE_MAX_BYTES), { mode: 0o600 });
  process.env.COSTPOINT_TRACE = file;
  await stubClient()._postServlet('REQ');
  assert.equal(fs.statSync(file + '.1').size, DirectClient.TRACE_MAX_BYTES);
  assert.equal(lines(file).length, 1);
});
