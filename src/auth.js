/**
 * Authentication lifecycle for bt-trade.ro.
 *
 * Verified against the live Angular bundle (chunk-FFWVNPBH.js):
 *
 *   login(t, r, o, i) {
 *     let s = o ? `?code=${o}` : '';
 *     POST ${authUrl}/RefreshToken${s}  (application/json)
 *     Body: { grant_type:'password', username: t.replace(/\s/g,''),
 *             password: encodeURIComponent(r), client_id:'bttrade',
 *             recaptcha: i ?? '', platform:'', version: null }
 *   }
 *
 *   refreshLogin(t) {
 *     POST ${authUrl}/RefreshToken  (application/x-www-form-urlencoded)
 *     Body: `grant_type=refresh_token&client_id=bttrade&refresh_token=${t}`
 *   }
 *
 *   logout(t) {
 *     DELETE ${apiUrl}/User/Logout?token=${t}
 *   }
 *
 * Step 1 carries creds, step 2 carries the typed 5-digit OTP in the URL as
 * ?code=<otp>. Step 2 must also send Authorization: Bearer <pending-token>
 * from step 1 (the Angular interceptor attaches it transparently).
 */

import crypto from 'node:crypto';
import { AuthError, ValidationError, errorFromResponse } from './errors.js';

const AUTH_PATH = '/api/RefreshToken';
const LOGOUT_PATH = '/api/api/User/Logout';
const CLIENT_ID = 'bttrade';

/**
 * @typedef {object} SessionSnapshot
 * @property {string} username
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt        - epoch ms when the access token expires
 * @property {string|null} sessionId
 */

/**
 * @typedef {object} OtpPromptInfo
 * @property {string} username      - username being authenticated (useful for multi-account providers)
 * @property {string} prefix        - displayed-only 2-digit prefix returned by step 1
 * @property {string} details       - human-readable message from server (romanian)
 * @property {number} expiresIn     - seconds until the SMS code expires
 */

/**
 * @typedef {(info: OtpPromptInfo) => Promise<string>} OtpProvider
 *   Function the caller supplies to produce the SMS code. Receives the prefix,
 *   the details message, and the expiresIn window. Should return the typed
 *   digits (with or without the prefix — it will be normalized).
 */

const SAFETY_MARGIN_MS = 60_000;  // refresh proactively when <60s to expiry

/**
 * Owns the tokens and knows how to renew them. Injected into Transport.
 */
export class AuthSession {
  /**
   * @param {object} opts
   * @param {import('./transport.js').Transport} opts.transport
   * @param {OtpProvider}                          opts.otpProvider
   * @param {(msg:string,data?:any)=>void}        [opts.log]
   * @param {(snap: SessionSnapshot|null)=>void|Promise<void>} [opts.onSessionChange]
   *   Invoked whenever the session state changes (after login, refresh, or
   *   logout). Callers use it to persist the snapshot. Called with `null` on
   *   logout. Exceptions from the callback are logged but not rethrown.
   */
  constructor(opts) {
    if (!opts.transport) throw new ValidationError('AuthSession: transport is required');
    if (!opts.otpProvider) throw new ValidationError('AuthSession: otpProvider is required');
    this.transport = opts.transport;
    this.otpProvider = opts.otpProvider;
    this.log = opts.log || (() => {});
    this.onSessionChange = opts.onSessionChange || null;

    /** @type {SessionSnapshot | null} */
    this.snapshot = null;
    /** @type {string | null} password in memory, used for step-2 retry after step-1 */
    this._password = null;
    /** @type {Promise<void> | null} in-flight refresh, deduped for concurrent calls */
    this._refreshing = null;
  }

  // ---- factory / restore ----

  /** Restore from a prior `snapshot`; only needs access/refresh tokens to operate. */
  restore(snapshot) {
    if (!snapshot || !snapshot.accessToken || !snapshot.refreshToken) {
      throw new ValidationError('AuthSession.restore: snapshot must include access/refresh tokens');
    }
    this.snapshot = { ...snapshot };
    this._password = null;
  }

