/**
 * Orders endpoints.
 *
 * Verified order-service `Ja` in chunk-IU5POLU6.js:
 *
 *   search(criteria, queryModel)
 *     → POST ${apiUrl}/Orders/Search
 *       Body: { queryModel,
 *               criteria: { portfolioKey, statuses, side, symbol,
 *                           interval, startDate, endDate } }
 *
 *   getOrder(orderNumber)
 *     → GET ${apiUrl}/Orders/Get?orderNumber=<n>
 *
 *   getOrderActions(orderNumber)
 *     → GET ${apiUrl}/Orders/GetOrderActions?orderNumber=<n>
 *
 *   getOrderHistory(orderNumber)
 *     → GET ${apiUrl}/Orders/History/Get?orderNumber=<n>
 *
 *   performBulkAction(action, orderNumbers)
 *     → POST ${apiUrl}/Orders/PerformAction
 *       Body: { action, orderNumbers }
 *
 * Write operations (SaveOrder, SaveChangeOrder) are NOT implemented here yet
 * — they require recaptcha and a questionnaire `answers` payload. Add when
 * trading support is added.
 */

import { ValidationError } from '../errors.js';
import { toServerDate } from './portfolio.js';

export class OrdersApi {
  /** @param {import('../transport.js').Transport} transport */
  constructor(transport) { this.transport = transport; }

  /**
   * Search orders with pagination + filters.
   *
   * @param {object} args
   * @param {string} args.portfolioKey
   * @param {string[]|number[]} [args.statuses]   - server-known status codes; omit to return all
   * @param {'buy'|'sell'|string} [args.side]
   * @param {string} [args.symbol]
   * @param {string|number} [args.interval]       - a value from listPortfolioIntervals() or similar
   * @param {string|Date} [args.startDate]        - DD.MM.YYYY | 'YYYY-MM-DD' | Date; sent as DD.MM.YYYY
   * @param {string|Date} [args.endDate]          - DD.MM.YYYY | 'YYYY-MM-DD' | Date; sent as DD.MM.YYYY
   * @param {object} [args.queryModel]            - defaults to { page: 1, pageSize: 200 }
   */
  search({ portfolioKey, statuses, side, symbol, interval, startDate, endDate, queryModel } = {}) {
    if (!portfolioKey) throw new ValidationError('orders.search: portfolioKey required');
    const qm = { ...(queryModel || {}) };
    if (qm.page === undefined) qm.page = 1;
    if (qm.pageSize === undefined) qm.pageSize = 200;
    return this.transport.post('/api/api/Orders/Search', {
      body: {
        queryModel: qm,
        criteria: {
          portfolioKey,
          statuses: statuses ?? null,
          side: side ?? null,
          symbol: symbol ?? null,
          interval: interval ?? null,
          startDate: startDate ? toServerDate(startDate) : null,
          endDate: endDate ? toServerDate(endDate) : null,
        },
      },
    });
  }

  /** Fetch a single order by order number. */
  get(orderNumber) {
    if (!orderNumber) throw new ValidationError('orders.get: orderNumber required');
    return this.transport.get('/api/api/Orders/Get', { query: { orderNumber } });
  }

  /** Available actions (cancel, modify, …) on a given order. */
  getActions(orderNumber) {
    if (!orderNumber) throw new ValidationError('orders.getActions: orderNumber required');
    return this.transport.get('/api/api/Orders/GetOrderActions', { query: { orderNumber } });
  }

  /** Per-order execution history (fills, state transitions). */
  getHistory(orderNumber) {
    if (!orderNumber) throw new ValidationError('orders.getHistory: orderNumber required');
    return this.transport.get('/api/api/Orders/History/Get', { query: { orderNumber } });
  }
}
