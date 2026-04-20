/**
 * Public API surface. Everything a consumer needs.
 *
 * Typical usage:
 *
 *   import { BTTradeClient, stdinOtpProvider } from 'bt-trade';
 *
 *   const client = new BTTradeClient({ otpProvider: stdinOtpProvider() });
 *   await client.login({ username, password });
 *   const profile = await client.profile.get();
 */

export { BTTradeClient } from './client.js';
export { AuthSession, stdinOtpProvider, ntfyOtpProvider, defaultNtfyTopic, normalizeOtp } from './auth.js';
export { Transport } from './transport.js';
export { toServerDate } from './endpoints/portfolio.js';

export {
  BTTradeError,
  AuthError,
  NetworkError,
  ApiError,
  ValidationError,
} from './errors.js';

// Response-shape type definitions live in './types.js'.
// Reference them in JSDoc via: @type {import('bt-trade/src/types.js').TypeName}
