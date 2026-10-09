# Delta-neutral strategy

The delta-neutral strategy holds a long leg and an equal and opposite short
leg in the same asset, so the two offset and the position carries almost no
net price exposure. The return comes from carry rather than from price
direction: one leg pays the other while the price move of either leg cancels.

**Simulation only.** This strategy runs against the deterministic backtest
harness in `@meridian/strategies`. It is not wired to a live venue, a vault,
or mainnet funds. The hedge venue is modeled inside the harness: there is no
live perpetual or dated-futures venue, no order router, and no key that can
trade. Every number this page describes is produced by the simulation from a
scenario, not observed from a live account.

## How the position is built

A delta-neutral position starts from a capital amount and a target leverage.
The strategy holds the long leg in the base asset and shorts the hedge leg
for the same notional, so the two deltas cancel:

| Quantity       | Definition                                          | Note                       |
| -------------- | --------------------------------------------------- | -------------------------- |
| Long notional  | `capital × targetLeverage`                          | Long spot leg              |
| Short notional | Equal to the long notional                          | Hedge leg, sized 1:1       |
| Margin per leg | `long notional ÷ targetLeverage` (equals `capital`) | Posted on each leg         |
| Total margin   | `2 × capital`                                       | Both legs share the target |

Because the hedge is sized 1:1, the net delta of a freshly opened position is
zero. The position earns the spread between the two legs, not the price move
of either one.

### Target leverage

`targetLeverage` is the gross leverage applied to each leg, between `1` and
`20` inclusive. A value of `1` is an unlevered position; the upper bound of
`20` keeps the position inside typical exchange initial-margin limits. A value
outside the range, or a non-positive capital, is a typed error and the
position is not opened.

Higher leverage scales both notional and margin proportionally. It does not
change the direction of the trade, but it does shorten the distance to a
liquidation of either leg, which is the risk the rebalance band and the
liquidation path exist to manage.

## Rebalancing to neutral

The two legs are only neutral at the moment they are opened. As prices move,
the legs drift apart and a net delta reappears. The strategy measures the net
delta in basis points of total equity and rebalances when it leaves the
configured band:

- `netDeltaBps` is `net delta ÷ total equity × 10000`, where the net delta is
  the spot value minus the short perp value.
- `neutralityBandBps` is the allowed drift, in basis points.
- When `|netDeltaBps|` exceeds `neutralityBandBps`, the strategy trades the
  perp leg back to match the spot notional.

The trigger and the size of the correcting order are pure functions of the
position state, so the same state always produces the same decision. That is
what makes a backtest reproducible: a scenario plus a seed replays to the same
trades.

A wide band trades less and tolerates more drift; a narrow band keeps the
position closer to neutral but pays more in fills and fees. The band is a
scenario input, and the trade-off is visible in the run summary as
`totalRebalances` against `maxNetDeltaBps`.

## Carry sources

Delta-neutral return is carry: the payments one leg makes to the other plus
the yield on the collateral. Three sources are modeled.

1. **Funding.** A perpetual hedge pays or receives a periodic funding rate. A
   positive rate is paid by longs and received by shorts; a negative rate
   reverses that. The strategy's short hedge therefore receives positive
   funding and pays negative funding. Funding accrues over each interval
   aligned to the simulation clock, and a gap in the series accrues zero
   rather than interpolating.
2. **Basis.** When the hedge is a dated future rather than a perpetual, the
   gap between the spot price and the future price converges as the future
   approaches expiry. A short future opened above spot earns that
   convergence.
3. **Collateral and borrow spread.** The long base leg can earn a supply rate
   while the leveraged legs pay borrow interest on their margin. The net of
   the two is part of carry and is accrued each step.

Carry is the sum of the three and can be negative. The strategy is
market-neutral in price, not in carry: a negative funding regime, or a basis
that moves against the hedge, loses money even when the net delta is zero.

## Configuration

A backtest is driven by a scenario plus the strategy configuration. Money and
rate values are fixed-point decimal strings, never JavaScript numbers, and
carry at most seven decimal places. The strategy configuration exposes:

| Option                 | Meaning                                     | Safe range                      |
| ---------------------- | ------------------------------------------- | ------------------------------- |
| `initialCapitalQuote`  | Starting quote capital, as a decimal string | Greater than zero               |
| `targetLeverage`       | Gross leverage applied to each leg          | `1` to `20` inclusive           |
| `neutralityBandBps`    | Allowed net-delta drift, in basis points    | Positive; commonly `20` to `50` |
| `rebalanceSlippageBps` | Cost applied to each rebalance fill         | Small and non-negative          |

The scenario that carries them is the single input a run is reproduced from:
the same scenario and seed always yield the same run. A scenario describes a
time window and step, the traded assets, the price and rate source, the
starting capital, the strategy block, and the seed, plus a series of steps
holding the spot price, the perp price, and the funding rate.

## Running a scenario backtest

Scenarios are generated deterministically from a seed. The package ships
generators for three market regimes:

- a trending market with a persistent basis and steady positive funding,
- a ranging market that mean-reverts,
- a high-funding regime that stresses carry.

Each generator takes a seed and a step count, so a scenario is reproducible on
any machine. Run the strategy package, which validates the scenario and drives
the backtest runner and its tests:

```bash
pnpm --filter @meridian/strategies test
pnpm --filter @meridian/strategies typecheck
```

The runner advances the clock one fixed step at a time. On each step it
accrues funding and interest, asks the strategy for a rebalance action,
applies any trade with slippage and fees, and records a snapshot. Every
amount is `bigint` fixed-point, so identical inputs produce byte-identical
runs. When the run ends, the metrics collector summarizes it.

## Reading the run summary

The summary is the output to read. It reports the metrics the strategy is
judged on:

| Metric                 | Meaning                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `netPnl`               | Total change in equity over the window                        |
| `carryPnl`             | Equity earned from funding and carry                          |
| `pricePnl`             | Equity from price moves, which should stay small when neutral |
| `maxNetDeltaBps`       | Largest net-delta drift seen, in basis points                 |
| `withinNeutralityBand` | Whether every step stayed inside `neutralityBandBps`          |
| `totalRebalances`      | How many times the strategy traded back to neutral            |

A healthy run keeps `maxNetDeltaBps` inside the band, shows `carryPnl` as the
dominant contributor to `netPnl`, and keeps `pricePnl` close to zero. A run
where `pricePnl` dominates means the hedge stopped tracking; a run with a
large `totalRebalances` means the band is too narrow for the volatility and
fees are eating the carry.

## Risks and limits

- **The hedge venue is modeled.** The simulation assumes the hedge leg fills
  at the modeled price with the modeled cost and slippage. It does not model
  exchange outages, delisting, or a funding regime change a live venue could
  impose.
- **Carry can invert.** Funding and basis are not stable. A position that is
  neutral in price can still lose money when carry turns negative.
- **Leverage can liquidate.** A fast adverse move can push a leg through its
  liquidation threshold before the next rebalance. This is a real risk, not an
  edge case.
- **Rebalancing is not free.** Every correcting order pays a fill and a fee. A
  band that is too narrow costs more than it protects.
- **Simulation only.** No part of this strategy touches user funds. It exists
  to answer, deterministically, whether a given scenario earns carry worth the
  risk.

## Related

- `packages/strategies` holds the SDK: fixed-point money math, price feeds,
  position sizing, the delta-neutral strategy, the scenario generators, the
  backtest runner, and the metrics collector.
