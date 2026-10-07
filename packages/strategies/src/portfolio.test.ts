import { describe, it, expect } from "vitest";
import {
  Portfolio,
  FixedPointDecimal,
  InvalidFillError,
  UnknownAssetError,
} from "./index";
import type { AssetSymbol, PriceSet } from "./index";

const D = (v: string) => FixedPointDecimal.fromString(v);
const USDC: AssetSymbol = "USDC";
const EURC: AssetSymbol = "EURC";
const prices = (usdc: string, eurc = "1"): PriceSet =>
  new Map([
    [USDC, D(usdc)],
    [EURC, D(eurc)],
  ]);
const buy = (
  asset: AssetSymbol,
  size: string,
  price: string,
  fee?: string
) => ({
  asset,
  size: D(size),
  price: D(price),
  fee: fee ? D(fee) : undefined,
});

describe("Portfolio", () => {
  it("opens a position and updates cash and basis", () => {
    const p = new Portfolio(D("1000"));
    p.applyFill(buy(USDC, "10", "2"));
    expect(p.cash.toString()).toBe("980");
    expect(p.getPosition(USDC)?.size.toString()).toBe("10");
    expect(p.getPosition(USDC)?.basis.toString()).toBe("20");
    expect(p.positionValue(prices("2")).toString()).toBe("20");
    expect(p.totalValue(prices("2")).toString()).toBe("1000");
  });

  it("reproduces hand-worked increase, reduce and close", () => {
    const p = new Portfolio(D("1000"));
    p.applyFill(buy(USDC, "10", "2", "0.5")); // cash 979.5, basis 20
    p.applyFill(buy(USDC, "10", "4", "0.5")); // cash 939, size 20, basis 60
    expect(p.cash.toString()).toBe("939");
    expect(p.getPosition(USDC)?.basis.toString()).toBe("60");

    // Mark at 5: value 100, unrealized 40, total 1039
    expect(p.unrealized(prices("5")).toString()).toBe("40");
    expect(p.totalValue(prices("5")).toString()).toBe("1039");

    // Sell 5 at 5: proceeds 25, released basis 15, realized 10.
    p.applyFill(buy(USDC, "-5", "5"));
    expect(p.realized.toString()).toBe("10");
    expect(p.cash.toString()).toBe("964");
    expect(p.getPosition(USDC)?.size.toString()).toBe("15");
    expect(p.getPosition(USDC)?.basis.toString()).toBe("45");
    expect(p.unrealized(prices("5")).toString()).toBe("30");

    // Close 15 at 6: proceeds 90, released 45, realized total 55.
    p.applyFill(buy(USDC, "-15", "6"));
    expect(p.getPosition(USDC)).toBeUndefined();
    expect(p.realized.toString()).toBe("55");
    expect(p.cash.toString()).toBe("1054");
    expect(p.fees.toString()).toBe("1");
    expect(p.unrealized(prices("6")).toString()).toBe("0");
    // 1000 + 55 realized - 1 fees
    expect(p.totalValue(prices("6")).toString()).toBe("1054");
  });

  it("moves the full result from unrealized to realized on close", () => {
    const p = new Portfolio(D("100"));
    p.applyFill(buy(USDC, "10", "1"));
    const px = prices("1.5");
    expect(p.unrealized(px).toString()).toBe("5");
    expect(p.realized.toString()).toBe("0");
    p.applyFill(buy(USDC, "-10", "1.5"));
    expect(p.unrealized(px).toString()).toBe("0");
    expect(p.realized.toString()).toBe("5");
  });

  it("handles shorts", () => {
    const p = new Portfolio(D("1000"));
    p.applyFill(buy(EURC, "-10", "100")); // cash 2000, basis -1000
    expect(p.cash.toString()).toBe("2000");
    expect(p.unrealized(prices("1", "90")).toString()).toBe("100");
    p.applyFill(buy(EURC, "4", "90")); // cover 4: released -400, realized 40
    expect(p.realized.toString()).toBe("40");
    expect(p.getPosition(EURC)?.basis.toString()).toBe("-600");
    p.assertIdentity(prices("1", "90"));
  });

  it("holds the accounting identity after every mutation", () => {
    const p = new Portfolio(D("5000.1234567"));
    const seq = [
      buy(USDC, "3.3333333", "1.0000001", "0.01"),
      buy(EURC, "-7.7777777", "1.0912345", "0.02"),
      buy(USDC, "1.1111111", "0.9999999"),
      buy(USDC, "-2.2222222", "1.0100001", "0.0000001"),
      buy(EURC, "3", "1.0500005"),
      buy(USDC, "-2.2222222", "0.98"),
      buy(EURC, "4.7777777", "1.2"),
    ];
    const marks = [prices("1.01", "1.09"), prices("0.97", "1.3")];
    for (const fill of seq) {
      p.applyFill(fill);
      for (const m of marks) p.assertIdentity(m);
    }
    expect(p.positions()).toHaveLength(0);
  });

  it("rejects invalid fills", () => {
    const p = new Portfolio(D("100"));
    expect(() => p.applyFill(buy(USDC, "0", "1"))).toThrow(InvalidFillError);
    expect(() => p.applyFill(buy(USDC, "1", "-1"))).toThrow(InvalidFillError);
    expect(() => p.applyFill(buy(USDC, "1", "1", "-1"))).toThrow(
      InvalidFillError
    );
    p.applyFill(buy(USDC, "1", "1"));
    expect(() => p.applyFill(buy(USDC, "-2", "1"))).toThrow(InvalidFillError);
    expect(p.getPosition(USDC)?.size.toString()).toBe("1");
  });

  it("requires a price for every held asset", () => {
    const p = new Portfolio(D("100"));
    p.applyFill(buy(USDC, "1", "1"));
    expect(() => p.totalValue(new Map())).toThrow(UnknownAssetError);
  });
});
