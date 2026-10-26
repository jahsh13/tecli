#!/usr/bin/env node
'use strict';

// The Puppeteer client reports save and sign failures by throwing, like
// DirectClient, so the web UI, TUI and MCP stay alive and show the error.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../mock/codec');
const Costpoint = require('../costpoint');
const { RevisionRequiredError } = require('../direct');

const EXPLANATION = 'Explanation or Reject Reason is required.';
const OK = codec.buildResponse([
  { rsKey: 0, cmdCd: 206, rescd: 1 },
  { rsKey: -1, cmdCd: 507 },
]);

// A page whose MasterServlet POSTs answer with `responses` in order and
// whose status field reads `status()`.
function stubPage({ responses = [], status = () => 'O', signButton = true } = {}) {
  const events = [];
  const page = {
    events,
    keyboard: { press: async key => events.push('press ' + key) },
    waitForFunction: async () => {
      if (!signButton) throw new Error('Waiting failed: 10000ms exceeded');
    },
    waitForResponse: async predicate => {
      const body = responses.shift();
      const response = {
        url: () => 'https://cp.example/cpweb/MasterServlet.cps',
        request: () => ({ method: () => 'POST' }),
        text: async () => body,
      };
      assert.ok(predicate(response), 'waits for a MasterServlet POST');
      events.push('response');
      return response;
    },
    evaluate: async () => status(),
    locator: selector => ({
      click: async () => {
        events.push('click ' + selector);
        if (selector === '#SIGN_BUT' && page.dialogHandler) {
          await page.dialogHandler({ accept: async () => events.push('accept') });
        }
      },
      fill: async value => events.push('fill ' + selector + ' ' + value),
    }),
    once: (name, handler) => {
      if (name === 'dialog') page.dialogHandler = handler;
    },
    waitForNetworkIdle: async () => {},
  };
  return page;
}

function client(page) {
  const cp = new Costpoint();
  cp.page = page;
  return cp;
}

test('save() resolves when the 206 succeeds', async () => {
  const cp = client(stubPage({ responses: [OK] }));
  await cp.save();
  assert.equal(cp.timesheetStatusCode, 'O');
});

test('save() rejects with the server message when the 206 fails', async () => {
  const resp = codec.buildResponse([
    { rsKey: 0, cmdCd: 206, rescd: -1, error: 'Timesheet is read only' },
    { rsKey: -1, cmdCd: 507 },
  ]);
  const cp = client(stubPage({ responses: [resp] }));
  await assert.rejects(
    () => cp.save(),
    err => !(err instanceof RevisionRequiredError) && /Timesheet is read only/.test(err.message)
  );
});

test('save() rejects on a servlet exception', async () => {
  const cp = client(stubPage({ responses: ['onServletException("boom")'] }));
  await assert.rejects(() => cp.save(), /Server error/);
});

test('save() raises RevisionRequiredError for the explanation prompt', async () => {
  const resp = codec.buildResponse([
    { rsKey: 0, cmdCd: 206, rescd: -1, error: EXPLANATION },
    { rsKey: -1, cmdCd: 507 },
  ]);
  const cp = client(stubPage({ responses: [resp] }));
  await assert.rejects(() => cp.save(), RevisionRequiredError);
});

test('saveWithExplanation() fills the prompt, continues and checks the response', async () => {
  const page = stubPage({ responses: [OK] });
  await client(page).saveWithExplanation('fixed a typo');
  const fill = page.events.indexOf('fill #EXPLANATION_TEXT fixed a typo');
  assert.ok(fill >= 0, 'explanation filled');
  assert.ok(page.events.indexOf('click #OK_BUT___T') > fill, 'Continue clicked after filling');
  assert.ok(page.events.includes('response'), 'save response read');
});

test('saveWithExplanation() rejects when the save still fails', async () => {
  const resp = codec.buildResponse([
    { rsKey: 0, cmdCd: 206, rescd: -1, error: 'Hours exceed limit' },
    { rsKey: -1, cmdCd: 507 },
  ]);
  const cp = client(stubPage({ responses: [resp] }));
  await assert.rejects(() => cp.saveWithExplanation('why'), /Hours exceed limit/);
});

test('sign() throws instead of exiting when the Sign button never shows', async () => {
  const exit = process.exit;
  process.exit = () => assert.fail('sign() must not call process.exit');
  try {
    const cp = client(stubPage({ signButton: false }));
    await assert.rejects(() => cp.sign(), /already signed/);
  } finally {
    process.exit = exit;
  }
});

test('sign() accepts the certification dialog and resolves once the week is Signed', async () => {
  let signed = false;
  const page = stubPage({ status: () => (signed ? 'S' : 'O') });
  const accept = page.locator;
  page.locator = selector => {
    const l = accept(selector);
    const click = l.click;
    l.click = async () => {
      await click();
      if (selector === '#SIGN_BUT') signed = true;
    };
    return l;
  };
  const cp = client(page);
  await cp.sign();
  assert.ok(page.events.includes('accept'), 'dialog accepted');
  assert.equal(cp.timesheetStatusCode, 'S');
});

test('sign() rejects when the week is not Signed afterwards', async () => {
  const cp = client(stubPage({ status: () => 'O' }));
  await assert.rejects(() => cp.sign(), /not signed/i);
});

test('set() types every key of the hours in order before tabbing on', async () => {
  const page = stubPage({ responses: [OK] });
  page.waitForSelector = async () => {};
  page.click = async () => {};
  const cp = client(page);
  const moment = require('moment');
  cp.dates = [0, 1, 2].map(i => moment('2026-10-18').add(i, 'days'));
  cp.table = [[0, 'Line', '', '', '']];
  await cp.set(0, 19, 7.5);
  const typed = page.events.filter(e => /^press (\d|Period)$/.test(e));
  assert.deepEqual(typed, ['press 7', 'press Period', 'press 5']);
  const afterTyping = page.events.slice(page.events.indexOf('press 5') + 1);
  assert.ok(afterTyping.includes('press Tab'), 'tabs out after the hours are typed');
});
