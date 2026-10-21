'use strict';

// Servlet traffic is traced to a file so a failed live write leaves evidence.

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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-trace-'));
  saved = process.env.COSTPOINT_TRACE;
  delete process.env.COSTPOINT_TRACE;
  DirectClient.setDefaultTrace(null);
});

afterEach(() => {
  if (saved === undefined) delete process.env.COSTPOINT_TRACE;
  else process.env.COSTPOINT_TRACE = saved;
  DirectClient.setDefaultTrace(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('COSTPOINT_TRACE set after load still traces, owner-only', async () => {
  const file = path.join(dir, 'env.jsonl');
  process.env.COSTPOINT_TRACE = file;
  await stubClient()._postServlet('REQ');
  assert.deepEqual(lines(file).map(e => [e.request, e.response]), [['REQ', 'var responses=[];']]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('the default trace file is used when COSTPOINT_TRACE is unset', async () => {
  const file = path.join(dir, 'default.jsonl');
  DirectClient.setDefaultTrace(file);
  await stubClient()._postServlet('REQ');
  assert.equal(lines(file).length, 1);
});

test('COSTPOINT_TRACE=off disables the default trace', async () => {
  const file = path.join(dir, 'default.jsonl');
  DirectClient.setDefaultTrace(file);
  process.env.COSTPOINT_TRACE = 'off';
  await stubClient()._postServlet('REQ');
  assert.equal(fs.existsSync(file), false);
});

test('a full trace file rotates to .1 before the next entry', async () => {
  const file = path.join(dir, 'big.jsonl');
  fs.writeFileSync(file, 'x'.repeat(DirectClient.TRACE_MAX_BYTES), { mode: 0o600 });
  process.env.COSTPOINT_TRACE = file;
  await stubClient()._postServlet('REQ');
  assert.equal(fs.statSync(file + '.1').size, DirectClient.TRACE_MAX_BYTES);
  assert.equal(lines(file).length, 1);
});
