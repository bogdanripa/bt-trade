/**
 * JSDoc type definitions for bt-trade API responses.
 *
 * All shapes were verified against live API responses from evo.bt-trade.ro.
 * Import in JSDoc via: @type {import('./types.js').TypeName}
 */

// ─── Shared ──────────────────────────────────────────────────────────────────

/**
 * @template T
 * @typedef {object} PaginatedResult
 * @property {T[]}   Items
 * @property {number} Page
 * @property {number} PageSize
 * @property {number} TotalItemCount
 */

// ─── Profile ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} PortfolioCurrency
 * @property {number} currencyId
 * @property {string} country
 * @property {number} id
 * @property {string} name
 */

/**
 * @typedef {object} ClientPortfolio
 * @property {PortfolioCurrency[]} currencies
 * @property {number}  id
 * @property {string}  name
 * @property {boolean} allowOrders
 * @property {boolean} allowTransfers
 * @property {number}  selectedCurrencyId
 */

/**
 * @typedef {object} Client
 * @property {number}           id
 * @property {string}           displayName
 * @property {string}           relation
 * @property {string}           selectedPortfolioID   - used as `portfolioKey` in most API calls
 * @property {ClientPortfolio[]} portfolios
 * @property {boolean}          allowTrading
 * @property {boolean}          allowTopUp
 * @property {boolean}          allowView
 * @property {boolean}          allowEdit
 * @property {boolean}          allowUpdate
 * @property {boolean}          allowFatca
 * @property {boolean}          pending
 * @property {boolean}          approved
 * @property {boolean}          isInEditing
 * @property {number|null}      pendingClientId
 * @property {any[]}            pendingRequests
 */

/**
 * Response from GET /User/GetUserProfile
 * @typedef {object} UserProfile
 * @property {number}   id
 * @property {number}   userID
 * @property {string}   displayName
 * @property {string}   theme
 * @property {string}   language
 * @property {string}   landingPage
 * @property {string}   lastLogin
 * @property {string}   serverTime
 * @property {boolean}  signLater
 * @property {boolean}  balancesPanelCollapsed
 * @property {boolean}  portfolioPanelCollapsed
 * @property {boolean}  listsPanelCollapsed
 * @property {boolean}  groupedView
 * @property {number}   portfolioPanelViewID
 * @property {number}   selectedPortfolioPanelCurrencyID
 * @property {number}   selectedClientID
 * @property {Client[]} clients
 * @property {any[]}    notifications
 */

// ─── Accounts ────────────────────────────────────────────────────────────────

/**
 * Normalized account descriptor returned by `accounts.list()`.
 * @typedef {object} Account
 * @property {number}           id
 * @property {string}           displayName
 * @property {string}           relation
 * @property {string}           portfolioKey   - pass this to portfolio/order endpoints
 * @property {boolean}          selected       - true if this is the server-selected client
 * @property {boolean}          allowTrading
 * @property {boolean}          allowTopUp
 * @property {boolean}          allowView
 * @property {boolean}          allowEdit
 * @property {boolean}          allowUpdate
 * @property {boolean}          allowFatca
 * @property {boolean}          pending
 * @property {boolean}          approved
 * @property {ClientPortfolio[]} portfolios
 * @property {Client}           raw            - full raw client object from the profile payload
 */

// ─── Portfolio ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} MoneyValue
 * @property {string} formatted   - localised display string, e.g. "1,234.56"
 * @property {number} amount
 * @property {string} currency    - ISO code, e.g. "RON"
 * @property {string} direction   - "none" | "up" | "down"
 */

/**
 * One row in the GetBalances response array.
 * @typedef {object} BalanceEntry
 * @property {string}     title
 * @property {string}     type
 * @property {MoneyValue} value
 * @property {string}     highlightText
 * @property {string}     highlightBackground
 * @property {number}     balanceId
 */

/**
 * One entry inside a BalanceInfoSection.
 * `highlightText` is a boolean that marks section totals / header rows.
 * @typedef {object} BalanceInfoEntry
 * @property {string}  title
 * @property {string}  type
 * @property {boolean} highlightText
 * @property {boolean} highlightBackground
 * @property {number}  balanceId
 */

/**
 * One section in the GetBalancesInfo response array.
 * @typedef {object} BalanceInfoSection
 * @property {string}            title
 * @property {BalanceInfoEntry[]} balances
 */

/**
 * One row in the GetAccountsTransfer response array.
 * @typedef {object} AccountTransfer
 * @property {string}      title
 * @property {number}      currencyId
 * @property {string}      currency
 * @property {string}      country
 * @property {object}      balance            - nested object with `.value.formatted`
 * @property {object}      availableTransfer  - nested object with `.value.formatted`
 * @property {any[]}       allowedTransfers
 */

