import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AmountInput } from "../ui/AmountInput";
import type { ApiPosition, ApiVault } from "../../lib/api";
import { formatUsd } from "../../lib/format";

interface DepositTabProps {
  amount: string;
  onAmountChange: (value: string) => void;
  onAmountKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  bestVault: ApiVault | undefined;
  position: ApiPosition | undefined;
  hasPosition: boolean;
  showRiskDisclosure: boolean;
  onAcknowledgeRisk: () => void;
  isDepositing: boolean;
  onSubmit: () => void;
}

export function DepositTab({
  amount,
  onAmountChange,
  onAmountKeyDown,
  bestVault,
  position,
  hasPosition,
  showRiskDisclosure,
  onAcknowledgeRisk,
  isDepositing,
  onSubmit,
}: DepositTabProps) {
  const { t, i18n } = useTranslation();
  // Local until the submit button below commits it via onAcknowledgeRisk:
  // checking the box alone must not dismiss the overlay, so a wallet can't
  // acknowledge the risks by an accidental or automated click on the
  // checkbox alone.
  const [riskChecked, setRiskChecked] = useState(false);

  return (
    <div className="space-y-4">
      {showRiskDisclosure && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="deposit-risk-disclosure-title"
        >
          <section
            data-testid="deposit-risk-disclosure"
            className="w-full max-w-md rounded-2xl border border-amber-800/70 bg-[#161b22] p-6 space-y-4 shadow-2xl shadow-black/60"
          >
            <h3
              id="deposit-risk-disclosure-title"
              className="text-base font-semibold text-amber-300"
            >
              {t("vaultPanel.riskDisclosure.title")}
            </h3>
            <p className="text-sm leading-relaxed text-amber-200/90">
              {t("vaultPanel.riskDisclosure.description")}
            </p>
            <ul className="space-y-2 text-sm leading-relaxed text-amber-200/80 list-disc list-inside">
              <li>{t("vaultPanel.riskDisclosure.smartContractRisk")}</li>
              <li>{t("vaultPanel.riskDisclosure.adapterRisk")}</li>
            </ul>
            <label className="flex items-start gap-2 text-sm text-amber-200">
              <input
                type="checkbox"
                data-testid="deposit-risk-acknowledgement"
                checked={riskChecked}
                onChange={(event) =>
                  setRiskChecked(event.currentTarget.checked)
                }
                className="mt-0.5"
              />
              <span>{t("vaultPanel.riskDisclosure.acknowledgement")}</span>
            </label>
            <button
              type="button"
              data-testid="deposit-risk-submit"
              disabled={!riskChecked}
              onClick={onAcknowledgeRisk}
              className="w-full rounded-xl bg-amber-600 hover:bg-amber-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold py-3 transition-all duration-150 disabled:cursor-not-allowed"
            >
              {t("vaultPanel.riskDisclosure.continue")}
            </button>
          </section>
        </div>
      )}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-500">
            {t("vaultPanel.amount")}
          </span>
          {hasPosition && position && (
            <span className="text-xs text-gray-600">
              {t("vaultPanel.balance")}:{" "}
              {formatUsd(position.deposited, i18n.language)}
            </span>
          )}
        </div>
        <AmountInput
          currency="USDC"
          value={amount}
          onChange={onAmountChange}
          onKeyDown={onAmountKeyDown}
        />
      </div>
      <button
        data-testid="vault-deposit-submit"
        onClick={onSubmit}
        disabled={
          !amount ||
          !bestVault ||
          isDepositing ||
          showRiskDisclosure ||
          parseFloat(amount) <= 0 ||
          Number.isNaN(parseFloat(amount))
        }
        className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold py-3.5 transition-all duration-150 disabled:cursor-not-allowed"
      >
        {isDepositing ? t("vaultPanel.waiting") : t("vaultPanel.deposit")}
      </button>
    </div>
  );
}
