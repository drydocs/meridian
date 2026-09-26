import { describe, it, expect, beforeEach } from "vitest";
import {
  FixedPointDecimal,
  StaticPriceFeed,
  BacktestPriceFeed,
  PriceFeed,
  UnknownAssetError,
  TimestampOutOfRangeError,
  AssetSymbol,
  SimulationTimestamp,
  isUnknownAssetError,
  isTimestampOutOfRangeError,
} from "./index";

const USDC: AssetSymbol = "USDC";
const EURC: AssetSymbol = "EURC";

const BASE_TIMESTAMP: SimulationTimestamp = 1_700_000_000_000;

describe("FixedPointDecimal", () => {
  it("creates from string and preserves precision", () => {
    const price = FixedPointDecimal.fromString("1.0000001");
    expect(price.toString()).toBe("1.0000001");
    expect(price.toStroops()).toBe(10_000_001n);
  });

  it("creates from stroops and converts back", () => {
    const price = FixedPointDecimal.fromStroops(10_000_001n);
    expect(price.toString()).toBe("1.0000001");
  });

  it("handles whole numbers", () => {
    const price = FixedPointDecimal.fromString("100");
    expect(price.toString()).toBe("100");
    expect(price.toStroops()).toBe(1_000_000_000n);
  });

  it("handles negative values", () => {
    const price = FixedPointDecimal.fromString("-1.5");
    expect(price.toString()).toBe("-1.5");
    expect(price.toStroops()).toBe(-15_000_000n);
  });

  it("compares correctly", () => {
    const a = FixedPointDecimal.fromString("1.5");
    const b = FixedPointDecimal.fromString("1.5");
    const c = FixedPointDecimal.fromString("2.0");
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.compareTo(c)).toBe(-1);
    expect(c.compareTo(a)).toBe(1);
    expect(a.compareTo(b)).toBe(0);
  });

  it("trailing zeros are trimmed in toString", () => {
    const price = FixedPointDecimal.fromString("1.5000000");
    expect(price.toString()).toBe("1.5");
  });
});

