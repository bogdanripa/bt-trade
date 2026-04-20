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
 *   BT_USER=MYUSER BT_PASS='...' node bin/bt-trade.js
 *   node bin/bt-trade.js --debug
 */

import readline from 'node:readline/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BTTradeClient, stdinOtpProvider, ntfyOtpProvider, BTTradeError, AuthError } from '../src/index.js';

const DEBUG = process.argv.includes('--debug');
let DEMO  = process.argv.includes('--demo');
let SESSION_FILE;

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

/** Fallback: pretty-print raw JSON. */
function dump(x) { console.log(JSON.stringify(x, null, 2)); }

/**
 * Render an array of objects as an aligned text table.
 *
 * @param {object[]} rows
 * @param {Array<{key:string, label?:string, align?:'left'|'right', max?:number}>} [cols]
 *   Column specs. Omit to auto-detect from the first row's keys.
 */
function table(rows, cols) {
  if (!Array.isArray(rows) || rows.length === 0) { console.log('  (no rows)'); return; }

  if (!cols) {
    cols = Object.keys(rows[0]).map((k) => ({ key: k }));
  }

  const MAX_DEFAULT = 30;

  // Build string cells + measure widths.
  const headers = cols.map((c) => c.label ?? c.key);
  const widths  = headers.map((h) => h.length);
  const cells   = rows.map((row) =>
    cols.map((c, ci) => {
      const raw = c.format ? c.format(row[c.key], row) : row[c.key];
      let s;
      if (raw === null || raw === undefined) s = '';
      else if (typeof raw === 'number')      s = raw.toLocaleString('en', { maximumFractionDigits: 4 });
      else if (typeof raw === 'boolean')     s = raw ? 'yes' : 'no';
      else if (typeof raw === 'object')      s = JSON.stringify(raw);
      else                                   s = String(raw);
      const max = c.max ?? MAX_DEFAULT;
      if (s.length > max) s = s.slice(0, max - 1) + '…';
      widths[ci] = Math.max(widths[ci], s.length);
      return s;
    })
  );

  const pad = (s, w, align) =>
    align === 'right' ? s.padStart(w) : s.padEnd(w);

  const row2str = (rowCells) =>
    '  ' + rowCells.map((s, i) => pad(s, widths[i], cols[i].align ?? 'left')).join('  ');

  console.log(row2str(headers));
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  cells.forEach((r) => console.log(row2str(r)));
  console.log(`  (${rows.length} row${rows.length !== 1 ? 's' : ''})`);
}

/** Print a single object as aligned key: value lines. */
function kv(obj, keys) {
  const entries = keys
    ? keys.map((k) => [k, obj[k]])
    : Object.entries(obj);
  const maxLen = Math.max(...entries.map(([k]) => k.length));
  entries.forEach(([k, v]) => {
    const val = v === null || v === undefined ? '—'
      : typeof v === 'object' ? JSON.stringify(v)
      : String(v);
    console.log('  ' + k.padEnd(maxLen) + '  ' + val);
  });
}

// ---------- menus ----------

async function menu(title, items) {
  while (true) {
    console.log('\n' + (typeof title === 'function' ? title() : title));
    let menuIdx = 0;
    items.forEach((it) => {
      if (it.separator) { console.log('  ' + '─'.repeat(38)); return; }
      console.log(`  [${++menuIdx}] ${typeof it.label === 'function' ? it.label() : it.label}`);
    });
    const raw = await ask('> ');
    const idx = parseInt(raw, 10) - 1;
    const selectable = items.filter((it) => !it.separator);
    if (Number.isNaN(idx) || idx < 0 || idx >= selectable.length) {
      console.log('  (pick a valid option)');
      continue;
    }
    const chosen = selectable[idx];
    if (chosen.back || chosen.quit) return chosen;
    const label = typeof chosen.label === 'function' ? chosen.label() : chosen.label;
    try { await chosen.run(); }
    catch (e) { warn(label, e); }
  }
}

function mainMenu(client, ctx) {
  return menu('MAIN MENU', [
    { label: 'Profile & accounts',        run: () => doProfileAndAccounts(client, ctx) },
    { label: 'Markets',                  run: () => doExchanges(client) },
    { label: 'Holdings & cash',          run: () => portfolioMenu(client, ctx) },
    { label: 'Orders...',                run: () => ordersMenu(client, ctx) },
    { label: 'Reference data...',        run: () => referenceMenu(client) },
    { label: 'Refresh token now',        run: () => doRefresh(client) },
    { label: 'Sign out',                 quit: 'logout' },
    { label: 'Exit',                     quit: 'quit' },
  ]);
}

