import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fetchBlendPositions, fetchDefindexPosition } from "@meridian/stellar-sdk-helpers";
import { APP_NETWORK, APP_ADDRESSES, isValidStellarAddress } from "@meridian/shared";
import { applyCors, checkRateLimit } from "../../_lib/middleware";

const defindexVaultId = process.env.DEFINDEX_VAULT_ID ?? APP_ADDRESSES.defindex.vault;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!checkRateLimit(req, res)) return;
  const { publicKey } = req.query as { publicKey: string };

  if (!publicKey || !isValidStellarAddress(publicKey)) {
    return res.status(400).json({ error: "Invalid public key" });
  }

  try {
    const positions = await fetchBlendPositions(APP_NETWORK, APP_ADDRESSES.blend.pool, publicKey, [
      { assetId: APP_ADDRESSES.usdc, vaultId: "blend-usdc-fixed" },
      { assetId: APP_ADDRESSES.eurc, vaultId: "blend-eurc-fixed" },
    ]);

    if (defindexVaultId) {
      // Isolated so a DeFindex read failure can't drop the Blend positions.
      try {
        const dfx = await fetchDefindexPosition(APP_NETWORK, defindexVaultId, "defindex-usdc", publicKey);
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
