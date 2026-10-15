'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { weekLabel, assertBackReachable } = require('../week-label');

describe('week-label', () => {
  test('weekLabel names the week', () => {
    assert.equal(weekLabel(1), 'previous week');
    assert.equal(weekLabel(3), '3 weeks back');
  });

  test('assertBackReachable allows the last loaded period', () => {
    assert.doesNotThrow(() => assertBackReachable(19, 20));
    assert.doesNotThrow(() => assertBackReachable(0, 1));
  });

  test('assertBackReachable reports how far back Costpoint goes', () => {
    assert.throws(() => assertBackReachable(20, 20), /Cannot go back 20 weeks. Costpoint offers 19 past weeks./);
    assert.throws(() => assertBackReachable(2, 2), /offers 1 past week\./);
  });
});
