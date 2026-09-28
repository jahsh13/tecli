#!/usr/bin/env node
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const moment = require("moment");
const Costpoint = require("./costpoint");
const DirectClient = require("./direct");
const { normalizeTimesheetStatus } = require("./timesheet-status");
const { COMMON_CODES } = require("./charge-codes");
const { getCredentials } = require("./credentials");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const creds = getCredentials();
if (!creds) {
  console.error("No credentials found. Run `te login` to set up.");
  process.exit(1);
}
if (!creds.useDirect && !creds.system) {
  console.error(
    "COSTPOINT_SYSTEM is required when not using direct mode. Set COSTPOINT_DIRECT=true for direct protocol."
  );
  process.exit(1);
}

const { url, username, password, system, useDirect } = creds;

// Periods: 0 = active week, 1 = previous week (parent K0 row index)
const WEEK_PERIOD = { active: 0, prev: 1 };

// A previous-week session is launched fresh and moved to its period before
// anything else runs on it (same rule as signing, see signTimesheet()).
async function launchClient(period = 0) {
  if (useDirect) {
    if (period === 0) {
      return DirectClient.launch(url, username, password, { loadPreviousPeriod: true });
    }
    const cp = await DirectClient.launch(url, username, password);
    try {
      await cp.selectPeriod(period);
    } catch (e) {
      try { await cp.close(); } catch (e2) { /* ignore */ }
      throw e;
    }
    return cp;
  }
  if (period !== 0) {
    throw new Error("Editing the previous week requires direct mode (COSTPOINT_DIRECT=true)");
  }
  return Costpoint.launch(url, username, password, system);
}

// Persistent session management — reuse one client across operations.
// The session is bound to one period; asking for another relaunches it.
let activeClient = null;
let activeClientPeriod = 0;
let clientIdleTimer = null;
const CLIENT_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

async function getClient(period = 0) {
  if (clientIdleTimer) clearTimeout(clientIdleTimer);

  if (activeClient && activeClientPeriod !== period) {
    await releaseClient();
  }

  if (!activeClient) {
    console.log(`Creating new Costpoint session (period ${period})...`);
    activeClient = await launchClient(period);
    activeClientPeriod = period;
    console.log('Session established.');
  } else {
    console.log('Reusing existing Costpoint session.');
  }

  clientIdleTimer = setTimeout(releaseClient, CLIENT_IDLE_TIMEOUT);
  return activeClient;
}

async function releaseClient() {
  if (clientIdleTimer) {
    clearTimeout(clientIdleTimer);
    clientIdleTimer = null;
  }
  if (activeClient) {
    try { await activeClient.close(); } catch (e) { /* ignore */ }
    activeClient = null;
    console.log('Costpoint session released.');
  }
}

function isSessionError(e) {
  const msg = (e.message || '').toLowerCase();
  return msg.includes('session') || msg.includes('not valid') ||
         msg.includes('econnreset') || msg.includes('econnrefused') ||
         msg.includes('socket hang up') || msg.includes('onservletexception');
}

async function withClient(fn, period = 0) {
  try {
    return await fn(await getClient(period));
  } catch (e) {
    if (isSessionError(e)) {
      console.log('Session error, retrying with fresh login:', e.message);
      await releaseClient();
      return await fn(await getClient(period));
    }
    throw e;
  }
}

// Cache file location — stores per-week data keyed by week start date
const CACHE_FILE = path.join(os.homedir(), ".costpoint-cache.json");

// In-memory state
let cachedWeeks = {}; // { "2026-04-06": weekData, ... }
let activeWeekStart = null; // fullDate of the most recently fetched week
let pendingChanges = new Map(); // key: "week-line-day", value: { week, line, day, hours, comment }
let pendingRevisionWeek = null; // week whose save is waiting on a revision explanation
let isProcessing = false;
let lastError = null;
let syncStatus = "idle"; // idle, loading, syncing, error
let isFetchingInitialData = false;
const VALID_PAY_TYPES = new Set(["EWW", "RHB", "LWD", "REG"]);

