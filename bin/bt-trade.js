#!/usr/bin/env node
/**
 * Interactive example CLI using the `bt-trade` module.
 *
 * Flow: prompt for credentials → log in (with SMS prompt) → main menu.
 * The menu is a thin wrapper — its real purpose is to demonstrate how to
 * call each module endpoint from application code.
 *
 * Run:
 *   node bin/bt-trade.js
 *   BT_USER=M101021BR BT_PASS='...' node bin/bt-trade.js
 *   node bin/bt-trade.js --debug
 */

import readline from 'node:readline/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BTTradeClient, stdinOtpProvider, ntfyOtpProvider, BTTradeError, AuthError } from '../src/index.js';

const DEBUG = process.argv.includes('--debug');
const SESSION_FILE = path.join(os.tmpdir(), 'bt-trade-session.json');

// Selects the OTP provider. Defaults to ntfy.sh (stable, phone-shortcut
// friendly). The topic is either:
//   - the value of --ntfy-topic <slug>
//   - the BT_NTFY_TOPIC env var
//   - derived deterministically from the username (default)
// Pass --otp-stdin to fall back to terminal entry.
function pickOtpMode() {
  if (process.argv.includes('--otp-stdin')) return { mode: 'stdin' };
  const i = process.argv.indexOf('--ntfy-topic');
  const explicit = (i >= 0 && process.argv[i + 1]) || process.env.BT_NTFY_TOPIC || null;
  return { mode: 'ntfy', topic: explicit };
}
const log = DEBUG
  ? (tag, data) => console.error('[' + tag + ']', typeof data === 'string' ? data : JSON.stringify(data).slice(0, 300))
  : undefined;

// ---------- prompt helpers ----------

