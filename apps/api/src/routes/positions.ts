import type { FastifyPluginAsync } from "fastify";
import { APP_NETWORK, APP_ADDRESSES, isValidStellarAddress } from "@meridian/shared";
import { fetchBlendPositions, fetchDefindexPosition } from "@meridian/stellar-sdk-helpers";

const defindexVaultId = process.env.DEFINDEX_VAULT_ID ?? APP_ADDRESSES.defindex.vault;

export const positionsRoute: FastifyPluginAsync = async (app) => {
  app.get("/:publicKey", async (req, reply) => {
    const { publicKey } = req.params as { publicKey: string };

    if (!publicKey || !isValidStellarAddress(publicKey)) {
      return reply.code(400).send({ error: "Invalid public key" });
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
