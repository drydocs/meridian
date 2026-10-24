export function horizonUrlFor(network: string) {
  return network === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}

const HORIZON_TIMEOUT_MS = 15_000;

export async function fetchBalances(publicKey: string, network: string) {
  const res = await fetch(`${horizonUrlFor(network)}/accounts/${publicKey}`, {
    signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return (await res.json()) as {
    balances: {
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
    }[];
  };
}
