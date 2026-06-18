import type { FastifyPluginAsync } from "fastify";
import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";
import { fetchBlendPositions } from "@meridian/stellar-sdk-helpers";

const network = STELLAR_NETWORKS.testnet;
const addresses = CONTRACT_ADDRESSES.testnet;

export const positionsRoute: FastifyPluginAsync = async (app) => {
  app.get("/:publicKey", async (req, reply) => {
    const { publicKey } = req.params as { publicKey: string };

    if (!publicKey || publicKey.length !== 56) {
      return reply.code(400).send({ error: "Invalid public key" });
    }

    try {
      const positions = await fetchBlendPositions(network, addresses.blend.pool, publicKey, [
        { assetId: addresses.usdc, vaultId: "blend-usdc-fixed" },
        { assetId: addresses.eurc, vaultId: "blend-eurc-fixed" },
      ]);
      reply.send({ positions });
    } catch (err) {
      app.log.error(err, "[positions] read failed");
      reply.send({ positions: [] });
    }
  });
};
