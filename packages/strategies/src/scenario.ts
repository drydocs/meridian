import { z } from "zod";

/**
 * Validated, declarative description of a backtest scenario.
 *
 * A scenario is the *single* input a run is reproduced from: given the same
 * scenario, the same window/assets/sources/capital/strategy config, a run is
 * deterministic. Nothing here is a live lookup or an ambient default — every
 * value that could change the outcome is written down explicitly.
 *
 * Money and rate fields are fixed-point decimal *strings*, never JS `number`
 * (see #856). A `number` is IEEE-754 binary floating point: `0.1 + 0.2` is not
 * `0.3`, and that drift compounds across the many steps of a backtest. The
 * schema therefore rejects `number` outright for those fields, and accepts a
 * decimal string with at most {@link SCENARIO_DECIMAL_PLACES} fractional
 * digits, matching the vault's on-chain 7-decimal stroop scale.
 *
 * Validation uses `zod`, the same runtime validator the rest of the repo
 * (`@meridian/shared`, `@meridian/api-core`, `@meridian/stellar-sdk-helpers`)
 * already uses. This package declares its own `zod` dependency rather than
 * importing the shared `formatZodError`, so `pnpm --filter
 * @meridian/strategies test` works without first building `@meridian/shared`.
 */

/** Schema revision. Bump when the shape changes in a breaking way. */
export const SCENARIO_SCHEMA_VERSION = 1;

/**
 * Fractional digits allowed in monetary/rate fields. Matches the vault's
 * on-chain fixed-point scale (1 USDC = 10,000,000 stroops, 7 decimals).
 */
export const SCENARIO_DECIMAL_PLACES = 7;

// Signed decimal string, 0..SCENARIO_DECIMAL_PLACES fractional digits. Used
// for values that may legitimately be negative (e.g. a net rate/spread).
const FIXED_POINT = /^-?\d+(?:\.\d{1,7})?$/;
// Unsigned decimal string. Monetary amounts that can never be negative, such
// as starting capital, use this so a leading "-" is rejected as malformed
// rather than silently accepted.
const NON_NEGATIVE_FIXED_POINT = /^\d+(?:\.\d{1,7})?$/;
const ZERO = /^0(?:\.0+)?$/;
// Strict UTC instant: full date, time to the second (optional millis), "Z".
// Rejecting offset forms ("+01:00") and partial dates keeps two scenarios that
// describe the same window comparable as strings.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// ISO-8601 duration accepted for the step: weeks, days, and/or a time part
// (P1W, P1D, PT1H, PT15M, PT1H30M, P1DT6H). The `/\d/` refine below rejects
// the degenerate "P" / "PT" that this pattern would otherwise allow.
const ISO_DURATION = /^P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/;
const ASSET_SYMBOL = /^[A-Z][A-Z0-9]{1,11}$/;

/**
 * A fixed-point decimal string with at most {@link SCENARIO_DECIMAL_PLACES}
 * fractional digits. Accepts negatives; use for rates/spreads where a sign is
 * meaningful. Rejects `number` (a float) at the type level with a message that
 * names the offending field.
 */
export const FixedPointDecimalSchema = z.string().regex(FIXED_POINT, {
  message: `must be a fixed-point decimal string (signed, at most ${SCENARIO_DECIMAL_PLACES} decimal places), not a float`,
});

function nonNegativeDecimal(field: string) {
  return z.string().regex(NON_NEGATIVE_FIXED_POINT, {
    message: `${field} must be a non-negative fixed-point decimal string (at most ${SCENARIO_DECIMAL_PLACES} decimal places), not a float`,
  });
}

function isoInstant(field: string) {
  return z
    .string()
    .regex(ISO_INSTANT, {
      message: `${field} must be an ISO-8601 UTC instant (e.g. 2024-01-01T00:00:00Z)`,
    })
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: `${field} must be a real calendar instant`,
    });
}

/** Time window and the fixed step the run advances by. */
export const ScenarioWindowSchema = z
  .object({
    start: isoInstant("window.start"),
    end: isoInstant("window.end"),
    step: z
      .string()
      .regex(ISO_DURATION, {
        message:
          "window.step must be an ISO-8601 duration (e.g. PT1H, P1D, P1W)",
      })
      .refine((value) => /\d/.test(value), {
        message: "window.step must include a duration amount",
      }),
  })
  .strict()
  .refine((window) => Date.parse(window.end) > Date.parse(window.start), {
    message: "window.end must be after window.start",
    path: ["end"],
  });

/** A single asset in a scenario, identified by its uppercase symbol. */
export const AssetSymbolSchema = z.string().regex(ASSET_SYMBOL, {
  message:
    "must be an uppercase asset symbol of 2-12 characters (e.g. USDC, EURC)",
});

