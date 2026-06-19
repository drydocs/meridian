import { buildWithdrawTx } from "@meridian/stellar-sdk-helpers";
import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";

const network = STELLAR_NETWORKS.testnet;
const addresses = CONTRACT_ADDRESSES.testnet;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // `amount` is the underlying asset amount (USDC/EURC) to withdraw from the pool.
  const { walletAddress, vaultId, amount } = req.body ?? {};
  if (!walletAddress || !vaultId || !amount) {
    const missing = (["walletAddress", "vaultId", "amount"] as const)
      .filter((k) => !req.body?.[k])
      .join(", ");
    return res.status(400).json({ error: `Missing required fields: ${missing}` });
  }

  try {
    const result = await buildWithdrawTx(vaultId, walletAddress, amount, {
      blendPool: addresses.blend.pool,
      usdc: addresses.usdc,
      eurc: addresses.eurc,
      defindexVault: process.env.DEFINDEX_VAULT_ID ?? addresses.defindex.vault,
    }, network);
    return res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to build withdraw transaction";
    res.status(500).json({ error: msg });
  }
}
