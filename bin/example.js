#!/usr/bin/env node
/**
 * Minimal programmatic usage example.
 *
 * Shows the two-phase pattern:
 *   1. login() → returns a snapshot (serialisable token bundle)
 *   2. restore() → pick up where you left off without re-authenticating
 *
 * Run:
 *   BT_USER=MYUSER BT_PASS=secret node bin/example.js
 *   BT_USER=MYUSER BT_PASS=secret BT_NTFY_TOPIC=my-topic node bin/example.js
 */

import { BTTradeClient, ntfyOtpProvider } from '../src/index.js';

const username = process.env.BT_USER;
const password = process.env.BT_PASS;
if (!username || !password) {
  console.error('Set BT_USER and BT_PASS environment variables.');
  process.exit(1);
}

// ── Phase 1: authenticate ────────────────────────────────────────────────────

const client = new BTTradeClient({
  otpProvider: ntfyOtpProvider({ topic: process.env.BT_NTFY_TOPIC }),
});

const snapshot = await client.login({ username, password });

console.log('Logged in. Token expires at', new Date(snapshot.expiresAt).toISOString());
// `snapshot` is a plain object — persist it however you like (env var, file, keychain, DB…).
// It contains: { username, accessToken, refreshToken, expiresAt, sessionId }

// ── Phase 2: use the snapshot ────────────────────────────────────────────────
// In a real app this would be a separate process/request that loaded the
// snapshot from storage instead of calling login() again.

const client2 = new BTTradeClient();
client2.restore(snapshot);
// The transport will silently refresh the access token if it's near expiry.

const accounts = await client2.accounts.list();
const active   = accounts.find(a => a.selected) ?? accounts[0];
console.log('\nAccounts:');
accounts.forEach(a => console.log(` ${a.selected ? '★' : ' '} ${a.displayName} (${a.portfolioKey})`));

const currencyId = client2.accounts.defaultCurrencyId(active);
const balances   = await client2.portfolio.getBalance({
  portfolioKey: active.portfolioKey,
  currencyId,
});
console.log('\nBalance:');
balances.forEach(b => console.log(` ${b.title}: ${b.value}`));

const positions = await client2.portfolio.listPositions({ portfolioKey: active.portfolioKey });
console.log(`\nOpen positions: ${positions.Positions.TotalItemCount}`);
positions.Positions.Items.forEach(p =>
  console.log(` ${p.Code} @ ${p.Market}  qty=${p.SecurityBalance}  avg=${p.AvgPrice}`)
);