  /** Returns a serializable snapshot, safe to persist. Does NOT include the password. */
  toSnapshot() {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  /**
   * Full login flow: step 1 (creds) -> prompt OTP -> step 2 (creds + ?code).
   * Returns the session snapshot on success.
   */
  async login(username, password) {
    if (!username || !password) {
      throw new ValidationError('login: username and password are required');
    }

    const cleanUser = String(username).replace(/\s/g, '');
    const baseBody = {
      grant_type: 'password',
      username: cleanUser,
      password: encodeURIComponent(password),
      client_id: CLIENT_ID,
      recaptcha: '',
      platform: '',
      version: null,
    };

    // Step 1
    const r1 = await this.transport.post(AUTH_PATH, { body: baseBody, noAuth: true });

    // A fully successful (no 2FA) response has refresh_token. Otherwise we expect
    // a pending access_token plus a `details` message announcing the SMS.
    if (!r1.refresh_token) {
      if (!r1.access_token) {
        throw new AuthError('Login response missing tokens', { body: r1 });
      }
      const prefix = r1.prefix || '';
      const info = {
        username: cleanUser,
        prefix,
        details: r1.details || 'SMS code required',
        expiresIn: Number(r1.expires_in) || 0,
      };
      const typed = await this.otpProvider(info);
      const digits = normalizeOtp(typed, prefix);
      if (!digits) throw new ValidationError('OTP provider returned no digits');

      const pendingToken = r1.access_token;
      // Step 2: same body, add ?code=<otp>, send pending token as bearer.
      const r2 = await this.transport.post(AUTH_PATH, {
        body: baseBody,
        query: { code: digits },
        bearer: pendingToken,
      });
      if (!r2.refresh_token || !r2.access_token) {
        throw new AuthError('OTP accepted but session tokens missing', { body: r2 });
      }
      this.#adoptTokens(cleanUser, r2, password);
      await this.#emitChange();
      return this.toSnapshot();
    }

    this.#adoptTokens(cleanUser, r1, password);
    await this.#emitChange();
    return this.toSnapshot();
  }

  /**
   * Returns a non-expired access token. Triggers refresh() if within the
   * safety margin of expiry and the caller asked for auto-refresh.
   */
  async getAccessToken({ refreshIfNear = false } = {}) {
    if (!this.snapshot) throw new AuthError('Not logged in', { code: 'NOT_LOGGED_IN' });
    if (refreshIfNear && Date.now() + SAFETY_MARGIN_MS >= this.snapshot.expiresAt) {
      await this.refresh();
    }
    return this.snapshot.accessToken;
  }

  /**
   * Refresh the access token using the refresh_token. Concurrent callers share
   * a single in-flight promise to avoid burning the refresh_token.
   */
  refresh() {
    if (!this.snapshot) throw new AuthError('Cannot refresh: no session', { code: 'NOT_LOGGED_IN' });
    if (this._refreshing) return this._refreshing;

    const rt = this.snapshot.refreshToken;
    this._refreshing = (async () => {
      try {
        const body = {
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: rt,
        };
        const r = await this.transport.post(AUTH_PATH, { body, form: true, noAuth: true });
        if (!r.access_token) {
          throw new AuthError('Refresh response missing access_token', { body: r });
        }
        this.snapshot.accessToken = r.access_token;
        if (r.refresh_token) this.snapshot.refreshToken = r.refresh_token;
        this.snapshot.expiresAt = tokenExpiry(r);
        if (r.SessionId) this.snapshot.sessionId = String(r.SessionId);
        this.log('auth:refreshed', { expiresAt: new Date(this.snapshot.expiresAt).toISOString() });
        await this.#emitChange();
      } finally {
        this._refreshing = null;
      }
    })();
    return this._refreshing;
  }

  /**
   * Revoke the server-side session. Safe to call when not logged in.
   * Best-effort: network failures or stale tokens will NOT prevent local state
   * from being cleared (and the onSessionChange callback from firing).
   */
  async logout() {
    if (!this.snapshot) return;
    const token = this.snapshot.accessToken;
    try {
      // Use the current access token as-is; don't pre-refresh. If it's
      // expired, the server will accept or reject — either way we proceed
      // to wipe local state.
      await this.transport.delete(LOGOUT_PATH, {
        query: { token },
        bearer: token,
        noRefresh: true,
      });
    } catch (e) {
      this.log('auth:logout:server-error', { message: e.message });
    } finally {
      this.snapshot = null;
      this._password = null;
      await this.#emitChange();  // fires with null snapshot
    }
  }

  // ---- private ----

  async #emitChange() {
    if (!this.onSessionChange) return;
    try {
      await this.onSessionChange(this.toSnapshot());
    } catch (e) {
      this.log('auth:onSessionChange:error', { message: e.message });
    }
  }

