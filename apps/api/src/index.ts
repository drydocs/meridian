import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { vaultsRoute } from "./routes/vaults";
import { txRoute } from "./routes/tx";

const app = Fastify({ logger: true });

await app.register(cors, { origin: process.env.ALLOWED_ORIGIN ?? "*" });
await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

app.register(vaultsRoute, { prefix: "/api/v1/vaults" });
app.register(txRoute, { prefix: "/api/v1/tx" });

app.get("/health", async () => ({ status: "ok" }));

try {
  await app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
