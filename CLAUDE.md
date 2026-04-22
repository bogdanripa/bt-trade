# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Unofficial Node.js HTTP client for the **bt-trade.ro** (Banca Transilvania / BT Capital Partners) trading platform, reverse-engineered from the public Angular web app. Pure ESM, zero runtime dependencies, Node 18+ (relies on built-in `fetch`).

## Commands

```bash
npm run check            # syntax-check the main entry points via `node --check`
npm start                # run the interactive demo CLI (bin/bt-trade.js)
node bin/bt-trade.js [--demo] [--debug] [--ntfy-topic <t>] [--otp-stdin]
node bin/example.js      # minimal programmatic usage (needs BT_USER / BT_PASS env)
node bin/ntfy-test.js <username> [prefix]   # test the ntfy → OTP pipe without logging in
```

There is no lint, test, or build step. `npm run check` only validates that the three entry files parse. Verification of behavior is manual: run the CLI against the live server (or `--demo` for paper trading) and exercise the menu items, which hit every endpoint.

## Architecture

`BTTradeClient` (`src/client.js`) is composed (not inherited), owning one `Transport`, one `AuthSession`, and one instance of each endpoint class. Construction wires `Transport` ↔ `AuthSession` together in a two-step dance because the session needs the transport to make auth calls, and the transport needs the session to refresh on 401:

1. Construct `Transport` with no session.
2. Construct `AuthSession` with the transport.
3. Call `transport.setSession(auth)` to complete the cycle.

`Transport` (`src/transport.js`) is the only code that calls `fetch`. It:
- injects `Authorization: Bearer <at>` on every URL except `/api/auth/time` and `/api/auth/token`,
- calls `session.getAccessToken({ refreshIfNear: true })` so the session can lazy-refresh an expired access token before the request fires,
- on a 401 response, calls `session.refresh()` and retries the original request **once** (`isRetry` flag guards against loops),
- redacts `Authorization`, `password`, `code`, `access_token`, and `refresh_token` from logs unless `debug: true`.

`AuthSession` (`src/auth.js`) owns tokens and the refresh lifecycle. The model verified against the live Angular bundle:
- Step 1 `POST /api/RefreshToken` (JSON) with creds → pending `access_token` + SMS details.
- `otpProvider({ username, prefix, details, expiresIn })` resolves to the 5-digit code.
- Step 2 re-posts the same body with `?code=<otp>` and the pending token as `Bearer` → real `access_token` + wrapped refresh token `{"Token":"<hex>","Expires":"<ISO>"}` (parsed by `parseRefreshToken`).
- Refresh endpoint: same `/api/RefreshToken` but **form-encoded** in real mode, **JSON** in demo mode (`form: !this.demo`).
- Three refresh strategies run concurrently: (a) a background `setTimeout` fires `RT_FIRE_MARGIN_MS` before the refresh token expires; (b) an on-request lazy refresh when AT is past `expiresAt`; (c) a reactive 401-retry from `Transport`. In-flight refreshes dedupe via `this._refreshing`.
- If refresh fails with an `AuthError` and the original login's password is still in memory (`this._password`), `#tryRelogin` kicks off a fresh `login()` including re-prompting the OTP provider. If the password was lost (i.e., session restored from a snapshot), `onExpired` is invoked so the caller can prompt the user.
- `onSessionChange(snapshot|null)` fires on login, every refresh (tokens rotate), and logout. Persistence is the caller's responsibility — this library never writes to disk.

Endpoints (`src/endpoints/*.js`) are thin: each takes a transport, validates required args (throwing `ValidationError`), and returns the parsed JSON. Do **not** attempt to normalize field names in response bodies — some are typos in the server API (notably `InvestmentAmmount` in `PositionItem`). The types in `src/types.js` document the exact live shapes.

## Repo-specific conventions

- **URL paths are stable, unusual:** most resources live under `/api/api/...` (yes, doubled); auth is under `/api/RefreshToken` and `/api/api/User/Logout`. Don't "fix" the doubling.
- **Dates:** server accepts `DD.MM.YYYY` (Romanian) only. Use `toServerDate()` exported from `src/endpoints/portfolio.js` — it also accepts `Date` and `YYYY-MM-DD`. ISO will get a 400.
- **`portfolioKey` is not a UUID:** it's `selectedPortfolioID` from the profile payload, an underscore-joined list of portfolio IDs. Always source it from `accounts.list()` or the raw profile.
- **`currencyId` is mandatory** on `portfolio.getCash()` / `getCashDetails()` (server 404s otherwise). Use `accounts.defaultCurrencyId(account)` or values from `reference.listEvaluationCurrencies()`.
- **Demo mode** is triggered by passing `demo: true` to `BTTradeClient`. It prepends `/demo` to every path via `Transport.pathPrefix` and switches the refresh-token encoding to JSON. Never hardcode demo paths in endpoint files.
- **Market orders need a limit preview:** `orders.preview({ type: 'market' })` returns meaningless worst-case numbers. Fetch live bid/ask via `markets.getInstrument()` and preview as `type: 'limit'` at that price — see the README for the pattern.
- **Order placement is two-phase:** `orders.placeOrder()` first hits `/Orders/GetConfirmation` (action=`sign`), then `/Orders/SaveOrder` with `signed: true`. Both are required; the server rejects a `SaveOrder` without a matching confirmation. Write endpoints requiring recaptcha + questionnaire answers (`SaveOrder` with advisory flow, `SaveChangeOrder`) are intentionally not implemented — see the comment at the top of `src/endpoints/orders.js`.
- **No SignalR / WebSocket.** Live price and PNL updates on the real platform come from SignalR — this client is HTTP snapshot-only, by design. Do not add streaming.
- **ESM only:** `"type": "module"` in `package.json`. Use `.js` extensions in relative imports. No TypeScript — types are JSDoc referencing `src/types.js`.
- **Zero runtime dependencies.** The only `node:` imports are `node:crypto` (for `defaultNtfyTopic`) and `node:readline/promises` (lazy-loaded inside `stdinOtpProvider`). Adding a dependency is a significant change — justify it.
- **Public API surface is `src/index.js`** — everything re-exported from there is considered stable. Internal helpers stay unexported.
- **OTP providers are pluggable:** any `async ({ username, prefix, details, expiresIn }) => digits`. Three are shipped: `stdinOtpProvider` (interactive), `ntfyOtpProvider` (phone→ntfy.sh pipeline, multi-account safe via `username` filter), and `defaultNtfyTopic(username)` for a deterministic-but-guessable topic fallback. The provider may return the code with or without the prefix — `normalizeOtp` strips it.

## When modifying endpoints

Each endpoint file begins with a verbatim reference to the Angular service function it mirrors (e.g., `NomenclaturesService.getExchanges()` in `chunk-3PI5VRGE.js`). Keep these comments in sync when adjusting a call, and prefer verifying against the current web bundle over guessing. If you discover a new endpoint, document the chunk name and service name the same way.