  #adoptTokens(username, tokenResp, password) {
    this.snapshot = {
      username,
      accessToken: tokenResp.access_token,
      refreshToken: tokenResp.refresh_token,
      expiresAt: tokenExpiry(tokenResp),
      sessionId: tokenResp.SessionId ? String(tokenResp.SessionId) : null,
    };
    this._password = password || null;
  }
}

// ---------- helpers ----------

/**
 * Resolve the access-token expiry from a token response.
 * Prefers the server's absolute `expiration` ISO string (avoids request-latency
 * drift); falls back to computing from `expires_in` seconds.
 */
function tokenExpiry(r) {
  if (r.expiration) {
    const t = new Date(r.expiration).getTime();
    if (!isNaN(t)) return t;
  }
  return Date.now() + (Number(r.expires_in) || 599) * 1000;
}

/**
 * Strip non-digits and remove the prefix if the user accidentally included it.
 * Matches the behaviour of the Cordova SMS retriever in the 2FA component.
 */
export function normalizeOtp(typed, prefix) {
  const digits = String(typed).replace(/\D/g, '');
  if (prefix && digits.startsWith(prefix) && digits.length > prefix.length) {
    return digits.slice(prefix.length);
  }
  return digits;
}

/**
 * OTP provider that subscribes to an ntfy.sh topic and waits for a message
 * addressed to the current username. Designed for "phone shortcut forwards
 * the SMS" flows, where a hardcoded stable URL beats a per-run tunnel.
 *
 * Multi-account safe: many clients can share a single topic because the
 * provider filters by `username`. Messages for other users are ignored.
 *
 * Accepted message shapes (tried in this order):
 *
 *  1. The raw SMS body forwarded verbatim by an iOS/Android automation.
 *     The provider searches it for `<prefix>-<digits>` using the `prefix`
 *     returned by step 1 of the login (e.g. "25"), so a message like
 *     "Codul ... BT Trade este 25-74456 ..." yields code `74456`.
 *  2. JSON: {"username":"MYUSER","code":"12345"}
 *  3. Plain "username:code" or "username code"
 *  4. Bare 4–8 digit string
 *
 * @param {object} [opts]
 * @param {string} [opts.topic]           - ntfy topic (your stable URL slug). If omitted, a
 *                                          deterministic topic is derived from the username
 *                                          via `defaultNtfyTopic(username)` (still stable per user
 *                                          across runs; see SECURITY note in the README).
 * @param {string} [opts.server]          - default 'https://ntfy.sh'
 * @param {number} [opts.timeoutMs]       - abort if no matching message arrives; default 5 min
 * @param {string} [opts.since]           - ntfy `since` filter; default '30s' to catch messages
 *                                           the phone posted just before Node subscribed
 * @param {(msg:string,data?:any)=>void} [opts.log]
 */
export function ntfyOtpProvider(opts = {}) {
  const { topic: explicitTopic, server = 'https://ntfy.sh', timeoutMs = 5 * 60 * 1000, since = '30s', log = () => {} } = opts;

  return async ({ username, prefix, details }) => {
    const topic = explicitTopic || defaultNtfyTopic(username);
    process.stderr.write(`\n[2FA] ${details}\n`);
    process.stderr.write(`      Waiting for OTP on ${server}/${topic} (user: ${username}, prefix: ${prefix || '—'}) …\n`);
    if (!explicitTopic) {
      process.stderr.write(`      (default topic derived from username; hardcode this URL in your phone shortcut)\n`);
    }

    const url = `${server.replace(/\/$/, '')}/${encodeURIComponent(topic)}/json?since=${encodeURIComponent(since)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/x-ndjson' } });
      if (!res.ok) throw new AuthError(`ntfy subscribe failed: ${res.status} ${await res.text().catch(() => '')}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      // Process NDJSON stream: one JSON envelope per line.
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new AuthError('ntfy stream ended without a matching message');
        buf += decoder.decode(value, { stream: true });

        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;

          let envelope;
          try { envelope = JSON.parse(line); } catch { continue; }
          if (envelope.event !== 'message') continue;   // skip 'open' / 'keepalive'

          const { user: msgUser, code } = parseNtfyBody(envelope.message, prefix);
          if (msgUser && msgUser !== username) {
            log('ntfy:skipped', { reason: 'username-mismatch', msgUser });
            continue;
          }
          if (code) return code;
        }
      }
    } finally {
      clearTimeout(timer);
      try { controller.abort(); } catch (_) {}
    }
  };
}