let _rl = null;
function rl() {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
function closeRl() { if (_rl) { _rl.close(); _rl = null; } }

async function ask(q) { return (await rl().question(q)).trim(); }

async function askHidden(q) {
  // We need raw mode for hidden input, so we fully detach readline for this prompt.
  closeRl();
  process.stdout.write(q);
  let buf = '';
  const stdin = process.stdin;
  stdin.setRawMode && stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    const onData = (ch) => {
      switch (ch) {
        case '\n': case '\r': case '\u0004':
          stdin.setRawMode && stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          break;
        case '\u0003': process.exit(130);
        case '\u007f': if (buf.length) buf = buf.slice(0, -1); break;
        default: buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ---------- output helpers ----------

function heading(s) { console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 60 - s.length))); }
function warn(label, err) {
  if (err instanceof BTTradeError) {
    console.error(`  [${err.code}${err.status ? ' ' + err.status : ''}] ${label}: ${err.message}`);
  } else {
    console.error(`  [error] ${label}: ${err.message || err}`);
  }
}
function dump(x) { console.log(JSON.stringify(x, null, 2)); }

// ---------- menus ----------

async function menu(title, items) {
  while (true) {
    console.log('\n' + title);
    items.forEach((it, i) => console.log(`  [${i + 1}] ${it.label}`));
    const raw = await ask('> ');
    const idx = parseInt(raw, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= items.length) {
      console.log('  (pick a valid option)');
      continue;
    }
    const chosen = items[idx];
    if (chosen.back || chosen.quit) return chosen;
    try { await chosen.run(); }
    catch (e) { warn(chosen.label, e); }
  }
}

function mainMenu(client, ctx) {
  return menu('MAIN MENU', [
    { label: 'View profile',             run: () => doProfile(client) },
    { label: 'View markets (exchanges)', run: async () => { heading('Exchanges'); dump(await client.markets.listExchanges()); } },
    { label: 'View accounts',            run: () => doAccounts(client, ctx) },
    { label: 'Portfolio...',             run: () => portfolioMenu(client, ctx) },
    { label: 'Orders...',                run: () => ordersMenu(client, ctx) },
    { label: 'Reference data...',        run: () => referenceMenu(client) },
    { label: 'Refresh token now',        run: () => doRefresh(client) },
    { label: 'Logout',                   quit: 'logout' },
    { label: 'Quit without logout',      quit: 'quit' },
  ]);
}

function referenceMenu(client) {
  return menu('REFERENCE DATA', [
    { label: 'Currencies',                run: async () => { heading('Currencies');          dump(await client.reference.listCurrencies()); } },
    { label: 'Evaluation currencies',     run: async () => { heading('Evaluation cur.');     dump(await client.reference.listEvaluationCurrencies()); } },
    { label: 'Account types',             run: async () => { heading('Account types');      dump(await client.reference.listAccountTypes()); } },
    { label: 'Order statuses',            run: async () => { heading('Order statuses');     dump(await client.reference.listOrderStatuses()); } },
    { label: 'Trade operations',          run: async () => { heading('Trade operations');    dump(await client.reference.listTradeOperations()); } },
    { label: 'Trade types',               run: async () => { heading('Trade types');         dump(await client.reference.listTradeTypes()); } },
    { label: 'Portfolio intervals',       run: async () => { heading('Portfolio intervals'); dump(await client.reference.listPortfolioIntervals()); } },
    { label: 'Go back',                   back: true },
  ]);
}

function portfolioMenu(client, ctx) {
  return menu('PORTFOLIO', [
    { label: 'Balance',                   run: async () => { const k = await ensurePortfolio(client, ctx); const c = await ensureCurrency(client, ctx); heading('Balance');      dump(await client.portfolio.getBalance({ portfolioKey: k, currencyId: c })); } },
    { label: 'Balance info',              run: async () => { const k = await ensurePortfolio(client, ctx); const c = await ensureCurrency(client, ctx); heading('Balance info'); dump(await client.portfolio.getBalanceInfo({ portfolioKey: k, currencyId: c })); } },
    { label: 'Positions (snapshot)',      run: async () => { const k = await ensurePortfolio(client, ctx); heading('Positions');            dump(await client.portfolio.listPositions({ portfolioKey: k })); } },
    { label: 'Bank accounts',             run: async () => { const k = await ensurePortfolio(client, ctx); heading('Bank accounts');        dump(await client.portfolio.getBankAccounts({ portfolioKey: k })); } },
    { label: 'Account transfers',         run: async () => { const k = await ensurePortfolio(client, ctx); heading('Account transfers');    dump(await client.portfolio.getAccountsTransfer({ portfolioKey: k })); } },
    { label: 'Switch active account',     run: async () => { await chooseAccount(client, ctx); } },
    { label: 'Switch evaluation currency',run: async () => { await chooseCurrency(client, ctx); } },
    { label: 'Go back',                   back: true },
  ]);
}

function ordersMenu(client, ctx) {
  return menu('ORDERS', [
    { label: 'Search (all)',              run: async () => { const k = await ensurePortfolio(client, ctx); heading('Orders (all)');       dump(await client.orders.search({ portfolioKey: k })); } },
    { label: 'Search by date range',      run: async () => {
        const k = await ensurePortfolio(client, ctx);
        const startDate = await ask('start date YYYY-MM-DD (blank = none): ');
        const endDate   = await ask('end date   YYYY-MM-DD (blank = today): ');
        heading('Orders filtered');
        dump(await client.orders.search({ portfolioKey: k, startDate: startDate || null, endDate: endDate || null }));
      } },
    { label: 'Get one order',             run: async () => { const n = await ask('orderNumber: '); heading('Order ' + n); dump(await client.orders.get(n)); } },
    { label: 'Get order actions',         run: async () => { const n = await ask('orderNumber: '); heading('Actions ' + n); dump(await client.orders.getActions(n)); } },
    { label: 'Get order history',         run: async () => { const n = await ask('orderNumber: '); heading('History ' + n); dump(await client.orders.getHistory(n)); } },
    { label: 'Go back',                   back: true },
  ]);
}

// ---------- actions ----------

async function doProfile(client) {
  heading('Profile');
  const p = await client.profile.get();
  console.log('Display name :', p.displayName);
  console.log('User ID      :', p.userID || p.id);
  console.log('Language     :', p.language);
  console.log('Theme        :', p.theme);
  console.log('Last login   :', p.lastLogin);
  console.log('Server time  :', p.serverTime);
  console.log('Landing page :', p.landingPage);
  console.log(`Clients      : ${p.clients ? p.clients.length : 0}`);
}

async function doAccounts(client, ctx) {
  heading('Accounts');
  const accounts = await client.accounts.list();
  ctx.accounts = accounts;
  accounts.forEach((a, i) => {
    const star = a.selected ? '★' : ' ';
    const active = ctx.activePortfolioKey === a.portfolioKey ? ' (active)' : '';
    console.log(` ${star} [${i + 1}] ${a.displayName || '(no name)'}  —  ${a.relation || ''}${active}`);
    console.log(`       id=${a.id}`);
    console.log(`       portfolioKey=${a.portfolioKey}`);
    console.log(`       flags: trading=${a.allowTrading} topup=${a.allowTopUp} view=${a.allowView} edit=${a.allowEdit} update=${a.allowUpdate}`);
  });
  if (!ctx.activePortfolioKey) {
    const sel = accounts.find((a) => a.selected) || accounts[0];
    if (sel) { ctx.activePortfolioKey = sel.portfolioKey; console.log(`\n(auto-selected ${sel.displayName} as active account)`); }
  }
}

async function chooseAccount(client, ctx) {
  if (!ctx.accounts) await doAccounts(client, ctx);
  if (!ctx.accounts || !ctx.accounts.length) return;
  const raw = await ask(`pick account [1-${ctx.accounts.length}]: `);
  const idx = parseInt(raw, 10) - 1;
  if (idx >= 0 && idx < ctx.accounts.length) {
    ctx.activePortfolioKey = ctx.accounts[idx].portfolioKey;
    console.log(`active account set to ${ctx.accounts[idx].displayName}`);
  }
}

async function ensurePortfolio(client, ctx) {
  if (!ctx.activePortfolioKey) await doAccounts(client, ctx);
  if (!ctx.activePortfolioKey) throw new Error('no active account selected');
  return ctx.activePortfolioKey;
}

/**
 * Balances need a currency for evaluation. Each portfolio carries its own
 * supported `currencies[]` (the web app picks `portfolios[0].currencies[0].id`).
 * If the user has explicitly chosen one for this session, use that instead.
 */
async function ensureCurrency(client, ctx) {
  if (ctx.currencyId) return ctx.currencyId;
  if (!ctx.accounts) await doAccounts(client, ctx);
  const active = ctx.accounts.find((a) => a.portfolioKey === ctx.activePortfolioKey)
    || ctx.accounts.find((a) => a.selected) || ctx.accounts[0];
  const id = client.accounts.defaultCurrencyId(active);
  if (id != null) {
    ctx.currencyId = id;
    return id;
  }
  // Last resort: ask the user from the global evaluation list.
  console.log('No portfolio-specific currency found for the active account.');
  await chooseCurrency(client, ctx);
  if (!ctx.currencyId) throw new Error('cannot determine a currencyId');
  return ctx.currencyId;
}

async function chooseCurrency(client, ctx) {
  // Prefer the currencies the ACTIVE portfolio actually supports — picking
  // from the global list often yields 422 ("not available on this portfolio").
  if (!ctx.accounts) await doAccounts(client, ctx);
  const active = ctx.accounts.find((a) => a.portfolioKey === ctx.activePortfolioKey)
    || ctx.accounts.find((a) => a.selected) || ctx.accounts[0];
  let list = (active && active.portfolios && active.portfolios[0] && active.portfolios[0].currencies) || [];
  let source = "active portfolio's currencies";
  if (!list.length) {
    list = await client.reference.listEvaluationCurrencies();
    source = 'evaluation currencies (global)';
  }
  if (!Array.isArray(list) || !list.length) { console.log('no currencies available'); return; }
  console.log(`From: ${source}`);
  list.forEach((c, i) => {
    const mark = c.id === ctx.currencyId ? '★' : ' ';
    console.log(` ${mark} [${i + 1}] id=${c.id}  ${c.name || c.description || ''}`);
  });
  const raw = await ask(`pick currency [1-${list.length}]: `);
  const idx = parseInt(raw, 10) - 1;
  if (idx >= 0 && idx < list.length) {
    ctx.currencyId = list[idx].id;
    console.log('active currency set to id=' + ctx.currencyId);
  }
}

/**
 * "RIPA BOGDAN-CONSTANTIN" -> "Bogdan Ripa"
 *
 * Romanian civil register lists surname first. We take the first given name
 * (ignoring hyphenated second names), title-case it, and pair it with the
 * surname. Returns '' on anything unexpected.
 */
function formatRomanianName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return tokens.length === 1 ? titleCase(tokens[0]) : '';
  const surname = tokens[0];
  const firstGiven = tokens.slice(1).join(' ').split('-')[0];
  return `${titleCase(firstGiven)} ${titleCase(surname)}`;
}

