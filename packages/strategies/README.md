# @meridian/strategies

Strategy engine and simulation library for Meridian.

## Simulation Boundary & Isolation Guard

The `@meridian/strategies` engine is designed with a **simulation-first boundary**:
- Unlaunched strategies cannot construct, sign, or submit live transactions to real vault contracts or Stellar Mainnet.
- Any attempt to reach signing or live network submission pathways throws `StrategyIsolationViolationError` before network I/O.
- The feature flag `StrategyExecutionGuard.isLiveExecutionEnabled()` defaults to `false` in every environment, ensuring that simulations and backtests remain safely isolated from real funds.

## Installation

```bash
pnpm add @meridian/strategies
```

## License

MIT
