'use strict';

function periodLabel(period) {
  if (period <= 0) return '';
  if (period === 1) return 'PREVIOUS WEEK';
  return period + ' WEEKS AGO';
}

// periodCount is the number of loaded periods (getPeriods().length), or
// null when not yet known. Returns the target period or null if out of range.
function stepPeriod(current, delta, periodCount) {
  const next = current + delta;
  if (next < 0) return null;
  if (periodCount !== null && periodCount !== undefined && next >= periodCount) return null;
  return next;
}

module.exports = { periodLabel, stepPeriod };
