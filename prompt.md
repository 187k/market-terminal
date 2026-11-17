# Project: Crypto Market Intelligence Platform

## 1. Overall Objective

Develop a unified platform for monitoring, analyzing, and finding trading opportunities in the cryptocurrency market.

The application must consist of two main components:

1. **Telegram bots** — send notifications about market events, anomalies, and potential trading opportunities.
2. **Web Dashboard** — a single browser-based panel with quotes, market metrics, signal tables, and settings for all bots.

The main task of the application is to collect market data from multiple cryptocurrency exchanges in real time, normalize it, and find interesting market situations.

### Supported Exchanges

- Bybit
- Binance
- MEXC
- Hyperliquid
- Bitget
- BingX
- Gate.io

Use public REST APIs and WebSocket APIs of the exchanges wherever possible.

**Important:** do not assume that all exchanges provide the same set of data. For each exchange, verify the availability of specific metrics and document the limitations.

---

## 2. Technical Requirements

### Architecture

Develop the application as a modular system with separation of responsibilities:

- Exchange Connectors — connecting to exchanges and receiving market data.
- Market Data Engine — normalization, processing, and storage of current data.
- Analytics Engine — calculation of metrics and detection of market anomalies.
- Bot Services — the logic of each Telegram bot.
- API Server — interaction between the web panel and the backend.
- Web Dashboard — data visualization and application management.

Use a modular architecture so that adding a new exchange or bot does not require rewriting existing components.

### Preferred Technology Stack

- Backend: Node.js + TypeScript.
- API: Fastify.
- Frontend: React + TypeScript + Vite.
- Database: PostgreSQL.
- ORM: Prisma for regular data operations.
- Cache / Pub-Sub: Redis.
- Realtime: WebSocket.
- Telegram: grammY.
- Deployment: Docker Compose.

Using native exchange WebSocket and REST APIs instead of universal libraries is allowed if this provides more reliable access to the required data.

Do not use a heavy microservice architecture without real necessity. A modular system with separate processes for data collection, the API, and the Telegram bots is preferred.

### Performance

- Updates of current market data should happen as close to real time as possible.
- The target frequency for internal processing and updating of aggregated metrics is about 1 second, if the data source allows it.
- Use WebSocket to receive the data stream instead of constantly polling the REST API.
- Use the REST API for initial loading, retrieving missing data, and periodic synchronization.
- Avoid excessive requests to exchanges.
- Handle request rate limits (Rate Limits).
- Implement automatic reconnection when a WebSocket connection is lost.
- Monitor the freshness of incoming data.
- Do not save every high-frequency update to PostgreSQL unnecessarily: use Redis and batch writes.

**Important:** the target processing frequency does not mean that every exchange guarantees an update of all metrics every second. The actual update frequency of each source must be taken into account.

---

# 3. Telegram Bots

Each bot must be an independent module with its own business logic, filter settings, and notification system.

## Bot #1. Fair Price Scanner

### Objective

Find futures contracts whose Market Price deviates significantly from the Mark Price / Fair Price.

### Displayed Information

- Coin name and trading pair with a link to the exchange.
- Exchange.
- Fair Price / Mark Price.
- Market Price / Last Price.
- Index Price.
- Deviation of Market Price from Fair Price in percent.
- Deviation of Fair Price from Index Price in percent.
- Potential direction: LONG or SHORT.
- Maximum available leverage, if available via the API.
- Approximate liquidity and available order book volume.
- Funding Rate.
- Funding interval.
- Time until the next Funding.
- Risk level.

### Logic

If Market Price is below Fair Price — a potential LONG situation.

If Market Price is above Fair Price — a potential SHORT situation.

Formula:

deviation = (Market Price - Fair Price) / Fair Price * 100

Additionally, calculate the deviation of Fair Price from Index Price.

If Fair Price deviates significantly from Index Price, add a warning.

