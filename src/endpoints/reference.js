/**
 * Reference data (nomenclatures / enums / lookups).
 *
 * These are server-side lookup tables — mostly static, rarely change.
 * Caller should cache them locally if they're on a hot path.
 *
 * All endpoints verified against NomenclaturesService in chunk-3PI5VRGE.js.
 */

export class ReferenceApi {
  /** @param {import('../transport.js').Transport} transport */
  constructor(transport) { this.transport = transport; }

  /** Currencies used on the platform. */
  listCurrencies() {
    return this.transport.get('/api/api/Nomenclatures/GetCurrencies');
  }

  /** Subset of currencies usable for portfolio evaluation. */
  listEvaluationCurrencies() {
    return this.transport.get('/api/api/Nomenclatures/GetCurrenciesForEvaluation');
  }

  /** Account types available across exchanges (Spot / Margin / FIDELIS / etc.). */
  listAccountTypes() {
    return this.transport.get('/api/api/Nomenclatures/GetAccountTypes');
  }

  /** Order status values (Active, Filled, Cancelled, ...) accepted by Orders/Search. */
  listOrderStatuses() {
    return this.transport.get('/api/api/Nomenclatures/GetOrderStatuses');
  }

  /** Trade types. */
  listTradeTypes() {
    return this.transport.get('/api/api/Nomenclatures/GetTradeTypes');
  }

}
