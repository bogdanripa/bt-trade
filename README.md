# bt-trade

Unofficial Node.js client for the **bt-trade.ro** trading platform. HTTP only
— no SignalR, no WebSocket, no browser automation. Zero runtime dependencies.

> Requires Node 18+ (uses built-in `fetch`).

## Disclaimer

This project is **not affiliated with, endorsed by, or sponsored by** Banca
Transilvania or BT Capital Partners. It is an independent third-party client
created by reverse-engineering the publicly accessible web-app's HTTP API.
"BT Trade" and related marks are the property of their respective owners.

Use it at your own risk: the platform is not required to maintain a stable
API, and it may change, rate-limit, or block clients using this library
without notice. Authentication credentials are only ever sent to the official
bt-trade.ro / evo.bt-trade.ro endpoints; the library makes no network calls
anywhere else.

The author and contributors are not liable for any financial loss, account
suspension, or other consequences arising from the use of this software. Read
the terms of service of the platform before using.

## Install

```bash
npm install @bogdanripa/bt-trade
```

Or drop the source folder into your project — there are no dependencies.

## Quick start

```js
import { BTTradeClient, stdinOtpProvider } from '@bogdanripa/bt-trade';

const client = new BTTradeClient({
  otpProvider: stdinOtpProvider(),   // prompts the terminal for the SMS code
});

await client.login({ username: 'MYUSER', password: process.env.BT_PASS });

const accounts = await client.accounts.list();
const { portfolioKey } = accounts[0];

const holdings = await client.portfolio.getHoldings({ portfolioKey });
const orders   = await client.orders.search({ portfolioKey });
```

Run the bundled interactive CLI:

```bash
npx bt-trade
# or
node bin/bt-trade.js [--demo] [--debug] [--ntfy-topic <topic>] [--otp-stdin]
```

## Authentication

1. `login()` posts username + password to `POST /api/RefreshToken`.
2. If 2FA is required the server returns a pending `access_token` and sends an SMS.
3. `BTTradeClient` calls your `otpProvider({ username, prefix, details, expiresIn })` to get the code.
4. Step 2 re-posts with `?code=<otp>` and the pending token as `Authorization: Bearer`.
5. On success you receive an `access_token` (~10 min) and a `refresh_token`.

### Token lifecycle

The refresh token is a rotating credential. Each time the access token is refreshed, a new pair is issued. The library handles this automatically:

- **Background timer** fires a few seconds before the refresh token expires and refreshes both tokens silently, keeping the session alive indefinitely as long as the process is running.
- **On-request lazy refresh** — if the access token has expired by the time a request fires (e.g. the process was paused), it is refreshed transparently before the call.
- **Reactive 401 retry** — if the server rejects a request, the token is refreshed and the request is retried once.
- **Auto re-login** — if the refresh token itself expires (process was idle too long), and the client has credentials in memory from a fresh login this session, it logs back in automatically including re-prompting for the OTP via the configured provider.

### Persisting sessions

```js
// After login, save for later:
const snap = client.toSnapshot();
// → { username, accessToken, refreshToken, refreshTokenExpires, expiresAt, sessionId }
// Persist however you like (file, keychain, env var, …)

// Next process start — restore without re-entering credentials:
const client2 = new BTTradeClient({ otpProvider: stdinOtpProvider() });
client2.restore(snap);
await client2.profile.get();   // works immediately; refreshes token if needed
```

## Public API

```js
// Client lifecycle
client.login({ username, password })     // → SessionSnapshot
client.restore(snapshot)
client.toSnapshot()                      // → SessionSnapshot | null
client.logout()

// Profile
client.profile.get()

// Markets
client.markets.list()                    // all exchanges
client.markets.searchInstrument(code)    // find instrument by ticker → [{ code, marketId, market, currency, … }]
client.markets.getInstrument({ portfolioKey, code, marketId })
                                         // live bid/ask + trading rules for one instrument

// Reference data (enums — cache locally, rarely change)
client.reference.listCurrencies()
client.reference.listEvaluationCurrencies()
client.reference.listAccountTypes()
client.reference.listOrderStatuses()
client.reference.listTradeTypes()

// Accounts
client.accounts.list()                   // normalized list from profile
client.accounts.getAvailableTypes(portfolioKey)

// Portfolio
client.portfolio.getCash({ portfolioKey, currencyId })
client.portfolio.getCashDetails({ portfolioKey, currencyId })
client.portfolio.getCashAccounts({ portfolioKey })
client.portfolio.getBankAccounts({ portfolioKey })
client.portfolio.getHoldings({ portfolioKey, market?, endDate?, queryModel? })

// Orders
client.orders.search({ portfolioKey, statuses?, side?, symbol?,
                        startDate?, endDate?, queryModel? })
client.orders.get(orderNumber)
client.orders.getActions(orderNumber)
client.orders.getHistory(orderNumber)
client.orders.preview({ portfolioKey, symbol, marketId, quantity?,
                         price, side, type? })
client.orders.placeOrder({ portfolioKey, symbol, marketId, quantity,
                            price?, side, type?, valability? })
```

