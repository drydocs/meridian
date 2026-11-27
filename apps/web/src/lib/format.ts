const MAX_MONEY_DECIMAL_PLACES = 7;
const MONEY_SPACE = /[\s\u00a0\u202f]/g;

function isGroupedInteger(value: string, separator: "," | "."): boolean {
  const escapedSeparator = separator === "." ? "\\." : separator;
  return new RegExp(`^\\d{1,3}(?:${escapedSeparator}\\d{3})+$`).test(value);
}

/**
 * Converts user-entered money into the dot-decimal representation accepted by
 * the API. Empty input is returned as an empty string; invalid input is null.
 */
export function parseMoneyInput(input: string, locale: string): string | null {
  const value = input.trim();
  if (value === "") return "";

  if (!/^\d[\d.,\s\u00a0\u202f]*$/.test(value)) return null;

  if (/[\s\u00a0\u202f]/.test(value)) {
    if (!/^\d{1,3}(?:[\s\u00a0\u202f]\d{3})*(?:[.,]\d+)?$/.test(value)) {
      return null;
    }
  }

  const compact = value.replace(MONEY_SPACE, "");
  const hasDot = compact.includes(".");
  const hasComma = compact.includes(",");
  let integerPart = compact;
  let fractionPart = "";
  let hasDecimalPart = false;

  if (hasDot && hasComma) {
    const decimalSeparator = locale === "fr" ? "," : ".";
    const groupingSeparator = decimalSeparator === "." ? "," : ".";
    const decimalIndex = compact.lastIndexOf(decimalSeparator);
    if (
      decimalIndex <= 0 ||
      decimalIndex === compact.length - 1 ||
      compact.indexOf(decimalSeparator) !== decimalIndex
    ) {
      return null;
    }
    integerPart = compact.slice(0, decimalIndex);
    fractionPart = compact.slice(decimalIndex + 1);
    hasDecimalPart = true;
    if (!isGroupedInteger(integerPart, groupingSeparator)) return null;
    integerPart = integerPart.split(groupingSeparator).join("");
  } else if (hasComma) {
    if (locale !== "fr") {
      if (!isGroupedInteger(compact, ",")) return null;
      integerPart = compact.split(",").join("");
    } else {
      if (compact.indexOf(",") !== compact.lastIndexOf(",")) return null;
      const decimalIndex = compact.indexOf(",");
      if (decimalIndex === 0 || decimalIndex === compact.length - 1) {
        return null;
      }
      integerPart = compact.slice(0, decimalIndex);
      fractionPart = compact.slice(decimalIndex + 1);
      hasDecimalPart = true;
    }
  } else if (hasDot) {
    if (compact.indexOf(".") !== compact.lastIndexOf(".")) return null;
    const decimalIndex = compact.indexOf(".");
    if (decimalIndex === 0 || decimalIndex === compact.length - 1) return null;
    integerPart = compact.slice(0, decimalIndex);
    fractionPart = compact.slice(decimalIndex + 1);
    hasDecimalPart = true;
  }

  if (!/^\d+$/.test(integerPart) || !/^\d*$/.test(fractionPart)) return null;
  if (
    hasDecimalPart &&
    (fractionPart.length === 0 ||
      fractionPart.length > MAX_MONEY_DECIMAL_PLACES)
  ) {
    return null;
  }

  return hasDecimalPart ? `${integerPart}.${fractionPart}` : integerPart;
}

/** Formats a canonical dot-decimal amount for display in an input field. */
export function formatMoneyInput(value: string, locale: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return value;
  return locale === "fr" ? value.replace(".", ",") : value;
}

/** Formats a number using the active application locale. */
export function formatNumber(
  value: number,
  locale: string,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(toIntlLocale(locale), options).format(value);
}

/** Formats a percentage value without adding a percent sign. */
export function formatApy(value: number, locale: string): string {
  return formatNumber(value, locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Formats compact USD values such as $12K or 1,2 k $US. */
export function formatCompactUsd(value: number, locale: string): string {
  return formatNumber(value, locale, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    minimumFractionDigits: Math.abs(value) >= 1_000_000 ? 1 : 0,
    maximumFractionDigits: Math.abs(value) >= 1_000_000 ? 1 : 0,
  });
}

/**
 * Formats a numeric USD value as a localised currency string.
 *
 * @param value  - The numeric amount to format.
 * @param locale - The i18n locale string (e.g. "en", "fr").
 * @returns A string such as "$1,234.56" or "1 234,56 $US".
 */
export function formatUsd(value: number, locale: string): string {
  return value.toLocaleString(toIntlLocale(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Maps the app's short language codes to full Intl locale tags.
function toIntlLocale(locale: string): string {
  return locale === "fr" ? "fr-FR" : "en-US";
}

// Visible stand-in for unparseable input, so a bad timestamp never renders
// as "Invalid Date" on a dashboard.
export const INVALID_DATE_FALLBACK = "-";

function toValidDate(value: number | string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Formats a date without its time, localised to the active language.
 *
 * @param value   - Anything `new Date()` accepts.
 * @param locale  - The i18n locale string (e.g. "en", "fr").
 * @param options - Overrides the default `{ year, month: "short", day }`.
 * @returns A string such as "Nov 20, 2026" / "20 nov. 2026", or the
 *          fallback for invalid input.
 */
export function formatDate(
  value: number | string | Date,
  locale: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = toValidDate(value);
  if (!date) return INVALID_DATE_FALLBACK;
  // When callers pass options they replace the default set entirely, so a
  // component can drop the year (chart ticks) without a merge surprise.
  return new Intl.DateTimeFormat(toIntlLocale(locale), {
    ...(options ?? { year: "numeric", month: "short", day: "numeric" }),
  }).format(date);
}

/**
 * Formats a date with its clock time, localised to the active language.
 *
 * @param value  - Anything `new Date()` accepts.
 * @param locale - The i18n locale string (e.g. "en", "fr").
 * @returns A string such as "Nov 20, 2026, 09:30", or the fallback for
 *          invalid input.
 */
export function formatDateTime(
  value: number | string | Date,
  locale: string
): string {
  const date = toValidDate(value);
  if (!date) return INVALID_DATE_FALLBACK;
  return new Intl.DateTimeFormat(toIntlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Coarse, human-friendly duration for health readouts ("5m", "3h", "2d").
 * Whole units only — this is a dashboard glance, not a stopwatch.
 *
 * @param ms - Duration in milliseconds.
 * @returns The coarse duration, or the fallback for non-finite input.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return INVALID_DATE_FALLBACK;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
