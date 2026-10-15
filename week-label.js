'use strict';

// Wording for weeks counted back from the current one (0 = current), shared
// by the CLI and the MCP server.

function weekLabel(back) {
  return back === 1 ? 'previous week' : `${back} weeks back`;
}

// Throws when back is further than the K0 periods the session loaded
function assertBackReachable(back, periodCount) {
  const reach = periodCount - 1;
  if (back > reach) {
    throw new Error(
      `Cannot go back ${back} weeks. Costpoint offers ${reach} past week${reach === 1 ? '' : 's'}.`,
    );
  }
}

module.exports = { weekLabel, assertBackReachable };
