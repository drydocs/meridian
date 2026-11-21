import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AmountInput } from "../ui/AmountInput";
import type { ApiPosition, ApiVault } from "../../lib/api";
import { formatUsd } from "../../lib/format";

type DepositAmountError =
  "required" | "invalid" | "nonPositive" | "exceedsBalance";

// Returns null when the amount is submittable. `availableBalance` is optional:
// the balance check only runs when the caller knows the spendable balance.
function validateDepositAmount(
  amount: string,
  availableBalance?: number
): DepositAmountError | null {
  if (amount.trim() === "") return "required";
  const value = Number(amount);
  if (Number.isNaN(value) || !Number.isFinite(value)) return "invalid";
  if (value <= 0) return "nonPositive";
  if (availableBalance !== undefined && value > availableBalance) {
    return "exceedsBalance";
  }
  return null;
}

interface DepositTabProps {
  amount: string;
  onAmountChange: (value: string) => void;
  onAmountKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  bestVault: ApiVault | undefined;
  position?: ApiPosition | undefined;
  hasPosition?: boolean;
  isDepositing: boolean;
  onSubmit: () => void;
  availableBalance?: number;
  isBalanceError?: boolean;
  onRetryBalance?: () => void;
}

export function DepositTab({
  amount,
  onAmountChange,
  onAmountKeyDown,
  bestVault,
  isDepositing,
  onSubmit,
  availableBalance,
  isBalanceError,
  onRetryBalance,
}: DepositTabProps) {
  const { t, i18n } = useTranslation();
  // True only when the user emptied the field themselves. A completed deposit
  // also clears it, and that must not surface the required message.
  const [clearedByUser, setClearedByUser] = useState(false);
  const error = validateDepositAmount(amount, availableBalance);
  const showError = error !== null && (amount !== "" || clearedByUser);

  function handleMax() {
    if (availableBalance === undefined) return;
    const maxAmount = Number.isInteger(availableBalance)
      ? availableBalance.toString()
      : parseFloat(availableBalance.toFixed(7)).toString();
    setClearedByUser(false);
    onAmountChange(maxAmount);
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-500">
            {t("vaultPanel.amount")}
          </span>
          {isBalanceError ? (
            <div
              data-testid="vault-balance-error"
              className="flex items-center gap-1.5 text-xs text-amber-400"
            >
              <span>{t("vaultPanel.balanceError")}</span>
              {onRetryBalance && (
                <button
                  type="button"
                  data-testid="vault-balance-retry"
                  onClick={onRetryBalance}
                  aria-label={t("vaultPanel.retryBalance")}
                  className="text-amber-300 hover:text-amber-200 underline font-medium"
                >
                  {t("common.retry")}
                </button>
              )}
            </div>
          ) : availableBalance !== undefined ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600">
                {t("vaultPanel.balance")}:{" "}
                {formatUsd(availableBalance, i18n.language)}
              </span>
              <button
                type="button"
                data-testid="vault-deposit-max"
                onClick={handleMax}
                className="text-xs text-emerald-500 hover:text-emerald-400 transition-colors duration-150"
              >
                {t("vaultPanel.max")}
              </button>
            </div>
          ) : null}
        </div>
        <AmountInput
          currency="USDC"
          value={amount}
          onChange={(v) => {
            setClearedByUser(v === "");
            onAmountChange(v);
          }}
          onKeyDown={onAmountKeyDown}
          invalid={showError}
          describedBy={showError ? "deposit-amount-error" : undefined}
        />
        {showError && (
          <p
            id="deposit-amount-error"
            data-testid="deposit-amount-error"
            role="alert"
            className="mt-2 text-xs text-red-400"
          >
            {t(`vaultPanel.validation.${error}`)}
          </p>
        )}
      </div>
      <button
        data-testid="vault-deposit-submit"
        onClick={onSubmit}
        disabled={error !== null || !bestVault || isDepositing}
        className="w-full rounded-xl bg-emerald-600 hover:bg-settled disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold py-3.5 transition-all duration-150 disabled:cursor-not-allowed"
      >
        {isDepositing ? t("vaultPanel.waiting") : t("vaultPanel.deposit")}
      </button>
    </div>
  );
}
