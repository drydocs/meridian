import { useTranslation } from "react-i18next";

interface AmountInputProps {
  currency: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  invalid?: boolean;
  describedBy?: string;
}

export function AmountInput({
  currency,
  value,
  onChange,
  onKeyDown,
  invalid = false,
  describedBy,
}: AmountInputProps) {
  const { t, i18n } = useTranslation();
  const placeholder = i18n.language === "fr" ? "0,00" : "0.00";
  return (
    <div
      className={`flex items-center gap-2 rounded-xl border bg-gray-900/70 px-3 py-3.5 transition-colors duration-150 sm:gap-3 sm:px-4 ${
        invalid
          ? "border-red-800/70 focus-within:border-red-600 focus-within:ring-2 focus-within:ring-red-500"
          : "border-gray-700 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500"
      }`}
    >
      {/* Accessible name for screen readers — ties the input to its currency denomination */}
      <input
        type="text"
        inputMode="decimal"
        placeholder={placeholder}
        aria-label={t("vaultPanel.amountAriaLabel", { currency })}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="min-h-11 min-w-0 flex-1 bg-transparent text-lg font-semibold text-paper outline-none placeholder:text-gray-700 sm:text-xl [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="shrink-0 rounded-lg border border-gray-700 bg-gray-800 px-2 py-1 text-xs font-semibold text-gray-300 sm:px-2.5">
        {currency}
      </span>
    </div>
  );
}
