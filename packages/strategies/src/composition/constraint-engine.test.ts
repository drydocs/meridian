import { describe, it, expect } from "vitest";
import {
  validateComposition,
  enforceReject,
  enforceClamp,
  CompositionConstraintError,
  isCompositionConstraintError,
  type CompositionConstraints,
  type MemberView,
} from "./constraint-engine";
import { FixedPointDecimal } from "../types";
import type { AssetSymbol } from "../types";
import type { PortfolioView, PositionView } from "../strategy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const D = (v: string) => FixedPointDecimal.fromString(v);
const USDC: AssetSymbol = "USDC";
const EURC: AssetSymbol = "EURC";

function makePortfolio(
  cash: string,
  positions: Array<{ asset: AssetSymbol; size: string; memberId?: string }>
): PortfolioView {
  const posViews: PositionView[] = positions.map((p) => ({
    asset: p.asset,
    size: D(p.size),
    basis: D("0"),
    memberId: p.memberId,
  }));

  return {
    cash: D(cash),
    getPosition(asset: AssetSymbol) {
      return posViews.find((p) => p.asset === asset);
    },
    positions() {
      return posViews;
    },
    totalValue(prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>) {
      let total = D(cash);
      for (const pos of posViews) {
        const price = prices.get(pos.asset) ?? D("0");
        total = total.add(pos.size.mul(price));
      }
      return total;
    },
  };
}

function makeMember(
  id: string,
  cash: string,
  positions: Array<{ asset: AssetSymbol; size: string }>
): MemberView {
  const posViews: PositionView[] = positions.map((p) => ({
    asset: p.asset,
    size: D(p.size),
    basis: D("0"),
    memberId: id,
  }));
  const portfolio: PortfolioView = {
    cash: D(cash),
    getPosition(asset: AssetSymbol) {
      return posViews.find((p) => p.asset === asset);
    },
    positions() {
      return posViews;
    },
    totalValue(prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>) {
      let total = D(cash);
      for (const pos of posViews) {
        const price = prices.get(pos.asset) ?? D("0");
        total = total.add(pos.size.mul(price));
      }
      return total;
    },
  };
  return { id, portfolio };
}

const PRICES: ReadonlyMap<AssetSymbol, FixedPointDecimal> = new Map([
  [USDC, D("1")],
  [EURC, D("1")],
]);

// ---------------------------------------------------------------------------
// validateComposition – member-count
// ---------------------------------------------------------------------------