Implement configurable deviation thresholds, minimum liquidity, volume filtering, and exclusion of stale data.

The LONG / SHORT direction is an analytical signal, not a guaranteed trading recommendation.

---

## Bot #2. Open Interest Scanner

### Objective

Track sharp changes in Open Interest on cryptocurrency futures.

Find coins in which the number of open contracts is rapidly increasing or decreasing.

### Displayed Information

- Ticker.
- Exchange.
- OI Change over 5 minutes.
- OI Change over 30 minutes.
- OI Change over 1 hour.
- OI Change over 4 hours.
- OI change in number of coins.
- Current OI value.
- Previous OI value.
- OI change in USD.
- Current price.
- Price change over the corresponding periods.
- Funding Rate.
- Long / Short Ratio, if available.
- 24-hour trading volume.

### Logic

Implement configurable filters:

- Minimum OI growth over 5 minutes.
- Minimum OI growth over 30 minutes.
- Minimum OI growth over 4 hours.
- Minimum OI decline.
- Minimum trading volume.
- Minimum liquidity.
- Minimum OI value in USD.

Support signals on both OI growth and OI decline.

Calculate changes relative to historical snapshots of the metric.

Formula:

OI Change (%) = (Current OI - Previous OI) / Previous OI * 100

### Classification of Market Scenarios

1. Price rises + OI rises.
2. Price falls + OI rises.
3. Price rises + OI falls.
4. Price falls + OI falls.

Do not interpret OI growth exclusively as the opening of LONG positions. Keep in mind that every open contract has a counterparty on the opposite side.

---

## Bot #3. Funding Rate Scanner

### Objective

Collect the Funding Rate for the same coin across different exchanges, and find extreme rates and cross-exchange discrepancies.

### Displayed Information

- Ticker.
- Exchange.
- Funding Rate.
- Funding period: 1h, 4h, 8h, etc.
- Normalized 24-hour Funding Rate.
- Contract price on each exchange.
- Time until the next settlement.
- Funding difference between exchanges.

### Logic

- Compare the Funding Rate across all available exchanges.
- Convert rates to a single period — 24 hours.
- Find the maximum positive and negative rates.
- Identify potential Funding Arbitrage combinations.
- Highlight extreme values.
- Update messages when Funding changes significantly.
- Show the time until the next settlement.
- Separate the current Funding Rate from the predicted Funding Rate for the next period.

Normalization must take into account the actual accrual period:

Funding 24h = Funding Rate × (24 / Funding Interval Hours)

Take into account the specifics of rate calculation on different exchanges.

---

## Bot #4. Cross-Exchange Spread Scanner

### Objective

Look for significant price discrepancies of the same cryptocurrency between different exchanges.

The main goal is to detect potential cross-exchange arbitrage opportunities.

### Main Information

- Coin.
- Size of the price discrepancy between venues in percent.
- Suggested direction, for example SHORT / Bybit.
- Trading instrument: Spot / Perpetual.
- Exchange with the highest price.
- Exchange with the lowest price.
- Buy price.
- Sell price.
- Spread in percent.
- Average price across available exchanges.
- Deviation from the average price.
- Potential profit in USD.
- Position size.
- Available liquidity in the order book.
- Funding Rate of both sides.
- Funding interval.
- Funding converted to a daily rate.
- 24-hour trading volume.
- Deposit and withdrawal availability, if the information is available.
- Index Price and Mark Price.
- Risk level.
- Verification of trading contract compatibility.

### Potential Profit Calculation

For each combination:

1. Calculate the number of coins.
2. Calculate the purchase cost.
3. Calculate the sale proceeds.
4. Calculate the gross profit.
5. Subtract the trading fees of both sides.
6. Account for slippage.
7. Account for Funding, if applicable.
8. Calculate the potential net profit.

Buying must take place on the cheaper venue, selling on the more expensive one.

Use real Bid / Ask prices and order book depth in calculations, not just the Last Price.

