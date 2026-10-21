#!/usr/bin/env node
'use strict';

// Parent columns are found by name from the OPEN_RS maObjId list, so a
// server-side column insert cannot silently move the sign/closed flags.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const protocol = require('../protocol');
const DirectClient = require('../direct');

const CAPTURE = path.join(__dirname, '../captured/prev-period-edit/006-res.txt');
const hasCapture = fs.existsSync(CAPTURE);

test('decodes the compressed K0 column list from a browser capture', { skip: !hasCapture && 'no captured/' }, () => {
  const [names] = protocol.columnNames(fs.readFileSync(CAPTURE, 'utf8'));
  assert.equal(names.length, 688);
  assert.ok(names.every(n => /^[A-Z0-9_]+$/.test(n)));
  assert.equal(names[3], 'END_DT');
  assert.equal(names[23], 'ACTION_CD');
  assert.equal(names[573], 'ENABLE_SIGN_FL');
  assert.equal(names[676], 'ENABLE_CORRECT_FL');
  assert.equal(names[685], 'TS_CLOSED_FL');
});

test('reads plain uncompressed names', () => {
  const text = 'var responses=[[],"",[],[],[],[function(g){D.V(g,"maObjId","A\x0bB_FL\x0bC")}]];';
  assert.deepEqual(protocol.columnNames(text), [['A', 'B_FL', 'C']]);
});

function layout(width, at) {
  const names = Array.from({ length: width }, (_, i) => 'COL' + i);
  for (const [name, i] of Object.entries(at)) names[i] = name;
  return names;
}

const SHIFTED = { EMPL_FULL_NAME: 0, EMPL_ID: 1, SCHEDULE_DESC_AND_P_TEXT: 2, END_DT: 3, S_STATUS_CD: 4,
  ACTION_CD: 23, ENABLE_SIGN_FL: 575, ENABLE_CORRECT_FL: 680, TS_CLOSED_FL: 689 };

test('resolves the shifted live layout (692 columns) by name', () => {
  const cols = DirectClient.resolveParentColumns(layout(692, SHIFTED), 692);
  assert.equal(cols.ENABLE_SIGN_FL, 575);
  assert.equal(cols.ENABLE_CORRECT_FL, 680);
  assert.equal(cols.TS_CLOSED_FL, 689);
  assert.equal(cols.SCHEDULE_DESC, 2);
});

test('fails loudly when a required column is missing', () => {
  const names = layout(692, SHIFTED);
  names[689] = 'SOMETHING_ELSE';
  assert.throws(() => DirectClient.resolveParentColumns(names, 692), /TS_CLOSED_FL/);
});

test('fails loudly when the name list does not match the row width', () => {
  assert.throws(() => DirectClient.resolveParentColumns(layout(692, SHIFTED), 688), /692.*688|688.*692/);
});

test('a Processed week in the shifted layout is seen as closed', () => {
  const client = Object.create(DirectClient.prototype);
  client.parentCol = DirectClient.resolveParentColumns(layout(692, SHIFTED), 692);
  const row = new Array(692).fill('');
  row[4] = 'P'; row[575] = 'N'; row[680] = 'Y'; row[689] = 'Y'; row[685] = 'R';
  client.parentData = { rowNums: ['0'], rowFlags: ['0'], rows: [row] };
  client.periodIdx = 0;
  assert.equal(client._isPeriodClosed(), true);
});

test('refuses to treat a Processed week as open', () => {
  const client = Object.create(DirectClient.prototype);
  const row = new Array(688).fill('');
  row[4] = 'P'; row[685] = 'R';
  client.parentData = { rowNums: ['0'], rowFlags: ['0'], rows: [row] };
  client.periodIdx = 0;
  assert.throws(() => client._isPeriodClosed(), /Processed/);
});
