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
import { BTTradeClient, stdinOtpProvider, ntfyOtpProvider, BTTradeError, AuthError, parseRefreshToken } from '../src/index.js';

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
  ? (tag, data) => console.error('[' + tag + ']', typeof data === 'string' ? data : JSON.stringify(data))
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
  // Split into normal items and pinned items (items with `at: N`).
  const normal = items.filter((it) => !it.at);
  const pinned = items.filter((it) => it.at);

  // Build a number→item map.  Normal items fill 1..N sequentially (skipping
  // any slots claimed by pinned items).  Pinned items sit at their fixed slot.
  const byNumber = new Map();
  const pinnedSlots = new Set(pinned.map((it) => it.at));
  let n = 0;
  for (const it of normal) {
    if (it.separator) continue;
    do { n++; } while (pinnedSlots.has(n));
    byNumber.set(n, it);
  }
  for (const it of pinned) byNumber.set(it.at, it);

  while (true) {
    console.log('\n' + (typeof title === 'function' ? title() : title));

    // Display normal items in order, then a separator, then pinned items.
    let displayN = 0;
    normal.forEach((it) => {
      if (it.separator) { console.log('  ' + '─'.repeat(38)); return; }
      do { displayN++; } while (pinnedSlots.has(displayN));
      console.log(`  [${displayN}] ${typeof it.label === 'function' ? it.label() : it.label}`);
    });
    if (pinned.length) {
      console.log('  ' + '─'.repeat(38));
      pinned.forEach((it) => {
        console.log(`  [${it.at}] ${typeof it.label === 'function' ? it.label() : it.label}`);
      });
    }

    const raw = await ask('> ');
    const num = parseInt(raw, 10);
    if (Number.isNaN(num) || !byNumber.has(num)) {
      console.log('  (pick a valid option)');
      continue;
    }
    const chosen = byNumber.get(num);
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
    { label: 'Exit',                     quit: 'quit',   at: 9 },
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
    ref('Trade types',           () => client.reference.listTradeTypes()),
    { label: 'Go back', back: true, at: 9 },
  ]);
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

  const holdingsCols = () => [
    { key: 'Code',            label: 'Symbol',   max: 10 },
    { key: 'Market',          label: 'Market',   max: 10 },
    { key: 'SecurityBalance', label: 'Qty',      align: 'right' },
    { key: 'AvgPrice',        label: 'Avg Price',align: 'right' },
    { key: 'Code',            label: 'Ccy',      max: 5, format: (_, row) => ctx.instrumentCurrencyMap?.get(`${row.Code}:${row.Market}`) ?? '?' },
    { key: 'LineEvaluation',  label: 'Value',    align: 'right' },
    { key: 'GainLoss',        label: 'Gain/Loss',align: 'right' },
    { key: 'PriceVariation',  label: 'Chg %',   align: 'right' },
  ];

  return menu('HOLDINGS & CASH', [
    {
      label: () => `Account: ${activeAccountName(ctx) ?? '(none)'}`,
      run: async () => { await chooseAccount(client, ctx); },
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
        // Populate currency cache for any symbols not yet seen.
        if (!ctx.instrumentCurrencyMap) ctx.instrumentCurrencyMap = new Map();
        const newCodes = [...new Set(res.Positions.Items.map((p) => p.Code))]
          .filter((code) => ![...ctx.instrumentCurrencyMap.keys()].some((k) => k.startsWith(code + ':')));
        await Promise.all(newCodes.map(async (code) => {
          try {
            const matches = await client.markets.searchInstrument(code);
            if (Array.isArray(matches)) {
              matches.forEach((m) => { if (m.currency && m.market) ctx.instrumentCurrencyMap.set(`${m.code}:${m.market}`, m.currency); });
            }
          } catch (_) {}
        }));
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
    { label: 'Go back', back: true, at: 9 },
  ]);
}

async function pickInstrument(client, symbolHint) {
  const code = symbolHint || (await ask('Symbol (e.g. TSLA): ')).toUpperCase().trim();
  if (!code) return null;
  const results = await client.markets.searchInstrument(code);
  if (!Array.isArray(results) || !results.length) { console.log(`  No instruments found for "${code}"`); return null; }
  results.forEach((r, i) => {
    console.log(`  [${i + 1}] ${r.code}  ${r.name}  —  ${r.market}  ${r.currency}`);
  });
  if (results.length === 1) {
    console.log('  (auto-selected)');
    return results[0];
  }
  const raw = (await ask(`Pick [1-${results.length}]: `)).trim();
  const idx = parseInt(raw, 10) - 1;
  if (idx < 0 || idx >= results.length) { console.log('  invalid selection'); return null; }
  return results[idx];
}

