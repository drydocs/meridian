import { z } from "zod";
import { FixedPointDecimal, SimulationTimestamp } from "./types";
import { BacktestPriceFeed } from "./feeds";

// ============================================================================
// 1. Scenario Definitions & Schema (#874)
// ============================================================================

export const MarketRegimeSchema = z.enum([
  "trending",
  "ranging",
  "high-funding",
]);
export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

export const ScenarioStepSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  spotPrice: z.string(),
  perpPrice: z.string(),
  fundingRate: z.string(), // Periodic funding rate (e.g. "0.0005" for +5 bps per funding interval)
  volume: z.string().optional(),
});
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export const BacktestScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  regime: MarketRegimeSchema,
  asset: z.enum(["USDC", "EURC"] as const),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  seed: z.number().int().optional(),
  startTimestamp: z.number().int().nonnegative(),
  endTimestamp: z.number().int().nonnegative(),
  stepIntervalMs: z.number().int().positive(),
  steps: z.array(ScenarioStepSchema).min(1),
  neutralityBandBps: z.number().positive(), // e.g. 50 bps = 0.50%
  expectedMinCarryPnl: z.string().optional(),
  expectedMaxCarryPnl: z.string().optional(),
});
export type BacktestScenario = z.infer<typeof BacktestScenarioSchema>;

// ============================================================================
// 2. Strategy Interfaces & Delta-Neutral Types
// ============================================================================

export interface StrategyPosition {
  spotAmount: FixedPointDecimal; // Long spot holdings
  perpShortAmount: FixedPointDecimal; // Short perp position (positive = short exposure in base units)
  quoteBalance: FixedPointDecimal; // Cash / quote balance (e.g. USDC)
}

export interface StrategyContext {
  scenario: BacktestScenario;
  stepIndex: number;
  currentStep: ScenarioStep;
  spotPrice: FixedPointDecimal;
  perpPrice: FixedPointDecimal;
  fundingRate: FixedPointDecimal;
  position: StrategyPosition;
}

export interface StrategyRebalanceAction {
  spotTradeDelta: FixedPointDecimal; // > 0 to buy spot, < 0 to sell spot
  perpTradeDelta: FixedPointDecimal; // > 0 to increase short, < 0 to decrease short
}

export interface Strategy<TConfig = unknown> {
  name: string;
  init(scenario: BacktestScenario, config: TConfig): StrategyPosition;
  onStep(context: StrategyContext, config: TConfig): StrategyRebalanceAction;
}

export interface DeltaNeutralStrategyConfig {
  initialCapitalQuote: string; // e.g. "10000.0000000"
  neutralityBandBps: number; // Rebalance threshold in basis points, e.g. 20 (0.2%)
  rebalanceSlippageBps?: number;
}

// ============================================================================
// 3. Metrics & Collection
// ============================================================================

export interface StepMetricRecord {
  timestamp: SimulationTimestamp;
  stepIndex: number;
  spotPrice: FixedPointDecimal;
  perpPrice: FixedPointDecimal;
  fundingRate: FixedPointDecimal;
  spotAmount: FixedPointDecimal;
  perpShortAmount: FixedPointDecimal;
  quoteBalance: FixedPointDecimal;
  spotValueQuote: FixedPointDecimal;
  perpUnrealizedPnl: FixedPointDecimal;
  netDeltaQuote: FixedPointDecimal; // Spot value - Perp short value
  netDeltaBps: number; // (Net Delta / Total Equity) * 10000
  cumulativeCarryPnl: FixedPointDecimal; // Accrued funding payments
  totalEquity: FixedPointDecimal; // Spot value + Quote balance + Perp PnL + Carry
  rebalanceOccurred: boolean;
}

export interface BacktestSummaryMetrics {
  scenarioId: string;
  totalSteps: number;
  initialEquity: FixedPointDecimal;
  finalEquity: FixedPointDecimal;
  netPnl: FixedPointDecimal;
  carryPnl: FixedPointDecimal;
  pricePnl: FixedPointDecimal;
  maxNetDeltaBps: number;
  minNetDeltaBps: number;
  withinNeutralityBand: boolean;
  neutralityBandBps: number;
  totalRebalances: number;
  stepMetrics: StepMetricRecord[];
}

export class MetricsCollector {
  private records: StepMetricRecord[] = [];

  record(metric: StepMetricRecord): void {
    this.records.push(metric);
  }

  getRecords(): StepMetricRecord[] {
    return [...this.records];
  }