// Get the week start date string from week data
function weekStartKey(weekData) {
  if (!weekData || !weekData.dates || weekData.dates.length === 0) return null;
  return weekData.dates[0].fullDate;
}

// Store fetched week data into the cache without changing the active week
function cacheWeek(weekData) {
  const key = weekStartKey(weekData);
  if (key) cachedWeeks[key] = weekData;
  return key;
}

// Store the active week's data into the cache
function storeWeekData(weekData) {
  const key = cacheWeek(weekData);
  if (key) activeWeekStart = key;
}

// Cache a session's data under the week it belongs to
function storeClientData(cp, week) {
  if (week === 'active') storeWeekData(cp.getData());
  else cacheWeek(cp.getData());
}

function getPrevWeekData() {
  const activeWeek = getActiveWeekData();
  if (!activeWeek) return null;
  const prevKey = moment(activeWeek.dates[0].fullDate).subtract(7, 'days').format('YYYY-MM-DD');
  return cachedWeeks[prevKey] || null;
}

function getWeekData(week) {
  return week === 'prev' ? getPrevWeekData() : getActiveWeekData();
}

// Build the merged 2-week view from cached data: week1 = previous week
// (parent row 1), week2 = active week (parent row 0)
function getMergedData() {
  const activeWeek = getActiveWeekData();
  if (!activeWeek) return null;
  const prevWeek = getPrevWeekData();

  // Build 14-day date array: prev week + active week
  const week1Start = moment(activeWeek.dates[0].fullDate).subtract(7, 'days');
  const allDates = [];
  for (let i = 0; i < 14; i++) {
    const d = week1Start.clone().add(i, 'days');
    allDates.push({
      date: d.date(),
      fullDate: d.format('YYYY-MM-DD'),
      dayOfWeek: d.format('ddd'),
    });
  }

  // Merge projects from both weeks by code+payType
  const projectMap = new Map();

  function addProjects(weekData, week) {
    if (!weekData) return;
    for (const p of weekData.projects) {
      const key = `${p.code || ''}|${p.payType || ''}`;
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          code: p.code,
          description: p.description,
          payType: p.payType,
          hours: {},
          comments: {},
          lines: {},
        });
      }
      const merged = projectMap.get(key);
      // Prefer the longer description
      if (p.description && p.description.length > (merged.description || '').length) {
        merged.description = p.description;
      }
      Object.assign(merged.hours, p.hours);
      if (p.comments) Object.assign(merged.comments, p.comments);
      merged.lines[week] = p.line;
    }
  }

  addProjects(prevWeek, 'prev');
  addProjects(activeWeek, 'active');

  // Assign sequential line numbers for the merged view
  const projects = Array.from(projectMap.values()).map((p, i) => ({
    line: i,
    code: p.code,
    description: p.description,
    payType: p.payType,
    hours: p.hours,
    comments: p.comments,
    activeLine: p.lines.active,
    prevLine: p.lines.prev,
  }));

  function weekInfo(weekData, week, dates) {
    const statusMeta = weekData
      ? normalizeTimesheetStatus(weekData.timesheetStatusCode || weekData.timesheetStatus)
      : null;
    return {
      week,
      startDate: dates[0].fullDate,
      endDate: dates[6].fullDate,
      isActive: week === 'active',
      // Previous-week edits need the direct client (selectPeriod)
      isEditable: !!weekData && weekData.editable !== false && (week === 'active' || useDirect),
      statusLabel: statusMeta ? statusMeta.label : null,
      statusTone: statusMeta ? statusMeta.tone : null,
    };
  }

  return {
    dates: allDates,
    projects,
    activeDates: activeWeek.dates.map(d => d.fullDate),
    timesheetStatus: activeWeek.timesheetStatus,
    timesheetStatusCode: activeWeek.timesheetStatusCode,
    weeks: [
      weekInfo(prevWeek, 'prev', allDates.slice(0, 7)),
      weekInfo(activeWeek, 'active', allDates.slice(7)),
    ],
  };
}

