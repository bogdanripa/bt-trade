/**
 * Markets = trading venues (exchanges).
 *
 * Verified: NomenclaturesService.getExchanges() in chunk-3PI5VRGE.js calls
 *   GET ${apiUrl}/Nomenclatures/GetExchanges
 *
 * All other lookup/enum endpoints live in `reference.js`.
 */

export class MarketsApi {
  /** @param {import('../transport.js').Transport} transport */
  constructor(transport) { this.transport = transport; }

  /** List of exchanges (markets) available for trading. */
  list() {
    return this.transport.get('/api/api/Nomenclatures/GetExchanges');
  }

  /**
   * Search for instruments by ticker code. Returns all matches across markets,
   * each with the correct `marketId` to pass to orders.preview() / orders.placeOrder().
   *
   * @param {string} code  - ticker symbol, e.g. "TSLA", "TVBETETF"
   * @returns {Promise<Array<{code:string, marketId:number, market:string, currency:string, name:string, exchange:string, isin:string}>>}
   */
  searchInstrument(code) {
    if (!code) throw new Error('markets.searchInstrument: code required');
    return this.transport.get('/api/api/PersonalLists/Instrument/GetInstrumentsByCode', {
      query: { code: String(code).toUpperCase() },
    });
  }

  /**
   * Fetch live instrument data including bid/ask prices, currency, and trading rules
   * for a specific symbol on a specific market.
   *
   * @param {object} args
   * @param {string} args.portfolioKey
   * @param {string} args.code      - ticker symbol, e.g. "TSLA"
   * @param {number} args.marketId  - exchange ID from searchInstrument() or markets.list()
   * @returns {Promise<{bid:number, ask:number, currency:string, market:string, name:string, status:string, allowMarket:boolean}>}
   */
  getInstrument({ portfolioKey, code, marketId } = {}) {
    if (!portfolioKey) throw new Error('markets.getInstrument: portfolioKey required');
    if (!code)         throw new Error('markets.getInstrument: code required');
    if (!marketId)     throw new Error('markets.getInstrument: marketId required');
    return this.transport.post('/api/api/PersonalLists/Instrument/GetBySymbol', {
      query: { portfolioKey },
      body:  { code: String(code).toUpperCase(), marketId: Number(marketId) },
    });
  }
}
