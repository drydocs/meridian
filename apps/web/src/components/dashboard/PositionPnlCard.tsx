import { useTranslation } from "react-i18next";
import { VAULT_PERFORMANCE_FEE_BPS } from "@meridian/shared";
import type { ApiPosition } from "../../lib/api";
import { formatUsd } from "../../lib/format";

export interface PositionPnlBreakdown {
  principal: number;
  grossYield: number;
  performanceFee: number;
  netYield: number;
  currentValue: number;
  feeBps: number;
}

export function computePositionPnl(
  position: ApiPosition,
  performanceFeeBps: number = VAULT_PERFORMANCE_FEE_BPS
): PositionPnlBreakdown {
  const currentValue = Number.isFinite(position.deposited)
    ? position.deposited
    : 0;
  const principal =
    typeof position.principal === "number" &&
    Number.isFinite(position.principal) &&
    position.principal > 0
      ? position.principal
      : Math.max(
          0,
          currentValue -
            (Number.isFinite(position.earned) ? position.earned : 0)
        );
  const grossYield = currentValue - principal;
  const performanceFee =
    grossYield > 0 ? (grossYield * performanceFeeBps) / 10_000 : 0;
  const netYield = grossYield - performanceFee;

  return {
    principal,
    grossYield,
    performanceFee,
    netYield,
    currentValue,
    feeBps: performanceFeeBps,
  };
}

function formatSignedUsd(value: number, locale: string): string {
  if (value > 0) return `+${formatUsd(value, locale)}`;
  if (value < 0) return `-${formatUsd(Math.abs(value), locale)}`;
  return formatUsd(0, locale);
}

function yieldColorClass(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-gray-300";
}

export interface PositionPnlCardProps {
  position?: ApiPosition;
  isError?: boolean;
  onRetry?: () => void;
  performanceFeeBps?: number;
}

export function PositionPnlCard({
  position,
  isError = false,
  onRetry,
  performanceFeeBps = VAULT_PERFORMANCE_FEE_BPS,
}: PositionPnlCardProps) {
  const { t, i18n } = useTranslation();

  if (isError || !position) {
    return (
      <div
        data-testid="position-pnl-unavailable"
        className="mx-7 my-5 rounded-xl border border-amber-800/70 bg-amber-950/20 px-4 py-3.5 flex items-center justify-between gap-3"
      >
        <div>
          <p className="text-xs font-semibold text-amber-300 mb-0.5">
            {t("positionPnl.title")}
          </p>
          <p className="text-sm text-amber-400">
            {t("positionPnl.unavailable")}
          </p>
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-lg border border-amber-800/70 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-700 hover:text-amber-200 transition-colors duration-150"
          >
            {t("common.retry")}
          </button>
        )}
      </div>
    );
  }

  const breakdown = computePositionPnl(position, performanceFeeBps);
  const feePercent = (breakdown.feeBps / 100).toFixed(0);

  return (
    <div
      data-testid="position-pnl-card"
      className="mx-7 my-5 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3.5"
    >
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
        {t("positionPnl.title")}
      </p>
      <dl className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-gray-400">{t("positionPnl.principal")}</dt>
          <dd
            data-testid="pnl-principal"
            className="font-medium text-paper tabular-nums"
          >
            {formatUsd(breakdown.principal, i18n.language)}
          </dd>
        </div>

        <div className="flex items-center justify-between">
          <dt className="text-gray-400">{t("positionPnl.grossYield")}</dt>
          <dd
            data-testid="pnl-gross-yield"
            className={`font-medium tabular-nums ${yieldColorClass(breakdown.grossYield)}`}
          >
            {formatSignedUsd(breakdown.grossYield, i18n.language)}
          </dd>
        </div>

        <div className="flex items-center justify-between">
          <dt className="text-gray-400">
            {t("positionPnl.performanceFee", { percent: feePercent })}
          </dt>
          <dd
            data-testid="pnl-performance-fee"
            className="font-medium text-gray-300 tabular-nums"
          >
            {breakdown.performanceFee > 0
              ? `-${formatUsd(breakdown.performanceFee, i18n.language)}`
              : formatUsd(0, i18n.language)}
          </dd>
        </div>

        <div className="flex items-center justify-between">
          <dt className="text-gray-400">{t("positionPnl.netYield")}</dt>
          <dd
            data-testid="pnl-net-yield"
            className={`font-semibold tabular-nums ${yieldColorClass(breakdown.netYield)}`}
          >
            {formatSignedUsd(breakdown.netYield, i18n.language)}
          </dd>
        </div>

        <div className="flex items-center justify-between border-t border-gray-800 pt-2 mt-2">
          <dt className="font-medium text-gray-300">
            {t("positionPnl.currentValue")}
          </dt>
          <dd
            data-testid="pnl-current-value"
            className="font-bold text-paper tabular-nums"
          >
            {formatUsd(breakdown.currentValue, i18n.language)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
