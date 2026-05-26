// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { xdr } = req.body ?? {};
  if (!xdr) return res.status(400).json({ error: "Missing required field: xdr" });

  // TODO(#issue-7): submit signed XDR to Stellar network
  res.status(501).json({ error: "Transaction submission not yet implemented" });
}