describe("StaticPriceFeed", () => {
  let feed: PriceFeed;

  beforeEach(() => {
    feed = StaticPriceFeed.create({
      USDC: "1.0000000",
      EURC: "1.0800000",
    });
  });

  it("returns correct price for known asset at any timestamp", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    expect(price.toString()).toBe("1");
    expect(price.toStroops()).toBe(10_000_000n);
  });

  it("returns different prices for different assets", () => {
    const usdcPrice = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    const eurcPrice = feed.getSpotPrice(EURC, BASE_TIMESTAMP);
    expect(usdcPrice.toString()).toBe("1");
    expect(eurcPrice.toString()).toBe("1.08");
    expect(usdcPrice.equals(eurcPrice)).toBe(false);
  });

  it("throws UnknownAssetError for unknown asset", () => {
    expect(() =>
      feed.getSpotPrice("BTC" as AssetSymbol, BASE_TIMESTAMP)
    ).toThrow(UnknownAssetError);
    try {
      feed.getSpotPrice("BTC" as AssetSymbol, BASE_TIMESTAMP);
    } catch (err) {
      expect(isUnknownAssetError(err)).toBe(true);
      if (isUnknownAssetError(err)) {
        expect(err.asset).toBe("BTC");
      }
    }
  });

  it("returns FixedPointDecimal instance, not a number", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    expect(price).toBeInstanceOf(FixedPointDecimal);
    expect(typeof price.toStroops()).toBe("bigint");
  });

  it("uses the same timestamp for all assets", () => {
    const price1 = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    const price2 = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 1000);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe("BacktestPriceFeed", () => {
  let feed: PriceFeed;

  beforeEach(() => {
    feed = BacktestPriceFeed.create({
      USDC: [
        { timestamp: BASE_TIMESTAMP, price: "1.0000000" },
        { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0001000" },
        { timestamp: BASE_TIMESTAMP + 7200_000, price: "1.0002000" },
      ],
      EURC: [
        { timestamp: BASE_TIMESTAMP, price: "1.0800000" },
        { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0810000" },
      ],
    });
  });

  it("returns exact price at exact timestamp", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 3600_000);
    expect(price.toString()).toBe("1.0001");
  });

  it("returns latest price at or before requested timestamp (floor)", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 1800_000);
    expect(price.toString()).toBe("1");
  });

  it("returns different prices for different assets at same timestamp", () => {
    const usdcPrice = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    const eurcPrice = feed.getSpotPrice(EURC, BASE_TIMESTAMP);
    expect(usdcPrice.toString()).toBe("1");
    expect(eurcPrice.toString()).toBe("1.08");
  });

  it("throws UnknownAssetError for unknown asset", () => {
    expect(() =>
      feed.getSpotPrice("BTC" as AssetSymbol, BASE_TIMESTAMP)
    ).toThrow(UnknownAssetError);
    try {
      feed.getSpotPrice("BTC" as AssetSymbol, BASE_TIMESTAMP);
    } catch (err) {
      expect(isUnknownAssetError(err)).toBe(true);
    }
  });

  it("throws TimestampOutOfRangeError for timestamp before range", () => {
    expect(() => feed.getSpotPrice(USDC, BASE_TIMESTAMP - 1)).toThrow(
      TimestampOutOfRangeError
    );
    try {
      feed.getSpotPrice(USDC, BASE_TIMESTAMP - 1);
    } catch (err) {
      expect(isTimestampOutOfRangeError(err)).toBe(true);
      if (isTimestampOutOfRangeError(err)) {
        expect(err.timestamp).toBe(BASE_TIMESTAMP - 1);
        expect(err.minTimestamp).toBe(BASE_TIMESTAMP);
        expect(err.maxTimestamp).toBe(BASE_TIMESTAMP + 7200_000);
      }
    }
  });

  it("throws TimestampOutOfRangeError for timestamp after range", () => {
    expect(() =>
      feed.getSpotPrice(USDC, BASE_TIMESTAMP + 7200_000 + 1)
    ).toThrow(TimestampOutOfRangeError);
    try {
      feed.getSpotPrice(USDC, BASE_TIMESTAMP + 7200_000 + 1);
    } catch (err) {
      expect(isTimestampOutOfRangeError(err)).toBe(true);
      if (isTimestampOutOfRangeError(err)) {
        expect(err.timestamp).toBe(BASE_TIMESTAMP + 7200_000 + 1);
        expect(err.minTimestamp).toBe(BASE_TIMESTAMP);
        expect(err.maxTimestamp).toBe(BASE_TIMESTAMP + 7200_000);
      }
    }
  });

  it("succeeds at exactly the first valid timestamp", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    expect(price.toString()).toBe("1");
  });

  it("succeeds at exactly the last valid timestamp", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 7200_000);
    expect(price.toString()).toBe("1.0002");
  });

  it("throws for asset with no data points", () => {
    const emptyFeed = BacktestPriceFeed.create({
      USDC: [],
    });
    expect(() => emptyFeed.getSpotPrice(USDC, BASE_TIMESTAMP)).toThrow(
      UnknownAssetError
    );
  });

  it("returns FixedPointDecimal instance with correct precision", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 3600_000);
    expect(price).toBeInstanceOf(FixedPointDecimal);
    expect(price.toStroops()).toBe(10_001_000n);
  });

  it("sorts data points by timestamp internally", () => {
    const unsortedFeed = BacktestPriceFeed.create({
      USDC: [
        { timestamp: BASE_TIMESTAMP + 7200_000, price: "1.0002000" },
        { timestamp: BASE_TIMESTAMP, price: "1.0000000" },
        { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0001000" },
      ],
    });
    const price = unsortedFeed.getSpotPrice(USDC, BASE_TIMESTAMP + 3600_000);
    expect(price.toString()).toBe("1.0001");
  });
});

