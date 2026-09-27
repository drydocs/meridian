# @meridian/strategies

Strategy execution engine, self-repaying loan models, and determinism verification for Meridian.

## Test Suites

- **Unit tests**: `src/self-repaying-loan.spec.ts`
- **Property-based invariant tests**: `src/accounting-invariants.spec.ts`
  - Validates that the core accounting identity `InitialDebt + TotalInterest = RemainingDebt + TotalYieldAmortized` holds across randomized fill schedules.
  - Validates that two runs using the same seed and scenario parameters produce bit-for-bit identical outputs and report history.
- **Golden-file determinism suite**: `src/golden-scenario.spec.ts`
  - Compares the complete execution snapshot trace of a reference scenario against `test-fixtures/scenario-golden.json`.

### Regenerating Golden Files

Regenerating the golden fixture file must always be a deliberate action when strategy mechanics or snapshot schemas are intentionally altered.

To regenerate:
```bash
UPDATE_GOLDEN=true pnpm --filter @meridian/strategies test
```
Or on Windows PowerShell:
```powershell
$env:UPDATE_GOLDEN="true"; pnpm --filter @meridian/strategies test; $env:UPDATE_GOLDEN=""
```
