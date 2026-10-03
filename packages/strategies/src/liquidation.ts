import { AssetSymbol, FixedPointDecimal, PriceFeed, SimulationTimestamp, STROOPS_PER_UNIT } from "./types";

export interface Position {
  id: string;
  collateralAsset: AssetSymbol;
  collateralAmount: FixedPointDecimal;
  debtAsset: AssetSymbol;
  debtAmount: FixedPointDecimal;
}

export interface LiquidationParameters {
  threshold: FixedPointDecimal;
  penalty: FixedPointDecimal;
}

export interface LiquidationEvent {
  positionId: string;
  timestamp: SimulationTimestamp;
  healthFactor: FixedPointDecimal;
  debtCleared: FixedPointDecimal;
  collateralSeized: FixedPointDecimal;
  realizedLoss: FixedPointDecimal;
}

export interface PortfolioState {
  positions: Map<string, Position>;
  realizedLosses: FixedPointDecimal;
}

export interface MetricsCollector {
  emit(event: LiquidationEvent): void;
}

function multiply(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  const result = (a.toStroops() * b.toStroops()) / STROOPS_PER_UNIT;
  return FixedPointDecimal.fromStroops(result);
}

function divide(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  if (b.toStroops() === 0n) throw new Error("Divide by zero");
  const result = (a.toStroops() * STROOPS_PER_UNIT) / b.toStroops();
  return FixedPointDecimal.fromStroops(result);
}

function add(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(a.toStroops() + b.toStroops());
}

function subtract(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(a.toStroops() - b.toStroops());
}

export class LiquidationEngine {
  constructor(
    private priceFeed: PriceFeed,
    private params: LiquidationParameters,
    private metrics: MetricsCollector
  ) {}

  computeHealthFactor(position: Position, timestamp: SimulationTimestamp): FixedPointDecimal {
    if (position.debtAmount.toStroops() === 0n) {
      return FixedPointDecimal.fromString("999999999");
    }

    const collateralPrice = this.priceFeed.getSpotPrice(position.collateralAsset, timestamp);
    const debtPrice = this.priceFeed.getSpotPrice(position.debtAsset, timestamp);

    const collateralValue = multiply(position.collateralAmount, collateralPrice);
    const debtValue = multiply(position.debtAmount, debtPrice);

    return divide(collateralValue, debtValue);
  }

  evaluatePosition(position: Position, timestamp: SimulationTimestamp, portfolio: PortfolioState): void {
    if (position.debtAmount.toStroops() === 0n) return;

    const hf = this.computeHealthFactor(position, timestamp);

    // Liquidate if health factor is strictly less than threshold
    // Behavior exactly at boundary: no liquidation if hf.compareTo(this.params.threshold) === 0
    if (hf.compareTo(this.params.threshold) < 0) {
      this.liquidate(position, timestamp, portfolio, hf);
    }
  }

  private liquidate(position: Position, timestamp: SimulationTimestamp, portfolio: PortfolioState, hf: FixedPointDecimal): void {
    const collateralPrice = this.priceFeed.getSpotPrice(position.collateralAsset, timestamp);
    const debtPrice = this.priceFeed.getSpotPrice(position.debtAsset, timestamp);

    const debtValue = multiply(position.debtAmount, debtPrice);
    
    const one = FixedPointDecimal.fromString("1");
    const penaltyMultiplier = add(one, this.params.penalty);
    const requiredCollateralValue = multiply(debtValue, penaltyMultiplier);
    
    let seizedCollateralAmount = divide(requiredCollateralValue, collateralPrice);
    let realizedLoss = FixedPointDecimal.fromString("0");

    if (seizedCollateralAmount.compareTo(position.collateralAmount) > 0) {
      seizedCollateralAmount = position.collateralAmount;
      const collateralValueSeized = multiply(seizedCollateralAmount, collateralPrice);
      
      if (collateralValueSeized.compareTo(debtValue) < 0) {
        realizedLoss = subtract(debtValue, collateralValueSeized);
      }
    }

    const debtCleared = position.debtAmount;

    this.metrics.emit({
      positionId: position.id,
      timestamp,
      healthFactor: hf,
      debtCleared,
      collateralSeized: seizedCollateralAmount,
      realizedLoss
    });

    position.debtAmount = FixedPointDecimal.fromString("0");
    position.collateralAmount = subtract(position.collateralAmount, seizedCollateralAmount);
    
    portfolio.realizedLosses = add(portfolio.realizedLosses, realizedLoss);
  }

  processTick(portfolio: PortfolioState, timestamp: SimulationTimestamp): void {
    for (const position of portfolio.positions.values()) {
      this.evaluatePosition(position, timestamp, portfolio);
    }
  }
}
