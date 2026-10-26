#!/usr/bin/env node
'use strict';

// Stateful HTTP mock of Costpoint for the direct client. See
// decisions/mock-backend.md for what it emulates and its quirks.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const codec = require('./codec');
const { Db, Session } = require('./state');
const { handleRequest, parseQuirks, SESSION_NOT_VALID } = require('./handlers');

const DEFAULT_FIXTURE = path.join(__dirname, 'fixture.json');
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const SAVE_FAULT = 'Mock save failure';

function readFixture(fixture) {
  if (fixture && typeof fixture === 'object') return fixture;
  return JSON.parse(fs.readFileSync(fixture || DEFAULT_FIXTURE, 'utf8'));
}

function cookieValue(req, name) {
  const header = req.headers.cookie || '';
  const match = header
    .split(/;\s*/)
    .map(c => c.split('='))
    .find(([k]) => k === name);
  return match ? match[1] : '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * options: port (0 picks a free one), fixture (path or object), quirks (list
 * or comma string), today (YYYY-MM-DD), user/password (unset accepts any
 * login), sessionTtlMs, stateFile.
 * Returns { server, port, url, db, sessions, reset(), failSave(period, error),
 * expire(sid), close() }. failSave makes the next 206 for that period fail.
 */
async function createMockServer(options = {}) {
  const fixture = readFixture(options.fixture);
  const quirks = parseQuirks(options.quirks);
  const ttl = options.sessionTtlMs || DEFAULT_TTL_MS;
  const stateFile = options.stateFile;
  const today = options.today;
  const sessions = new Map();
  // One-shot save failures by period, set with failSave()
  const faults = new Map();
  let clock = options.now || (() => Date.now());

  const freshDb = () => new Db(fixture, { today });
  let db = freshDb();
  if (stateFile && fs.existsSync(stateFile)) {
    db = Db.fromState(fixture, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  }
  const persist = () => {
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(db));
  };

  const passwordOk = value => options.password === undefined || value === options.password;
  const userOk = value => options.user === undefined || value === options.user;
  // The client does not check the password response, so a failed login shows
  // up as a masterPage without a session (the client then fails at LOGININFO)
  function handleLogin(req, body, res) {
    const params = new URLSearchParams(body);
    if (params.has('USER')) {
      const ok = userOk(params.get('USER')) ? 'ok' : 'bad';
      return send(res, 200, '', { 'Set-Cookie': 'MockUser=' + ok + '; Path=/' });
    }
    if (params.has('PASSWORD')) {
      const ok = cookieValue(req, 'MockUser') !== 'bad' && passwordOk(params.get('PASSWORD'));
      return send(res, ok ? 200 : 401, ok ? '' : 'error: invalid user or password', {
        'Set-Cookie': 'MockAuth=' + (ok ? 'ok' : 'no') + '; Path=/',
      });
    }
    return send(res, 200, '');
  }

  function newSession(req, res) {
    if (cookieValue(req, 'MockAuth') !== 'ok') return send(res, 200, '<html><body>login required</body></html>');
    const sid = crypto.randomBytes(16).toString('hex');
    sessions.set(sid, new Session(sid, clock()));
    send(res, 200, '<html><body>masterPage</body></html>', {
      'Set-Cookie': 'ProcIdSeed=' + sid + '; Path=/cpweb',
    });
  }

  function liveSession(sid) {
    const session = sessions.get(sid);
    if (!session) return null;
    if (clock() - session.lastSeen > ttl) {
      sessions.delete(sid);
      return null;
    }
    session.lastSeen = clock();
    return session;
  }

  function handleServlet(body, res) {
    const params = new URLSearchParams(body);
    const session = liveSession(params.get('sid') || '');
    if (!session) return send(res, 200, SESSION_NOT_VALID);
    if (params.has('LOGININFO')) return send(res, 200, "var responseCd='ok';");
    let text;
    try {
      const { commands } = codec.parseRequest(body);
      const env = { db, session, quirks, persist, faults, ctx: { stale: new Map(), suppress204: false } };
      text = handleRequest(env, commands);
    } catch (e) {
      console.error('mock: ' + e.stack);
      return send(res, 500, 'mock error: ' + e.message);
    }
    return send(res, 200, text);
  }

  function adminState() {
    return {
      today: db.today,
      quirks: [...quirks],
      sessions: [...sessions.values()].map(s => ({ sid: s.sid, worked: s.worked, autoLoaded: s.autoLoaded })),
      periods: db.periods.slice(0, 5).map((p, i) => ({
        idx: i,
        endDate: db.endDate(i),
        status: p.status,
        closed: p.closed,
        lines: p.lines.length,
      })),
      favorites: db.favorites,
    };
  }

  function handleAdmin(req, url, res) {
    if (req.method === 'POST' && url.pathname === '/__mock/reset') {
      db = freshDb();
      sessions.clear();
      faults.clear();
      if (stateFile && fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
      return send(res, 200, 'reset');
    }
    if (req.method === 'POST' && url.pathname === '/__mock/expire') {
      const sid = url.searchParams.get('sid');
      if (!sid || sid === 'all') sessions.clear();
      else sessions.delete(sid);
      return send(res, 200, 'expired');
    }
    if (req.method === 'POST' && url.pathname === '/__mock/fail-save') {
      faults.set(parseInt(url.searchParams.get('period') || '0', 10), url.searchParams.get('error') || SAVE_FAULT);
      return send(res, 200, 'armed');
    }
    if (req.method === 'GET' && url.pathname === '/__mock/state') {
      return send(res, 200, JSON.stringify(adminState(), null, 1), { 'Content-Type': 'application/json' });
    }
    return send(res, 404, 'not found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/__mock/')) return handleAdmin(req, url, res);
      const body = req.method === 'POST' ? await readBody(req) : '';
      if (url.pathname.endsWith('/LoginServlet.cps')) return handleLogin(req, body, res);
      if (url.pathname.endsWith('/MasterServlet.cps')) return handleServlet(body, res);
      if (url.pathname.endsWith('/masterPage.htm')) return newSession(req, res);
      return send(res, 200, '<html><body>Costpoint mock</body></html>');
    } catch (e) {
      console.error('mock: ' + e.stack);
      return send(res, 500, 'mock error: ' + e.message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port === undefined ? 0 : options.port, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  return {
    server,
    port,
    url: 'http://127.0.0.1:' + port + '/cpweb/cploginform.htm?system=MOCK',
    get db() {
      return db;
    },
    sessions,
    setClock(fn) {
      clock = fn;
    },
    reset() {
      db = freshDb();
      sessions.clear();
      faults.clear();
    },
    failSave(period, error = SAVE_FAULT) {
      faults.set(period, error);
    },
    expire(sid) {
      if (sid) sessions.delete(sid);
      else sessions.clear();
    },
    close() {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

async function main() {
  const port = parseInt(process.env.MOCK_PORT || '4000', 10);
  const mock = await createMockServer({
    port,
    today: process.env.MOCK_TODAY,
    user: process.env.MOCK_USER,
    password: process.env.MOCK_PASSWORD,
    sessionTtlMs: process.env.MOCK_SESSION_TTL_MS ? parseInt(process.env.MOCK_SESSION_TTL_MS, 10) : undefined,
    stateFile: process.env.MOCK_STATE_FILE,
    quirks: process.env.MOCK_QUIRKS,
  });
  console.log('Costpoint mock listening on port ' + mock.port);
  console.log("COSTPOINT_URL='" + mock.url + "' COSTPOINT_USERNAME=mock COSTPOINT_PASSWORD=mock COSTPOINT_DIRECT=true");
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { createMockServer };
