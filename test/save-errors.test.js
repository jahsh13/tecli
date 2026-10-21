#!/usr/bin/env node
'use strict';

// save() raises RevisionRequiredError only for the explanation prompt; every
// other failed 206 surfaces the server's message.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../mock/codec');
const protocol = require('../protocol');
const DirectClient = require('../direct');

const { RevisionRequiredError } = DirectClient;
const EXPLANATION = 'Explanation or Reject Reason is required.';

function stubClient(responses) {
  const client = Object.create(DirectClient.prototype);
  client.sid = 'SID';
  client.lastPutId = 0;
  client.periodIdx = 0;
  const parent = new Array(688).fill('');
  parent[3] = '2026-10-18';
  parent[4] = 'O';
  client.parentData = { rowNums: ['0'], rowFlags: ['0'], rows: [parent] };
  const child = new Array(402).fill('');
  client.childData = { rowNums: ['0'], rowFlags: ['0'], rows: [child] };
  client._buildTableRows = () => {};
  client._fetchRevisionDetails = async () => [];
  client._postServlet = async () => responses.shift();
  return client;
}

test('a read-only 206 failure surfaces the server message', async () => {
  const resp = codec.buildResponse([
    { rsKey: 0, cmdCd: 206, rescd: -1, error: 'Timesheet is read only' },
    { rsKey: -1, cmdCd: 507 },
  ]);
  const client = stubClient([resp]);
  await assert.rejects(() => client.save(), err => {
    assert.ok(!(err instanceof RevisionRequiredError), 'not a revision prompt');
    assert.match(err.message, /Timesheet is read only/);
    return true;
  });
});

test('the explanation error on 206 is a revision prompt', async () => {
  const resp = codec.buildResponse([
    { rsKey: 0, cmdCd: 206, rescd: -1, error: EXPLANATION },
    { rsKey: -1, cmdCd: 507 },
  ]);
  const client = stubClient([resp]);
  await assert.rejects(() => client.save(), RevisionRequiredError);
});

test('finds the 206 result code when it is not the first frame', () => {
  const resp = codec.buildResponse([
    { rsKey: 1, cmdCd: 205, rescd: 12 },
    { rsKey: 0, cmdCd: 205, rescd: 10 },
    { rsKey: 0, cmdCd: 206, rescd: -1, error: EXPLANATION },
    { rsKey: -1, cmdCd: 507 },
  ]);
  const client = Object.create(DirectClient.prototype);
  assert.equal(client._isSaveRevisionRequired(protocol.parseResponse(resp)), true);
});

test('a negative code on another frame is not a revision prompt', () => {
  const resp = codec.buildResponse([
    { rsKey: 0, cmdCd: 206, rescd: 1 },
    { rsKey: 1, cmdCd: 204, rescd: -12, error: EXPLANATION },
    { rsKey: -1, cmdCd: 507 },
  ]);
  const client = Object.create(DirectClient.prototype);
  assert.equal(client._isSaveRevisionRequired(protocol.parseResponse(resp)), false);
});