describe("validateComposition – member-count", () => {
  it("passes when member count is within limit", () => {
    const members = [makeMember("a", "100", []), makeMember("b", "100", [])];
    const portfolio = makePortfolio("200", []);
    const result = validateComposition(
      { maxMemberCount: 3 },
      members,
      portfolio,
      PRICES
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("flags a violation when member count exceeds limit", () => {
    const members = [
      makeMember("a", "100", []),
      makeMember("b", "100", []),
      makeMember("c", "100", []),
    ];
    const portfolio = makePortfolio("300", []);
    const result = validateComposition(
      { maxMemberCount: 2 },
      members,
      portfolio,
      PRICES
    );
    expect(result.valid).toBe(false);
    const v = result.violations[0];
    expect(v?.kind).toBe("member-count");
    if (v?.kind === "member-count") {
      expect(v.actual).toBe(3);
      expect(v.limit).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// validateComposition – member-weight
// ---------------------------------------------------------------------------

describe("validateComposition – member-weight", () => {
  it("passes when all members are within the weight limit", () => {
    const members = [
      makeMember("a", "0", [{ asset: USDC, size: "500" }]),
      makeMember("b", "0", [{ asset: USDC, size: "500" }]),
    ];
    const portfolio = makePortfolio("0", [
      { asset: USDC, size: "1000" },
    ]);
    const result = validateComposition(
      { maxMemberWeight: D("0.6") },
      members,
      portfolio,
      PRICES
    );
    expect(result.valid).toBe(true);
  });

  it("flags the offending member when its weight exceeds the limit", () => {
    const members = [
      makeMember("heavy", "0", [{ asset: USDC, size: "800" }]),
      makeMember("light", "0", [{ asset: USDC, size: "200" }]),
    ];
    const portfolio = makePortfolio("0", [{ asset: USDC, size: "1000" }]);
    const result = validateComposition(
      { maxMemberWeight: D("0.7") },
      members,
      portfolio,
      PRICES
    );
    expect(result.valid).toBe(false);
    const v = result.violations[0];
    expect(v?.kind).toBe("member-weight");
    if (v?.kind === "member-weight") {
      expect(v.memberId).toBe("heavy");
      expect(v.limit.toString()).toBe("0.7");
    }
  });
});

// ---------------------------------------------------------------------------
// validateComposition – aggregate-exposure
// ---------------------------------------------------------------------------

describe("validateComposition – aggregate-exposure", () => {
  it("passes when aggregate exposure per asset is within limit", () => {
    const members = [
      makeMember("a", "0", [{ asset: USDC, size: "300" }]),
      makeMember("b", "0", [{ asset: USDC, size: "200" }]),
    ];
    const portfolio = makePortfolio("500", [
      { asset: USDC, size: "500" },
    ]);
    // total value = 500 cash + 500 USDC = 1000
    // aggregate USDC exposure = (300 + 200) / 1000 = 0.5
    const result = validateComposition(
      { maxAggregateExposure: D("0.6") },
      members,
      portfolio,
      PRICES
    );
    expect(result.valid).toBe(true);
  });

  it("detects aggregate exposure across members that no single member shows", () => {
    // Each member alone looks fine (30% each), but together they're at 60%.
    const members = [
      makeMember("a", "0", [{ asset: USDC, size: "300" }]),
      makeMember("b", "0", [{ asset: USDC, size: "300" }]),
    ];
    const portfolio = makePortfolio("400", [{ asset: USDC, size: "600" }]);
    // total value = 400 + 600 = 1000, aggregate USDC = 600/1000 = 0.6
    const result = validateComposition(
      { maxAggregateExposure: D("0.5") },
      members,
      portfolio,
      PRICES
    );
    expect(result.valid).toBe(false);
    const v = result.violations[0];
    expect(v?.kind).toBe("aggregate-exposure");
    if (v?.kind === "aggregate-exposure") {
      expect(v.asset).toBe(USDC);
      expect(v.limit.toString()).toBe("0.5");
    }
  });

  it("reports each asset that breaches the limit independently", () => {
    const members = [
      makeMember("a", "0", [
        { asset: USDC, size: "600" },
        { asset: EURC, size: "600" },
      ]),
    ];
    const portfolio = makePortfolio("0", [
      { asset: USDC, size: "600" },
      { asset: EURC, size: "600" },
    ]);
    // total = 1200, each asset = 600/1200 = 0.5 → both exceed 0.4
    const result = validateComposition(
      { maxAggregateExposure: D("0.4") },
      members,
      portfolio,
      PRICES
    );
    expect(result.valid).toBe(false);
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds.filter((k) => k === "aggregate-exposure")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// validateComposition – cash-buffer
// ---------------------------------------------------------------------------

describe("validateComposition – cash-buffer", () => {
  it("passes when cash buffer meets the minimum", () => {
    const members = [makeMember("a", "200", [{ asset: USDC, size: "800" }])];
    const portfolio = makePortfolio("200", [{ asset: USDC, size: "800" }]);
    // total = 1000, cash = 200, buffer = 0.2
    const result = validateComposition(
      { minCashBuffer: D("0.1") },
      members,
      portfolio,
      PRICES
    );
    expect(result.valid).toBe(true);
  });

  it("flags a violation when cash buffer falls below minimum", () => {
    const members = [makeMember("a", "50", [{ asset: USDC, size: "950" }])];
    const portfolio = makePortfolio("50", [{ asset: USDC, size: "950" }]);
    // total = 1000, cash = 50, buffer = 0.05 < 0.1
    const result = validateComposition(
      { minCashBuffer: D("0.1") },
      members,
      portfolio,
      PRICES
    );
    expect(result.valid).toBe(false);
    const v = result.violations[0];
    expect(v?.kind).toBe("cash-buffer");
    if (v?.kind === "cash-buffer") {
      expect(v.limit.toString()).toBe("0.1");
    }
  });
});

// ---------------------------------------------------------------------------
// enforceReject
// ---------------------------------------------------------------------------

describe("enforceReject", () => {
  it("does nothing when the composition is valid", () => {
    expect(() =>
      enforceReject({ valid: true, violations: [] })
    ).not.toThrow();
  });

  it("throws a CompositionConstraintError naming the violated constraint", () => {
    const members = [
      makeMember("a", "0", [{ asset: USDC, size: "300" }]),
      makeMember("b", "0", [{ asset: USDC, size: "300" }]),
    ];
    const portfolio = makePortfolio("400", [{ asset: USDC, size: "600" }]);
    const result = validateComposition(
      { maxAggregateExposure: D("0.5") },
      members,
      portfolio,
      PRICES
    );

    expect(() => enforceReject(result)).toThrow(CompositionConstraintError);

    try {
      enforceReject(result);
    } catch (error) {
      expect(isCompositionConstraintError(error)).toBe(true);
      if (isCompositionConstraintError(error)) {
        expect(error.reason).toBe("constraint-violated");
        expect(error.violations.length).toBeGreaterThan(0);
        expect(error.message).toContain("USDC");
      }
    }
  });

  it("includes all violations in the thrown error", () => {
    const members = [
      makeMember("heavy", "0", [{ asset: USDC, size: "900" }]),
      makeMember("light", "0", [{ asset: USDC, size: "100" }]),
    ];
    const portfolio = makePortfolio("0", [{ asset: USDC, size: "1000" }]);
    const result = validateComposition(
      { maxMemberWeight: D("0.5"), maxAggregateExposure: D("0.5") },
      members,
      portfolio,
      PRICES
    );

    try {
      enforceReject(result);
    } catch (error) {
      if (isCompositionConstraintError(error)) {
        expect(error.violations.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// enforceClamp
// ---------------------------------------------------------------------------

describe("enforceClamp", () => {
  it("returns orders unchanged when the composition is valid", () => {
    const orders = [{ asset: USDC, size: D("100") }];
    const result = enforceClamp(
      { valid: true, violations: [] },
      orders,
      PRICES,
      D("1000"),
      { maxAggregateExposure: D("0.6") }
    );
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]?.size.toString()).toBe("100");
    expect(result.clampedViolations).toHaveLength(0);
  });

  it("scales down orders to fit within the aggregate-exposure limit", () => {
    // total value = 1000, limit = 50%, max notional = 500
    // proposed orders sum to 600 notional → should be scaled to 500
    const orders = [
      { asset: USDC, size: D("400") },
      { asset: USDC, size: D("200") },
    ];
    const members = [
      makeMember("a", "0", [{ asset: USDC, size: "400" }]),
      makeMember("b", "0", [{ asset: USDC, size: "200" }]),
    ];
    const portfolio = makePortfolio("400", [{ asset: USDC, size: "600" }]);
    const validationResult = validateComposition(
      { maxAggregateExposure: D("0.5") },
      members,
      portfolio,
      PRICES
    );
    expect(validationResult.valid).toBe(false);

    const clampResult = enforceClamp(
      validationResult,
      orders,
      PRICES,
      D("1000"),
      { maxAggregateExposure: D("0.5") }
    );

    // Total clamped size should be ≤ 500
    const totalSize = clampResult.orders.reduce(
      (sum, o) => sum + o.size.toStroops(),
      0n
    );
    expect(totalSize).toBeLessThanOrEqual(D("500").toStroops());
    expect(clampResult.clampedViolations.length).toBeGreaterThan(0);
  });

  it("reports non-order violations in clampedViolations without altering orders", () => {
    // member-count violation cannot be fixed by clamping orders
    const members = [
      makeMember("a", "100", []),
      makeMember("b", "100", []),
      makeMember("c", "100", []),
    ];
    const portfolio = makePortfolio("300", []);
    const result = validateComposition(
      { maxMemberCount: 2 },
      members,
      portfolio,
      PRICES
    );

    const orders = [{ asset: USDC, size: D("50") }];
    const clampResult = enforceClamp(
      result,
      orders,
      PRICES,
      D("300"),
      { maxMemberCount: 2 }
    );

    // Orders unchanged (no aggregate-exposure violation to clamp)
    expect(clampResult.orders[0]?.size.toString()).toBe("50");
    expect(
      clampResult.clampedViolations.some((v) => v.kind === "member-count")
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid constraint definitions
// ---------------------------------------------------------------------------

describe("invalid constraint definitions", () => {
  const members = [makeMember("a", "100", [])];
  const portfolio = makePortfolio("100", []);

  it("throws when maxMemberWeight is zero", () => {
    expect(() =>
      validateComposition(
        { maxMemberWeight: D("0") },
        members,
        portfolio,
        PRICES
      )
    ).toThrow(CompositionConstraintError);
  });

  it("throws when maxMemberWeight exceeds 1", () => {
    expect(() =>
      validateComposition(
        { maxMemberWeight: D("1.0000001") },
        members,
        portfolio,
        PRICES
      )
    ).toThrow(CompositionConstraintError);
  });

  it("throws when maxAggregateExposure is zero", () => {
    expect(() =>
      validateComposition(
        { maxAggregateExposure: D("0") },
        members,
        portfolio,
        PRICES
      )
    ).toThrow(CompositionConstraintError);
  });

  it("throws when maxMemberCount is less than 1", () => {
    expect(() =>
      validateComposition(
        { maxMemberCount: 0 },
        members,
        portfolio,
        PRICES
      )
    ).toThrow(CompositionConstraintError);
  });

  it("throws when minCashBuffer is negative", () => {
    expect(() =>
      validateComposition(
        { minCashBuffer: D("-0.1") },
        members,
        portfolio,
        PRICES
      )
    ).toThrow(CompositionConstraintError);
  });

  it("throws when minCashBuffer equals 1", () => {
    expect(() =>
      validateComposition(
        { minCashBuffer: D("1") },
        members,
        portfolio,
        PRICES
      )
    ).toThrow(CompositionConstraintError);
  });

  it("isCompositionConstraintError returns false for unrelated errors", () => {
    expect(isCompositionConstraintError(new RangeError("nope"))).toBe(false);
    expect(isCompositionConstraintError("not an error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("skips weight and exposure checks when total value is zero", () => {
    const members = [makeMember("a", "0", [])];
    const portfolio = makePortfolio("0", []);
    const result = validateComposition(
      { maxMemberWeight: D("0.5"), maxAggregateExposure: D("0.5") },
      members,
      portfolio,
      PRICES
    );
    expect(result.valid).toBe(true);
  });

  it("returns valid when no constraints are defined", () => {
    const members = [makeMember("a", "0", [{ asset: USDC, size: "1000" }])];
    const portfolio = makePortfolio("0", [{ asset: USDC, size: "1000" }]);
    const result = validateComposition({}, members, portfolio, PRICES);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("skips assets with no price when checking aggregate exposure", () => {
    const noPrices: ReadonlyMap<AssetSymbol, FixedPointDecimal> = new Map([
      [USDC, D("1")],
      // EURC has no price
    ]);
    const members = [
      makeMember("a", "0", [{ asset: EURC, size: "1000" }]),
    ];
    const portfolio = makePortfolio("1000", [{ asset: EURC, size: "1000" }]);
    // Should not throw and EURC should be skipped
    const result = validateComposition(
      { maxAggregateExposure: D("0.1") },
      members,
      portfolio,
      noPrices
    );
    // EURC skipped (no price), no violation
    expect(result.violations.filter((v) => v.kind === "aggregate-exposure")).toHaveLength(0);
  });
});