When possible, calculate VWAP for the given position size.

Compare only truly comparable instruments, taking into account the trading pair, quote currency, contract type, and contract size.

Separate the gross Spread from the Net Spread after fees and estimated slippage.

If there is no data on fees, transfers, or liquidity, explicitly state that the calculation is preliminary.

---

## Bot #5. TWAP / DCA / Large Trade Detector

### Objective

Detect large buys and sells that may be executed gradually through many small trades.

The goal is to find signs of activity by large market participants.

### Displayed Information

- Ticker.
- Exchange.
- Direction: BUY / SELL.
- Size of the detected order or estimated volume.
- Actually executed volume, if available.
- Execution percentage, if available.
- Status: active / completed / unknown.
- Wallet address, if available from a public on-chain source.
- History of the participant's large trades, if available.
- Average execution price.
- Price change since the start of the activity.
- Market Cap.
- Trading volume.

### Logic

- Detection of large trades.
- Analysis of the sequence of trades for a single instrument.
- Identification of repeated trades of similar size at short time intervals.
- Determination of the presumed direction of accumulation or distribution.
- Analysis of volume, frequency, and duration of trades.
- Tracking of price changes during the detected activity.
- Notifications when activity is detected and when it changes.

### Important Limitations

Do not treat every large sequence of trades as a real TWAP order.

If the exchange does not provide public information about other participants' algorithmic orders, use your own heuristic pattern-detection algorithm.

Separately label data confirmed by the exchange and assumptions made by the algorithm.

Do not invent wallet addresses or participant history. Obtain address information only from suitable public on-chain sources, where technically possible.

Add a confidence score — the degree of the algorithm's confidence in the detected pattern.

---

# 4. Web Dashboard

Develop a browser-based control panel for all bots and market data.

### Design

- Dark theme.
- Minimalist interface in the style of professional trading terminals.
- Responsive layout.
- Tables with sorting and filtering.
- Data updates without reloading the page.
- Color highlighting of positive and negative changes.
- Display of the time of the last data update.

### Main Page

The main page must contain 5 separate working windows:

1. Fair Price Scanner.
2. Open Interest Scanner.
3. Funding Rate Scanner.
4. Cross-Exchange Spread Scanner.
5. TWAP / DCA Detector.

Each window must contain:

- Bot name.
- Operating status.
- Main detected signals.
- Latest updates.
- Key metrics.
- A button to open the detailed view.
- Filter settings.

### Additional Features

- Enabling and disabling each bot.
- Configuring signal thresholds.
- Filtering by exchange.
- Filtering by trading pair.
- Filtering by volume and liquidity.
- History of detected signals.
- Viewing detailed information for each coin.
- Display of the state of exchange connections.
- Display of API and WebSocket problems.

---

# 5. Data Processing and Reliability

This is one of the most important components of the application.

A unified data normalization system must be implemented.

Create a separate Connector for each exchange that converts the original API responses into a single internal format.

For example, different exchanges may use different designations for:

- Mark Price.
- Index Price.
- Last Price.
- Open Interest.
- Funding Rate.
- Funding Interval.
- Contract Size.

Internal modules must not depend on the original data format of a specific exchange.

### Data Processing Requirements

- Timestamp control.
- Validation of values.
- Handling of missing data.
- Detection of stale quotes.
- Automatic connection recovery.
- Protection against duplicate signals.
- Rate Limit control.
- API error handling.
- Logging of errors and events.
- Tracking the state of each connection.

Do not substitute fictitious values when data is missing. Use null or an unavailable status with an indication of the reason.

---

# 6. Telegram Notifications

Each bot must have an independent notification delivery system.

Implement:

- Configuration of notification thresholds.
- Configuration of minimum liquidity and volume.
- Selection of tracked exchanges.
- Selection of trading pairs.
- Protection against repeated notifications.
- Cooldown between identical signals.
- Updating existing messages when a signal changes significantly, where appropriate.