function referenceMenu(client) {
  const ref = (label, fn) => ({
    label,
    run: async () => {
      heading(label);
      const rows = await fn();
      table(rows, [
        { key: 'id',          label: 'ID',          align: 'right', max: 10 },
        { key: 'key',         label: 'Key',         max: 20 },
        { key: 'name',        label: 'Name',        max: 30 },
        { key: 'description', label: 'Description', max: 40 },
      ].filter((c) => rows[0] && c.key in rows[0]));
    },
  });

  return menu('REFERENCE DATA', [
    ref('Currencies',            () => client.reference.listCurrencies()),
    ref('Evaluation currencies', () => client.reference.listEvaluationCurrencies()),
    ref('Account types',         () => client.reference.listAccountTypes()),
    ref('Order statuses',        () => client.reference.listOrderStatuses()),
    ref('Trade operations',      () => client.reference.listTradeOperations()),
    ref('Trade types',           () => client.reference.listTradeTypes()),
    ref('Portfolio intervals',   () => client.reference.listPortfolioIntervals()),
    { label: 'Go back', back: true },
  ]);
}

function activeCurrencyName(ctx) {
  if (!ctx.currencyId || !ctx.accounts) return null;
  const active = ctx.accounts.find((a) => a.portfolioKey === ctx.activePortfolioKey) || ctx.accounts[0];
  return active?.portfolios?.[0]?.currencies?.find((c) => c.id === ctx.currencyId)?.name ?? null;
}

function activeAccountName(ctx) {
  if (!ctx.accounts || !ctx.activePortfolioKey) return null;
  return ctx.accounts.find((a) => a.portfolioKey === ctx.activePortfolioKey)?.displayName ?? null;
}

function portfolioMenu(client, ctx) {
  const CASH_COLS = [
    { key: 'title',             label: 'Account',   max: 15 },
    { key: 'currency',          label: 'Ccy',       max: 4  },
    { key: 'balance',           label: 'Balance',   align: 'right', format: (v) => v?.value?.formatted ?? String(v ?? '') },
    { key: 'availableTransfer', label: 'Available', align: 'right', format: (v) => v?.value?.formatted ?? String(v ?? '') },
  ];

  const holdingsCols = () => {
    const cur = activeCurrencyName(ctx) ?? '?';
    return [
      { key: 'Code',            label: 'Symbol',             max: 10 },
      { key: 'Market',          label: 'Market',             max: 10 },
      { key: 'SecurityBalance', label: 'Qty',                align: 'right' },
      { key: 'AvgPrice',        label: 'Avg Price',          align: 'right' },
      { key: 'LineEvaluation',  label: `Value (${cur})`,     align: 'right' },
      { key: 'GainLoss',        label: `Gain/Loss (${cur})`, align: 'right' },
      { key: 'PriceVariation',  label: 'Chg %',              align: 'right' },
    ];
  };

  return menu('HOLDINGS & CASH', [
    {
      label: () => `Account: ${activeAccountName(ctx) ?? '(none)'}`,
      run: async () => { await chooseAccount(client, ctx); },
    },
    {
      label: () => `Currency: ${activeCurrencyName(ctx) ?? 'All'}`,
      run: async () => { await chooseCurrency(client, ctx); },
    },
    {
      label: () => `Market: ${ctx.marketFilter ?? 'All'}`,
      run: async () => { await chooseMarket(client, ctx); },
    },
    { separator: true },
    {
      label: 'Cash',
      run: async () => {
        const k = await ensurePortfolio(client, ctx);
        heading('Cash');
        table(await client.portfolio.getCashAccounts({ portfolioKey: k }), CASH_COLS);
      },
    },
    {
      label: 'Holdings',
      run: async () => {
        const k = await ensurePortfolio(client, ctx);
        heading('Holdings');
        const res = await client.portfolio.getHoldings({ portfolioKey: k, market: ctx.marketFilter ?? undefined });
        table(res.Positions.Items, holdingsCols());
        const suffix = ctx.marketFilter ? ` on ${ctx.marketFilter}` : ' across all markets';
        console.log(`  ${res.Positions.TotalItemCount} position${res.Positions.TotalItemCount !== 1 ? 's' : ''}${suffix}`);
      },
    },
    {
      label: 'Bank accounts',
      run: async () => {
        const k = await ensurePortfolio(client, ctx);
        heading('Bank accounts');
        table(await client.portfolio.getBankAccounts({ portfolioKey: k }), [
          { key: 'accountNumber', label: 'Account',  max: 25 },
          { key: 'bank',          label: 'Bank',     max: 20 },
          { key: 'currency',      label: 'Currency', max: 6  },
          { key: 'country',       label: 'Country',  max: 10 },
          { key: 'status',        label: 'Status',   max: 15, format: (v) => v?.name ?? String(v ?? '') },
        ]);
      },
    },
    { label: 'Go back', back: true },
  ]);
}