function titleCase(s) {
  return String(s).toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
}

async function doRefresh(client) {
  heading('Refreshing access token');

  const before = client.toSnapshot();
  const oldRefreshTail = before?.refreshToken ? before.refreshToken.slice(-8) : '(none)';
  const oldAccessTail  = before?.accessToken  ? before.accessToken.slice(-8)  : '(none)';
  const oldExp         = before?.expiresAt ? new Date(before.expiresAt).toISOString() : '(unknown)';

  console.log('Before:');
  console.log('  access_token  fingerprint:', oldAccessTail);
  console.log('  refresh_token fingerprint:', oldRefreshTail);
  console.log('  access expires:           ', oldExp);

  await client.auth.refresh();

  const after = client.toSnapshot();
  const newRefreshTail = after?.refreshToken ? after.refreshToken.slice(-8) : '(none)';
  const newAccessTail  = after?.accessToken  ? after.accessToken.slice(-8)  : '(none)';
  const newExp         = after?.expiresAt ? new Date(after.expiresAt).toISOString() : '(unknown)';
  const rotated        = oldRefreshTail !== newRefreshTail;
  const accessRotated  = oldAccessTail  !== newAccessTail;

  console.log('\nAfter:');
  console.log('  access_token  fingerprint:', newAccessTail,  accessRotated ? '(ROTATED)' : '(unchanged)');
  console.log('  refresh_token fingerprint:', newRefreshTail, rotated ? '(ROTATED — server returned a new one)' : '(UNCHANGED — server reused same one, so single-use is unlikely)');
  console.log('  access expires:           ', newExp);

  if (accessRotated && !rotated) {
    console.log('\nDiagnostic: refresh-token appears NOT to rotate. Single-use refresh tokens are unlikely to be the cause of a later invalid_grant.');
  } else if (rotated) {
    console.log('\nDiagnostic: refresh-token was rotated. If you run a second Refresh immediately and it fails with invalid_grant, rotation is the cause and this CLI is saving the new one correctly.');
  }
}