/** Non-empty, duplicate-free asset list. */
export const ScenarioAssetsSchema = z
  .array(AssetSymbolSchema)
  .min(1, { message: "assets must contain at least one asset symbol" })
  .refine((assets) => new Set(assets).size === assets.length, {
    message: "assets must not contain duplicate asset symbols",
  });

/** Where price data comes from. */
export const PRICE_SOURCES = ["horizon", "defillama"] as const;
/** Where protocol rate data comes from. */
export const RATE_SOURCES = ["blend", "defindex"] as const;

export type PriceSource = (typeof PRICE_SOURCES)[number];
export type RateSource = (typeof RATE_SOURCES)[number];

export const PriceSourceSchema = z
  .string()
  .refine(
    (value): value is PriceSource =>
      (PRICE_SOURCES as readonly string[]).includes(value),
    { message: `source.price must be one of: ${PRICE_SOURCES.join(", ")}` }
  );

export const RateSourceSchema = z
  .string()
  .refine(
    (value): value is RateSource =>
      (RATE_SOURCES as readonly string[]).includes(value),
    { message: `source.rate must be one of: ${RATE_SOURCES.join(", ")}` }
  );

/** Price and rate data-source selector. */
export const ScenarioSourceSchema = z
  .object({
    price: PriceSourceSchema,
    rate: RateSourceSchema,
  })
  .strict();

/**
 * Strategy-specific configuration block. `params` values are strings so a
 * `number` (float) can never enter the config; anything money- or rate-shaped
 * must be written as a fixed-point decimal string. Object literals with any
 * unexpected key are rejected so a scenario cannot silently carry config the
 * engine ignores.
 */
export const StrategyConfigSchema = z
  .object({
    id: z.string().min(1, {
      message: "strategy.id must be a non-empty string",
    }),
    version: z.string().min(1, {
      message: "strategy.version must be a non-empty string",
    }),
    params: z.record(z.string(), z.string()).default({}),
  })
  .strict();

/**
 * The full scenario schema. `.strict()` at every level means an unknown key is
 * a validation error rather than a silently dropped value, so the scenario
 * really is the only input that determines a run.
 */
export const ScenarioSchema = z
  .object({
    schemaVersion: z
      .literal(SCENARIO_SCHEMA_VERSION)
      .default(SCENARIO_SCHEMA_VERSION),
    window: ScenarioWindowSchema,
    assets: ScenarioAssetsSchema,
    source: ScenarioSourceSchema,
    startingCapital: nonNegativeDecimal("startingCapital").refine(
      (value) => !ZERO.test(value),
      { message: "startingCapital must be greater than zero" }
    ),
    strategy: StrategyConfigSchema,
    seed: z.string().min(1, {
      message: "seed must be a non-empty string so the run is reproducible",
    }),
  })
  .strict();

/** A fully validated, fully typed scenario. */
export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * Thrown by {@link parseScenario} when the input is not a valid scenario. The
 * message names the offending field(s) (e.g. `startingCapital: ...`), and
 * `issues` carries the raw zod issues for callers that want them.
 */
export class ScenarioValidationError extends Error {
  readonly issues: z.ZodError["issues"];

  constructor(message: string, error: z.ZodError) {
    super(message);
    this.name = "ScenarioValidationError";
    this.issues = error.issues;
  }
}

/**
 * Flattens a zod error into a single, field-qualified string. Nested paths are
 * dot-joined (`window.end`, `source.price`) so the offending field is named
 * unambiguously.
 */
export function formatScenarioError(error: z.ZodError): string {
  const formatted = error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${field}: ${issue.message}`;
  });
  return formatted.length > 0 ? formatted.join("; ") : "Invalid scenario";
}

/**
 * Parses an untrusted value into a fully typed {@link Scenario}, or throws a
 * {@link ScenarioValidationError} naming the offending field.
 */
export function parseScenario(input: unknown): Scenario {
  const result = ScenarioSchema.safeParse(input);
  if (!result.success) {
    throw new ScenarioValidationError(
      formatScenarioError(result.error),
      result.error
    );
  }
  return result.data;
}

export type SafeParseScenarioResult =
  | { success: true; data: Scenario }
  | { success: false; error: ScenarioValidationError };

/** Non-throwing counterpart to {@link parseScenario}. */
export function safeParseScenario(input: unknown): SafeParseScenarioResult {
  const result = ScenarioSchema.safeParse(input);
  if (!result.success) {
    return {
      success: false,
      error: new ScenarioValidationError(
        formatScenarioError(result.error),
        result.error
      ),
    };
  }
  return { success: true, data: result.data };
}
