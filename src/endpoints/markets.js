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
}
