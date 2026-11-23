import { useTranslation } from "react-i18next";
import type { VaultTransactionPreview } from "../../hooks/useVaultActions";

interface TransactionSimulationDialogProps {
  preview: VaultTransactionPreview | null;
  isPreparing: boolean;
  error: string | null;
  onRetry: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function formatStroops(value: string, locale: string): string {
  const amount = Number(value) / 10_000_000;
  return Number.isFinite(amount)
    ? amount.toLocaleString(locale === "fr" ? "fr-FR" : "en-US", {
        maximumFractionDigits: 7,
      })
    : value;
}

export function TransactionSimulationDialog({
  preview,
  isPreparing,
  error,
  onRetry,
  onConfirm,
  onCancel,
}: TransactionSimulationDialogProps) {
  const { t, i18n } = useTranslation();
  const isDeposit = preview?.operation === "deposit";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      data-testid="transaction-simulation-backdrop"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="transaction-simulation-title"
        data-testid="transaction-simulation-dialog"
        className="w-full max-w-md rounded-2xl border border-gray-700 bg-deep p-6 shadow-2xl"
      >
        <h2
          id="transaction-simulation-title"
          className="text-lg font-semibold text-paper"
        >
          {t("vaultPanel.simulation.title")}
        </h2>

        {isPreparing && !preview ? (
          <p role="status" className="mt-4 text-sm text-gray-400">
            {t("vaultPanel.simulation.loading")}
          </p>
        ) : error ? (
          <div className="mt-4 space-y-3">
            <p role="alert" className="text-sm text-red-400">
              {t("vaultPanel.simulation.failed")}
            </p>
            <p className="text-sm text-gray-400">{error}</p>
          </div>
        ) : preview ? (
          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-400">
                {t("vaultPanel.simulation.operation")}
              </dt>
              <dd className="text-right text-paper">
                {t(
                  isDeposit
                    ? "vaultPanel.simulation.deposit"
                    : "vaultPanel.simulation.withdraw"
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-400">
                {t("vaultPanel.simulation.amount")}
              </dt>
              <dd className="text-right text-paper">
                {preview.amount} {isDeposit ? preview.asset : "mUSDC"}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-400">
                {t(
                  isDeposit
                    ? "vaultPanel.simulation.expectedShares"
                    : "vaultPanel.simulation.expectedPayout"
                )}
              </dt>
              <dd className="text-right text-paper">
                {formatStroops(preview.expectedResult, i18n.language)}{" "}
                {isDeposit ? "mUSDC" : preview.asset}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-400">
                {t("vaultPanel.simulation.fee")}
              </dt>
              <dd className="text-right text-paper">
                {formatStroops(preview.fee, i18n.language)} XLM
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-400">
                {t("vaultPanel.simulation.minimumReceived")}
              </dt>
              <dd className="text-right text-paper">
                {formatStroops(preview.minimumReceived, i18n.language)}{" "}
                {isDeposit ? "mUSDC" : preview.asset}
              </dd>
            </div>
          </dl>
        ) : null}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            data-testid="simulation-cancel"
            onClick={onCancel}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800"
          >
            {t("vaultPanel.simulation.cancel")}
          </button>
          {error ? (
            <button
              type="button"
              data-testid="simulation-retry"
              onClick={onRetry}
              disabled={isPreparing}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {t("common.retry")}
            </button>
          ) : preview ? (
            <button
              type="button"
              data-testid="simulation-confirm"
              onClick={onConfirm}
              disabled={isPreparing}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {t("vaultPanel.simulation.confirm")}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
