import type { FastifyPluginAsync } from "fastify";
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
import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";

const network = STELLAR_NETWORKS.testnet;
const vaultContractId = process.env.VAULT_CONTRACT_ID ?? CONTRACT_ADDRESSES.testnet.vault;

async function simulateView(server: rpc.Server, method: string, ...args: xdr.ScVal[]): Promise<unknown> {
  const dummyAccount = new Account("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", "0");
  const contract = new Contract(vaultContractId);

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

export const positionsRoute: FastifyPluginAsync = async (app) => {
  app.get("/:publicKey", async (req, reply) => {
    const { publicKey } = req.params as { publicKey: string };

    if (!publicKey || publicKey.length !== 56) {
      return reply.code(400).send({ error: "Invalid public key" });
    }

    try {
      const server = new rpc.Server(network.rpcUrl);
      const callerScVal = Address.fromString(publicKey).toScVal();

      const [shares, totalShares, totalAssets, entryTime] = (await Promise.all([
        simulateView(server, "get_position", callerScVal),
        simulateView(server, "get_total_shares"),
        simulateView(server, "get_total_assets"),
        simulateView(server, "get_entry_time", callerScVal),
      ])) as [bigint | number, bigint | number, bigint | number, bigint | number];

      const sharesBig = BigInt(shares ?? 0);

      if (sharesBig === 0n) {
        return reply.send({ positions: [] });
      }

      const totalSharesBig = BigInt(totalShares ?? 0);
      const totalAssetsBig = BigInt(totalAssets ?? 0);

      const depositedStroops = totalSharesBig > 0n ? (sharesBig * totalAssetsBig) / totalSharesBig : 0n;
      const deposited = Number(depositedStroops) / 1e7;

      reply.send({
        positions: [
          {
            vaultId: vaultContractId,
            shares: Number(sharesBig) / 1e7,
            deposited,
            earned: 0, // contract does not track yield per user yet
            entryTime: Number(entryTime ?? 0), // ledger timestamp of the deposit
          },
        ],
      });
    } catch (err) {
      app.log.error(err, "[positions] read failed");
      reply.send({ positions: [] });
    }
  });
};
