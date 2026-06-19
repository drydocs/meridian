import type { FastifyPluginAsync } from "fastify";
import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";
import { fetchBlendPositions, fetchDefindexPosition } from "@meridian/stellar-sdk-helpers";

const network = STELLAR_NETWORKS.testnet;
const addresses = CONTRACT_ADDRESSES.testnet;
const defindexVaultId = process.env.DEFINDEX_VAULT_ID ?? addresses.defindex.vault;

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

      if (defindexVaultId) {
        // Isolated so a DeFindex read failure can't drop the Blend positions.
        try {
          const dfx = await fetchDefindexPosition(network, defindexVaultId, "defindex-usdc", publicKey);
          positions.push(...dfx);
        } catch (err) {
          app.log.error(err, "[positions] defindex read failed");
        }
      }

      reply.send({ positions });
    } catch (err) {
      app.log.error(err, "[positions] read failed");
      reply.code(503).send({ error: "Failed to read positions" });
    }
  });
};
