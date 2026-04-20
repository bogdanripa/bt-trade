/**
 * Account endpoints.
 *
 * "Account" on this platform means a trading client (a row in profile.clients[]).
 * Each account has one portfolio key (underscore-joined list of portfolio IDs).
 * For a more-structured list of account *types* available under a portfolio use
 * getAvailableTypes().
 */

import { ValidationError } from '../errors.js';

export class AccountsApi {
  /**
   * @param {import('../transport.js').Transport} transport
   * @param {import('./profile.js').ProfileApi} profileApi
   */
  constructor(transport, profileApi) {
    this.transport = transport;
    this.profileApi = profileApi;
  }

  /**
   * Lists the authenticated user's accounts. Returns an array of normalized
   * account descriptors sourced from the profile payload.
   *
   * Each account has:
   *   id, displayName, relation, portfolioKey, selected,
   *   allow{Trading,TopUp,View,Edit,Update,Fatca}, pending, approved,
   *   portfolios[]         — array of { id, name, currencies[{id,name,...}], ... }
   *                          (the web app uses portfolios[0].currencies[0].id as
   *                           the default evaluation currency for this account)
   *   raw                  — the full raw client object from the profile payload
   */
  async list() {
    const profile = await this.profileApi.get();
    const selected = profile.selectedClientID;
    const arr = Array.isArray(profile.clients) ? profile.clients : [];
    return arr.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      relation: c.relation,
      portfolioKey: c.selectedPortfolioID,
      selected: c.id === selected,
      allowTrading: !!c.allowTrading,
      allowTopUp: !!c.allowTopUp,
      allowView: !!c.allowView,
      allowEdit: !!c.allowEdit,
      allowUpdate: !!c.allowUpdate,
      allowFatca: !!c.allowFatca,
      pending: !!c.pending,
      approved: !!c.approved,
      portfolios: Array.isArray(c.portfolios) ? c.portfolios : [],
      raw: c,
    }));
  }

  /**
   * Convenience: pick the default evaluation currency for an account, the same
   * way the web app's portfolio dropdown does. Returns a number/string id,
   * or null if the account has no currencies on its portfolios.
   */
  defaultCurrencyId(account) {
    if (!account) return null;
    const p = (account.portfolios || [])[0];
    if (!p || !Array.isArray(p.currencies) || !p.currencies.length) return null;
    return p.currencies[0].id ?? null;
  }

  /**
   * The account-type entries available for opening additional accounts under a
   * given portfolio. Mirrors ClientService.GetAvailableAccountTypes(portfolioKey).
   */
  getAvailableTypes(portfolioKey) {
    if (!portfolioKey) throw new ValidationError('getAvailableTypes: portfolioKey required');
    return this.transport.get('/api/api/Client/GetAvailableAccountTypes', {
      query: { portfolioKey },
    });
  }
}
