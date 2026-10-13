'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { periodLabel, stepPeriod } = require('../tui-nav');

test('periodLabel names past weeks', () => {
  assert.strictEqual(periodLabel(0), '');
  assert.strictEqual(periodLabel(1), 'PREVIOUS WEEK');
  assert.strictEqual(periodLabel(2), '2 WEEKS AGO');
  assert.strictEqual(periodLabel(7), '7 WEEKS AGO');
});

test('stepPeriod moves within bounds', () => {
  assert.strictEqual(stepPeriod(0, 1, 20), 1);
  assert.strictEqual(stepPeriod(3, -1, 20), 2);
});

test('stepPeriod stops at the active week', () => {
  assert.strictEqual(stepPeriod(0, -1, 20), null);
});

test('stepPeriod stops at the oldest loaded period', () => {
  assert.strictEqual(stepPeriod(18, 1, 20), 19);
  assert.strictEqual(stepPeriod(19, 1, 20), null);
});

test('stepPeriod allows older weeks while the count is unknown', () => {
  assert.strictEqual(stepPeriod(5, 1, null), 6);
  assert.strictEqual(stepPeriod(0, -1, null), null);
});
