import { useId, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import {
  MARKET_REGIMES,
  PRICE_SOURCES,
  RATE_SOURCES,
} from "@meridian/strategies";
import type { MarketRegime } from "@meridian/strategies";
import {
  STRATEGY_PARAM_FIELDS,
  defaultFormValues,
  defaultParams,
  hasParamFields,
  parseAssetList,
  presetValues,
  registeredStrategyIds,
  registeredVersion,
  toScenarioInput,
  toSyntheticMarket,
} from "../lib/scenario-form";
import type { ScenarioFormValues } from "../lib/scenario-form";
import { formatDecimal } from "../lib/format";
import { runScenario } from "../lib/scenario-run";
import { RiskMetricsPanel } from "../components/RiskMetricsPanel";
import type { ScenarioRun, ScenarioRunError } from "../lib/scenario-run";

export interface SingleRunViewProps {
  /**
   * The run to summarise. When omitted the view keeps its own latest run, so
   * it also works without a parent holding the state.
   */
  readonly latestRun?: ScenarioRun | null;
  /** Called with every successful run, before the summary renders. */
  readonly onRunComplete?: (run: ScenarioRun) => void;
  /**
   * Called when a submission fails, so a parent holding `latestRun` can drop
   * the previous run instead of showing it next to the error.
   */
  readonly onRunCleared?: () => void;
}

type TextField =
  | "windowStart"
  | "windowEnd"
  | "windowStep"
  | "assets"
  | "priceSource"
  | "rateSource"
  | "startingCapital"
  | "seed"
  | "strategyVersion"
  | "paramsText"
  | "cashRateAnnual";

const ERROR_TITLES: Record<ScenarioRunError["kind"], string> = {
  validation: "Scenario is invalid",
  "unknown-strategy": "Unknown strategy",
  "strategy-params": "Invalid strategy params",
  source: "Source data unavailable",
  execution: "Run failed",
};

function fieldErrors(error: ScenarioRunError | null): Record<string, string> {
  if (error === null) return {};
  if (error.kind === "validation") return { ...error.fields };
  if (error.kind === "strategy-params") {
    return { [`strategy.params.${error.param}`]: error.message };
  }
  return {};
}

function errorFor(
  errors: Record<string, string>,
  path: string
): string | undefined {
  const messages = Object.entries(errors)
    .filter(([key]) => key === path || key.startsWith(`${path}.`))
    .map(([, message]) => message);
  return messages.length > 0 ? messages.join("; ") : undefined;
}

interface FieldProps {
  readonly label: string;
  readonly path: string;
  readonly error: string | undefined;
  readonly hint?: string;
  readonly wide?: boolean;
  readonly children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby": string | undefined;
  }) => ReactNode;
}

function Field({ label, path, error, hint, wide, children }: FieldProps) {
  const id = useId();
  const describedBy =
    [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
      .filter((value) => value !== null)
      .join(" ") || undefined;
  return (
    <div className={`field ${wide ? "field--wide" : ""}`}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        "aria-invalid": error !== undefined,
        "aria-describedby": describedBy,
      })}
      {hint && (
        <span className="field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span
          className="field__error"
          id={`${id}-error`}
          data-testid={`field-error-${path}`}
        >
          {error}
        </span>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <span className="metric__value" data-testid={testId}>
        {formatDecimal(value)}
      </span>
    </div>
  );
}

