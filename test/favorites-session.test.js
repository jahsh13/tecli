'use strict';

// Listing favorites must not change the week or the edit session
// (tecli-4mz.2, tecli-4mz.3).

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-helper');

describe('favorites leave the session clean', () => {
  let mock;
  beforeEach(async () => {
    mock = await startMock();
  });
  afterEach(() => mock.stop());

  test('getFavorites then set + save succeeds and persists', async () => {
    const cp = await mock.launch();
    assert.equal((await cp.getFavorites()).length, 2);
    assert.equal(cp.pendingLine(), null);
    await cp.set(0, 15, 3);
    await cp.save();
    assert.equal((await mock.launch()).getData().projects[0].hours[15], 3);
  });

  test('getFavorites on a processed week leaves it processed', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(1);
    assert.equal((await cp.getFavorites()).length, 2);
    await cp.close();
    const fresh = await mock.launch();
    assert.equal(fresh.getPeriods()[1].statusCode, 'P');
    assert.equal(mock.db.period(1).status, 'P');
  });

  test('addFromFavorite on a processed week still corrects it', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(1);
    const fav = await cp.addFromFavorite(0);
    assert.equal(fav.code, 'PROJ.A.100');
    assert.equal(cp.getData().timesheetStatusCode, 'O');
    assert.ok(cp.pendingLine());
  });

  test('getFavorites({ keepLine: true }) keeps the line for add()', async () => {
    const cp = await mock.launch();
    await cp.getFavorites({ keepLine: true });
    assert.ok(cp.pendingLine());
    await cp.add('PROJ.B.200', 'REG');
    await cp.save();
    const codes = (await mock.launch()).getData().projects.map(p => p.code);
    assert.ok(codes.includes('PROJ.B.200'));
  });
});

describe('web UI favorites', () => {
  const { startWeb, pageToken, waitForData } = require('./web-helper');
  let mock;
  let web;
  let headers;

  beforeEach(async () => {
    mock = await startMock();
    web = await startWeb(mock);
    const token = await pageToken(web);
    await waitForData(web, token);
    headers = { 'Content-Type': 'application/json', 'X-Tecli-Token': token, Origin: web.base };
  });
  afterEach(async () => {
    if (web) await web.stop();
    if (mock) await mock.stop();
  });

  test('GET /api/favorites then PUT /api/hours + POST /api/save succeeds', async () => {
    const favs = await fetch(web.base + '/api/favorites?period=0', { headers });
    assert.equal(favs.status, 200);
    assert.equal((await favs.json()).length, 2);
    const hours = await fetch(web.base + '/api/hours', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ period: 0, periodLine: 0, day: 15, hours: 3 }),
    });
    assert.equal(hours.status, 200, await hours.text());
    const save = await fetch(web.base + '/api/save', { method: 'POST', headers });
    assert.equal(save.status, 200, await save.text());
    assert.equal((await mock.launch()).getData().projects[0].hours[15], 3);
  });

  test('GET /api/favorites?period=1 leaves the processed week processed', async () => {
    const favs = await fetch(web.base + '/api/favorites?period=1', { headers });
    assert.equal(favs.status, 200, web.log());
    assert.equal(mock.db.period(1).status, 'P');
  });
});

describe('listFavorites (TUI, web UI and MCP)', () => {
  const { listFavorites } = require('../session');
  let mock;
  beforeEach(async () => {
    mock = await startMock();
  });
  afterEach(() => mock.stop());

  test('lists on its own session, sends no Correct and leaves no pending line', async () => {
    const edit = await mock.launch();
    await edit.selectPeriod(1);
    const creds = { url: mock.url, username: 'mock', password: 'mock', useDirect: true };
    assert.equal((await listFavorites(creds)).length, 2);
    assert.equal(mock.db.period(1).status, 'P');
    assert.equal(edit.pendingLine(), null);
  });

  test('tui.js and server.js list favorites through listFavorites, not the edit session', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['tui.js', 'server.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      assert.match(src, /listFavorites\(creds\)/, file);
      assert.doesNotMatch(src, /cp\.getFavorites\(/, file);
    }
  });
});