// Get the active week data (raw, for API/save operations)
function getActiveWeekData() {
  return activeWeekStart ? cachedWeeks[activeWeekStart] : null;
}

// Load cache from disk on startup
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      // Support old single-week format: migrate to multi-week
      if (parsed && parsed.dates && Array.isArray(parsed.dates)) {
        const key = weekStartKey(parsed);
        if (key) {
          cachedWeeks = { [key]: parsed };
          activeWeekStart = key;
          console.log("Migrated single-week cache to multi-week format");
          saveCache();
          return true;
        }
      }
      // New multi-week format
      if (parsed && parsed.weeks) {
        cachedWeeks = parsed.weeks;
        activeWeekStart = parsed.activeWeekStart || null;
        console.log("Loaded multi-week cache (" + Object.keys(cachedWeeks).length + " weeks)");
        return true;
      }
    }
  } catch (e) {
    console.error("Failed to load cache:", e.message);
  }
  return false;
}

// Save cache to disk
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      weeks: cachedWeeks,
      activeWeekStart,
    }, null, 2));
  } catch (e) {
    console.error("Failed to save cache:", e.message);
  }
}

// Save all pending changes to Costpoint, one session per week: active week
// first, then the previous week. Each week's changes leave pendingChanges
// once saved. A week that needs a revision explanation stops the run;
// saveWithExplanation() finishes it and resumes with the rest.
async function saveAllChanges() {
  if (isProcessing || pendingChanges.size === 0) return { success: true, message: "No changes to save" };

  isProcessing = true;
  syncStatus = "syncing";
  const total = pendingChanges.size;

  try {
    for (const week of Object.keys(WEEK_PERIOD)) {
      const changes = Array.from(pendingChanges.values()).filter(c => c.week === week);
      if (changes.length === 0) continue;
      try {
        await withClient(async (cp) => {
          await cp.setm(changes);
          await cp.save();
          storeClientData(cp, week);
          saveCache();
        }, WEEK_PERIOD[week]);
      } catch (e) {
        if (e.name === 'RevisionRequiredError') {
          pendingRevisionWeek = week;
          syncStatus = "idle";
          return { revisionRequired: true, week, auditDetails: e.auditDetails };
        }
        throw e;
      }
      clearPendingWeek(week);
    }

    lastError = null;
    syncStatus = "idle";
    return { success: true, message: `Saved ${total} changes` };
  } catch (e) {
    console.error("Save failed:", e.message);
    lastError = e.message;
    syncStatus = "error";
    throw e;
  } finally {
    isProcessing = false;
  }
}

function clearPendingWeek(week) {
  for (const [key, change] of pendingChanges) {
    if (change.week === week) pendingChanges.delete(key);
  }
}

async function saveWithExplanation(explanation) {
  if (isProcessing) throw new Error("Another operation is in progress");
  if (!pendingRevisionWeek) throw new Error("No save is waiting on a revision explanation");

  isProcessing = true;
  syncStatus = "syncing";
  const week = pendingRevisionWeek;

  try {
    // Same period as the save that asked for it, so this reuses that session
    await withClient(async (cp) => {
      await cp.saveWithExplanation(explanation);
      storeClientData(cp, week);
      saveCache();
    }, WEEK_PERIOD[week]);

    clearPendingWeek(week);
    pendingRevisionWeek = null;
    lastError = null;
    syncStatus = "idle";
  } catch (e) {
    console.error("Save with explanation failed:", e.message);
    lastError = e.message;
    syncStatus = "error";
    throw e;
  } finally {
    isProcessing = false;
  }

  // Save the other week's changes, if any are still pending
  const rest = await saveAllChanges();
  if (rest.revisionRequired) return rest;
  return { success: true, message: "Saved with revision explanation" };
}

