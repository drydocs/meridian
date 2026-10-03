export function parseDecimal(value: string | number): number {
  if (typeof value === "number") return value
  const sign = value.startsWith("-") ? -1 : 1
  const clean = value.replace(/^-/, "")
  const parts = clean.split(".")
  const integerPart = parts[0] || "0"
  const fractionalPart = parts[1] || ""
  // Scale to 8 decimal places (standard financial precision)
  const fracScaled = fractionalPart.padEnd(8, "0").slice(0, 8)
  const combined = `${integerPart}${fracScaled}`
  const result = sign * Number(combined) / 100_000_000
  return result
}

export function formatDecimal(value: number, places: number = 8): string {
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(value)
  const scaled = Math.round(abs * 10 ** places) / 10 ** places
  const whole = Math.floor(scaled).toString()
  const frac = String(Math.round((scaled - Math.floor(scaled)) * 10 ** places))
    .padStart(places, "0")
  return `${sign}${whole}.${frac}`
}

export function decimalToBigint(value: number, places: number = 8): bigint {
  return BigInt(Math.round(value * 10 ** places))
}

export function bigintToDecimal(value: bigint, places: number = 8): number {
  return Number(value) / 10 ** places
}