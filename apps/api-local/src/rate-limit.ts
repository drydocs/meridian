import type { FastifyInstance } from "fastify";
import {
  enforceRateLimit,
  rateLimitRouteForPath,
  verifiedWalletFromRequest,
  type RateLimitStore,
} from "@meridian/api-core";

/**
 * Applies the same policy table and headers as the deployed handlers, so the
 * local server cannot drift from production behaviour.
 */
export function registerRateLimit(
  app: FastifyInstance,
  store: RateLimitStore
): void {
  app.addHook("preHandler", async (request, reply) => {
    const route = rateLimitRouteForPath(request.url);
    const decision = await enforceRateLimit(store, route, {
      ip: request.ip,
      wallet: verifiedWalletFromRequest(request.body),
    });

    for (const [name, value] of Object.entries(decision.headers)) {
      reply.header(name, value);
    }

    if (!decision.allowed) {
      return reply.code(429).send({
        error: "Too many requests. Try again in a minute.",
      });
    }
    return undefined;
  });
}
