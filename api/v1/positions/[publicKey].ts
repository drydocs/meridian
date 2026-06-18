import { fetchBlendPositions } from "@meridian/stellar-sdk-helpers";
import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";

const network = STELLAR_NETWORKS.testnet;
const addresses = CONTRACT_ADDRESSES.testnet;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  const { publicKey } = req.query as { publicKey: string };

  if (!publicKey || publicKey.length !== 56) {
    return res.status(400).json({ error: "Invalid public key" });
  }

  try {
    const positions = await fetchBlendPositions(network, addresses.blend.pool, publicKey, [
      { assetId: addresses.usdc, vaultId: "blend-usdc-fixed" },
      { assetId: addresses.eurc, vaultId: "blend-eurc-fixed" },
    ]);
    res.json({ positions });
  } catch (err) {
    console.error("[positions] error:", err);
    res.json({ positions: [] });
  }
}
