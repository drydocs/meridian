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
