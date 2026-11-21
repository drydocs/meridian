/** Groups the integer part of a fixed-point decimal string with commas. */
export function formatDecimal(value: string): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction] = (negative ? value.slice(1) : value).split(
    "."
  );
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}
