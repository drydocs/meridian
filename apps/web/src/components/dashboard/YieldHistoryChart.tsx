import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { usePositionHistory } from "../../hooks/usePositionHistory";
import { formatUsd } from "../../lib/format";
import { PROTOCOL_LABEL } from "../../lib/protocolLabels";
import { toChartData } from "../../lib/yieldHistory";

const RANGES = [
  { days: 7, labelKey: "yieldHistory.range7" },
  { days: 30, labelKey: "yieldHistory.range30" },
  { days: 90, labelKey: "yieldHistory.range90" },
] as const;

// One muted hue family (emerald to slate) so series read as a set on the
// dark panel rather than as competing accents.
const SERIES_COLORS = ["#34d399", "#64748b", "#fbbf24", "#94a3b8"];

interface YieldHistoryChartProps {
  publicKey: string | null;
}

export function YieldHistoryChart({ publicKey }: YieldHistoryChartProps) {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState<number>(30);
  const { data, isLoading, isError, refetch } = usePositionHistory(
    publicKey,
    days
  );
  const locale = i18n.language === "fr" ? "fr-FR" : "en-US";
  const { points, protocols } = toChartData(data ?? []);
  const latest = points[points.length - 1];
  // A single point draws no line; wait for a second snapshot.
  const hasHistory = points.length >= 2;

  const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString(locale, { month: "short", day: "numeric" });

  return (
    <section
      aria-label={t("yieldHistory.title")}
      className="mx-7 my-5 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3.5"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-xs text-gray-500 mb-1">
            {t("yieldHistory.title")}
          </p>
          {latest && (
            <p
              data-testid="yield-history-earned"
              className="text-base font-bold text-emerald-400 tabular-nums"
            >
              +{formatUsd(latest.earned, i18n.language)}
              <span className="ml-2 text-xs font-normal text-gray-500">
                {t("yieldHistory.earned")}
              </span>
            </p>
          )}
        </div>
        <div
          role="group"
          aria-label={t("yieldHistory.rangeLabel")}
          className="flex gap-1 shrink-0"
        >
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              aria-pressed={days === range.days}
              onClick={() => setDays(range.days)}
              className={`rounded-md px-2 py-1 text-xs font-medium transition-colors duration-150 active:scale-95 ${
                days === range.days
                  ? "bg-gray-800 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t(range.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div
          data-testid="yield-history-loading"
          className="h-40 w-full bg-gray-800 rounded animate-pulse"
        />
      ) : isError ? (
        <div className="rounded-xl border border-amber-800/70 bg-amber-950/20 px-4 py-3.5 flex items-center justify-between gap-3">
          <p className="text-sm text-amber-400">
            {t("yieldHistory.loadError")}
          </p>
          <button
            onClick={() => void refetch()}
            className="shrink-0 rounded-lg border border-amber-800/70 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-700 hover:text-amber-200 transition-colors duration-150"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : !hasHistory ? (
        <p data-testid="yield-history-empty" className="text-sm text-gray-500">
          {t("yieldHistory.empty")}
        </p>
      ) : (
        <div
          role="img"
          aria-label={t("yieldHistory.chartLabel")}
          data-testid="yield-history-chart"
          className="h-40 w-full"
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={points}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <CartesianGrid stroke="#1f2937" vertical={false} />
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatDate}
                tick={{ fill: "#6b7280", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                width={48}
                tickFormatter={(v: number) =>
                  v.toLocaleString(locale, { maximumFractionDigits: 0 })
                }
                tick={{ fill: "#6b7280", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                labelFormatter={(ms) => formatDate(Number(ms))}
                formatter={(value, name) => [
                  formatUsd(Number(value), i18n.language),
                  PROTOCOL_LABEL[String(name)] ?? String(name),
                ]}
                contentStyle={{
                  background: "#0d1e35",
                  border: "1px solid #1f2937",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              {protocols.map((protocol, i) => (
                <Area
                  key={protocol}
                  type="monotone"
                  dataKey={protocol}
                  stackId="value"
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                  fillOpacity={0.18}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {hasHistory && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {protocols.map((protocol, i) => (
            <li
              key={protocol}
              className="flex items-center gap-1.5 text-xs text-gray-400"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{
                  background: SERIES_COLORS[i % SERIES_COLORS.length],
                }}
              />
              {PROTOCOL_LABEL[protocol] ?? protocol}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