/**
 * Deterministic default topic for a given username: `bt-trade-otp-<16 hex chars>`
 * where the hex is SHA-256 of the username. Stable across runs; unique per user.
 *
 * SECURITY NOTE: because the derivation is deterministic and the input space
 * (BT Trade usernames) is small, a determined attacker who scrapes the source
 * and enumerates usernames could guess the topic and subscribe to it. Without
 * your password the OTP is still useless on its own, but if you want a
 * stronger secret, pass an explicit `topic` with at least 128 bits of entropy
 * (e.g. `crypto.randomUUID()`).
 */
export function defaultNtfyTopic(username) {
  if (!username) throw new ValidationError('defaultNtfyTopic: username is required');
  const hex = crypto.createHash('sha256').update('bt-trade-otp/' + username).digest('hex').slice(0, 16);
  return `bt-trade-otp-${hex}`;
}

/**
 * Parse an ntfy message body to extract { user, code }. Tolerant of several shapes.
 *
 * Accepted body shapes (tried in order of specificity):
 *
 *   1. Structured JSON with an explicit code:
 *        {"username":"MYUSER","code":"74456"}
 *
 *   2. JSON wrapping the raw SMS (iOS Shortcuts' "Get Contents of URL" action
 *      only offers JSON / Form / File, so the iOS flow posts something like):
 *        {"body":"Codul tau BT Trade este 25-74456. Nu il transmite nimanui."}
 *      — any of `body`, `message`, `text`, `sms`, or `content` is recognized.
 *      If `prefix` is known, the inner text is searched for `<prefix>-<digits>`.
 *
 *   3. Raw text (plain-text SMS forwarding, Android apps, curl) — same
 *      `<prefix>-<digits>` search runs directly on the message body.
 *
 *   4. Plain `username:code` or `username code` shorthand.
 *
 *   5. Bare 4–8 digit string.
 */
function parseNtfyBody(raw, prefix) {
  if (!raw || typeof raw !== 'string') return { user: null, code: null };
  const s = raw.trim();

  // If it's JSON, unwrap common shapes — we may extract code directly, or
  // fall through to regex-on-text with a richer starting string.
  let text = s;
  let user = null;
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      user = obj.username || obj.user || null;
      // 1) Explicit code field wins.
      if (obj.code !== undefined && obj.code !== null) {
        const code = String(obj.code).replace(/\D/g, '');
        if (code) return { user, code };
      }
      // 2) Wrapped SMS body — replace `text` for the regex pass below.
      const wrapped = obj.body ?? obj.message ?? obj.text ?? obj.sms ?? obj.content;
      if (typeof wrapped === 'string' && wrapped.length > 0) text = wrapped;
    }
  } catch (_) { /* not JSON → text stays as-is */ }

  // 3) `<prefix>-<digits>` anywhere in the text.
  if (prefix) {
    const re = new RegExp(escapeRegex(String(prefix)) + '-(\\d{3,8})\\b');
    const hit = text.match(re);
    if (hit) return { user, code: hit[1] };
  }

  // 4) "username:code" or "username code" shorthand (only meaningful if we didn't
  //    already get a user/text from a JSON wrapper).
  const m = text.match(/^([A-Za-z0-9_.\-]+)[\s:]+(\d{4,8})\b/);
  if (m) return { user: user || m[1], code: m[2] };

  // 5) Bare digits.
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 4 && digits.length <= 8) return { user, code: digits };

  return { user, code: null };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Interactive OTP provider for CLI use. Prompts on stdin/stdout. */
export function stdinOtpProvider() {
  return async ({ prefix, details }) => {
    // Lazy import readline so the module can be used headlessly.
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stderr.write(`\n[2FA] ${details}\n`);
      if (prefix) process.stderr.write(`      Prefix (display only): "${prefix}"\n`);
      const answer = await rl.question('Enter SMS code: ');
      return answer.trim();
    } finally {
      rl.close();
    }
  };
}
