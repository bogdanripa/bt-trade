/**
 * HTTP transport for the BT Trade API.
 *
 * Mirrors the behaviour of the live Angular HTTP interceptor:
 *   - injects Authorization: Bearer <access_token> on every URL except the
 *     exclusion list (/api/auth/time, /api/auth/token);
 *   - on 401, refreshes the access token (using the refresh_token flow) and
 *     retries the original request ONCE;
 *   - never retries on 2xx/4xx other than 401, never retries on refresh failure;
 *   - treats non-JSON bodies transparently (some endpoints return quoted strings).
 *
 * The transport is stateful: it holds a reference to an AuthSession, and calls
 * session.refresh() when it needs a new access token. The AuthSession is
 * responsible for knowing how to refresh.
 */

import { errorFromResponse, NetworkError, AuthError } from './errors.js';

const AUTH_EXCLUSIONS = ['/api/auth/time', '/api/auth/token'];

/**
 * @typedef {object} TransportOptions
 * @property {string} [baseUrl]        - defaults to https://evo.bt-trade.ro
 * @property {object} [session]        - AuthSession (see auth.js)
 * @property {(msg:string,data?:any)=>void} [log]  - optional logger for debug
 * @property {number} [timeoutMs]      - per-request timeout (default 30_000)
 */

export class Transport {
  /** @param {TransportOptions} opts */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || 'https://evo.bt-trade.ro';
    this.session = opts.session || null;
    this.log = opts.log || (() => {});
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Attach the AuthSession AFTER construction (useful when session depends on transport). */
  setSession(session) { this.session = session; }

  /**
   * Perform an HTTP request with automatic auth-header injection and 401 retry.
   *
   * @param {string} method                - 'GET' | 'POST' | 'PUT' | 'DELETE'
   * @param {string} path                  - path starting with '/'
   * @param {object} [opts]
   * @param {any}    [opts.body]           - JSON-serialized unless opts.form=true
   * @param {boolean}[opts.form]           - send body as application/x-www-form-urlencoded
   * @param {object} [opts.query]          - appended to the URL as a query string
   * @param {object} [opts.headers]
   * @param {boolean}[opts.noAuth]         - skip Authorization header
   * @param {boolean}[opts.noRefresh]      - skip both proactive and reactive token refresh (for logout)
   * @param {boolean}[opts.isRetry]        - internal flag, caller should not set
   * @param {string|null} [opts.bearer]    - override Authorization with a specific bearer token
   * @returns {Promise<any>}               - parsed response body on 2xx, throws otherwise
   */
  async request(method, path, opts = {}) {
    const url = this.#buildUrl(path, opts.query);
    const needsAuth = !opts.noAuth && !AUTH_EXCLUSIONS.some((x) => url.toLowerCase().includes(x));

    // Pick bearer: explicit override wins, else session's current access token.
    let bearer = opts.bearer === undefined ? null : opts.bearer;
    if (needsAuth && bearer === null && this.session) {
      bearer = await this.session.getAccessToken({ refreshIfNear: !opts.noRefresh });
    }

    const headers = {
      Accept: 'application/json, text/plain, */*',
      ...(opts.headers || {}),
    };
    if (bearer) headers['Authorization'] = 'Bearer ' + bearer;

    let body;
    if (opts.body !== undefined) {
      if (opts.form) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
        body = typeof opts.body === 'string' ? opts.body : toFormUrlencoded(opts.body);
      } else {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      }
    }

    this.log('http:request', { method, url: redactUrl(url), headers: redactHeaders(headers), body: redactBody(body) });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (e) {
      throw new NetworkError(`${method} ${url}: ${e.message}`, { cause: e });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = text; }

    this.log('http:response', {
      status: res.status,
      url: redactUrl(url),
      // Print enough of the body to see refresh_token presence, but still
      // redacted. For auth endpoints show more; for data endpoints keep short.
      bodyPreview: typeof text === 'string'
        ? redactBody(text).slice(0, url.includes('/RefreshToken') ? 2000 : 400)
        : text,
    });

    if (res.status === 401 && needsAuth && !opts.isRetry && !opts.noRefresh && this.session) {
      // One-shot refresh-and-retry, matching the live Angular interceptor behavior.
      try {
        await this.session.refresh();
      } catch (e) {
        throw new AuthError('Session refresh failed after 401', { cause: e });
      }
      return this.request(method, path, { ...opts, isRetry: true });
    }

    if (!res.ok) {
      throw errorFromResponse(res.status, parsed, url);
    }
    return parsed;
  }

  /** Convenience wrappers. */
  get(path, opts) { return this.request('GET', path, opts); }
  post(path, opts) { return this.request('POST', path, opts); }
  put(path, opts) { return this.request('PUT', path, opts); }
  delete(path, opts) { return this.request('DELETE', path, opts); }

  // --- private ---

  #buildUrl(path, query) {
    let url = this.baseUrl.replace(/\/$/, '') + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) { for (const x of v) qs.append(k, String(x)); }
        else qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    return url;
  }
}

// ---------- helpers ----------

function toFormUrlencoded(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.join('&');
}

function redactUrl(url) {
  return String(url)
    .replace(/([?&]code=)[^&]*/gi, '$1[REDACTED]')
    .replace(/([?&]token=)[^&]*/gi, '$1[REDACTED]')
    .replace(/([?&]refresh_token=)[^&]*/gi, '$1[REDACTED]');
}

function redactHeaders(h) {
  const out = { ...h };
  if (out.Authorization) out.Authorization = 'Bearer [REDACTED]';
  return out;
}

function redactBody(body) {
  if (typeof body !== 'string') return body;
  return body
    .replace(/("password"\s*:\s*")[^"]*/g, '$1[REDACTED]')
    .replace(/(password=)[^&]*/g, '$1[REDACTED]')
    .replace(/(refresh_token=)[^&]*/g, '$1[REDACTED]')
    .replace(/("refresh_token"\s*:\s*")[^"]*/g, '$1[REDACTED]')
    .replace(/("access_token"\s*:\s*")[^"]*/g, '$1[REDACTED]')
    .replace(/(code=)[^&]*/g, '$1[REDACTED]');
}