// ---------- main ----------

// Session persistence adapter — CLI-only, module stays filesystem-free.
function loadSavedSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const snap = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!snap || !snap.accessToken || !snap.refreshToken) return null;
    return snap;
  } catch (e) {
    if (DEBUG) console.error('[saved-session] read failed:', e.message);
    return null;
  }
}
function saveSession(snap) {
  try {
    if (snap) fs.writeFileSync(SESSION_FILE, JSON.stringify(snap, null, 2), { mode: 0o600 });
    else try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
  } catch (e) {
    console.error('[warn] could not update session file:', e.message);
  }
}

async function main() {
  console.log('bt-trade interactive example\n');

  const otpMode = pickOtpMode();
  if (otpMode.mode === 'ntfy') {
    if (otpMode.topic) console.log(`OTP delivery: ntfy.sh topic "${otpMode.topic}"`);
    else console.log(`OTP delivery: ntfy.sh (topic will be derived from username)`);
  } else {
    console.log('OTP delivery: terminal (stdin)');
  }

  const client = new BTTradeClient({
    otpProvider: otpMode.mode === 'ntfy'
      ? ntfyOtpProvider({ topic: otpMode.topic || undefined, log })
      : stdinOtpProvider(),
    log,
    onSessionChange: saveSession,   // persists after login / refresh / logout
  });

  const saved = loadSavedSession();
  let usedSaved = false;

  if (saved) {
    console.log(`Saved session found for ${saved.username}`);
    console.log(`  (access token expired ${accessAge(saved.expiresAt)}; refresh token will be validated)`);
    const choice = (await ask('  [1] use saved session   [2] log in fresh   > ')).trim();
    if (choice === '' || choice === '1') {
      try {
        client.restore(saved);
        await client.auth.refresh();     // proves the refresh_token still works
        usedSaved = true;
        console.log('Saved session restored.');
      } catch (e) {
        saveSession(null);
        if (e instanceof BTTradeError) {
          console.log(`Saved session no longer valid (${e.code}${e.status ? ' ' + e.status : ''}) — falling back to fresh login.`);
        } else throw e;
      }
    } else {
      saveSession(null);
      console.log('Discarded saved session.');
    }
  }

  if (!usedSaved) {
    const username = process.env.BT_USER || await ask('Username: ');
    const password = process.env.BT_PASS || await askHidden('Password: ');
    console.log('\nLogging in...');
    await client.login({ username, password });
  }

  const snap = client.toSnapshot();
  const ctx = { accounts: null, activePortfolioKey: null, profile: null, currencyId: null };

  // Friendly greeting — real name lives in profile.clients[0].displayName.
  try {
    ctx.profile = await client.profile.get();
    const raw = ctx.profile?.clients?.[0]?.displayName || '';
    const friendly = formatRomanianName(raw);
    if (friendly) console.log(`\nHi there, ${friendly}! 👋`);
  } catch (_) { /* greeting never blocks */ }

  console.log(`Token expires in ~${Math.round((snap.expiresAt - Date.now()) / 1000)}s.`);
  const outcome = await mainMenu(client, ctx);

  if (outcome.quit === 'logout') {
    console.log('\nLogging out...');
    try { await client.logout(); console.log('Logged out; saved session cleared.'); }
    catch (e) { warn('logout', e); saveSession(null); }
  } else {
    console.log('\nSession kept alive (saved for next launch).');
  }
  closeRl();
}

function accessAge(expiresAt) {
  if (!expiresAt) return 'unknown';
  const diff = Date.now() - expiresAt;
  if (diff < 0) return `in ${Math.round(-diff / 1000)}s`;
  const mins = Math.round(diff / 60000);
  return mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins/60)}h ago` : `${Math.round(mins/1440)}d ago`;
}

main().catch((e) => {
  if (e instanceof BTTradeError) {
    console.error(`Fatal: ${e.code}${e.status ? ' ' + e.status : ''} — ${e.message}`);
    if (DEBUG && e.body) console.error(e.body);
  } else {
    console.error('Fatal:', e);
  }
  closeRl();
  process.exit(1);
});