describe("PriceFeed contract tests - multiple implementations", () => {
  function runBaseContractTests(feed: PriceFeed, name: string) {
    describe(`${name} base contract`, () => {
      it("known asset + valid timestamp returns FixedPointDecimal", () => {
        const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
        expect(price).toBeInstanceOf(FixedPointDecimal);
        expect(price.toStroops()).toBe(10_000_000n);
      });

      it("two assets return their own prices correctly", () => {
        const usdcPrice = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
        const eurcPrice = feed.getSpotPrice(EURC, BASE_TIMESTAMP);
        expect(usdcPrice.toString()).toBe("1");
        expect(eurcPrice.toString()).toBe("1.08");
        expect(usdcPrice.equals(eurcPrice)).toBe(false);
      });

      it("unknown asset throws UnknownAssetError", () => {
        expect(() =>
          feed.getSpotPrice("BTC" as AssetSymbol, BASE_TIMESTAMP)
        ).toThrow(UnknownAssetError);
      });
    });
  }

  function runTimeRangeContractTests(feed: PriceFeed, name: string) {
    describe(`${name} time-range contract`, () => {
      it("timestamp before range fails with TimestampOutOfRangeError", () => {
        expect(() => feed.getSpotPrice(USDC, BASE_TIMESTAMP - 1)).toThrow(
          TimestampOutOfRangeError
        );
      });

      it("timestamp after range fails with TimestampOutOfRangeError", () => {
        expect(() =>
          feed.getSpotPrice(USDC, BASE_TIMESTAMP + 7200_000 + 1)
        ).toThrow(TimestampOutOfRangeError);
      });

      it("exactly first valid timestamp succeeds", () => {
        const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
        expect(price.toString()).toBe("1");
      });

      it("exactly last valid timestamp succeeds", () => {
        const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 7200_000);
        expect(price.toString()).toBe("1.0002");
      });

      it("decimal precision is preserved exactly", () => {
        const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 3600_000);
        expect(price.toStroops()).toBe(10_001_000n);
      });
    });
  }

  const staticFeed = StaticPriceFeed.create({
    USDC: "1.0000000",
    EURC: "1.0800000",
  });

  const backtestFeed = BacktestPriceFeed.create({
    USDC: [
      { timestamp: BASE_TIMESTAMP, price: "1.0000000" },
      { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0001000" },
      { timestamp: BASE_TIMESTAMP + 7200_000, price: "1.0002000" },
    ],
    EURC: [
      { timestamp: BASE_TIMESTAMP, price: "1.0800000" },
      { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0810000" },
    ],
  });

  runBaseContractTests(staticFeed, "StaticPriceFeed");
  runBaseContractTests(backtestFeed, "BacktestPriceFeed");
  runTimeRangeContractTests(backtestFeed, "BacktestPriceFeed");

  it("strategy compiles and executes against both implementations without changes", () => {
    function strategy(
      feed: PriceFeed,
      asset: AssetSymbol,
      timestamp: SimulationTimestamp
    ): FixedPointDecimal {
      return feed.getSpotPrice(asset, timestamp);
    }

    const staticResult = strategy(staticFeed, USDC, BASE_TIMESTAMP);
    const backtestResult = strategy(backtestFeed, USDC, BASE_TIMESTAMP);

    expect(staticResult.toString()).toBe("1");
    expect(backtestResult.toString()).toBe("1");
    expect(staticResult.equals(backtestResult)).toBe(true);
  });
});

describe("Error type guards", () => {
  it("isUnknownAssetError identifies UnknownAssetError", () => {
    const err = new UnknownAssetError("BTC" as AssetSymbol);
    expect(isUnknownAssetError(err)).toBe(true);
    expect(isUnknownAssetError(new Error())).toBe(false);
    expect(isUnknownAssetError("string")).toBe(false);
  });

  it("isTimestampOutOfRangeError identifies TimestampOutOfRangeError", () => {
    const err = new TimestampOutOfRangeError(
      BASE_TIMESTAMP,
      BASE_TIMESTAMP,
      BASE_TIMESTAMP + 1000
    );
    expect(isTimestampOutOfRangeError(err)).toBe(true);
    expect(isTimestampOutOfRangeError(new Error())).toBe(false);
    expect(isTimestampOutOfRangeError("string")).toBe(false);
  });
});