async function doOrderPreview(client, ctx) {
  heading('Order Preview');
  const k = await ensurePortfolio(client, ctx);

  const symbol = (await ask('Symbol (e.g. TVBETETF): ')).toUpperCase().trim();
  if (!symbol) return;

  // Let user pick market from the live list (sorted alphabetically).
  const markets = (await client.markets.list()).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  markets.forEach((m, i) => console.log(`  [${i + 1}] ${m.name || m.code || '?'}  (id=${m.id})`));
  const mRaw = (await ask(`Market — list number or id: `)).trim();
  const mNum = parseInt(mRaw, 10);
  // Accept either list index (1-based) or raw market id.
  let market = markets.find((m) => m.id === mNum) ?? markets[mNum - 1];
  if (!market) { console.log('  invalid selection'); return; }
  const marketId = market.id;

  const sideRaw = await ask('Side [1=buy / 2=sell]: ');
  const side = sideRaw.trim() === '2' ? 'sell' : 'buy';

  const typeRaw = await ask('Type [1=limit / 2=market]: ');
  const type = typeRaw.trim() === '2' ? 'market' : 'limit';

  let price;
  if (type === 'limit') {
    const pr = await ask('Price: ');
    price = pr.trim() || undefined;
  }

  const qtyRaw = await ask('Quantity (blank to skip): ');
  const quantity = qtyRaw.trim() || null;

  const result = await client.orders.preview({ portfolioKey: k, symbol, marketId, quantity, price, side, type });
  dump(result);
}

function ordersMenu(client, ctx) {
  const sideStr = (v) => typeof v === 'string' ? v : (v?.Short ?? v?.Name ?? v?.Value ?? '');
  const ORDER_COLS = [
    { key: 'OrderNumber',        label: 'Order #',   align: 'right' },
    { key: 'DateShort',          label: 'Date',      max: 12 },
    { key: 'Code',               label: 'Symbol',    max: 10 },
    { key: 'SideDisplayShort',   label: 'Side',      max: 6, format: sideStr },
    { key: 'TypeDisplay',        label: 'Type',      max: 10 },
    { key: 'Quantity',           label: 'Qty',       align: 'right' },
    { key: 'FilledQuantity',     label: 'Filled',    align: 'right' },
    { key: 'PriceDisplay',       label: 'Price',     max: 14 },
  ];

  return menu('ORDERS', [
    {
      label: 'Preview order',
      run: async () => { await doOrderPreview(client, ctx); },
    },
    { separator: true },
    {
      label: 'All orders',
      run: async () => {
        const k = await ensurePortfolio(client, ctx);
        heading('Orders (all)');
        const res = await client.orders.search({ portfolioKey: k });
        table(res.Items, ORDER_COLS);
        console.log('  Total: ' + res.TotalItemCount);
      },
    },
    {
      label: 'Filter by dates',
      run: async () => {
        const k         = await ensurePortfolio(client, ctx);
        const startDate = await ask('start date YYYY-MM-DD (blank = none): ');
        const endDate   = await ask('end date   YYYY-MM-DD (blank = today): ');
        heading('Orders filtered');
        const res = await client.orders.search({
          portfolioKey: k,
          startDate: startDate || null,
          endDate:   endDate   || null,
        });
        table(res.Items, ORDER_COLS);
        console.log('  Total: ' + res.TotalItemCount);
      },
    },
    {
      label: 'Order details',
      run: async () => {
        const n = await ask('orderNumber: ');
        heading('Order ' + n);
        const o = await client.orders.get(n);
        kv(o, ['OrderNumber','OrderNumberDisplay','DateShort','Code','SideDisplayShort',
                'TypeDisplay','Quantity','FilledQuantity','RemainingQuantity',
                'PriceDisplay','ValabilityDisplay','ValidUntil','PortfolioKey']);
      },
    },
    {
      label: 'Available actions',
      run: async () => {
        const n = await ask('orderNumber: ');
        heading('Actions ' + n);
        const res = await client.orders.getActions(n);
        Array.isArray(res) ? table(res) : dump(res);
      },
    },
    {
      label: 'Execution history',
      run: async () => {
        const n = await ask('orderNumber: ');
        heading('History ' + n);
        const res = await client.orders.getHistory(n);
        Array.isArray(res) ? table(res) : dump(res);
      },
    },
    { label: 'Go back', back: true },
  ]);
}