  summarize(
    scenario: BacktestScenario,
    initialEquity: FixedPointDecimal
  ): BacktestSummaryMetrics {
    if (this.records.length === 0) {
      throw new Error("Cannot summarize empty metrics records");
    }

    const last = this.records[this.records.length - 1]!;
    const finalEquity = last.totalEquity;
    const netPnl = FixedPointDecimal.fromStroops(
      finalEquity.toStroops() - initialEquity.toStroops()
    );
    const carryPnl = last.cumulativeCarryPnl;
    const pricePnl = FixedPointDecimal.fromStroops(
      netPnl.toStroops() - carryPnl.toStroops()
    );

    let maxNetDeltaBps = -Infinity;
    let minNetDeltaBps = Infinity;
    let totalRebalances = 0;

    for (const r of this.records) {
      if (r.netDeltaBps > maxNetDeltaBps) maxNetDeltaBps = r.netDeltaBps;
      if (r.netDeltaBps < minNetDeltaBps) minNetDeltaBps = r.netDeltaBps;
      if (r.rebalanceOccurred) totalRebalances++;
    }

    const maxAbsDeltaBps = Math.max(
      Math.abs(maxNetDeltaBps),
      Math.abs(minNetDeltaBps)
    );
    const withinNeutralityBand = maxAbsDeltaBps <= scenario.neutralityBandBps;

    return {
      scenarioId: scenario.id,
      totalSteps: this.records.length,
      initialEquity,
      finalEquity,
      netPnl,
      carryPnl,
      pricePnl,
      maxNetDeltaBps,
      minNetDeltaBps,
      withinNeutralityBand,
      neutralityBandBps: scenario.neutralityBandBps,
      totalRebalances,
      stepMetrics: this.records,
    };
  }
}

// ============================================================================
// 4. Shared Backtest Runner (#873)
// ============================================================================

export interface BacktestRunOptions<TConfig = unknown> {
  scenario: BacktestScenario;
  strategy: Strategy<TConfig>;
  config: TConfig;
}

export class BacktestRunner {
  static run<TConfig>(
    options: BacktestRunOptions<TConfig>
  ): BacktestSummaryMetrics {
    const validatedScenario = BacktestScenarioSchema.parse(options.scenario);
    const collector = new MetricsCollector();

    let position = options.strategy.init(validatedScenario, options.config);
    let cumulativeCarryPnlStroops = 0n;
    let perpEntryPriceStroops = 0n;

    // Spot price feed for any spot lookups
    const stepsData = validatedScenario.steps.map((s) => ({
      timestamp: s.timestamp,
      price: s.spotPrice,
    }));
    const dummySteps = [
      { timestamp: validatedScenario.startTimestamp, price: "1.0000000" },
    ];

    const spotFeed = BacktestPriceFeed.create({
      USDC: validatedScenario.asset === "USDC" ? stepsData : dummySteps,
      EURC: validatedScenario.asset === "EURC" ? stepsData : dummySteps,
    });

    const initialEquityStroops =
      position.quoteBalance.toStroops() +
      (position.spotAmount.toStroops() *
        FixedPointDecimal.fromString(
          validatedScenario.steps[0]!.spotPrice
        ).toStroops()) /
        10_000_000n;
    const initialEquity = FixedPointDecimal.fromStroops(initialEquityStroops);

    for (
      let stepIndex = 0;
      stepIndex < validatedScenario.steps.length;
      stepIndex++
    ) {
      const step = validatedScenario.steps[stepIndex]!;
      const spotPrice = spotFeed.getSpotPrice(
        validatedScenario.asset,
        step.timestamp
      );
      const perpPrice = FixedPointDecimal.fromString(step.perpPrice);
      const fundingRate = FixedPointDecimal.fromString(step.fundingRate);

      if (stepIndex === 0 && position.perpShortAmount.toStroops() > 0n) {
        perpEntryPriceStroops = perpPrice.toStroops();
      }

      // Funding carry payment on short perp:
      // When funding rate > 0 (long pays short), short receives: fundingRate * perpPrice * shortAmount
      const fundingPaymentStroops =
        (((position.perpShortAmount.toStroops() * perpPrice.toStroops()) /
          10_000_000n) *
          fundingRate.toStroops()) /
        10_000_000n;
      cumulativeCarryPnlStroops += fundingPaymentStroops;

      // Unrealized PnL on short perp = (EntryPrice - CurrentPerpPrice) * shortAmount
      const perpPriceDiffStroops =
        perpEntryPriceStroops - perpPrice.toStroops();
      const perpUnrealizedPnlStroops =
        (position.perpShortAmount.toStroops() * perpPriceDiffStroops) /
        10_000_000n;

      const spotValueStroops =
        (position.spotAmount.toStroops() * spotPrice.toStroops()) / 10_000_000n;
      const perpValueStroops =
        (position.perpShortAmount.toStroops() * perpPrice.toStroops()) /
        10_000_000n;

      // Net Delta = Spot Value - Perp Short Notional Value
      const netDeltaStroops = spotValueStroops - perpValueStroops;
      const totalEquityStroops =
        spotValueStroops +
        position.quoteBalance.toStroops() +
        perpUnrealizedPnlStroops +
        cumulativeCarryPnlStroops;

      const netDeltaBps =
        totalEquityStroops > 0n
          ? Number((netDeltaStroops * 10000n * 1000n) / totalEquityStroops) /
            1000
          : 0;

      const context: StrategyContext = {
        scenario: validatedScenario,
        stepIndex,
        currentStep: step,
        spotPrice,
        perpPrice,
        fundingRate,
        position,
      };

      const action = options.strategy.onStep(context, options.config);
      let rebalanceOccurred = false;

      // Execute rebalance if requested
      if (
        action.spotTradeDelta.toStroops() !== 0n ||
        action.perpTradeDelta.toStroops() !== 0n
      ) {
        rebalanceOccurred = true;
        const spotTrade = action.spotTradeDelta.toStroops();
        const perpTrade = action.perpTradeDelta.toStroops();

        const newSpotAmount = position.spotAmount.toStroops() + spotTrade;
        const newPerpShort = position.perpShortAmount.toStroops() + perpTrade;
        const tradeCost = (spotTrade * spotPrice.toStroops()) / 10_000_000n;
        const newQuoteBalance = position.quoteBalance.toStroops() - tradeCost;

        position = {
          spotAmount: FixedPointDecimal.fromStroops(newSpotAmount),
          perpShortAmount: FixedPointDecimal.fromStroops(newPerpShort),
          quoteBalance: FixedPointDecimal.fromStroops(newQuoteBalance),
        };
      }

      collector.record({
        timestamp: step.timestamp,
        stepIndex,
        spotPrice,
        perpPrice,
        fundingRate,
        spotAmount: position.spotAmount,
        perpShortAmount: position.perpShortAmount,
        quoteBalance: position.quoteBalance,
        spotValueQuote: FixedPointDecimal.fromStroops(spotValueStroops),
        perpUnrealizedPnl: FixedPointDecimal.fromStroops(
          perpUnrealizedPnlStroops
        ),
        netDeltaQuote: FixedPointDecimal.fromStroops(netDeltaStroops),
        netDeltaBps,
        cumulativeCarryPnl: FixedPointDecimal.fromStroops(
          cumulativeCarryPnlStroops
        ),
        totalEquity: FixedPointDecimal.fromStroops(totalEquityStroops),
        rebalanceOccurred,
      });
    }

    return collector.summarize(validatedScenario, initialEquity);
  }
}

