import { fetchBlendPositions, fetchDefindexPosition } from "@meridian/stellar-sdk-helpers";
import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";
import { applyCors } from "../../_lib/middleware";

const network = STELLAR_NETWORKS.testnet;
const addresses = CONTRACT_ADDRESSES.testnet;
const defindexVaultId = process.env.DEFINDEX_VAULT_ID ?? addresses.defindex.vault;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (applyCors(req, res)) return;
  const { publicKey } = req.query as { publicKey: string };

  if (!publicKey || publicKey.length !== 56) {
    return res.status(400).json({ error: "Invalid public key" });
  }

  try {
    const positions = await fetchBlendPositions(network, addresses.blend.pool, publicKey, [
      { assetId: addresses.usdc, vaultId: "blend-usdc-fixed" },
      { assetId: addresses.eurc, vaultId: "blend-eurc-fixed" },
    ]);

    if (defindexVaultId) {
      // Isolated so a DeFindex read failure can't drop the Blend positions.
      try {
        const dfx = await fetchDefindexPosition(network, defindexVaultId, "defindex-usdc", publicKey);
        positions.push(...dfx);
      } catch (err) {
        console.error("[positions] defindex read failed:", err);
      }
    }

    res.json({ positions });
  } catch (err) {
    console.error("[positions] error:", err);
    res.status(503).json({ error: "Failed to read positions" });
  }
}
