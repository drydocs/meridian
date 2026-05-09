export function formatUsdAmount(stroops: bigint, decimals = 7): string {
  const divisor = BigInt(10 ** decimals);
  const whole = stroops / divisor;
  const frac = stroops % divisor;
  return `${whole}.${frac.toString().padStart(decimals, "0").slice(0, 2)}`;
}

export function parseUsdAmount(display: string, decimals = 7): bigint {
  const [whole = "0", frac = ""] = display.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * BigInt(10 ** decimals) + BigInt(fracPadded);
}

export function fromStroops(stroops: bigint, decimals = 7): number {
  return Number(stroops) / 10 ** decimals;
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