export function SingleRunView({
  latestRun,
  onRunComplete,
  onRunCleared,
}: SingleRunViewProps = {}) {
  const [values, setValues] = useState<ScenarioFormValues>(defaultFormValues);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ScenarioRunError | null>(null);
  const [ownRun, setOwnRun] = useState<ScenarioRun | null>(null);
  const run = latestRun !== undefined ? latestRun : ownRun;
  const strategyIds = registeredStrategyIds();
  const errors = fieldErrors(error);

  const setField =
    (field: TextField) =>
    (
      event: ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >
    ) => {
      const { value } = event.target;
      setValues((current) => ({ ...current, [field]: value }));
    };

  const setParam = (key: string) => (event: ChangeEvent<HTMLInputElement>) => {
    const { value } = event.target;
    setValues((current) => ({
      ...current,
      params: { ...current.params, [key]: value },
    }));
  };

  const selectStrategy = (event: ChangeEvent<HTMLSelectElement>) => {
    const strategyId = event.target.value;
    setValues((current) => ({
      ...current,
      strategyId,
      strategyVersion: registeredVersion(strategyId) ?? "",
      params: defaultParams(
        strategyId,
        current.regime,
        parseAssetList(current.assets)[0] ?? ""
      ),
      paramsText: "",
    }));
  };

  const selectRegime = (event: ChangeEvent<HTMLSelectElement>) => {
    const regime = event.target.value as MarketRegime;
    setValues((current) => presetValues(regime, current.strategyId));
  };

  // A failed submission invalidates the previous run: the form no longer
  // describes it, so it must not stay on screen next to the error.
  const fail = (failure: ScenarioRunError) => {
    setError(failure);
    setOwnRun(null);
    onRunCleared?.();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRunning(true);
    setError(null);
    try {
      const outcome = await runScenario(
        toScenarioInput(values),
        toSyntheticMarket(values)
      );
      if (outcome.ok) {
        setOwnRun(outcome.run);
        onRunComplete?.(outcome.run);
      } else {
        fail(outcome.error);
      }
    } catch (caught) {
      fail({
        kind: "execution",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setRunning(false);
    }
  };

  const textInput = (
    field: TextField,
    path: string,
    label: string,
    options: { hint?: string; mono?: boolean } = {}
  ) => (
    <Field
      label={label}
      path={path}
      error={errorFor(errors, path)}
      {...(options.hint ? { hint: options.hint } : {})}
    >
      {(props) => (
        <input
          {...props}
          className={`field__control ${options.mono === false ? "" : "field__control--mono"}`}
          value={values[field]}
          onChange={setField(field)}
          data-testid={`input-${field}`}
        />
      )}
    </Field>
  );

  const sourceSelect = (
    field: "priceSource" | "rateSource",
    path: string,
    label: string,
    choices: readonly string[]
  ) => (
    <Field label={label} path={path} error={errorFor(errors, path)}>
      {(props) => (
        <select
          {...props}
          className="field__control"
          value={values[field]}
          onChange={setField(field)}
          data-testid={`input-${field}`}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  const paramFields = STRATEGY_PARAM_FIELDS[values.strategyId] ?? [];

  return (
    <div className="view" data-testid="view-single-run">
      <div className="view__header">
        <h2 className="view__title">Single Run</h2>
        <p className="view__description">
          Configure strategy parameters and scenario models to simulate a single
          execution path.
        </p>
      </div>

      <form
        className="panel scenario-form"
        onSubmit={handleSubmit}
        noValidate
        aria-label="Scenario"
        data-testid="scenario-form"
      >
        <fieldset className="scenario-form__group">
          <legend className="scenario-form__legend">Market</legend>
          <div className="form-grid">
            <Field
              label="Regime preset"
              path="market.regime"
              error={undefined}
              hint="Resets the fields below to the engine's regime scenario."
            >
              {(props) => (
                <select
                  {...props}
                  className="field__control"
                  value={values.regime}
                  onChange={selectRegime}
                  data-testid="input-regime"
                >
                  {MARKET_REGIMES.map((regime) => (
                    <option key={regime} value={regime}>
                      {regime}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {textInput(
              "cashRateAnnual",
              "market.cashRateAnnual",
              "Cash rate (annual)",
              {
                hint: "Decimal fraction recorded for the rate source, e.g. 0.05.",
              }
            )}
          </div>
        </fieldset>

        <fieldset className="scenario-form__group">
          <legend className="scenario-form__legend">Window</legend>
          <div className="form-grid">
            {textInput("windowStart", "window.start", "Start (UTC)")}
            {textInput("windowEnd", "window.end", "End (UTC)")}
            {textInput("windowStep", "window.step", "Step", {
              hint: "ISO-8601 duration, e.g. PT1H or P1D.",
            })}
          </div>
        </fieldset>

        <fieldset className="scenario-form__group">
          <legend className="scenario-form__legend">Assets and sources</legend>
          <div className="form-grid">
            {textInput("assets", "assets", "Assets", {
              hint: "Comma-separated symbols, e.g. USDC, EURC.",
            })}
            {sourceSelect(
              "priceSource",
              "source.price",
              "Price source",
              PRICE_SOURCES
            )}
            {sourceSelect(
              "rateSource",
              "source.rate",
              "Rate source",
              RATE_SOURCES
            )}
          </div>
          <p className="scenario-form__note">
            Prices and rates are a seeded synthetic recording served under the
            selected sources. No network request is made.
          </p>
        </fieldset>

        <fieldset className="scenario-form__group">
          <legend className="scenario-form__legend">Capital and seed</legend>
          <div className="form-grid">
            {textInput(
              "startingCapital",
              "startingCapital",
              "Starting capital"
            )}
            {textInput("seed", "seed", "Seed")}
          </div>
        </fieldset>

        <fieldset className="scenario-form__group">
          <legend className="scenario-form__legend">Strategy</legend>
          <div className="form-grid">
            <Field
              label="Strategy"
              path="strategy.id"
              error={errorFor(errors, "strategy.id")}
            >
              {(props) => (
                <select
                  {...props}
                  className="field__control"
                  value={values.strategyId}
                  onChange={selectStrategy}
                  data-testid="input-strategyId"
                >
                  {strategyIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {textInput("strategyVersion", "strategy.version", "Version")}
            {hasParamFields(values.strategyId) ? (
              paramFields.map((param) => (
                <Field
                  key={param.key}
                  label={param.label}
                  path={`strategy.params.${param.key}`}
                  error={errorFor(errors, `strategy.params.${param.key}`)}
                  hint={param.hint}
                >
                  {(props) => (
                    <input
                      {...props}
                      className="field__control field__control--mono"
                      value={values.params[param.key] ?? ""}
                      onChange={setParam(param.key)}
                      data-testid={`input-param-${param.key}`}
                    />
                  )}
                </Field>
              ))
            ) : (
              <Field
                label="Params"
                path="strategy.params"
                error={errorFor(errors, "strategy.params")}
                hint="One key=value pair per line."
                wide
              >
                {(props) => (
                  <textarea
                    {...props}
                    className="field__control field__control--mono"
                    rows={4}
                    value={values.paramsText}
                    onChange={setField("paramsText")}
                    data-testid="input-paramsText"
                  />
                )}
              </Field>
            )}
          </div>
        </fieldset>

        <div className="scenario-form__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={running}
            data-testid="run-scenario"
          >
            {running ? "Running…" : "Run simulation"}
          </button>
        </div>

        {error && (
          <div
            className="alert alert--error"
            role="alert"
            data-testid="run-error"
            data-error-kind={error.kind}
          >
            <span className="alert__title">{ERROR_TITLES[error.kind]}</span>
            <p className="alert__body">{error.message}</p>
          </div>
        )}
      </form>

      {run && error === null && (
        <section
          className="panel run-summary"
          aria-label="Run summary"
          data-testid="run-summary"
        >
          <div className="run-summary__header">
            <h3 className="run-summary__title">Run summary</h3>
            <span className="run-summary__meta">
              {run.scenario.strategy.id}@{run.scenario.strategy.version} ·{" "}
              {run.market.regime} · {run.result.snapshots.length} snapshots
            </span>
          </div>
          <div className="run-summary__metrics">
            <Metric
              label="Final value"
              value={run.result.finalValue.toString()}
              testId="summary-final-value"
            />
            <Metric
              label="Total interest"
              value={run.result.totalInterest.toString()}
              testId="summary-total-interest"
            />
            <Metric
              label="Total funding"
              value={run.result.totalFunding.toString()}
              testId="summary-total-funding"
            />
            <Metric
              label="Total fees"
              value={run.result.totalFees.toString()}
              testId="summary-total-fees"
            />
          </div>
          <p className="run-summary__note">
            Starting capital {formatDecimal(run.scenario.startingCapital)}.
            Strategy equity at close{" "}
            {formatDecimal(run.result.strategyEquity.toString())}.
          </p>
        </section>
      )}

      {run && error === null && (
        <RiskMetricsPanel
          snapshots={run.result.snapshots}
          step={run.scenario.window.step}
        />
      )}
    </div>
  );
}
