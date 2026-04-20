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

Drop the folder into your project or `npm link` it. There are no dependencies
to install.

## Quick start

```js
import { BTTradeClient, stdinOtpProvider } from 'bt-trade';

const client = new BTTradeClient({
  otpProvider: stdinOtpProvider(),       // or your own (e.g. SMS-forwarder, Telegram bot)
});

await client.login({ username, password });

const profile   = await client.profile.get();
const exchanges = await client.markets.listExchanges();
const accounts  = await client.accounts.list();

const active = accounts.find((a) => a.selected) || accounts[0];
const positions = await client.portfolio.listPositions({ portfolioKey: active.portfolioKey });
const orders    = await client.orders.search({ portfolioKey: active.portfolioKey });
```

Run the bundled example end-to-end:

```
node bin/bt-trade.js --debug
```

## Authentication

1. `login()` sends username/password to `POST /api/RefreshToken`.
2. If 2FA is required the server replies with a pending `access_token`, a
   `prefix` (display-only), and a `details` string announcing the SMS.
3. `BTTradeClient` calls your `otpProvider(info)` to obtain the SMS code.
4. Step 2 posts the same body with `?code=<otp>` in the URL and the pending
   token as `Authorization: Bearer`.
5. On success you get `access_token` (~10 min lifetime), `refresh_token`,
   `SessionId`.

The client persists tokens in memory (via `AuthSession`). Snapshot them for
long-running processes:

```js
const snap = client.toSnapshot();         // { username, accessToken, refreshToken, expiresAt, sessionId }
// save snap to disk, database, keychain, ...
// later:
const client2 = new BTTradeClient();
client2.restore(snap);
await client2.profile.get();              // works — auto-refreshes the access token if near expiry
```

### Token refresh

The transport refreshes automatically in two cases:

- **proactively**, when the next request finds the access token within 60 s
  of expiry;
- **reactively**, on a `401` response, retrying the original request once.

Concurrent requests that arrive during a refresh share a single in-flight
refresh promise so the refresh token is used only once per cycle.

## Public surface

```
client.login({ username, password })
client.restore(snapshot)
client.toSnapshot()
client.logout()

client.profile.get({ device })                         // GET /User/GetUserProfile
client.markets.listExchanges()                         // GET /Nomenclatures/GetExchanges — trading venues

// Reference data (enums, lookups) — server-side nomenclatures. Cache locally.
client.reference.listCurrencies()
client.reference.listEvaluationCurrencies()
client.reference.listAccountTypes()
client.reference.listOrderStatuses()
client.reference.listTradeOperations()
client.reference.listTradeTypes()
client.reference.listPortfolioIntervals()

client.accounts.list()                                 // normalized from profile.clients[]
client.accounts.getAvailableTypes(portfolioKey)        // GET /Client/GetAvailableAccountTypes

// Portfolio — currencyId is REQUIRED by the server for balance endpoints.
// Take it from profile.selectedPortfolioPanelCurrencyID or listEvaluationCurrencies().
client.portfolio.getBalance({ portfolioKey, currencyId })
client.portfolio.getBalanceInfo({ portfolioKey, currencyId })
client.portfolio.getAccountsTransfer({ portfolioKey })
client.portfolio.getBankAccounts({ portfolioKey })
// endDate accepts Date | 'YYYY-MM-DD' | 'DD.MM.YYYY' — sent as DD.MM.YYYY (server requirement).
client.portfolio.listPositions({ portfolioKey, endDate, queryModel })   // POST /Portfolio/Select

client.orders.search({ portfolioKey, statuses, side, symbol, interval, startDate, endDate, queryModel })
client.orders.get(orderNumber)
client.orders.getActions(orderNumber)
client.orders.getHistory(orderNumber)
```

All methods return parsed JSON from the server.

## OTP providers

`otpProvider` is an `async (info) => string` where `info` carries
`{ username, prefix, details, expiresIn }`. The default
`stdinOtpProvider()` prompts on the terminal. The library ships two more
providers ready to use, and a custom one is a one-liner:

```js
import { BTTradeClient, stdinOtpProvider, ntfyOtpProvider } from '@bogdanripa/bt-trade';

// Terminal entry (interactive only)
new BTTradeClient({ otpProvider: stdinOtpProvider() });

// Phone-shortcut delivery via ntfy.sh (works headless)
new BTTradeClient({ otpProvider: ntfyOtpProvider() });

// Fully custom (Telegram bot, IMAP scraper, SMS-forwarder webhook, ...)
new BTTradeClient({
  otpProvider: async ({ username, prefix, details }) => {
    // ... however you fetch the code ...
    return '12345';
  },
});
```

Only the digits the user typed are sent; the `prefix` is display-only. The
client normalizes by stripping non-digits and removing the prefix if the user
accidentally included it.

### ntfy.sh + phone shortcut (recommended for headless / scheduled use)