/**
 * Interactively prompt for the parameters of an order.
 * Returns { k, symbol, marketId, side, type, price, quantity, previewPrice } or null if cancelled.
 * `previewPrice` is the price to use for Orders/GetOrderDetails — for market orders it's
 * the live ask/bid (server preview is unreliable without a price); for limit orders it's `price`.
 */
async function promptOrderParams(client, ctx) {
  const k = await ensurePortfolio(client, ctx);

  const instrument = await pickInstrument(client);
  if (!instrument) return null;
  const { code: symbol, marketId } = instrument;

  const sideRaw = await ask('Side [1=buy / 2=sell]: ');
  const side = sideRaw.trim() === '2' ? 'sell' : 'buy';

  const typeRaw = await ask('Type [1=limit / 2=market]: ');
  const type = typeRaw.trim() === '2' ? 'market' : 'limit';

  let price;
  if (type === 'limit') {
    const prRaw = await ask('Price: ');
    price = prRaw.trim() ? Number(prRaw.trim()) : undefined;
    if (!price) { console.log('  invalid price'); return null; }
  }

  const qtyRaw = await ask('Quantity: ');
  const quantity = qtyRaw.trim() ? Number(qtyRaw.trim()) : null;
  if (!quantity) { console.log('  invalid quantity'); return null; }

  let previewPrice = price;
  if (type === 'market') {
    const info = await client.markets.getInstrument({ portfolioKey: k, code: symbol, marketId });
    previewPrice = side === 'buy' ? info.ask : info.bid;
  }

  return { k, symbol, marketId, side, type, price, quantity, previewPrice };
}

function printOrderPreview(r, type) {
  const fmt = (v) => v ? `${v.formatted} ${v.currency}` : '—';
  if (type === 'market') console.log('  (market order — preview based on live ask/bid price)');
  console.log(`  Position      ${r.securityBalance ?? '—'}`);
  console.log(`  Est. price    ${fmt(r.computedPrice)}`);
  if (r.computedPrice?.info) console.log(`                (${r.computedPrice.info})`);
  console.log(`  Net value     ${fmt(r.netValue)}`);
  console.log(`  Commission    ${fmt(r.commission)}`);
  if (r.commissionDetails?.balances?.length) {
    r.commissionDetails.balances.forEach((b) => {
      console.log(`    ${b.title.padEnd(30)} ${fmt(b.value)}`);
    });
  }
  console.log(`  Available     ${fmt(r.availableCash)}`);
}

async function doOrderPreview(client, ctx) {
  heading('Order Preview');
  const p = await promptOrderParams(client, ctx);
  if (!p) return;

  const r = await client.orders.preview({
    portfolioKey: p.k, symbol: p.symbol, marketId: p.marketId,
    quantity: p.quantity, price: p.previewPrice, side: p.side, type: 'limit',
  });
  printOrderPreview(r, p.type);
}

