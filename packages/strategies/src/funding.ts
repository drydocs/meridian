import { FixedPointDecimal } from "./types";

export interface FundingCapture {
  horizon: number;
  funding: FixedPointDecimal;
  basis: FixedPointDecimal;
}

export class FundingTermStructure {
  readonly #points: FundingCapture[];

  constructor(points: FundingCapture[]) {
    if (points.length === 0) {
      throw new Error("Term structure requires at least one point");
    }
    
    // Validate horizons are integers
    for (const p of points) {
      if (!Number.isInteger(p.horizon)) {
        throw new Error("Horizon must be an integer");
      }
    }

    this.#points = [...points].sort((a, b) => a.horizon - b.horizon);
  }

  get points(): FundingCapture[] {
    return [...this.#points];
  }

  getExpectedCapture(horizon: number): FundingCapture {
    if (!Number.isInteger(horizon)) {
      throw new Error("Horizon must be an integer");
    }

    const first = this.#points[0]!;
    if (horizon <= first.horizon) {
      return {
        horizon,
        funding: first.funding,
        basis: first.basis,
      };
    }

    const last = this.#points[this.#points.length - 1]!;
    if (horizon >= last.horizon) {
      return {
        horizon,
        funding: last.funding,
        basis: last.basis,
      };
    }

    let left = first;
    let right = first;
    for (let i = 1; i < this.#points.length; i++) {
      if (this.#points[i]!.horizon >= horizon) {
        right = this.#points[i]!;
        left = this.#points[i - 1]!;
        break;
      }
    }

    const horizonDiff = BigInt(right.horizon - left.horizon);
    const targetDiff = BigInt(horizon - left.horizon);

    const fundingStroops = left.funding.toStroops() +
      ((right.funding.toStroops() - left.funding.toStroops()) * targetDiff) / horizonDiff;
    
    const basisStroops = left.basis.toStroops() +
      ((right.basis.toStroops() - left.basis.toStroops()) * targetDiff) / horizonDiff;

    return {
      horizon,
      funding: FixedPointDecimal.fromStroops(fundingStroops),
      basis: FixedPointDecimal.fromStroops(basisStroops),
    };
  }
}
