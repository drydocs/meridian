import { submitTx } from "@meridian/stellar-sdk-helpers";
import { STELLAR_NETWORKS } from "@meridian/shared";
import { applyCors, checkRateLimit } from "../../_lib/middleware";

const network = STELLAR_NETWORKS.testnet;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (applyCors(req, res)) return;
  if (!checkRateLimit(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { xdr } = req.body ?? {};
  if (!xdr) return res.status(400).json({ error: "Missing required field: xdr" });

  try {
    const result = await submitTx(xdr, network);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to submit transaction";
    res.status(500).json({ error: msg });
  }
}
