import type { FastifyPluginAsync } from "fastify";
import { DepositRequestSchema, WithdrawRequestSchema, CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";
import {
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  submitTx,
} from "@meridian/stellar-sdk-helpers";

const network = STELLAR_NETWORKS.testnet;
const addresses = CONTRACT_ADDRESSES.testnet;

export const txRoute: FastifyPluginAsync = async (app) => {
  app.post("/deposit", async (req, reply) => {
    const parsed = DepositRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const fields = parsed.error.flatten().fieldErrors;
      const msg = Object.entries(fields).map(([k, v]) => `${k}: ${v?.join(", ")}`).join("; ");
      return reply.code(400).send({ error: msg || "Invalid request" });
    }

    try {
      const { walletAddress, vaultId, amount } = parsed.data;
      const result = await buildDepositTx(vaultId, walletAddress, amount, {
        blendPool: addresses.blend.pool,
        usdc: addresses.usdc,
        eurc: addresses.eurc,
        defindexVault: process.env.DEFINDEX_VAULT_ID ?? addresses.defindex.vault,
      }, network);
      reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to build deposit transaction";
      reply.code(500).send({ error: msg });
    }
  });

  app.post("/withdraw", async (req, reply) => {
    const parsed = WithdrawRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const fields = parsed.error.flatten().fieldErrors;
      const msg = Object.entries(fields).map(([k, v]) => `${k}: ${v?.join(", ")}`).join("; ");
      return reply.code(400).send({ error: msg || "Invalid request" });
    }

    try {
      const { walletAddress, vaultId, shares } = parsed.data;
      const result = await buildWithdrawTx(vaultId, walletAddress, shares, {
        blendPool: addresses.blend.pool,
        usdc: addresses.usdc,
        eurc: addresses.eurc,
        defindexVault: process.env.DEFINDEX_VAULT_ID ?? addresses.defindex.vault,
      }, network);
      reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to build withdraw transaction";
      reply.code(500).send({ error: msg });
    }
  });

  app.post("/add-trustline", async (req, reply) => {
    const { walletAddress } = (req.body ?? {}) as { walletAddress?: string };
    if (!walletAddress) return reply.code(400).send({ error: "Missing required field: walletAddress" });
    try {
      const result = await buildAddTrustlineTx(walletAddress, network);
      reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to build trustline transaction";
      reply.code(500).send({ error: msg });
    }
  });

  app.post("/submit", async (req, reply) => {
    const { xdr } = (req.body ?? {}) as { xdr?: string };
    if (!xdr) return reply.code(400).send({ error: "Missing required field: xdr" });

    try {
      const result = await submitTx(xdr, network);
      reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to submit transaction";
      reply.code(500).send({ error: msg });
    }
  });
};