All key parameters must be configurable without changing the source code.

---

# 7. Testing and Documentation

The following must be implemented:

- Unit tests of mathematical calculations.
- Tests of data normalization for different exchanges.
- Integration tests of API connections.
- Verification of WebSocket reconnection.
- Verification of handling of missing and invalid data.
- Testing of signal detection algorithms.

Create documentation:

- README.md.
- Architecture description.
- Project structure description.
- Installation instructions.
- Instructions for configuring environment variables.
- Instructions for running via Docker Compose.
- Description of each bot.
- Description of the API and data sources.

---

# 8. Development Order

Do not try to implement the entire system in one big change.

Work sequentially, in small stages.

### Stage 1. Analysis and Design

Before writing the main code:

1. Analyze the requirements.
2. Review the official API documentation of all seven exchanges.
3. Compile a table of availability of the required data for each exchange.
4. Determine which data is available via WebSocket and which via REST.
5. Determine API limitations and Rate Limits.
6. Identify functionality that cannot be implemented on the basis of public data.
7. Prepare the application architecture.
8. Define the project structure.
9. Draw up a sequential development plan.

At this stage, do not start mass code generation. First provide the analysis results and the plan.

### Stage 2. Basic Infrastructure

- Creating the project structure.
- Setting up Backend and Frontend.
- Setting up PostgreSQL and Redis.
- Setting up Docker Compose.
- Creating the logging system.
- Creating the basic exchange connection system.

### Stage 3. Exchange Integration

- Implement the general Exchange Connectors system.
- Start with Bybit and Binance.
- Verify data retrieval and normalization.
- After testing, add the remaining exchanges.
- Verify WebSocket stability and connection recovery.

### Stage 4. Bot Development

Implement and test the bots sequentially:

1. Fair Price Scanner.
2. Open Interest Scanner.
3. Funding Rate Scanner.
4. Cross-Exchange Spread Scanner.
5. TWAP / DCA Detector.

Each bot must be tested before moving on to the next.

### Stage 5. Web Dashboard

- Create the interface.
- Connect the API.
- Implement WebSocket updates.
- Create the five working windows.
- Add settings, filters, and signal history.

### Stage 6. Final Testing

- Verification of all integrations.
- Performance verification.
- Connection stability verification.
- Verification of calculation correctness.
- Verification of Telegram notification operation.
- Preparation of the production configuration.

---

# 9. Working Rules

During development, observe the following principles:

1. Do not create fictitious data and do not imitate API operation.
2. Do not assume the existence of functions that are not in the exchange's official documentation.
3. When required data is unavailable, explicitly state the limitations.
4. Do not duplicate business logic between bots.
5. Move common calculations and handlers into separate modules.
6. Do not create an unnecessarily complex architecture.
7. Monitor performance and the number of requests.
8. After each stage, run tests and verify the result.
9. Do not rewrite working components without necessity.
10. Explain important architectural decisions.

**Main priority:** reliability and accuracy of market data, correctness of mathematical calculations, stable real-time operation, and the ability to extend the system further.

The application must be exclusively an analytical tool. At this stage, do not implement automatic opening and closing of trading positions.

---

# 10. Scalability and Architecture

Develop the application with the possibility of further functional expansion in mind.

Main requirements:

1. Use a modular architecture so that each of the five bots has independent business logic.
2. Create a common system for connecting to exchanges and receiving market data that all analytical modules can use.
3. Avoid code duplication and coupling of business logic with the interface.
4. Provide for the possibility of adding new exchanges, analytical modules, and Dashboard sections without major rework of existing code.

New indicators, a Heatmap, Market Sentiment, etc. are planned for the future, as well as a graphical Trading Terminal. For now, you only need to account for the possibility of such expansion, without developing these features.

**Important:** choose the optimal technical solutions yourself, keeping a balance between simplicity, performance, and scalability.
