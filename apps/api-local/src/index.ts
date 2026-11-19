import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env.local first (developer overrides), then fall back to .env
config({ path: resolve(process.cwd(), "../../.env.local") });
config({ path: resolve(process.cwd(), "../../.env") });

import Redis from "ioredis";
import { writeLog } from "@meridian/shared/logger";
import { buildApp } from "./app.js";

const redisClient = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : undefined;

const app = await buildApp({
  logger: true,
  redisClient,
});

try {
  await app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" });
} catch (err) {
  writeLog("error", "http.server_start_failed", { error: err });
  app.log.error(err);
  process.exit(1);
}