// Add a project to the timesheet
async function addProject(code, payType) {
  if (isProcessing) throw new Error("Another operation is in progress");

  isProcessing = true;
  syncStatus = "syncing";

  try {
    await withClient(async (cp) => {
      await cp.add(code, payType);
      await cp.save();
      storeWeekData(cp.getData());
      saveCache();
    });

    lastError = null;
    syncStatus = "idle";
    return { success: true };
  } catch (e) {
    console.error("Add project failed:", e.message);
    lastError = e.message;
    syncStatus = "error";
    throw e;
  } finally {
    isProcessing = false;
  }
}

// Sign the timesheet
//
// Signing requires a fresh session (launch → sign, nothing between). On a
// session that has done other work the server silently ignores the
// ACTION_CD='S' transition (the request round-trips cleanly but the
// timesheet stays unsigned; see CLAUDE.md). Release the persistent client
// and launch a fresh single-period session just for the sign.
async function signTimesheet() {
  if (isProcessing) throw new Error("Another operation is in progress");

  isProcessing = true;
  syncStatus = "syncing";

  try {
    await releaseClient();
    const cp = useDirect
      ? await DirectClient.launch(url, username, password)
      : await Costpoint.launch(url, username, password, system);
    try {
      await cp.sign();
      storeWeekData(cp.getData());
      saveCache();
    } finally {
      try { await cp.close(); } catch (e) { /* ignore */ }
    }

    lastError = null;
    syncStatus = "idle";
    return { success: true };
  } catch (e) {
    console.error("Sign failed:", e.message);
    lastError = e.message;
    syncStatus = "error";
    throw e;
  } finally {
    isProcessing = false;
  }
}

// Fetch fresh data from Costpoint (both current and previous week)
async function fetchFreshData() {
  if (isProcessing) throw new Error("Another operation is in progress");

  isProcessing = true;
  syncStatus = "loading";

  try {
    // Release existing session — we want fresh data from server
    await releaseClient();
    pendingRevisionWeek = null;

    const cp = await getClient();

    // Store current week
    const currentWeek = cp.getData();
    storeWeekData(currentWeek);

    // Get previous period data without mutating client state (keeps
    // the session usable for subsequent save/sign operations)
    try {
      if (typeof cp.getPreviousPeriodData === 'function') {
        const otherWeek = cp.getPreviousPeriodData();
        if (otherWeek) cacheWeek(otherWeek);
      } else {
        // Fallback for Puppeteer client — uses navigateToPreviousPeriod
        await cp.navigateToPreviousPeriod();
        cacheWeek(cp.getData());
      }
    } catch (navErr) {
      console.error("Failed to fetch other period (non-fatal):", navErr.message);
    }

    activeWeekStart = weekStartKey(currentWeek);

    saveCache();
    lastError = null;
    syncStatus = "idle";
    return getActiveWeekData();
  } catch (e) {
    console.error("Failed to fetch fresh data:", e.message);
    lastError = e.message;
    syncStatus = "error";
    throw e;
  } finally {
    isProcessing = false;
  }
}

