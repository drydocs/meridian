// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(_req: any, res: any) {
  // TODO(#issue-6): fetch real on-chain positions for this public key
  res.json({ positions: [] });
}