All methods return the parsed JSON response from the server.

### Placing an order

```js
// 1. Find the instrument and its marketId
const [instrument] = await client.markets.searchInstrument('TVBETETF');
const { code, marketId } = instrument;

// 2. (Optional) preview fees before committing
const preview = await client.orders.preview({
  portfolioKey, symbol: code, marketId,
  quantity: 10, price: 12.50, side: 'buy', type: 'limit',
});
console.log(preview.netValue, preview.commission);

// 3. Place
const result = await client.orders.placeOrder({
  portfolioKey, symbol: code, marketId,
  quantity: 10, price: 12.50, side: 'buy',
  type: 'limit',      // 'limit' | 'market'
  valability: 'day',  // 'day'   | 'gtc'
});
```

For **market orders**, always preview with a `type: 'limit'` and the current
ask/bid as the price — the server's market-order preview is uncapped and
returns worst-case figures that are meaningless. Use `markets.getInstrument()`
to get live ask/bid:

```js
const info = await client.markets.getInstrument({ portfolioKey, code, marketId });
const preview = await client.orders.preview({
  portfolioKey, symbol: code, marketId,
  quantity: 1, price: side === 'buy' ? info.ask : info.bid,
  side, type: 'limit',
});
```

## OTP providers

`otpProvider` is an `async ({ username, prefix, details, expiresIn }) => string`.
Three are included:

```js
import { BTTradeClient, stdinOtpProvider, ntfyOtpProvider } from '@bogdanripa/bt-trade';

// Interactive terminal
new BTTradeClient({ otpProvider: stdinOtpProvider() });

// Headless: phone shortcut forwards SMS to ntfy.sh (see below)
new BTTradeClient({ otpProvider: ntfyOtpProvider({ topic: 'my-secret-topic' }) });

// Fully custom (Telegram bot, IMAP, webhook, …)
new BTTradeClient({
  otpProvider: async ({ prefix, details }) => {
    // fetch the code however you like, return just the digits
    return '12345';
  },
});
```

### ntfy.sh + phone shortcut (recommended for headless use)

`ntfyOtpProvider()` subscribes to a free [ntfy.sh](https://ntfy.sh) topic and
waits for the SMS code to arrive. A shortcut on your phone forwards the raw
BT Trade SMS to that topic. No inbound port, no tunnel, no account required.

**Pick a topic:**

```js
import { defaultNtfyTopic } from '@bogdanripa/bt-trade';
console.log(defaultNtfyTopic('MYUSER'));
// → bt-trade-otp-a1b2c3d4e5f60718
```

Or pass your own unguessable string:

```js
ntfyOtpProvider({ topic: 'bt-trade-' + crypto.randomUUID() })
```

**iOS automation (Shortcuts):**

1. **Automation** → **+** → trigger: **Message** → filter on the BT Trade sender.
2. Enable **Run Immediately**.
3. Action: **Get Contents of URL** — `POST https://ntfy.sh/<topic>`, body type `JSON`, one key `body` = the **Message** magic variable.

**Android:** Tasker / MacroDroid / any SMS-forwarder app — POST the raw SMS body to `https://ntfy.sh/<topic>`.

The provider extracts the 5-digit code from the raw SMS text using the `prefix`
the server returned (e.g. `25-74456` → `74456`). Multiple processes can share
one topic safely — each filters by its own `username`.

## Errors

All errors extend `BTTradeError`:

| Class             | When                                              |
| ----------------- | ------------------------------------------------- |
| `AuthError`       | 401/403, wrong OTP, expired or rejected tokens    |
| `NetworkError`    | fetch failures (DNS, TLS, timeout)                |
| `ApiError`        | other non-2xx responses                           |
| `ValidationError` | bad arguments before any request was sent         |

`err.status`, `err.body`, `err.cause` are set where applicable.

## What this client does not do

- **No SignalR / WebSocket.** The web app uses SignalR for live price/PNL
  updates. This client only exposes the underlying HTTP snapshot endpoints.
- **No disk-based session persistence.** `toSnapshot()` / `restore()` give you
  the data; where you store it is up to you.

## Files

```
src/
  index.js          public exports
  client.js         BTTradeClient
  auth.js           AuthSession — login, refresh, OTP, auto re-login
  transport.js      fetch wrapper with auth injection and 401 retry
  errors.js         BTTradeError hierarchy
  endpoints/
    profile.js
    markets.js      list, searchInstrument, getInstrument
    accounts.js
    portfolio.js    getCash, getHoldings, …
    orders.js       search, preview, placeOrder, …
    reference.js    currencies, account types, order statuses, …
bin/
  bt-trade.js       interactive CLI (demo of every endpoint)
```