// ============================================================================
// 5. Delta-Neutral Strategy Implementation
// ============================================================================

export class DeltaNeutralStrategy implements Strategy<DeltaNeutralStrategyConfig> {
  readonly name = "DeltaNeutralFundingCarryStrategy";

  init(
    scenario: BacktestScenario,
    config: DeltaNeutralStrategyConfig
  ): StrategyPosition {
    const initialCapital = FixedPointDecimal.fromString(
      config.initialCapitalQuote
    );
    const initialPrice = FixedPointDecimal.fromString(
      scenario.steps[0]!.spotPrice
    );

    // Deploy capital to 1:1 spot long and perp short
    // Spot position value = capital / 2, Cash margin = capital / 2
    // Base units = (capital / 2) / spotPrice
    const halfCapitalStroops = initialCapital.toStroops() / 2n;
    const baseUnitsStroops =
      (halfCapitalStroops * 10_000_000n) / initialPrice.toStroops();
    const remainingQuoteStroops =
      initialCapital.toStroops() - halfCapitalStroops;

    return {
      spotAmount: FixedPointDecimal.fromStroops(baseUnitsStroops),
      perpShortAmount: FixedPointDecimal.fromStroops(baseUnitsStroops),
      quoteBalance: FixedPointDecimal.fromStroops(remainingQuoteStroops),
    };
  }

  onStep(
    context: StrategyContext,
    config: DeltaNeutralStrategyConfig
  ): StrategyRebalanceAction {
    const spotVal =
      (context.position.spotAmount.toStroops() *
        context.spotPrice.toStroops()) /
      10_000_000n;
    const perpVal =
      (context.position.perpShortAmount.toStroops() *
        context.perpPrice.toStroops()) /
      10_000_000n;
    const totalEquity = spotVal + context.position.quoteBalance.toStroops();

    const netDelta = spotVal - perpVal;
    const deltaBps =
      totalEquity > 0n ? Number((netDelta * 10000n) / totalEquity) : 0;

    // If delta drift exceeds configured threshold, rebalance perp position to match spot notional
    if (Math.abs(deltaBps) > config.neutralityBandBps) {
      // Rebalance perp short quantity to match spot base units
      const perpDelta =
        context.position.spotAmount.toStroops() -
        context.position.perpShortAmount.toStroops();
      return {
        spotTradeDelta: FixedPointDecimal.fromStroops(0n),
        perpTradeDelta: FixedPointDecimal.fromStroops(perpDelta),
      };
    }

    return {
      spotTradeDelta: FixedPointDecimal.fromStroops(0n),
      perpTradeDelta: FixedPointDecimal.fromStroops(0n),
    };
  }
}
