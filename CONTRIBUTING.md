# Contributing to Meridian

Meridian is a stablecoin yield aggregator on Stellar, built for emerging market savers. It is submitted to the **Drips Stellar Wave Program** and welcomes contributions across TypeScript, Rust/Soroban, and frontend UI.

This document is the single source of truth for contributing. Read it fully before opening a PR.

---

## Table of Contents

- [Getting Started](#getting-started)
- [How to Pick an Issue](#how-to-pick-an-issue)
- [Branch Naming](#branch-naming)
- [Commit Convention](#commit-convention)
- [Code Standards](#code-standards)
- [Pull Request Process](#pull-request-process)
- [Running Checks Locally](#running-checks-locally)
- [Getting Help](#getting-help)

---

## Getting Started

1. Fork the repo and clone your fork:

   ```bash
   git clone https://github.com/<your-username>/meridian.git
   cd meridian
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Copy and configure your environment:

   ```bash
   cp .env.example .env
   # Set STELLAR_NETWORK=testnet for local development
   ```

4. Run the project locally:

   ```bash
   pnpm dev
   # Web: http://localhost:3000
   # API: http://localhost:3001
   ```

5. Run all checks:

   ```bash
   pnpm lint && pnpm typecheck && pnpm test
   ```

---

## How to Pick an Issue

All Wave-eligible issues are labelled `Stellar Wave`. Complexity is indicated by a second label:

| Label             | Complexity | Description                                           |
| ----------------- | ---------- | ----------------------------------------------------- |
| `good first issue`| Trivial    | Isolated, well-scoped, minimal context needed         |
| `medium`          | Medium     | Requires understanding of one or two modules          |
| `hard`            | Hard       | Spans multiple packages or involves Soroban contracts |

All Wave-eligible issues also carry the `Stellar Wave` label. Filter by it to see the full list: [`label:Stellar Wave`](https://github.com/collinsezedike/meridian/labels/Stellar%20Wave).

**Before starting work**, comment on the issue to let the maintainer know you are picking it up. Do not open a PR for an issue that has not been assigned to you — Wave contributor slots are limited.

---

## Branch Naming

All branches must follow this pattern:

```text
<type>/<short-description>
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`

**Examples:**

```text
feat/freighter-wallet-integration
fix/apy-cache-stale-data
docs/blend-integration-guide
test/yield-routing-edge-cases
```

Branches that do not match this pattern will fail the branch naming ruleset and cannot be merged.

---

## Commit Convention

Meridian uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit must follow:

```text
<type>(<scope>): <subject>
```

**Types:** `feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `chore`, `ci`

**Scopes:** Use the relevant area — `api`, `web`, `contracts`, `sdk`, `shared`, `ci`, `docs`

**Rules:**

- Subject line under 72 characters
- Use imperative mood: "add", not "added" or "adds"
- No period at end of subject
- Reference issues in the body or footer: `Closes #7`

**Examples:**

```text
feat(api): add Blend pool APY aggregation endpoint
fix(sdk): handle Soroban RPC timeout on testnet
test(api): add edge case coverage for empty pool response
docs: update CONTRIBUTING with Soroban contract standards
chore(ci): pin Node.js to v20 in GitHub Actions workflow
```

Commits that do not match the `^(feat|fix|docs|chore|refactor|test|style|ci)(\(.+\))?: .{1,72}` pattern will be blocked by the commit message ruleset.

---

## Code Standards

### TypeScript (apps/web, apps/api, packages/\*)

- **Formatting:** Run `pnpm format` before committing. We use Prettier with default settings.
- **Linting:** Must pass `pnpm lint` (ESLint with strict TypeScript rules) with zero errors.
- **Types:** No `any`. Use `unknown` and narrow explicitly. Zod schemas are the source of truth for all external data shapes.
- **Naming:**
  - `PascalCase` for types, interfaces, classes, and React components
  - `camelCase` for variables, functions, and object keys
  - `UPPER_SNAKE_CASE` for module-level constants
  - `kebab-case` for filenames
- **Error handling:** Never swallow errors silently. Log with context and re-throw or return a typed error result.
- **No side effects at module load time.** All protocol clients must be instantiated inside functions, not at the top level of a module.
- **Comments:** Only comment on WHY — not what the code does. If the code needs a what-comment, rewrite the code.

### Rust / Soroban (packages/contracts)

- **Formatting:** Run `cargo fmt --all` before committing.
- **Linting:** Must pass `cargo clippy --all-targets -- -D warnings` with zero warnings.
- **Naming:**
  - `snake_case` for functions and variables
  - `PascalCase` for types and traits
  - `UPPER_SNAKE_CASE` for constants
- **Error handling:** Use `Result<T, E>` everywhere. No `.unwrap()` in contract code except on values that are provably infallible — explain why in an inline comment.
- **Documentation:** All public functions must have doc comments (`///`). Include a one-line summary and a note on any panics or preconditions.
- **Security:** Validate all inputs. Assume callers are adversarial. Never read from storage without checking the key exists first.

---

## Pull Request Process

1. **One PR per issue.** Do not bundle multiple issues into a single PR.
2. **Keep PRs small.** A PR that changes more than 400 lines of non-test code will be asked to split.
3. **Fill out the PR template fully.** Incomplete templates will be closed without review.
4. **All CI checks must pass** before a review will be given. Do not open a PR with known failures.
5. **Resolve all review comments** before requesting a re-review. Mark threads as resolved only after you have addressed them — not before.
6. **Do not force-push** after a review has started. Add new commits to address feedback so the reviewer can see what changed.
7. **Squash on merge** is enforced. Your commit history inside the branch does not need to be clean — but your PR title must follow the commit convention, as it becomes the squashed commit message.

---

## Running Checks Locally

Run all checks before pushing. CI will catch failures, but failing CI wastes Wave time.

```bash
# Full check suite
pnpm lint && pnpm typecheck && pnpm test

# Individual checks
pnpm lint          # ESLint
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest
pnpm format        # Prettier (auto-fix)

# Soroban contract checks
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test --all
```

---

## Getting Help

- **Questions about an issue?** Comment directly on the issue — do not DM the maintainer.
- **Something broken in the dev setup?** Open a GitHub Discussion under the Q&A category.
- **Found a bug not covered by an existing issue?** Open a new issue using the Bug Report template before starting any work.
- **Have a feature idea?** Open a Discussion first. Do not open a PR for a feature that has not been discussed and approved.

---

Meridian is part of the Drips Stellar Wave Program. Contributions are reviewed promptly during the active Wave window — typically within 48 hours. Outside the Wave window, response times may be longer.
