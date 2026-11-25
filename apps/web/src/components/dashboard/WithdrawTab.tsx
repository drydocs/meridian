import { useTranslation } from "react-i18next";
import { AmountInput } from "../ui/AmountInput";
import type { ApiPosition, ApiVault } from "../../lib/api";
import {
  formatMoneyInput,
  formatNumber,
  parseMoneyInput,
} from "../../lib/format";

interface WithdrawTabProps {
  amount: string;
  onAmountChange: (value: string) => void;
  onAmountKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  bestVault: ApiVault | undefined;
  position: ApiPosition | undefined;
  hasPosition: boolean;
  isWithdrawing: boolean;
  // True only while the wallet signature is pending; gates the cancel control.
  isSigning?: boolean;
  onCancel?: () => void;
  onSubmit: () => void;
}

export function WithdrawTab({
  amount,
  onAmountChange,
  onAmountKeyDown,
  bestVault,
  position,
  hasPosition,
  isWithdrawing,
  isSigning,
  onCancel,
  onSubmit,
}: WithdrawTabProps) {
  const { t, i18n } = useTranslation();
  const canonicalAmount = parseMoneyInput(amount, i18n.language);
  const numericAmount = canonicalAmount ? Number(canonicalAmount) : NaN;
  const amountError =
    amount === ""
      ? null
      : canonicalAmount === null || !Number.isFinite(numericAmount)
        ? "invalid"
        : numericAmount <= 0
          ? "nonPositive"
          : numericAmount > (position?.shares ?? 0)
            ? "exceedsPosition"
            : null;
  const showError = amountError !== null;

  return (
    <div className="space-y-4">
      {!hasPosition ? (
        <p className="text-sm text-gray-400 py-2">{t("vaultPanel.position")}</p>
      ) : (
        <>
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-gray-400">
                {t("vaultPanel.amount")}
              </span>
              <button
                data-testid="vault-withdraw-max"
                onClick={() =>
                  onAmountChange(
                    formatMoneyInput(position!.shares.toFixed(7), i18n.language)
                  )
                }
                className="text-xs text-settled hover:text-emerald-400 rounded px-1 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none"
              >
                {t("vaultPanel.max")}:{" "}
                {formatNumber(position!.shares, i18n.language, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </button>
            </div>
            <AmountInput
              currency="mUSDC"
              value={amount}
              onChange={onAmountChange}
              onKeyDown={onAmountKeyDown}
              invalid={showError}
              describedBy={showError ? "withdraw-amount-error" : undefined}
            />
            {showError && (
              <p
                id="withdraw-amount-error"
                data-testid="withdraw-amount-error"
                role="alert"
                className="mt-2 text-xs text-red-400"
              >
                {t(`vaultPanel.validation.${amountError}`)}
              </p>
            )}
          </div>
          <button
            data-testid="vault-withdraw-submit"
            onClick={onSubmit}
            disabled={
              !amount || !bestVault || isWithdrawing || amountError !== null
            }
            className="w-full rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 disabled:text-gray-500 text-white text-sm font-semibold py-3.5 transition-all duration-150 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none"
          >
            {isWithdrawing ? t("vaultPanel.waiting") : t("vaultPanel.withdraw")}
          </button>
          {isSigning && onCancel && (
            <button
              type="button"
              data-testid="vault-withdraw-cancel"
              onClick={onCancel}
              className="w-full rounded-xl border border-gray-700 text-gray-400 hover:border-gray-600 hover:text-paper text-sm font-medium py-2.5 transition-colors duration-150"
            >
              {t("common.cancel")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
