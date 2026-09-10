import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

interface RiskDisclosureModalProps {
  onAccept: () => void;
  onCancel: () => void;
}

/**
 * Shown before a wallet connection is ever initiated (#720): accepting is
 * what triggers the actual connect, cancelling rejects the connection
 * request outright, so no wallet interaction happens at all. This is a
 * general usage caveat, not a deposit-specific one, and deliberately has no
 * wallet identity to key an acknowledgement to yet; see
 * WalletConnect.tsx for where the resulting accepted flag is read.
 */
export function RiskDisclosureModal({
  onAccept,
  onCancel,
}: RiskDisclosureModalProps) {
  const { t } = useTranslation();
  const [riskChecked, setRiskChecked] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="risk-disclosure-title"
    >
      <section
        data-testid="risk-disclosure"
        className="relative w-full max-w-md rounded-2xl border border-gray-800 bg-[#0d1e35] p-6 space-y-4 shadow-2xl shadow-black/60"
      >
        <button
          type="button"
          data-testid="risk-disclosure-cancel"
          onClick={onCancel}
          aria-label={t("riskDisclosure.cancel")}
          title={t("riskDisclosure.cancel")}
          className="absolute right-4 top-4 text-gray-500 hover:text-white transition-colors duration-150"
        >
          <X size={18} />
        </button>
        <h3
          id="risk-disclosure-title"
          className="text-base font-semibold text-white pr-6"
        >
          {t("riskDisclosure.title")}
        </h3>
        <p className="text-sm leading-relaxed text-gray-300">
          {t("riskDisclosure.description")}
        </p>
        <ul className="space-y-2 text-sm leading-relaxed text-gray-400 list-disc list-inside">
          <li>{t("riskDisclosure.smartContractRisk")}</li>
          <li>{t("riskDisclosure.adapterRisk")}</li>
        </ul>
        <label className="flex items-start gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            data-testid="risk-disclosure-acknowledgement"
            checked={riskChecked}
            onChange={(event) => setRiskChecked(event.currentTarget.checked)}
            className="mt-0.5"
          />
          <span>{t("riskDisclosure.acknowledgement")}</span>
        </label>
        <button
          type="button"
          data-testid="risk-disclosure-accept"
          disabled={!riskChecked}
          onClick={onAccept}
          className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold py-3 transition-all duration-150 disabled:cursor-not-allowed"
        >
          {t("riskDisclosure.continue")}
        </button>
      </section>
    </div>
  );
}
