# @meridian/strategies

Strategy engine and simulation library for Meridian.

## Fixed-point math

Monetary values use `Decimal`, a fixed-point type backed by `bigint` that stores
a value as `raw / 10^scale`. The default scale is 7, matching Stellar stroops.

```ts
import { Decimal } from "@meridian/strategies";

const a = Decimal.fromString("100.25");
const b = Decimal.fromStroops(500_000_000n); // 50.0000000
a.add(b).toString(); // "150.2500000"
```

Rounding rules:

- An operation aligns both operands to the wider of their two scales first, so
  no operand is rounded before the operation runs. The result carries that
  wider scale.
- `add` and `sub` are exact. `mul` and `div` round once, at the result scale,
  with the mode passed in (default `half-up`).
- Comparisons compare aligned values exactly and are symmetric across scales.
- `toStroops()` rescales to scale 7 and rounds `half-up`, so a value held at a
  finer scale loses precision on conversion.

A `bigint` operand is raw units at the receiver's scale. A `string` operand is
a decimal literal, taken at its exact value.

## Installation

```bash
pnpm add @meridian/strategies
```

## License

MIT
