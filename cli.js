#!/usr/bin/env node
"use strict";

const chalk = require("chalk");
const Table = require("cli-table");
const Costpoint = require("./costpoint");
const DirectClient = require("./direct");
const { program } = require("commander");
const readline = require("readline");
const ora = require("ora");
const { normalizeTimesheetStatus } = require("./timesheet-status");
const { getCredentials, login, logout } = require("./credentials");
const { COMMON_CODES, resolveAlias } = require("./charge-codes");

require("dotenv").config();

const { RevisionRequiredError } = DirectClient;

// ── Visual helpers ───────────────────────────────────────────────

function spin(text) {
  process.stdout.write(`  ${text}\r`);
  return ora({ text, color: "cyan", spinner: "dots" }).start();
}

function statusBadge(statusStr) {
  const { label, tone } = normalizeTimesheetStatus(statusStr);
  const colors = {
    approved: chalk.green,
    signed: chalk.cyan,
    open: chalk.yellow,
    missing: chalk.red,
    rejected: chalk.redBright.bold,
    processed: chalk.blue,
    unknown: chalk.gray,
  };
  return (colors[tone] || colors.unknown)(`● ${label}`);
}

// ── Core operation wrappers ──────────────────────────────────────

let _creds = null;

function requireCredentials() {
  if (_creds) return _creds;
  _creds = getCredentials();
  if (!_creds) {
    console.error(
      chalk.red("No credentials found. Run `te login` to set up."),
    );
    process.exit(1);
  }
  if (!_creds.useDirect && !_creds.system) {
    console.error(
      chalk.red(
        "COSTPOINT_SYSTEM is required when not using direct mode. Set COSTPOINT_DIRECT=true for direct protocol.",
      ),
    );
    process.exit(1);
  }
  return _creds;
}

function launchClient() {
  const { url, username, password, system, useDirect } = requireCredentials();
  if (useDirect) return DirectClient.launch(url, username, password);
  return Costpoint.launch(url, username, password, system);
}

async function connect() {
  const s = spin("Authenticating...");
  try {
    const cp = await launchClient();
    s.succeed("Authenticated");
    return cp;
  } catch (e) {
    s.fail("Authentication failed");
    throw e;
  }
}

