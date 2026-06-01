import {
  Contract,
  rpc,
  Networks,
  TransactionBuilder,
  Account,
  Address,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const VAULT_CONTRACT_ID = process.env.VAULT_CONTRACT_ID ?? "CBK5RI4BCA7TLSD2S5Q5TH2LUQAT55GF34OBTWPFUKWZ5O6YXSQDAWOJ";
const RPC_URL = "https://soroban-testnet.stellar.org";

// Simulates a read-only contract call — no fees, no signing, no account needed on-chain.
// Uses a dummy sequence-0 account; simulation doesn't validate the source account.
async function simulateView(server: rpc.Server, method: string, ...args: xdr.ScVal[]): Promise<unknown> {
  const dummyAccount = new Account("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", "0");
  const contract = new Contract(VAULT_CONTRACT_ID);

  const tx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(0)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;
  return scValToNative(sim.result.retval);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  const { publicKey } = req.query as { publicKey: string };

  if (!publicKey || publicKey.length !== 56) {
    return res.status(400).json({ error: "Invalid public key" });
  }

  try {
    const server = new rpc.Server(RPC_URL);
    const callerScVal = Address.fromString(publicKey).toScVal();

    const [shares, totalShares, totalAssets] = (await Promise.all([
      simulateView(server, "get_position", callerScVal),
      simulateView(server, "get_total_shares"),
      simulateView(server, "get_total_assets"),
    ])) as [bigint | number, bigint | number, bigint | number];

    const sharesBig = BigInt(shares ?? 0);

    if (sharesBig === 0n) {
      return res.json({ positions: [] });
    }

    const totalSharesBig = BigInt(totalShares ?? 0);
    const totalAssetsBig = BigInt(totalAssets ?? 0);

    // deposited = shares * totalAssets / totalShares (stroops → divide by 1e7 for USD)
    const depositedStroops = totalSharesBig > 0n ? (sharesBig * totalAssetsBig) / totalSharesBig : 0n;
    const deposited = Number(depositedStroops) / 1e7;

    res.json({
      positions: [
        {
          vaultId: VAULT_CONTRACT_ID,
          deposited,
          earned: 0,
          entryTime: 0,
        },
      ],
    });
  } catch (err) {
    console.error("[positions] error:", err);
    res.json({ positions: [] });
  }
}
