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
  /**
   * @returns {Promise<import('../types.js').PaginatedResult<import('../types.js').Order>>}
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

  /**
   * Fetch a single order by order number.
   * @returns {Promise<import('../types.js').Order>}
   */
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

  /**
   * Preview an order — returns fee breakdown, margin impact, and estimated total
   * before committing. Call this to show the user what they're about to pay.
   *
   * @param {object} args
   * @param {string} args.portfolioKey
   * @param {string} args.symbol          - ticker code, e.g. "TVBETETF"
   * @param {number} args.marketId        - exchange ID from markets.list()
   * @param {number|string|null} [args.quantity]
   * @param {number|string} args.price
   * @param {'buy'|'sell'} args.side
   * @param {'limit'|'market'} [args.type]  - default 'limit'
   */
  preview({ portfolioKey, symbol, marketId, quantity = null, price, side, type = 'limit' } = {}) {
    if (!portfolioKey) throw new ValidationError('orders.preview: portfolioKey required');
    if (!symbol)       throw new ValidationError('orders.preview: symbol required');
    if (!marketId)     throw new ValidationError('orders.preview: marketId required');
    if (!side)         throw new ValidationError('orders.preview: side required');
    return this.transport.post('/api/api/Orders/GetOrderDetails', {
      body: {
        portfolioKey,
        symbol: { code: symbol, marketId: Number(marketId) },
        quantity: quantity !== null && quantity !== undefined ? String(quantity) : null,
        price:    price !== undefined && price !== null ? String(price) : null,
        side,
        type,
      },
    });
  }

  /**
   * Place and sign an order in a single step.
   * Internally calls GetConfirmation (to register the intent) then SaveOrder.
   *
   * @param {object} args
   * @param {string} args.portfolioKey
   * @param {string} args.symbol           - ticker code, e.g. "TVBETETF"
   * @param {number} args.marketId         - exchange ID from markets.list()
   * @param {number|string} args.quantity
   * @param {number|string} args.price
   * @param {'buy'|'sell'} args.side
   * @param {'limit'|'market'} [args.type]        - default 'limit'
   * @param {'day'|'gtc'|string} [args.valability] - default 'day'
   * @returns {Promise<any>}  server response from SaveOrder
   */
  async placeOrder({ portfolioKey, symbol, marketId, quantity, price, side, type = 'limit', valability = 'day' } = {}) {
    if (!portfolioKey) throw new ValidationError('orders.placeOrder: portfolioKey required');
    if (!symbol)       throw new ValidationError('orders.placeOrder: symbol required');
    if (!marketId)     throw new ValidationError('orders.placeOrder: marketId required');
    if (!quantity)     throw new ValidationError('orders.placeOrder: quantity required');
    if (!side)         throw new ValidationError('orders.placeOrder: side required');
    if (type !== 'market' && !price) throw new ValidationError('orders.placeOrder: price required for non-market orders');

    const order = {
      symbol:      { code: symbol, marketId: Number(marketId) },
      portfolioKey,
      quantity:    String(quantity),
      side,
      price:       price !== undefined && price !== null ? String(price) : null,
      type,
      valability,
      signed:      false,
      recaptcha:   null,
    };

    // Step 1: register the intent — server may validate and record the order.
    await this.transport.post('/api/api/Orders/GetConfirmation', {
      body: { action: 'sign', order, orderNumbers: [] },
    });

    // Step 2: submit with signed: true.
    return this.transport.post('/api/api/Orders/SaveOrder', {
      body: { order: { ...order, signed: true }, recaptcha: null },
    });
  }
}