async function askYesNo(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function saveWithSpinner(cp) {
  const s = spin("Saving...");
  try {
    await cp.save();
    s.succeed("Saved");
  } catch (e) {
    if (e.name !== "RevisionRequiredError") {
      s.fail("Save failed");
      throw e;
    }
    s.warn("Revision explanation required");

    if (e.auditDetails.length > 0) {
      console.log(chalk.dim("  Changes requiring explanation:"));
      for (const d of e.auditDetails) {
        console.log(
          chalk.dim(`    Line ${d.lineNo}: ${d.description} (${d.project})`),
        );
      }
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const explanation = await new Promise((resolve) => {
      rl.question(chalk.yellow("  Enter explanation: "), (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });

    if (!explanation) {
      throw new Error("Revision explanation is required. Save cancelled.");
    }

    const s2 = spin("Saving...");
    try {
      await cp.saveWithExplanation(explanation);
      s2.succeed("Saved");
    } catch (e2) {
      s2.fail("Save failed");
      throw e2;
    }
  }
}

function showStatus(cp) {
  const data = cp.getData();
  console.log(`\n  Status: ${statusBadge(data.timesheetStatus)}`);
}

// ── Commands ─────────────────────────────────────────────────────

program
  .name("te")
  .version(require("./package.json").version)
  .description("Time entry CLI for Costpoint.");

program
  .command("show")
  .description("show timesheet")
  .action(async () => {
    try {
      const cp = await connect();
      showStatus(cp);
      console.log();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("sign")
  .description("sign timesheet")
  .option("-y, --yes", "skip confirmation prompt")
  .action(async (options) => {
    try {
      const cp = await connect();
      showStatus(cp);
      console.log();
      cp.display();

      let shouldSign = options.yes;
      if (!shouldSign) {
        shouldSign = await askYesNo("\n  Sign this timesheet? (y/n): ");
      }

      if (shouldSign) {
        const s = spin("Signing...");
        try {
          await cp.sign();
          s.succeed("Signed");
        } catch (e) {
          s.fail("Signing failed");
          throw e;
        }
      } else {
        console.log(chalk.dim("  Signing cancelled."));
      }

      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("set <line> <day> <hours>")
  .description("set hours for given project line and day")
  .option("-c, --comment <text>", "comment for the cell (direct mode only)")
  .action(async (line, day, hours, options) => {
    const lineNum = parseInt(line, 10);
    const dayNum = parseInt(day, 10);
    const hrs = Number(hours);
    if (Number.isNaN(lineNum) || Number.isNaN(dayNum) || Number.isNaN(hrs)) {
      console.error(
        chalk.red("  Invalid arguments: line, day, and hours must be numeric."),
      );
      process.exit(1);
    }
    if (options.comment && !requireCredentials().useDirect) {
      console.error(
        chalk.red(
          "  --comment is only supported in direct mode (COSTPOINT_DIRECT=true).",
        ),
      );
      process.exit(1);
    }
    try {
      const cp = await connect();

      const s = spin(`Setting line ${lineNum}, day ${dayNum} → ${hrs}h...`);
      await cp.set(lineNum, dayNum, hrs, options.comment);
      s.succeed(`Line ${lineNum}, day ${dayNum} → ${hrs}h`);

      await saveWithSpinner(cp);
      showStatus(cp);
      console.log();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("setm <values...>")
  .description("set hours for multiple project lines and days")
  .usage("<line> <day> <hours>, <line> <day> <hours>, ...")
  .action(async (xs) => {
    xs = xs.map((x) => x.replace(/,/g, "")).filter(Boolean);

    if (xs.length % 3 !== 0) {
      console.error(
        chalk.red(
          "  Invalid input: values must be provided in groups of three (line day hours).",
        ),
      );
      process.exit(1);
    }

    for (let i = 0; i < xs.length; i += 3) {
      const line = parseInt(xs[i], 10);
      const day = parseInt(xs[i + 1], 10);
      const hours = Number(xs[i + 2]);
      if (Number.isNaN(line) || Number.isNaN(day) || Number.isNaN(hours)) {
        console.error(
          chalk.red(
            `  Invalid arguments at position ${i / 3 + 1}: line, day, and hours must be numeric.`,
          ),
        );
        process.exit(1);
      }
    }

    try {
      const cp = await connect();

      const count = xs.length / 3;
      const s = spin(`Updating ${count} cell${count > 1 ? "s" : ""}...`);
      for (let i = 0; i < xs.length; i += 3) {
        const line = parseInt(xs[i], 10);
        const day = parseInt(xs[i + 1], 10);
        const hours = Number(xs[i + 2]);
        await cp.set(line, day, hours);
        s.text = `Updating cells... (${i / 3 + 1}/${count})`;
      }
      s.succeed(`${count} cell${count > 1 ? "s" : ""} updated`);

      await saveWithSpinner(cp);
      showStatus(cp);
      console.log();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("add [code] [payType]")
  .description(
    "add project code to timesheet (pick from favorites if no code given)\n" +
    "  Shortcuts: " + COMMON_CODES.map(c => c.alias).join(", ") + "\n" +
    "  e.g. 'te add pto' → ZLEAVE.CMP (REG)",
  )
  .option("-f, --favorite", "also add the code to your Costpoint favorites")
  .action(async (code, payType, options) => {
    try {
      const cp = await connect();
      let fromFavorites = false;

      if (!code) {
        const picked = await pickFromFavorites(cp);
        if (!picked) { await cp.close(); return; }
        code = picked.code;
        fromFavorites = true;
        if (!payType) payType = picked.payType || undefined;
      } else {
        const alias = resolveAlias(code);
        if (alias) {
          if (!payType) payType = alias.payType;
          code = alias.code;
        }
      }

      const label = payType ? `${code} (${payType})` : code;
      const s = spin(`Adding ${label}...`);
      await cp.add(code, payType);
      s.succeed(`Added ${label}`);

      const wantFavorite = options.favorite ||
        (!fromFavorites && process.stdin.isTTY &&
          await askYesNo(`  Also add ${label} to your favorites? (y/N): `));
      if (wantFavorite) await addToFavoritesWithSpinner(cp);

      await saveWithSpinner(cp);
      showStatus(cp);
      console.log();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

async function addToFavoritesWithSpinner(cp) {
  const s = spin("Adding to favorites...");
  try {
    await cp.addToFavorites();
    s.succeed("Added to favorites");
  } catch (e) {
    s.warn(`Could not add to favorites: ${e.message}`);
  }
}

async function pickFromFavorites(cp) {
  const s = spin("Loading favorites...");
  const favs = await cp.getFavorites();
  s.succeed("Favorites loaded");
  console.log();

  if (favs.length === 0) {
    console.log(chalk.dim("  No favorites saved. Run 'te add <code>' or save favorites in the Costpoint web UI."));
    return null;
  }

  const t = new Table({
    head: [chalk.cyan("#"), chalk.cyan("Code"), chalk.cyan("Description"), chalk.cyan("Pay Type")],
  });
  favs.forEach((f, i) => t.push([i + 1, f.code, f.description || "", f.payType || ""]));
  console.log(t.toString());
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question(`  Pick favorite [1-${favs.length}] or Enter to cancel: `, resolve);
  });
  rl.close();

  const trimmed = (answer || "").trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > favs.length) {
    console.log(chalk.red(`  Invalid selection: ${trimmed}`));
    return null;
  }
  return favs[n - 1];
}

program
  .command("favorites")
  .alias("fav")
  .description("list favorite charge codes saved in Costpoint")
  .action(async () => {
    try {
      const cp = await connect();
      const s = spin("Loading favorites...");
      const favs = await cp.getFavorites();
      s.succeed("Favorites loaded");
      console.log();

      if (favs.length === 0) {
        console.log(chalk.dim("  No favorites found. Add them in the Costpoint web UI."));
      } else {
        const t = new Table({
          head: [chalk.cyan("#"), chalk.cyan("Code"), chalk.cyan("Description"), chalk.cyan("Pay Type")],
        });
        favs.forEach((f, i) => t.push([i, f.code, f.description || '', f.payType || '']));
        console.log(t.toString());
      }
      console.log();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("leave")
  .description("show leave balances")
  .action(async () => {
    try {
      const cp = await connect();

      const s = spin("Loading balances...");
      const { balances, details } = await cp.getLeaveBalances();
      s.succeed("Balances loaded");
      console.log();

      if (balances.length === 0) {
        console.log(chalk.dim("  No leave balances found."));
      } else {
        const balTable = new Table({
          head: [chalk.cyan("Leave Type"), chalk.cyan("Balance")],
          colAligns: ["left", "right"],
        });
        for (const b of balances) {
          balTable.push([b.description, b.balance.toFixed(4)]);
        }
        console.log(balTable.toString());
      }

      if (details.length > 0) {
        console.log(chalk.dim("\n  Recent Leave Activity:"));
        const detTable = new Table({
          head: [
            chalk.cyan("Date"),
            chalk.cyan("Type"),
            chalk.cyan("Hours"),
            chalk.cyan("Leave Type"),
          ],
          colAligns: ["left", "left", "right", "left"],
        });
        for (const d of details) {
          detTable.push([
            d.date,
            d.type,
            d.hours.toFixed(4),
            d.leaveTypeDesc || d.leaveTypeCode,
          ]);
        }
        console.log(detTable.toString());
      }

      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("server")
  .description("start the web UI")
  .action(() => {
    require("./server");
  });

program
  .command("tui")
  .description("start the interactive terminal UI")
  .action(() => {
    require("./tui");
  });

program
  .command("login")
  .description("store credentials in OS keychain")
  .action(async () => {
    try {
      const creds = await login();
      console.log(chalk.green(`\n  Credentials saved for ${creds.username}.`));
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("remove stored credentials")
  .action(() => {
    logout();
    console.log(chalk.green("  Credentials removed."));
  });

program.parse(process.argv);
