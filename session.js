'use strict';

const Costpoint = require('./costpoint');
const DirectClient = require('./direct');
const { assertBackReachable } = require('./week-label');

const DEFAULT_IDLE_MS = 5 * 60 * 1000;

// Weeks are identified by period: the parent K0 row index (0 = active week,
// 1 = the week before it, ...). A past-week session is launched fresh and
// moved to its period before anything else runs (same rule as signing).
// preloadPrevious only applies to the active week in direct mode.
async function launchForPeriod(creds, period, { preloadPrevious = false } = {}) {
  const { url, username, password, useDirect } = creds;
  if (!useDirect) {
    if (period !== 0) {
      throw new Error('Editing a past week requires direct mode (COSTPOINT_DIRECT=true)');
    }
    return Costpoint.launch(url, username, password);
  }
  if (period === 0) {
    return DirectClient.launch(url, username, password, preloadPrevious ? { loadPreviousPeriod: true } : undefined);
  }
  const cp = await DirectClient.launch(url, username, password);
  try {
    assertBackReachable(period, cp.getPeriods().length);
    await cp.selectPeriod(period);
  } catch (e) {
    try {
      await cp.close();
    } catch (e2) {
      /* ignore */
    }
    throw e;
  }
  return cp;
}

// Favorites belong to the user, not the week: list them on a throwaway
// active-week session so an edit session and a processed week stay as they are
async function listFavorites(creds) {
  const cp = await launchForPeriod(creds, 0);
  try {
    return await cp.getFavorites();
  } finally {
    await cp.close().catch(() => {});
  }
}

function isSessionError(e) {
  const msg = (e.message || '').toLowerCase();
  return (
    msg.includes('session') ||
    msg.includes('not valid') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('onservletexception')
  );
}

// One client at a time, bound to one period; asking for another period
// relaunches it. An idle client is released after idleMs.
function createSessionManager({ launch, idleMs = DEFAULT_IDLE_MS, onLaunch, onLaunched, onReuse, onRetry, onRelease }) {
  let client = null;
  let clientPeriod = 0;
  let idleTimer = null;

  async function releaseClient() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (client) {
      const old = client;
      client = null;
      try {
        await old.close();
      } catch (e) {
        /* ignore */
      }
      if (onRelease) onRelease();
    }
  }

  async function getClient(period = 0) {
    if (idleTimer) clearTimeout(idleTimer);

    if (client && clientPeriod !== period) {
      await releaseClient();
    }

    if (!client) {
      if (onLaunch) onLaunch(period);
      client = await launch(period);
      clientPeriod = period;
      if (onLaunched) onLaunched(period);
    } else if (onReuse) {
      onReuse();
    }

    idleTimer = setTimeout(releaseClient, idleMs);
    idleTimer.unref();
    return client;
  }

  async function withClient(fn, period = 0) {
    try {
      return await fn(await getClient(period));
    } catch (e) {
      if (isSessionError(e)) {
        if (onRetry) onRetry(e);
        await releaseClient();
        return await fn(await getClient(period));
      }
      throw e;
    }
  }

  return {
    getClient,
    withClient,
    releaseClient,
    current: () => client,
    get period() {
      return clientPeriod;
    },
  };
}

module.exports = { launchForPeriod, listFavorites, isSessionError, createSessionManager };
