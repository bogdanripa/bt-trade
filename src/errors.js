/**
 * Error hierarchy for the BT Trade client.
 *
 * All errors thrown from the public API are instances of `BTTradeError`.
 * Callers can discriminate on subclass or on `.code` (stable string).
 */

export class BTTradeError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   * @param {string} [details.code]   - stable machine-readable code
   * @param {number} [details.status] - HTTP status when applicable
   * @param {any}    [details.body]   - server response body when applicable
   * @param {Error}  [details.cause]  - underlying error
   */
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = details.code || 'BT_ERROR';
    if (details.status !== undefined) this.status = details.status;
    if (details.body !== undefined) this.body = details.body;
    if (details.cause) this.cause = details.cause;
  }
}

/** Problems authenticating: wrong creds, wrong OTP, expired/revoked tokens, locked account. */
export class AuthError extends BTTradeError {
  constructor(message, details = {}) {
    super(message, { code: 'AUTH_ERROR', ...details });
  }
}

/** Problems reaching the server: DNS, TLS, connection reset, timeout. */
export class NetworkError extends BTTradeError {
  constructor(message, details = {}) {
    super(message, { code: 'NETWORK_ERROR', ...details });
  }
}

/** Server responded with a non-2xx status we couldn't recover from. */
export class ApiError extends BTTradeError {
  constructor(message, details = {}) {
    super(message, { code: 'API_ERROR', ...details });
  }
}

/** Caller-provided input failed validation before a network call was made. */
export class ValidationError extends BTTradeError {
  constructor(message, details = {}) {
    super(message, { code: 'VALIDATION_ERROR', ...details });
  }
}

/**
 * Build an ApiError (or AuthError for 401/403) from a failing HTTP response.
 * @param {number} status
 * @param {any} body   - parsed body (may be string if non-JSON)
 * @param {string} url
 */
export function errorFromResponse(status, body, url) {
  const msg =
    (body && typeof body === 'object' && (body.error_description || body.details || body.message))
    || (typeof body === 'string' ? body : `HTTP ${status}`);
  const details = { status, body };
  const isInvalidGrant = body && typeof body === 'object' && body.error === 'invalid_grant';
  if (status === 401 || status === 403 || isInvalidGrant) {
    return new AuthError(`Auth rejected by ${url}: ${msg}`, details);
  }
  return new ApiError(`${url} failed: ${msg}`, details);
}
