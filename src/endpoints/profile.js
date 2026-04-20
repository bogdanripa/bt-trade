/**
 * User profile endpoints.
 *
 * Verified: AuthService.getUserDetails() calls
 *   GET ${apiUrl}/User/GetUserProfile?device=desktop
 * Response includes displayName (== username), userID, clients[], selectedClientID,
 * landingPage, serverTime, notifications[], preferences, etc.
 */

const PATH = '/api/api/User/GetUserProfile';

export class ProfileApi {
  /** @param {import('../transport.js').Transport} transport */
  constructor(transport) { this.transport = transport; }

  /**
   * Fetch the authenticated user's profile.
   * @param {object} [opts]
   * @param {'desktop'|'mobile'} [opts.device='desktop']
   * @returns {Promise<import('../types.js').UserProfile>}
   */
  get({ device = 'desktop' } = {}) {
    return this.transport.get(PATH, { query: { device } });
  }
}
