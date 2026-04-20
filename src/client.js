/**
 * BTTradeClient — the main entry point consumers use in applications.
 *
 * Composition (no inheritance):
 *   BTTradeClient
 *     ├─ transport : Transport           (HTTP layer with auth + 401 retry)
 *     ├─ auth      : AuthSession         (login, refresh, logout)
 *     ├─ profile   : ProfileApi
 *     ├─ markets   : MarketsApi
 *     ├─ accounts  : AccountsApi
 *     ├─ portfolio : PortfolioApi
 *     └─ orders    : OrdersApi
 *
 * A client is stateful (holds tokens). Construct one, call login() once (or
 * restore() from a persisted snapshot), then call endpoint methods. The
 * transport transparently refreshes the access token on 401 or near expiry.
 */

import { Transport } from './transport.js';
import { AuthSession, stdinOtpProvider } from './auth.js';
import { ProfileApi } from './endpoints/profile.js';
import { MarketsApi } from './endpoints/markets.js';
import { ReferenceApi } from './endpoints/reference.js';
import { AccountsApi } from './endpoints/accounts.js';
import { PortfolioApi } from './endpoints/portfolio.js';
import { OrdersApi } from './endpoints/orders.js';
import { ValidationError } from './errors.js';

/**
 * @typedef {object} ClientOptions
 * @property {string}   [baseUrl]        - default 'https://evo.bt-trade.ro'
 * @property {import('./auth.js').OtpProvider} [otpProvider]
 *                                       - default: interactive stdin (CLI use only)
 * @property {(msg:string,data?:any)=>void} [log]   - optional logger; pass console.error for debug
 * @property {number}   [timeoutMs]      - per-request timeout, default 30_000
 * @property {(snap: import('./auth.js').SessionSnapshot | null) => void | Promise<void>}
 *          [onSessionChange]           - persistence hook (called after login/refresh/logout)
 */

export class BTTradeClient {
  /** @param {ClientOptions} [opts] */
  constructor(opts = {}) {
    this.transport = new Transport({
      baseUrl: opts.baseUrl,
      log: opts.log,
      timeoutMs: opts.timeoutMs,
    });
    this.auth = new AuthSession({
      transport: this.transport,
      otpProvider: opts.otpProvider || stdinOtpProvider(),
      log: opts.log,
      onSessionChange: opts.onSessionChange,
    });
    // Wire auth into transport so it can refresh on 401.
    this.transport.setSession(this.auth);

    this.profile = new ProfileApi(this.transport);
    this.markets = new MarketsApi(this.transport);
    this.reference = new ReferenceApi(this.transport);
    this.accounts = new AccountsApi(this.transport, this.profile);
    this.portfolio = new PortfolioApi(this.transport);
    this.orders = new OrdersApi(this.transport);
  }

  /**
   * Authenticate with username + password + OTP (via otpProvider).
   * Returns a session snapshot you can persist.
   *
   * @param {object} args
   * @param {string} args.username
   * @param {string} args.password
   * @returns {Promise<import('./auth.js').SessionSnapshot>}
   */
  login({ username, password } = {}) {
    if (!username || !password) {
      throw new ValidationError('login: username and password are required');
    }
    return this.auth.login(username, password);
  }

  /** Restore a previously-saved snapshot (e.g., from disk). */
  restore(snapshot) { this.auth.restore(snapshot); }

  /** Returns a serializable snapshot; may be null if not logged in. */
  toSnapshot() { return this.auth.toSnapshot(); }

  /** Ask the server to revoke the session. */
  logout() { return this.auth.logout(); }
}
