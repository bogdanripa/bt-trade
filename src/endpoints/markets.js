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
}
