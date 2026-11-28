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

  // Focus management and scroll lock: lock body scroll while modal is open,
  // move focus into the dialog on open and hand it back to the element that
  // opened it on close. The modal is mounted only while open, so mount/unmount
  // are the open/close moments.
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const opener = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? dialog)?.focus();

    return () => {
      document.body.style.overflow = originalOverflow;
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
      className="fixed inset-0 z-50 flex items-center outline-none justify-center bg-black/80 p-4 sm:backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="risk-disclosure-title"
      aria-describedby="risk-disclosure-desc"
    >
      <section
        data-testid="risk-disclosure"
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-gray-800 bg-deep p-5 space-y-4 shadow-2xl shadow-black/60 sm:p-6"
      >
        <button
          type="button"
          data-testid="risk-disclosure-cancel"
          onClick={onCancel}
          aria-label={t("riskDisclosure.cancel")}
          title={t("riskDisclosure.cancel")}
          className="absolute right-3 top-3 inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 hover:text-paper transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none sm:right-4 sm:top-4"
        >
          <X size={18} />
        </button>
        <h3
          id="risk-disclosure-title"
          className="text-base font-semibold text-paper pr-6"
        >
          {t("riskDisclosure.title")}
        </h3>
        <p
          id="risk-disclosure-desc"
          className="text-sm leading-relaxed text-gray-300"
        >
          {t("riskDisclosure.description")}
        </p>
        <ul className="space-y-2 text-sm leading-relaxed text-gray-400 list-disc list-inside">
          <li>{t("riskDisclosure.smartContractRisk")}</li>
          <li>{t("riskDisclosure.adapterRisk")}</li>
        </ul>
        <label className="flex min-h-11 items-start gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            data-testid="risk-disclosure-acknowledgement"
            checked={riskChecked}
            onChange={(event) => setRiskChecked(event.currentTarget.checked)}
            className="mt-0.5 rounded border border-gray-700 bg-night text-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
          />
          <span>{t("riskDisclosure.acknowledgement")}</span>
        </label>
        <button
          type="button"
          data-testid="risk-disclosure-accept"
          disabled={!riskChecked}
          onClick={onAccept}
          className="w-full rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 disabled:text-gray-500 text-white text-sm font-semibold py-3 transition-all duration-150 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none"
        >
          {t("riskDisclosure.continue")}
        </button>
      </section>
    </div>
  );
}
