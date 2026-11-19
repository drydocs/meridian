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
import { formatDate, formatUsd } from "../../lib/format";
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
  const [showTable, setShowTable] = useState<boolean>(false);
  const { data, isLoading, isError, refetch } = usePositionHistory(
    publicKey,
    days
  );
  const locale = i18n.language === "fr" ? "fr-FR" : "en-US";
  const { points, protocols } = toChartData(data ?? []);
  const latest = points[points.length - 1];
  // A single point draws no line; wait for a second snapshot.
  const hasHistory = points.length >= 2;

  const formatTickDate = (ms: number) =>
    formatDate(ms, i18n.language, { month: "short", day: "numeric" });

  return (
    <section
      aria-label={t("yieldHistory.title")}
      className="mx-7 my-5 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3.5"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-xs text-gray-400 mb-1">
            {t("yieldHistory.title")}
          </p>
          {latest && (
            <p
              data-testid="yield-history-earned"
              className="text-base font-bold text-emerald-400 tabular-nums"
            >
              +{formatUsd(latest.earned, i18n.language)}
              <span className="ml-2 text-xs font-normal text-gray-400">
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
              className={`rounded-md px-2 py-1 text-xs font-medium transition-colors duration-150 active:scale-95 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none ${
                days === range.days
                  ? "bg-gray-800 text-paper"
                  : "text-gray-400 hover:text-gray-200"
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
            className="shrink-0 rounded-lg border border-amber-800/70 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-700 hover:text-amber-200 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : !hasHistory ? (
        <p data-testid="yield-history-empty" className="text-sm text-gray-400">
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
                tickFormatter={formatTickDate}
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
                labelFormatter={(ms) => formatTickDate(Number(ms))}
                formatter={(value, name) => [
                  formatUsd(Number(value), i18n.language),
                  PROTOCOL_LABEL[String(name)] ?? String(name),
                ]}
                contentStyle={{
                  background: "var(--color-deep)",
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
        <>
          <div className="mt-3 flex items-center justify-between">
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
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
            <button
              type="button"
              data-testid="yield-history-toggle-table"
              onClick={() => setShowTable((v) => !v)}
              aria-expanded={showTable}
              aria-controls="yield-history-table"
              className="text-xs text-gray-400 hover:text-gray-200 underline focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none rounded"
            >
              {showTable
                ? t("yieldHistory.hideTable", "Hide tabular data")
                : t("yieldHistory.viewTable", "View data as table")}
            </button>
          </div>

          <div
            id="yield-history-table"
            data-testid="yield-history-table"
            className={showTable ? "mt-3 overflow-x-auto" : "sr-only"}
          >
            <table className="w-full text-left text-xs text-gray-300">
              <caption className="sr-only">
                {t("yieldHistory.tableCaption", "Yield history data points")}
              </caption>
              <thead className="border-b border-gray-800 text-gray-400">
                <tr>
                  <th scope="col" className="py-1.5 pr-3">
                    {t("yieldHistory.date", "Date")}
                  </th>
                  {protocols.map((protocol) => (
                    <th key={protocol} scope="col" className="py-1.5 pr-3">
                      {PROTOCOL_LABEL[protocol] ?? protocol}
                    </th>
                  ))}
                  <th scope="col" className="py-1.5">
                    {t("yieldHistory.total", "Total")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {points.map((pt) => (
                  <tr key={pt.timestamp}>
                    <td className="py-1 pr-3">
                      {formatDate(pt.timestamp, i18n.language)}
                    </td>
                    {protocols.map((protocol) => (
                      <td key={protocol} className="py-1 pr-3">
                        {formatUsd(Number(pt[protocol] ?? 0), i18n.language)}
                      </td>
                    ))}
                    <td className="py-1">
                      {formatUsd(Number(pt.total ?? 0), i18n.language)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