`ntfyOtpProvider()` long-polls a free [ntfy.sh](https://ntfy.sh) topic for the
SMS code. A shortcut on your phone forwards the digits to that topic when the
BT Trade SMS arrives. Stable URL, no inbound port, no tunnel, no account, zero
ops.

**Multi-account safe.** Multiple Node processes can share one ntfy topic
because each provider filters incoming messages by its own `username`. Other
users' codes are ignored.

#### 1. Pick (or derive) your topic

If you don't pass a `topic`, one is derived from the username:
`bt-trade-otp-<sha256(username)[0:16]>`. Stable across runs, unique per user.
Compute it ahead of time so you know what URL to put in the shortcut:

```js
import { defaultNtfyTopic } from '@bogdanripa/bt-trade';
console.log(defaultNtfyTopic('MYUSER'));
// → bt-trade-otp-a1b2c3d4e5f60718
// → URL: https://ntfy.sh/bt-trade-otp-a1b2c3d4e5f60718
```

For stronger secrecy, pass an explicit unguessable topic:

```js
ntfyOtpProvider({ topic: 'bt-trade-' + crypto.randomUUID() })
```

> **Security note:** the OTP alone is useless without the password (BT Trade
> requires both in the same request), so the default deterministic topic is
> generally fine for personal use. If you want defense in depth, use an
> explicit random topic and treat it like a password.

#### 2. Build the iOS automation (Apple)

Zero typing — triggered automatically when the BT Trade SMS arrives. The
automation just forwards the entire SMS body to ntfy. The Node side picks the
5-digit code out of the body using the prefix the server returned in step 1
(e.g. `25-74456` → `74456`).

1. Open **Shortcuts** → **Automation** tab → **+** → **New Automation**.
2. Choose **Message** as the trigger.
   - **Sender**: `BT Trade` (or whatever your BT Trade sender ID shows — usually a shortcode / alphanumeric sender, not a phone number).
   - **Message**: leave blank (all messages from that sender).
   - Turn **Run Immediately** on so it fires without a confirmation tap (iOS 18+).
3. Add a single action: **Get Contents of URL**.
   - **URL**: `https://ntfy.sh/<your-topic>` — the URL from step 1 above.
   - **Method**: `POST`.
   - **Request Body**: `JSON` (the Shortcuts app only offers JSON / Form /
     File for POST bodies — Text is not an option).
   - Add **one key** to the JSON:
     - Key: `body`
     - Value: tap the variable picker and insert the **Message** /
       **SMS Content** magic variable.
4. Save.

What lands on ntfy is `{"body":"Codul tau de autentificare BT Trade este 25-74456 ..."}`.
The Node `ntfyOtpProvider` recognizes the wrapper, pulls out the inner text,
matches `25-(\d+)` using the prefix the server returned in step 1 of the
login, and returns `74456`.

> The sender-ID filter is what keeps random SMS (2-factor codes from other
> services, marketing messages) from accidentally hitting the ntfy topic.

> The wrapper key can be any of `body`, `message`, `text`, `sms`, or
> `content` — pick whichever makes the shortcut readable.

#### 3. Build the Android equivalent (any of these works)

- **Tasker** — *Received Text* event filtered on the BT Trade sender → *HTTP Request* action, body = `%SMSRB` (the SMS body variable).
- **MacroDroid** — *SMS Received* trigger with a sender filter → *HTTP Request* with body = `[sms_message]`.
- **SMS Forwarder** apps — most have a "forward matching SMS to URL" template.

The point is: forward the **raw SMS body**. Don't pre-extract the code; the
Node provider does that, using the prefix the server returned. This keeps the
phone side trivial and tolerant of wording changes in the SMS.

#### 4. Use it from Node

```js
import { BTTradeClient, ntfyOtpProvider } from '@bogdanripa/bt-trade';

const client = new BTTradeClient({
  otpProvider: ntfyOtpProvider({ /* topic: optional */ }),
});

await client.login({ username: 'MYUSER', password: process.env.BT_PASS });
// ...your normal calls...
```

Or with the bundled CLI:

```bash
node bin/bt-trade.js                    # ntfy.sh, default topic from username
node bin/bt-trade.js --ntfy-topic foo   # explicit topic
BT_NTFY_TOPIC=foo node bin/bt-trade.js  # same, via env
node bin/bt-trade.js --otp-stdin        # fall back to terminal entry
```

## Errors

All errors thrown from the public API extend `BTTradeError`:

| Class             | `code`             | When                                                     |
| ----------------- | ------------------ | -------------------------------------------------------- |
| `AuthError`       | `AUTH_ERROR`       | 401/403, wrong OTP, expired refresh token                |
| `NetworkError`    | `NETWORK_ERROR`    | fetch failures (DNS, TLS, abort, timeout)                |
| `ApiError`        | `API_ERROR`        | other non-2xx responses                                  |
| `ValidationError` | `VALIDATION_ERROR` | bad input before a request was sent                      |

`err.status`, `err.body`, `err.cause` are populated where applicable.

## What this client intentionally does not do

- **No SignalR / WebSocket.** Portfolio and order screens in the BT Trade web
  app use SignalR for live price/PNL updates on top of an initial HTTP
  snapshot. This client only exposes the snapshot endpoints. If you need
  push updates, build them on top of this module.
- **No trading yet.** `SaveOrder`, `SaveChangeOrder`, `PerformAction` and the
  biometric/trading-password endpoints are intentionally omitted. The source
  references were catalogued but those flows require captcha + questionnaire
  answers, which are out of scope for this first pass.
- **No disk-based session persistence.** `toSnapshot()` / `restore()` let you
  persist wherever you prefer.

## Files

```
package.json
src/
  index.js          public exports
  client.js         BTTradeClient (composes everything)
  auth.js           AuthSession: login, refresh, OTP normalization
  transport.js      fetch wrapper with auth + 401 retry
  errors.js         BTTradeError hierarchy
  endpoints/
    profile.js
    markets.js
    accounts.js
    portfolio.js
    orders.js
bin/
  bt-trade.js       example script that exercises every read-only endpoint
```