/**
 * @typedef {{ id: number, name: string }} StatusRef
 */

/**
 * One row in the GetBankAccounts response array.
 * @typedef {object} BankAccount
 * @property {string}    bankAccountId
 * @property {string}    accountNumber
 * @property {string}    bank
 * @property {number}    bankId
 * @property {number}    currencyId
 * @property {string}    currency
 * @property {string}    country
 * @property {number}    countryId
 * @property {string}    swift
 * @property {boolean}   enrollable
 * @property {any}       payment
 * @property {any}       balance
 * @property {StatusRef} status
 */

/**
 * Summary totals row within PortfolioTotal.Positions.
 * @typedef {object} PositionSummary
 * @property {string}  Key
 * @property {string}  Name
 * @property {string}  Ticker
 * @property {string}  AssetType
 * @property {number}  CurrencyId
 * @property {number}  Percent
 * @property {any}     Info
 * @property {number}  Investment
 * @property {number}  Evaluation
 * @property {any[]}   MoneyBalances
 */

/**
 * @typedef {object} MoneyBalance
 * @property {string}  Title
 * @property {string}  SubTitle
 * @property {string}  Type
 * @property {number}  Value
 * @property {any}     ValueDetails
 * @property {string}  HighlightText
 * @property {string}  HighlightBackground
 * @property {number}  BalanceId
 */

/**
 * @typedef {object} CurrencyRate
 * @property {number} Rate
 * @property {number} ID
 * @property {string} Name
 */

/**
 * @typedef {object} PortfolioTotal
 * @property {number}            CurrencyId
 * @property {PositionSummary[]} Positions
 * @property {MoneyBalance[]}    MoneyBalances
 * @property {CurrencyRate[]}    CurrencyRates
 */

/**
 * One open position row in the Portfolio/Select response.
 * Note: the server spells "Amount" as "Ammount" — that typo is in the API.
 * @typedef {object} PositionItem
 * @property {string}  Key
 * @property {string}  Code
 * @property {string}  Market
 * @property {string}  MarketState
 * @property {string}  SecurityName
 * @property {number}  InvestmentAmmount   - server typo; mirrors the live field name
 * @property {number}  SecurityBalance
 * @property {number}  AvgPrice
 * @property {number}  InvestedPercent
 * @property {number}  PercentFromTotal
 * @property {number}  CloseAmount
 * @property {number}  PriceVariation
 * @property {number}  LineEvaluation
 * @property {number}  GainLoss
 * @property {number}  SecurityId
 * @property {string}  DateShort
 * @property {boolean} Blocked
 * @property {any}     Activity
 * @property {any}     Orders
 * @property {any}     Changes
 */

/**
 * Response from POST /Portfolio/Select
 * @typedef {object} PortfolioSelectResult
 * @property {PaginatedResult<PositionItem>} Positions
 * @property {PortfolioTotal}                Total
 * @property {string}                        SubscriptionKey
 */

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * One order row from Orders/Search.
 * @typedef {object} Order
 * @property {string}  OrderNumber
 * @property {string}  OrderNumberDisplay
 * @property {string}  Code
 * @property {string}  Symbol
 * @property {string}  SecurityName
 * @property {string}  Market
 * @property {string}  Date
 * @property {string}  DateShort
 * @property {string}  ValidUntil
 * @property {number}  ExchangeId
 * @property {number}  SecurityId
 * @property {number}  MarketCurrencyId
 * @property {number}  SettlementCurrencyId
 * @property {number}  Close
 * @property {number}  Quantity
 * @property {number}  FilledQuantity
 * @property {number}  RemainingQuantity
 * @property {number}  DisclosedQuantity
 * @property {number}  Price
 * @property {number}  TriggerPrice
 * @property {string}  PortfolioKey
 * @property {string}  SideDisplay
 * @property {string}  SideDisplayShort
 * @property {string}  ValabilityDisplay
 * @property {string}  TypeDisplay
 * @property {string}  PriceDisplay
 * @property {string}  Logo
 * @property {any}     Status
 * @property {any}     Side
 * @property {any}     Type
 * @property {any}     Valability
 * @property {any}     ContingentType
 * @property {any}     TriggerType
 * @property {any}     ViewMode
 * @property {any}     Sign
 * @property {boolean} View
 * @property {boolean} Edit
 * @property {boolean} Cancel
 * @property {boolean} Print
 * @property {boolean} Hidden
 * @property {boolean} Signed
 */