// ---------- actions ----------

async function doProfileAndAccounts(client, ctx) {
  heading('Profile');
  const p = await client.profile.get();
  kv(p, ['displayName','userID','language','theme','lastLogin','serverTime','landingPage']);
  await doAccounts(client, ctx);
}

async function doExchanges(client) {
  heading('Exchanges');
  const rows = await client.markets.list();
  if (!Array.isArray(rows) || !rows.length) { dump(rows); return; }
  const keys = Object.keys(rows[0]);
  const cols = [
    { key: 'id',   label: 'ID',   align: 'right', max: 8 },
    { key: 'name', label: 'Name', max: 30 },
    { key: 'code', label: 'Code', max: 10 },
  ].filter((c) => keys.includes(c.key));
  if (cols.length < 2) table(rows);
  else table(rows, cols);
}

async function doAccounts(client, ctx) {
  heading('Accounts');
  const accounts = await client.accounts.list();
  ctx.accounts = accounts;
  accounts.forEach((a, i) => {
    const star   = a.selected ? '★' : ' ';
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
  ctx.accounts.forEach((a, i) => {
    const mark = ctx.activePortfolioKey === a.portfolioKey ? '★' : ' ';
    console.log(` ${mark} [${i + 1}] ${a.displayName || '(no name)'}`);
  });
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

async function ensureCurrency(client, ctx) {
  if (ctx.currencyId) return ctx.currencyId;
  if (!ctx.accounts) await doAccounts(client, ctx);
  const active = ctx.accounts.find((a) => a.portfolioKey === ctx.activePortfolioKey)
    || ctx.accounts.find((a) => a.selected) || ctx.accounts[0];
  const id = client.accounts.defaultCurrencyId(active);
  if (id != null) { ctx.currencyId = id; return id; }
  console.log('No portfolio-specific currency found for the active account.');
  await chooseCurrency(client, ctx);
  if (!ctx.currencyId) throw new Error('cannot determine a currencyId');
  return ctx.currencyId;
}

async function chooseCurrency(client, ctx) {
  if (!ctx.accounts) await doAccounts(client, ctx);
  const active = ctx.accounts.find((a) => a.portfolioKey === ctx.activePortfolioKey)
    || ctx.accounts.find((a) => a.selected) || ctx.accounts[0];
  let list   = (active && active.portfolios && active.portfolios[0] && active.portfolios[0].currencies) || [];
  let source = "active portfolio's currencies";
  if (!list.length) { list = await client.reference.listEvaluationCurrencies(); source = 'evaluation currencies (global)'; }
  if (!Array.isArray(list) || !list.length) { console.log('no currencies available'); return; }
  console.log(`From: ${source}`);
  const options = [{ id: null, name: 'All currencies' }, ...list];
  options.forEach((c, i) => {
    const mark = (i === 0 ? ctx.currencyId === null : c.id === ctx.currencyId) ? '★' : ' ';
    console.log(` ${mark} [${i + 1}] ${c.name || c.description || ''}`);
  });
  const raw = await ask(`pick currency [1-${options.length}]: `);
  const idx = parseInt(raw, 10) - 1;
  if (idx >= 0 && idx < options.length) {
    ctx.currencyId = options[idx].id;
    console.log(ctx.currencyId === null ? 'currency filter cleared (all)' : 'display currency set to ' + options[idx].name);
  }
}

async function chooseMarket(client, ctx) {
  const k = await ensurePortfolio(client, ctx);
  const res = await client.portfolio.getHoldings({ portfolioKey: k });
  const markets = [...new Set(res.Positions.Items.map((p) => p.Market))].sort();
  const options = ['All markets', ...markets];
  options.forEach((m, i) => {
    const mark = (i === 0 ? ctx.marketFilter === null : ctx.marketFilter === m) ? '★' : ' ';
    console.log(` ${mark} [${i + 1}] ${m}`);
  });
  const raw = await ask(`pick market [1-${options.length}]: `);
  const idx = parseInt(raw, 10) - 1;
  if (idx === 0) {
    ctx.marketFilter = null;
    console.log('market filter cleared (all)');
  } else if (idx > 0 && idx < options.length) {
    ctx.marketFilter = options[idx];
    console.log(`market filter set to ${ctx.marketFilter}`);
  }
}

function formatRomanianName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return tokens.length === 1 ? titleCase(tokens[0]) : '';
  const surname    = tokens[0];
  const firstGiven = tokens.slice(1).join(' ').split('-')[0];
  return `${titleCase(firstGiven)} ${titleCase(surname)}`;
}

function titleCase(s) {
  return String(s).toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
}

async function doRefresh(client) {
  heading('Refreshing access token');

  const before        = client.toSnapshot();
  const oldRefreshTail = before?.refreshToken ? before.refreshToken.slice(-8) : '(none)';
  const oldAccessTail  = before?.accessToken  ? before.accessToken.slice(-8)  : '(none)';
  const oldExp         = before?.expiresAt    ? new Date(before.expiresAt).toISOString() : '(unknown)';

  console.log('Before:');
  console.log('  access_token  fingerprint:', oldAccessTail);
  console.log('  refresh_token fingerprint:', oldRefreshTail);
  console.log('  access expires:           ', oldExp);

  await client.auth.refresh();

  const after         = client.toSnapshot();
  const newRefreshTail = after?.refreshToken ? after.refreshToken.slice(-8) : '(none)';
  const newAccessTail  = after?.accessToken  ? after.accessToken.slice(-8)  : '(none)';
  const newExp         = after?.expiresAt    ? new Date(after.expiresAt).toISOString() : '(unknown)';
  const rotated        = oldRefreshTail !== newRefreshTail;
  const accessRotated  = oldAccessTail  !== newAccessTail;

  console.log('\nAfter:');
  console.log('  access_token  fingerprint:', newAccessTail,  accessRotated ? '(ROTATED)' : '(unchanged)');
  console.log('  refresh_token fingerprint:', newRefreshTail, rotated ? '(ROTATED)' : '(UNCHANGED)');
  console.log('  access expires:           ', newExp);

  if (accessRotated && !rotated) {
    console.log('\nDiagnostic: refresh-token appears NOT to rotate.');
  } else if (rotated) {
    console.log('\nDiagnostic: refresh-token was rotated.');
  }
}

// ---------- main ----------

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
  console.log('bt-trade\n');

  if (!DEMO) {
    const ans = (await ask('Mode [1=real / 2=demo]: ')).trim();
    DEMO = ans === '2';
  }
  SESSION_FILE = path.join(os.tmpdir(), `bt-trade-session${DEMO ? '-demo' : ''}.json`);
  if (DEMO) console.log('  Demo mode (paper trading)\n');

  const otpMode = pickOtpMode();
  if (otpMode.mode === 'ntfy') {
    if (otpMode.topic) console.log(`OTP delivery: ntfy.sh topic "${otpMode.topic}"`);
    else console.log(`OTP delivery: ntfy.sh (topic will be derived from username)`);
  } else {
    console.log('OTP delivery: terminal (stdin)');
  }

  if (DEMO) console.log('Mode: DEMO (paper trading)\n');

  const client = new BTTradeClient({
    demo: DEMO,
    otpProvider: otpMode.mode === 'ntfy'
      ? ntfyOtpProvider({ topic: otpMode.topic || undefined, log })
      : stdinOtpProvider(),
    log,
    onSessionChange: saveSession,
  });

  const saved = loadSavedSession();
  let usedSaved = false;

  if (saved) {
    const tokenStillValid = saved.expiresAt && Date.now() < saved.expiresAt - 30_000;
    console.log(`Saved session found for ${saved.username}`);
    console.log(`  (access token ${accessAge(saved.expiresAt)})`);
    const choice = (await ask('  [1] use saved session   [2] log in fresh   > ')).trim();
    if (choice === '' || choice === '1') {
      try {
        client.restore(saved);
        if (!tokenStillValid) {
          // Access token is expired or near expiry — refresh now so we start with a fresh one.
          await client.auth.refresh();
        }
        usedSaved = true;
        console.log('Saved session restored.');
      } catch (e) {
        if (e instanceof AuthError) {
          saveSession(null);
          console.log(`Saved session no longer valid (${e.code}${e.status ? ' ' + e.status : ''}) — falling back to fresh login.`);
        } else {
          throw e;
        }
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
  const ctx  = { accounts: null, activePortfolioKey: null, profile: null, currencyId: null, marketFilter: null };

  try {
    ctx.profile = await client.profile.get();
    const raw      = ctx.profile?.clients?.[0]?.displayName || '';
    const friendly = formatRomanianName(raw);
    if (friendly) console.log(`\nHi there, ${friendly}! 👋`);
  } catch (_) {}

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
  if (!expiresAt) return 'expiry unknown';
  const diff = Date.now() - expiresAt;
  if (diff < 0) return `valid, expires in ${Math.round(-diff / 1000)}s`;
  const mins = Math.round(diff / 60000);
  return `expired ${mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`}`;
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
