import { describe, expect, it } from "vitest";
import { FixedPointDecimal } from "./types";
import { computeRebalanceOrder, shouldRebalance } from "./rebalance";
import type { RebalanceState } from "./rebalance";

function amount(value: string): FixedPointDecimal {
  return FixedPointDecimal.fromString(value);
}

/** A book with `netDelta` quote units of exposure against `notional`. */
function book(netDelta: string, notional: string): RebalanceState {
  return { netDelta: amount(netDelta), notional: amount(notional) };
}

describe("shouldRebalance", () => {
  const band = amount("0.005");

  it("fires once drift is strictly outside the band", () => {
    expect(shouldRebalance(book("5", "1000"), band)).toBe(false);
    expect(shouldRebalance(book("4.9999999", "1000"), band)).toBe(false);
    expect(shouldRebalance(book("5.0000001", "1000"), band)).toBe(true);
  });

  it("measures drift by magnitude, so a net-short book fires too", () => {
    expect(shouldRebalance(book("-6", "1000"), band)).toBe(true);
    expect(shouldRebalance(book("-5", "1000"), band)).toBe(false);
  });

  it("treats a zero band as any nonzero drift", () => {
    const zero = amount("0");

    expect(shouldRebalance(book("0", "1000"), zero)).toBe(false);
    expect(shouldRebalance(book("0.0000001", "1000"), zero)).toBe(true);
    expect(shouldRebalance(book("-0.0000001", "1000"), zero)).toBe(true);
  });

  it("truncates the allowed drift at the stroop instead of rounding it up", () => {
    const tight = amount("0.001");
    const notional = "100.0000001";

    // 100.0000001 × 0.001 is 0.1000000001, which the band truncates to 0.1.
    expect(shouldRebalance(book("0.1", notional), tight)).toBe(false);
    expect(shouldRebalance(book("0.1000001", notional), tight)).toBe(true);
  });

  it("compares in stroops, where a float would round the band up", () => {
    // 0.3 × 0.1 and 0.7 × 0.1 both come out above their exact product in
    // IEEE-754, which would fire on a drift that is exactly on the band.
    expect(shouldRebalance(book("0.03", "0.3"), amount("0.1"))).toBe(false);
    expect(shouldRebalance(book("0.07", "0.7"), amount("0.1"))).toBe(false);
  });

  it("rejects a negative band", () => {
    expect(() => shouldRebalance(book("1", "1000"), amount("-0.005"))).toThrow(
      RangeError
    );
  });

  it("is deterministic and leaves the state it was given alone", () => {
    const input = book("6", "1000");

    const first = shouldRebalance(input, band);

    expect(shouldRebalance(input, band)).toBe(first);
    expect(input.netDelta.toString()).toBe("6");
    expect(input.notional.toString()).toBe("1000");
  });
});

describe("computeRebalanceOrder", () => {
  it("sizes the hedge adjustment that lands the book on target", () => {
    const input = book("400", "20000");
    const order = computeRebalanceOrder(input, amount("0"));

    expect(order.toString()).toBe("400");
    // Taking the order off the exposure is what the hedge leg does with it.
    expect(input.netDelta.sub(order).toStroops()).toBe(0n);
  });

  it("shrinks the hedge for a net-short book", () => {
    const input = book("-400", "20000");
    const order = computeRebalanceOrder(input, amount("0"));

    expect(order.toString()).toBe("-400");
    expect(input.netDelta.sub(order).toStroops()).toBe(0n);
  });

  it("leaves the book at a non-zero target", () => {
    const order = computeRebalanceOrder(book("400", "20000"), amount("100"));

    expect(order.toString()).toBe("300");
    expect(amount("400").sub(order).toString()).toBe("100");
  });

  it("is deterministic and leaves the state it was given alone", () => {
    const input = book("400", "20000");
    const target = amount("0");

    const first = computeRebalanceOrder(input, target);

    expect(computeRebalanceOrder(input, target).equals(first)).toBe(true);
    expect(input.netDelta.toString()).toBe("400");
    expect(input.notional.toString()).toBe("20000");
  });

  it("returns a drifted book to neutral in one order", () => {
    const input = book("250.5", "10000");

    expect(shouldRebalance(input, amount("0.005"))).toBe(true);

    const order = computeRebalanceOrder(input, amount("0"));

    expect(input.netDelta.sub(order).toStroops()).toBe(0n);
  });
});
