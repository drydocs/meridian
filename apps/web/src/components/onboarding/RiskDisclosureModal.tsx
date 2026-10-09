import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

interface RiskDisclosureModalProps {
  onAccept: () => void;
  onCancel: () => void;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// Shown before either connecting a wallet or making a deposit, whichever
// comes first for a given browser; accepting runs the caller's onAccept.
export function RiskDisclosureModal({
  onAccept,
  onCancel,
}: RiskDisclosureModalProps) {
  const { t } = useTranslation();
  const [riskChecked, setRiskChecked] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Always call the latest onCancel from the key handler without re-running
  // the focus effect (which must run exactly once per open/close).
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  // Focus management: move focus into the dialog on open and hand it back to
  // the element that opened it on close. The modal is mounted only while open,
  // so mount/unmount are the open/close moments.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? dialog)?.focus();

    return () => {
      if (opener && opener.isConnected && typeof opener.focus === "function") {
        opener.focus();
      }
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancelRef.current();
      return;
    }
    if (event.key !== "Tab") return;

    // Trap Tab / Shift+Tab inside the dialog by wrapping at the ends.
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const firstEl = focusable[0];
    const lastEl = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === firstEl || active === dialog)) {
      event.preventDefault();
      lastEl.focus();
    } else if (!event.shiftKey && active === lastEl) {
      event.preventDefault();
      firstEl.focus();
    } else if (!dialog.contains(active)) {
      event.preventDefault();
      firstEl.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-center outline-none justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="risk-disclosure-title"
    >
      <section
        data-testid="risk-disclosure"
        className="relative w-full max-w-md rounded-2xl border border-gray-800 bg-deep p-6 space-y-4 shadow-2xl shadow-black/60"
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
