# @meridian/strategies-app

React + Vite front end for browsing and simulating Meridian strategies. It
consumes the `@meridian/strategies` engine package.

## Development

```sh
pnpm --filter @meridian/strategies-app dev
```

## Testing

Tests use [Vitest](https://vitest.dev) with the `jsdom` environment and
[Testing Library](https://testing-library.com/docs/react-testing-library/intro/)
(`globals: true`, so `describe`/`it`/`expect` need no imports). Setup lives in
`vitest.config.ts`. Test files sit under `src/__tests__/`.

```sh
# Run the suite once
pnpm --filter @meridian/strategies-app test

# Run the suite with v8 coverage (text summary + lcov in ./coverage)
pnpm --filter @meridian/strategies-app coverage
```

Both commands pass when no tests are found (`--passWithNoTests`). From the
repository root, `pnpm test` and `pnpm coverage` run every workspace package
through Turbo.
