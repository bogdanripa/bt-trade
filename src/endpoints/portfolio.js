/**
 * Portfolio endpoints (balances + positions).
 *
 * Verified service `ns` in chunk-IU5POLU6.js:
 *
 *   getBalance(portfolioKey, currencyId)
 *     → GET ${apiUrl}/Portfolio/GetBalances?portfolioKey&currencyId
 *
 *   getBalanceInfo(portfolioKey, currencyId)
 *     → GET ${apiUrl}/Portfolio/GetBalancesInfo?portfolioKey&currencyId
 *
 *   search(criteria, queryModel)
 *     queryModel.page = 1; queryModel.pageSize = 200;  // mutated by service
 *     → POST ${apiUrl}/Portfolio/Select
 *       Body: { queryModel,
 *               criteria: { portfolioKey, endDate } }
 *
 * The server is strict about parameters:
 *   - currencyId is REQUIRED for both balance endpoints (404 "Content not
 *     found." otherwise).
 *   - endDate must be in Romanian format DD.MM.YYYY — verified from the
 *     caller side: `endDate = r[1].format("DD.MM.YYYY")`. Anything else
 *     yields a 400 ModelState error.
 *
 * Live price/PNL updates are pushed via SignalR (NOT used by this client —
 * snapshot-only by design).
 */

import { ValidationError } from '../errors.js';

export class PortfolioApi {
  /** @param {import('../transport.js').Transport} transport */
  constructor(transport) { this.transport = transport; }

  /**
   * Cash balances for a portfolio, expressed in the given evaluation currency.
   * @param {object} args
   * @param {string} args.portfolioKey
   * @param {number|string} args.currencyId   - REQUIRED. Use a value from
   *   `client.reference.listEvaluationCurrencies()` or the user's profile
   *   `selectedPortfolioPanelCurrencyID`.
   * @param {{ portfolioKey: string, currencyId: number|string }} args
   * @returns {Promise<import('../types.js').BalanceEntry[]>}
   */
  getCash({ portfolioKey, currencyId } = {}) {
    if (!portfolioKey) throw new ValidationError('getCash: portfolioKey required');
    if (currencyId === undefined || currencyId === null || currencyId === '') {
      throw new ValidationError('getCash: currencyId required (use evaluation currency id)');
    }
    return this.transport.get('/api/api/Portfolio/GetBalances', {
      query: { portfolioKey, currencyId },
    });
  }

  /**
   * Extended cash details (includes blocked, transferable, evaluated totals).
   * @param {{ portfolioKey: string, currencyId: number|string }} args
   * @returns {Promise<import('../types.js').BalanceInfoSection[]>}
   */
  getCashDetails({ portfolioKey, currencyId } = {}) {
    if (!portfolioKey) throw new ValidationError('getCashDetails: portfolioKey required');
    if (currencyId === undefined || currencyId === null || currencyId === '') {
      throw new ValidationError('getCashDetails: currencyId required');
    }
    return this.transport.get('/api/api/Portfolio/GetBalancesInfo', {
      query: { portfolioKey, currencyId },
    });
  }

  /**
   * Cash transfer relationships for the portfolio.
   * @param {{ portfolioKey: string }} args
   * @returns {Promise<import('../types.js').AccountTransfer[]>}
   */
  getCashTransfers({ portfolioKey } = {}) {
    if (!portfolioKey) throw new ValidationError('getCashTransfers: portfolioKey required');
    return this.transport.get('/api/api/Portfolio/GetAccountsTransfer', { query: { portfolioKey } });
  }

  /**
   * Linked bank accounts.
   * @param {{ portfolioKey: string }} args
   * @returns {Promise<import('../types.js').BankAccount[]>}
   */
  getBankAccounts({ portfolioKey } = {}) {
    if (!portfolioKey) throw new ValidationError('getBankAccounts: portfolioKey required');
    return this.transport.get('/api/api/Portfolio/GetBankAccounts', { query: { portfolioKey } });
  }

  /**
   * Holdings snapshot (open positions + valuation) at `endDate`.
   *
   * @param {object} args
   * @param {string} args.portfolioKey
   * @param {string} [args.market]         - filter by market code, e.g. "BVB", "LSE USD". Client-side.
   * @param {string|Date} [args.endDate]   - DD.MM.YYYY, ISO 'YYYY-MM-DD', or Date.
   *                                          Defaults to today. Sent as DD.MM.YYYY.
   * @param {object} [args.queryModel]     - {fieldKeys, sortKey, sortDirection, page, pageSize}
   * @returns {Promise<import('../types.js').PortfolioSelectResult>}
   */
  async getHoldings({ portfolioKey, market, endDate, queryModel } = {}) {
    if (!portfolioKey) throw new ValidationError('getHoldings: portfolioKey required');
    const qm = { ...(queryModel || {}) };
    if (qm.page === undefined) qm.page = 1;
    if (qm.pageSize === undefined) qm.pageSize = 200;
    const result = await this.transport.post('/api/api/Portfolio/Select', {
      body: {
        queryModel: qm,
        criteria: { portfolioKey, endDate: toServerDate(endDate) },
      },
    });
    if (market && result?.Positions?.Items) {
      result.Positions.Items = result.Positions.Items.filter((p) => p.Market === market);
      result.Positions.TotalItemCount = result.Positions.Items.length;
    }
    return result;
  }
}

/** Accept Date | 'YYYY-MM-DD' | 'DD.MM.YYYY' | undefined; output DD.MM.YYYY. */
export function toServerDate(input) {
  let d;
  if (!input) {
    d = new Date();
  } else if (input instanceof Date) {
    d = input;
  } else if (typeof input === 'string') {
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(input)) return input;            // already DD.MM.YYYY
    if (/^\d{4}-\d{2}-\d{2}/.test(input)) d = new Date(input);        // ISO
    else d = new Date(input);
  } else {
    throw new ValidationError(`toServerDate: unsupported input ${typeof input}`);
  }
  if (isNaN(d.getTime())) throw new ValidationError(`toServerDate: invalid date ${input}`);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}
