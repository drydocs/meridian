import {
  buildBlendDepositTx,
  blendAssetForVault,
  resolveProtocol,
  toStroops,
} from "@meridian/stellar-sdk-helpers";
import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";

const network = STELLAR_NETWORKS.testnet;
const addresses = CONTRACT_ADDRESSES.testnet;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { walletAddress, vaultId, amount } = req.body ?? {};
  if (!walletAddress || !vaultId || !amount) {
    const missing = (["walletAddress", "vaultId", "amount"] as const)
      .filter((k) => !req.body?.[k])
      .join(", ");
    return res.status(400).json({ error: `Missing required fields: ${missing}` });
  }

  try {
    const protocol = resolveProtocol(vaultId);

    if (protocol === "Blend") {
      const asset = blendAssetForVault(vaultId);
      const result = await buildBlendDepositTx(
        { poolId: addresses.blend.pool, assetId: addresses[asset], network },
        walletAddress,
        toStroops(amount)
      );
      return res.json(result);
    }

    // DeFindex routing is not wired yet — see issue #5. Fail honestly rather
    // than silently routing somewhere else.
    return res
      .status(501)
      .json({ error: "DeFindex deposits are not implemented yet. See issue #5." });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to build deposit transaction";
    res.status(500).json({ error: msg });
  }
}