// Fetch data in background (non-blocking)
function fetchFreshDataInBackground() {
  if (isFetchingInitialData || isProcessing) return;

  isFetchingInitialData = true;
  syncStatus = "loading";

  fetchFreshData()
    .then(() => {
      console.log("Background fetch completed successfully");
    })
    .catch(e => {
      console.error("Background fetch failed:", e.message);
    })
    .finally(() => {
      isFetchingInitialData = false;
    });
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// HTML template rendering
function renderHTML(data, isLoading = false) {
  const hasData = data && data.dates && data.dates.length > 0;
  const periodStart = hasData ? data.dates[0] : null;
  const periodEnd = hasData ? data.dates[data.dates.length - 1] : null;
  const currentStatus = isLoading ? "loading" : syncStatus;
  const timesheetStatusMeta = hasData
    ? normalizeTimesheetStatus(data.timesheetStatusCode || data.timesheetStatus)
    : null;
  const timesheetStatusTitle = timesheetStatusMeta && timesheetStatusMeta.code
    ? `Raw status code: ${timesheetStatusMeta.code}`
    : "Raw status unavailable";

  const weeksInfo = hasData && data.weeks ? data.weeks.map((w, i) => {
    const dates = data.dates.slice(i * 7, i * 7 + 7);
    const start = moment(dates[0].fullDate);
    const end = moment(dates[6].fullDate);
    const label = start.month() === end.month()
      ? start.format('MMM D') + '\u2013' + end.format('D')
      : start.format('MMM D') + ' \u2013 ' + end.format('MMM D');
    return Object.assign({}, w, { label: label });
  }) : [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Str8 Outta Deltek</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="container">
    <header class="header">
      <img src="/deltek.png" alt="Str8 Outta Deltek" class="logo" />
      <div class="status-container">
        <div class="status-badges">
          <span id="sync-status" class="sync-dot sync-${currentStatus}" title="${currentStatus}"></span>
          ${timesheetStatusMeta ? `
          <span
            id="timesheet-status"
            class="status-badge timesheet-status-badge timesheet-status-${timesheetStatusMeta.tone}"
            title="${timesheetStatusTitle}"
          >
            ${timesheetStatusMeta.label}
          </span>
          ` : ""}
        </div>
        <button id="refresh-btn" class="btn btn-secondary btn-icon" title="Refresh from Costpoint">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
        <button id="clear-cache-btn" class="btn btn-secondary btn-icon" title="Clear cache">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/>
          </svg>
        </button>
      </div>
    </header>

    ${hasData ? `
    <div class="period-info">
      <span class="period-label">Period:</span>
      <span class="period-dates">${periodStart.dayOfWeek} ${periodStart.fullDate} - ${periodEnd.dayOfWeek} ${periodEnd.fullDate}</span>
    </div>

    <div id="thursday-nudge" class="thursday-nudge" style="display: none;">
      <span class="nudge-message"></span>
      <button id="nudge-copy-btn" class="btn btn-secondary btn-sm">Copy Thu &rarr; Fri</button>
    </div>

    <div class="timesheet-wrapper">
      <table class="timesheet" id="timesheet">
        <thead>
          <tr class="week-header-row">
            <th colspan="4" class="week-header-spacer"></th>
            ${weeksInfo.map(w => {
              const canSign = w.isActive && (w.statusTone === 'open' || w.statusTone === 'missing');
              return `<th colspan="7" class="week-header ${w.isEditable ? 'week-active' : 'week-inactive'}">
                <div class="week-header-content">
                  <span class="week-dates">${w.label}</span>
                  ${w.statusLabel ? `<span class="week-status-badge timesheet-status-${w.statusTone}">${w.statusLabel}</span>` : ''}
                  ${canSign ? '<button class="btn-copy-thu" title="Copy Thursday hours to Friday">Thu &rarr; Fri</button><button class="btn-week-sign">Sign</button>' : ''}
                </div>
              </th>`;
            }).join("")}
            <th class="week-header-spacer"></th>
          </tr>
          <tr>
            <th class="col-line">#</th>
            <th class="col-code">Code</th>
            <th class="col-desc">Description</th>
            <th class="col-pay">Pay</th>
            ${data.dates.map((d, i) => {
              const isWeekend = d.dayOfWeek === 'Sat' || d.dayOfWeek === 'Sun';
              return `<th class="col-day ${isWeekend ? 'col-weekend' : 'col-weekday'}${i === 6 ? ' week-divider' : ''}"><div class="day-header"><span class="day-name">${d.dayOfWeek}</span><span class="day-num">${d.date}</span></div></th>`;
            }).join("")}
            <th class="col-total">Total</th>
          </tr>
        </thead>
        <tbody>
          ${data.projects.map(project => `
          <tr data-line="${project.line}">
            <td class="col-line">${project.line}</td>
            <td class="col-code" title="${project.code || ''}">${project.code || ''}</td>
            <td class="col-desc" title="${project.description}">${project.description}</td>
            <td class="col-pay">${project.payType || ''}</td>
            ${data.dates.map((d, i) => {
              const hours = project.hours[d.date];
              const displayValue = hours !== null && hours !== undefined ? hours : "";
              const comment = (project.comments && project.comments[d.date]) || "";
              const escapedComment = comment.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
              const isWeekend = d.dayOfWeek === 'Sat' || d.dayOfWeek === 'Sun';
              const w = data.weeks[i < 7 ? 0 : 1];
              const periodLine = w.week === 'active' ? project.activeLine : project.prevLine;
              const isEditable = w.isEditable && periodLine != null;
              const disabled = !isEditable ? 'disabled' : '';
              return `<td class="col-day ${isWeekend ? 'col-weekend' : 'col-weekday'} ${!isEditable ? 'col-inactive' : ''}${i === 6 ? ' week-divider' : ''}"><div class="cell-wrap${comment ? ' has-comment' : ''}"${comment ? ` title="${escapedComment}"` : ''}><input type="text" class="hours-input ${!isEditable ? 'inactive' : ''}" data-line="${project.line}" data-week="${w.week}" data-period-line="${isEditable ? periodLine : ''}" data-day="${d.date}" data-fulldate="${d.fullDate}" data-comment="${escapedComment}" value="${displayValue}" ${disabled} /></div></td>`;
            }).join("")}
            <td class="col-total row-total">0</td>
          </tr>
          `).join("")}
        </tbody>
        <tfoot>
          <tr class="totals-row">
            <td class="col-line"></td>
            <td class="col-code"></td>
            <td class="col-desc">Daily Total</td>
            <td class="col-pay"></td>
            ${data.dates.map((d, i) => {
              const isWeekend = d.dayOfWeek === 'Sat' || d.dayOfWeek === 'Sun';
              return `<td class="col-day daily-total ${isWeekend ? 'col-weekend' : 'col-weekday'}${i === 6 ? ' week-divider' : ''}" data-day="${d.date}">0</td>`;
            }).join("")}
            <td class="col-total grand-total">0</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div class="actions">
      <button id="add-project-btn" class="btn btn-secondary">+ Add Project</button>
      <button id="favorites-btn" class="btn btn-secondary">Favorites</button>
      <button id="leave-bal-btn" class="btn btn-secondary">Leave Balances</button>
      <div class="actions-right">
        <span id="unsaved-indicator" class="unsaved-indicator" style="display: none;">Unsaved changes</span>
        <button id="save-btn" class="btn btn-success" disabled>Save</button>
      </div>
    </div>
    ` : `
    <div class="skeleton-period-info"><div class="skel-bone skel-w40"></div></div>
    <div class="timesheet-wrapper">
      <table class="timesheet skeleton-table">
        <thead>
          <tr class="week-header-row">
            <th colspan="4" class="week-header-spacer"></th>
            <th colspan="7" class="week-header"><div class="skel-bone skel-w60"></div></th>
            <th colspan="7" class="week-header"><div class="skel-bone skel-w60"></div></th>
            <th class="week-header-spacer"></th>
          </tr>
          <tr>
            <th class="col-line"><div class="skel-bone skel-w100"></div></th>
            <th class="col-code"><div class="skel-bone skel-w100"></div></th>
            <th class="col-desc"><div class="skel-bone skel-w80"></div></th>
            <th class="col-pay"><div class="skel-bone skel-w100"></div></th>
            ${Array.from({length: 14}, (_, i) => `<th class="col-day${i === 6 ? ' week-divider' : ''}"><div class="skel-bone-circle"></div></th>`).join('')}
            <th class="col-total"><div class="skel-bone skel-w100"></div></th>
          </tr>
        </thead>
        <tbody>
          ${Array.from({length: 6}, () => `<tr>
            <td class="col-line"><div class="skel-bone skel-w60"></div></td>
            <td class="col-code"><div class="skel-bone skel-w80"></div></td>
            <td class="col-desc"><div class="skel-bone skel-w70"></div></td>
            <td class="col-pay"><div class="skel-bone skel-w60"></div></td>
            ${Array.from({length: 14}, (_, i) => `<td class="col-day${i === 6 ? ' week-divider' : ''}"><div class="skel-bone skel-cell"></div></td>`).join('')}
            <td class="col-total"><div class="skel-bone skel-w60"></div></td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr class="totals-row">
            <td class="col-line"></td>
            <td class="col-code"></td>
            <td class="col-desc"><div class="skel-bone skel-w60"></div></td>
            <td class="col-pay"></td>
            ${Array.from({length: 14}, (_, i) => `<td class="col-day${i === 6 ? ' week-divider' : ''}"><div class="skel-bone skel-w60"></div></td>`).join('')}
            <td class="col-total"><div class="skel-bone skel-w80"></div></td>
          </tr>
        </tfoot>
      </table>
    </div>
    `}

    <div id="error-banner" class="error-banner" style="display: none;">
      <span id="error-message"></span>
      <button id="dismiss-error" class="btn-dismiss">&times;</button>
    </div>
  </div>

  <!-- Add Project Modal -->
  <div id="add-project-modal" class="modal" style="display: none;">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Add Project</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="quick-picks">
          <label>Common Leave Codes:</label>
          <div class="quick-pick-grid">
            ${COMMON_CODES.map(c =>
              `<button class="btn btn-quick-pick" data-code="${c.code}" data-paytype="${c.payType}"${c.note ? ` title="${c.note}"` : ""}>${c.label}</button>`
            ).join("\n            ")}
          </div>
        </div>
        <div class="modal-divider"><span>or enter manually</span></div>
        <div class="modal-field">
          <label for="project-code">Project Code:</label>
          <input type="text" id="project-code" placeholder="Enter project code..." />
        </div>
        <div class="modal-field">
          <label for="project-pay-type">Pay Type:</label>
          <select id="project-pay-type">
            <option value="REG" selected>REG</option>
            <option value="EWW">EWW</option>
            <option value="RHB">RHB</option>
            <option value="LWD">LWD</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="confirm-add-project">Add</button>
      </div>
    </div>
  </div>

  <!-- Sign Confirmation Modal -->
  <div id="sign-modal" class="modal" style="display: none;">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Sign Timesheet</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <p>Are you sure you want to sign this timesheet?</p>
        <p class="warning">This action cannot be undone.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="confirm-sign">Sign</button>
      </div>
    </div>
  </div>

  <!-- Favorites Modal -->
  <div id="favorites-modal" class="modal" style="display: none;">
    <div class="modal-content modal-wide">
      <div class="modal-header">
        <h2>Favorites</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body" id="favorites-modal-body">
        <p>Loading...</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-cancel">Close</button>
      </div>
    </div>
  </div>

  <!-- Leave Balances Modal -->
  <div id="leave-modal" class="modal" style="display: none;">
    <div class="modal-content modal-wide">
      <div class="modal-header">
        <h2>Leave Balances</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body" id="leave-modal-body">
        <p>Loading...</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-cancel">Close</button>
      </div>
    </div>
  </div>

  <script>
    window.TIMESHEET_DATA = ${hasData ? JSON.stringify(data) : 'null'};
    window.IS_LOADING = ${isLoading};
  </script>
  <script src="/app.js"></script>
</body>
</html>`;
}

// Routes
app.get("/", (req, res) => {
  const mergedData = getMergedData();
  const isLoading = !mergedData && isFetchingInitialData;
  res.send(renderHTML(mergedData, isLoading));
});

app.get("/api/status", (req, res) => {
  res.json({
    status: syncStatus,
    error: lastError,
    pendingChanges: pendingChanges.size,
    hasData: !!getActiveWeekData()
  });
});

app.get("/api/data", (req, res) => {
  const data = getMergedData();
  if (!data) {
    return res.status(404).json({ error: "No data cached" });
  }
  res.json(data);
});

// Resolve a cell edit request to { week, line } (week-local Costpoint line)
// or an error message
function resolveEditTarget(body) {
  const week = body.week || 'active';
  if (!(week in WEEK_PERIOD)) return { error: "Invalid week" };
  const merged = getMergedData();
  const weekInfo = merged && merged.weeks.find(w => w.week === week);
  if (!weekInfo || !weekInfo.isEditable) return { error: `The ${week === 'prev' ? 'previous' : 'active'} week is not editable` };
  if (body.periodLine === undefined || body.periodLine === '' || body.periodLine === null) {
    return { error: "This line does not exist in that week" };
  }
  return { week, line: parseInt(body.periodLine, 10) };
}

app.put("/api/hours", (req, res) => {
  const { day, hours } = req.body;
  const target = resolveEditTarget(req.body);
  if (target.error) return res.status(400).json({ error: target.error });

  if (day === undefined || hours === undefined) {
    return res.status(400).json({ error: "Missing required fields: day, hours" });
  }

  const { week, line } = target;
  const key = `${week}-${line}-${day}`;
  const hoursValue = hours === "" ? 0 : parseFloat(hours);
  const existing = pendingChanges.get(key);
  pendingChanges.set(key, { week, line, day, hours: hoursValue, comment: existing ? existing.comment : undefined });

  // Update the week's cache optimistically
  const weekData = getWeekData(week);
  const project = weekData && weekData.projects.find(p => p.line === line);
  if (project) {
    project.hours[day] = hours === "" ? null : parseFloat(hours);
  }

  res.json({ success: true, pendingCount: pendingChanges.size });
});

app.put("/api/comment", (req, res) => {
  const { day, comment } = req.body;
  const target = resolveEditTarget(req.body);
  if (target.error) return res.status(400).json({ error: target.error });

  if (day === undefined) {
    return res.status(400).json({ error: "Missing required field: day" });
  }

  const { week, line } = target;
  const key = `${week}-${line}-${day}`;
  const existing = pendingChanges.get(key);
  const weekData = getWeekData(week);
  const project = weekData && weekData.projects ? weekData.projects.find(p => p.line === line) : null;

  if (existing) {
    // Merge comment into existing hours change
    existing.comment = comment || undefined;
  } else {
    // Comment-only change — use current hours from cache
    const currentHours = project && project.hours ? (project.hours[day] || 0) : 0;
    pendingChanges.set(key, { week, line, day, hours: currentHours, comment: comment || undefined });
  }

  // Update cache optimistically
  if (project) {
    if (!project.comments) project.comments = {};
    project.comments[day] = comment || null;
  }

  res.json({ success: true, pendingCount: pendingChanges.size });
});

app.post("/api/save", async (req, res) => {
  try {
    const result = await saveAllChanges();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/save-with-explanation", async (req, res) => {
  const { explanation } = req.body;
  if (!explanation || !explanation.trim()) {
    return res.status(400).json({ error: "Revision explanation is required" });
  }
  try {
    const result = await saveWithExplanation(explanation.trim());
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/project", async (req, res) => {
  const { code, payType } = req.body;

  if (!code) {
    return res.status(400).json({ error: "Missing required field: code" });
  }

  const normalizedPayType = typeof payType === "string" && payType.trim()
    ? payType.trim().toUpperCase()
    : "REG";

  if (!VALID_PAY_TYPES.has(normalizedPayType)) {
    return res.status(400).json({ error: "Invalid pay type" });
  }

  try {
    await addProject(code, normalizedPayType);
    res.json({ success: true, data: getMergedData() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sign", async (req, res) => {
  try {
    await signTimesheet();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/refresh", async (req, res) => {
  try {
    await fetchFreshData();
    res.json({ success: true, data: getMergedData() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/leave", async (req, res) => {
  try {
    const result = await withClient(async (cp) => {
      return await cp.getLeaveBalances();
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/favorites", async (req, res) => {
  try {
    const result = await withClient(async (cp) => {
      return await cp.getFavorites();
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/cache", (req, res) => {
  try {
    cachedWeeks = {};
    activeWeekStart = null;
    pendingChanges.clear();
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }
    res.json({ success: true, message: "Cache cleared" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Initialize and start server — fetch fresh data immediately on boot
app.listen(PORT, () => {
  console.log(`Costpoint Web UI running at http://localhost:${PORT}`);
  console.log("Fetching data from Costpoint...");
  fetchFreshDataInBackground();
});
