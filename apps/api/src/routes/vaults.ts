import type { FastifyPluginAsync } from "fastify";
import { createClient } from "redis";
import { fetchAllVaults } from "../services/vaults.js";

const CACHE_KEY = "meridian:vaults";
const CACHE_TTL = 3_600; // 1 hour — DeFiLlama data is daily

let redisClient: ReturnType<typeof createClient> | null = null;
let redisInitialised = false;

async function getCache(): Promise<ReturnType<typeof createClient> | null> {
  if (redisInitialised) return redisClient?.isReady ? redisClient : null;
  redisInitialised = true;

  try {
    const client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
    client.on("error", () => { redisClient = null; });
    await client.connect();
    redisClient = client;
    return redisClient;
  } catch (err) {
    console.warn("[redis] unavailable, running without cache:", (err as Error).message);
    return null;
  }
}

export const vaultsRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    const cache = await getCache();

    if (cache) {
      const raw = await cache.get(CACHE_KEY).catch(() => null);
      if (raw) return reply.send({ ...JSON.parse(raw), cached: true });
    }

    const vaults = await fetchAllVaults();
    const payload = { vaults, updatedAt: new Date().toISOString(), cached: false };

    if (cache) {
      await cache.setEx(CACHE_KEY, CACHE_TTL, JSON.stringify(payload)).catch(() => {});
    }

    return reply.send(payload);
  });

  app.get("/:vaultId", async (req, reply) => {
    const { vaultId } = req.params as { vaultId: string };
    const vaults = await fetchAllVaults();
    const vault = vaults.find((v) => v.id === vaultId);
    if (!vault) return reply.code(404).send({ error: "vault not found", vaultId });
    return reply.send(vault);
  });
};