async function doPlaceOrder(client, ctx) {
  heading('Place Order');
  const p = await promptOrderParams(client, ctx);
  if (!p) return;

  // Show the preview first so the user knows what they're committing to.
  console.log('\nPreview:');
  try {
    const r = await client.orders.preview({
      portfolioKey: p.k, symbol: p.symbol, marketId: p.marketId,
      quantity: p.quantity, price: p.previewPrice, side: p.side, type: 'limit',
    });
    printOrderPreview(r, p.type);
  } catch (e) {
    warn('preview (before placing)', e);
    const proceed = (await ask('Preview failed — place order anyway? [y/N]: ')).trim().toLowerCase();
    if (proceed !== 'y' && proceed !== 'yes') { console.log('  aborted'); return; }
  }

  const priceStr = p.type === 'market' ? 'MARKET' : String(p.price);
  console.log(`\nAbout to place: ${p.side.toUpperCase()} ${p.quantity} ${p.symbol} @ ${priceStr} (${p.type})`);
  const confirm = (await ask('Confirm? [y/N]: ')).trim().toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') { console.log('  aborted'); return; }

  console.log('\nPlacing order…');
  const res = await client.orders.placeOrder({
    portfolioKey: p.k,
    symbol:       p.symbol,
    marketId:     p.marketId,
    quantity:     p.quantity,
    price:        p.price,
    side:         p.side,
    type:         p.type,
  });

  // The SaveOrder response shape varies; surface OrderNumber if present, else raw response.
  const orderNum = res?.orderNumber ?? res?.OrderNumber ?? res?.order?.orderNumber ?? null;
  if (orderNum) {
    console.log(`  ✓ Order placed — #${orderNum}`);
  } else {
    console.log('  ✓ Order submitted.');
    if (DEBUG) console.log(JSON.stringify(res, null, 2));
  }
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
    {
      label: 'Place order',
      run: async () => { await doPlaceOrder(client, ctx); },
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
    { label: 'Go back', back: true, at: 9 },
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
  heading('Markets');
  const rows = await client.markets.list();
  if (!Array.isArray(rows) || !rows.length) { dump(rows); return; }
  const sorted = rows.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  sorted.forEach((m) => console.log(`  [${String(m.id).padStart(3)}] ${m.name || m.code || '?'}`));
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

function rtFingerprint(snap) {
  if (!snap?.refreshToken) return '(none)';
  return `...${snap.refreshToken.slice(-8)} (expires ${snap.refreshTokenExpires ?? '?'})`;
}

async function doRefresh(client) {
  heading('Refreshing access token');

  const before        = client.toSnapshot();
  const oldAccessTail  = before?.accessToken  ? before.accessToken.slice(-8)  : '(none)';
  const oldExp         = before?.expiresAt    ? new Date(before.expiresAt).toISOString() : '(unknown)';

  console.log('Before:');
  console.log('  access_token  fingerprint:', oldAccessTail);
  console.log('  refresh_token            :', rtFingerprint(before));
  console.log('  access expires:          ', oldExp);

  await client.auth.refresh();

  const after         = client.toSnapshot();
  const newAccessTail  = after?.accessToken  ? after.accessToken.slice(-8)  : '(none)';
  const newExp         = after?.expiresAt    ? new Date(after.expiresAt).toISOString() : '(unknown)';
  const accessRotated  = oldAccessTail  !== newAccessTail;
  const rtBefore       = rtFingerprint(before);
  const rtAfter        = rtFingerprint(after);
  const rotated        = rtBefore !== rtAfter;

  console.log('\nAfter:');
  console.log('  access_token  fingerprint:', newAccessTail, accessRotated ? '(ROTATED)' : '(unchanged)');
  console.log('  refresh_token            :', rtAfter, rotated ? '(ROTATED)' : '(UNCHANGED)');
  console.log('  access expires:          ', newExp);

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
    // Migrate old sessions that stored the raw JSON envelope as refreshToken.
    if (snap.refreshToken.startsWith('{')) {
      const { token, expires } = parseRefreshToken(snap.refreshToken);
      snap.refreshToken = token;
      snap.refreshTokenExpires = snap.refreshTokenExpires ?? expires;
      saveSession(snap);   // rewrite in new format
    }
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

  const client = new BTTradeClient({
    demo: DEMO,
    otpProvider: otpMode.mode === 'ntfy'
      ? ntfyOtpProvider({ topic: otpMode.topic || undefined, log })
      : stdinOtpProvider(),
    log,
    debug: DEBUG,
    onSessionChange: saveSession,
    onExpired: () => {
      console.error('\n[session] Session expired and could not be renewed automatically. Please log in again.\n');
    },
  });

  const saved = loadSavedSession();
  let usedSaved = false;

  if (saved) {
    const tokenStillValid  = saved.expiresAt && Date.now() < saved.expiresAt - 30_000;
    const rtExpMs          = saved.refreshTokenExpires ? new Date(saved.refreshTokenExpires).getTime() : null;
    const rtStillValid     = rtExpMs ? Date.now() < rtExpMs : true; // assume ok if unknown
    console.log(`Saved session found for ${saved.username}`);
    console.log(`  (access token  ${accessAge(saved.expiresAt)})`);
    if (rtExpMs) {
      console.log(`  (refresh token ${rtStillValid ? `valid, expires in ~${Math.round((rtExpMs - Date.now()) / 60000)}m` : 'EXPIRED — will need fresh login'})`);
    }
    const choice = (await ask('  [1] use saved session   [2] log in fresh   > ')).trim();
    if (choice === '' || choice === '1') {
      if (rtExpMs && !rtStillValid) {
        saveSession(null);
        console.log('Refresh token has expired — please log in fresh.');
      } else {
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
  const ctx  = { accounts: null, activePortfolioKey: null, profile: null, marketFilter: null, instrumentCurrencyMap: null };

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
