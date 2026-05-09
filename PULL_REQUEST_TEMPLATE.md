## Description

<!-- A clear and concise summary of what this PR does and WHY. -->
<!-- Do not just restate the issue title. Explain your approach and any decisions you made. -->

## Related Issue

<!-- Every PR must be linked to an open issue. -->

Closes #

## Type of Change

<!-- Check all that apply -->

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `test` — adding or improving tests
- [ ] `docs` — documentation only
- [ ] `refactor` — code restructuring without behaviour change
- [ ] `perf` — performance improvement
- [ ] `chore` — build, CI, or dependency update

## Context (DeFi / Stellar)

| Field              | Value                                                    |
| ------------------ | -------------------------------------------------------- |
| Network tested on  | <!-- testnet / mainnet / N/A -->                         |
| Protocol affected  | <!-- Blend / DeFindex / Both / None -->                  |
| Touches contracts? | <!-- Yes (specify) / No -->                              |
| Wallet used        | <!-- Freighter / Albedo / N/A -->                        |

## Testing

<!-- Describe how you tested your changes. Include specific test cases, commands run, and any edge cases considered. -->

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Screenshots / Recordings (if applicable)

<!-- For frontend or UI changes, include a screenshot or screen recording. -->

## Checklist

- [ ] My branch follows the naming convention: `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/`, or `ci/`
- [ ] My commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`
- [ ] I have run `pnpm lint && pnpm typecheck && pnpm test` locally and all checks pass
- [ ] I have added or updated tests where applicable
- [ ] I have updated documentation where applicable
- [ ] My changes do not introduce new `console.log` statements or commented-out code
- [ ] I have not committed `.env` files, secrets, or private keys
- [ ] For Soroban contract changes: I have run `cargo clippy` and `cargo fmt --all`
