import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  buildRateLimitHeaders,
  evaluateRateLimit,
  InMemoryRateLimitStore,
  rateLimitBlockedBody,
  resolveRateLimitPolicy,
  RedisRateLimitStore,
  walletAddressFromBody,
  type RateLimitPolicyName,
  type RateLimitStore,
} from "@meridian/api-core";
import { submissionSourceAccount } from "@meridian/stellar-sdk-helpers";
import { APP_NETWORK } from "@meridian/shared";

/**
 * Route class each URL prefix draws from. Mirrors the policy choice in the
 * deployed handlers (api/v1/**) so a request gets the same budget whether it
 * is served by Vercel or by this local server.
 */
const PREFIX_POLICIES: Array<[prefix: string, policy: RateLimitPolicyName]> = [
  ["/api/v1/tx/", "txBuild"],
  ["/api/v1/keepers/", "keeper"],
  ["/api/v1/admin/", "admin"],
  ["/api/v1/positions/", "read"],
  ["/api/v1/vaults", "read"],
];

/**
 * Resolves the policy for a request from its method and path. Submit is the
 * one transaction action that spends fees and mutates state, so it takes the
 * stricter submit budget; the other build actions share the build budget.
 */
export function policyForRequest(req: FastifyRequest): RateLimitPolicyName {
  const path = req.routeOptions.url ?? req.url;
  for (const [prefix, policy] of PREFIX_POLICIES) {
    if (path.startsWith(prefix)) {
      if (policy === "txBuild" && path.endsWith("/submit")) return "txSubmit";
      return policy;
    }
  }
  return "read";
}

/** The wallet a request acts for, when the policy is keyed by one. */
function walletForRequest(
  req: FastifyRequest,
  policy: RateLimitPolicyName
): string | undefined {
  if (policy !== "txBuild" && policy !== "txSubmit") return undefined;
  const fromBody = walletAddressFromBody(req.body);
  if (fromBody) return fromBody;
  if (policy !== "txSubmit") return undefined;
  const xdr = (req.body as { xdr?: unknown } | undefined)?.xdr;
  return typeof xdr === "string"
    ? submissionSourceAccount(xdr, APP_NETWORK)
    : undefined;
}

export interface RateLimitPluginOptions {
  /** Distributed store; the in-memory fallback is used when absent. */
  store?: RateLimitStore;
  /**
   * Rejects a request with 503 when a fail-closed policy has no distributed
   * store. The deployed handlers behave the same way, so local runs against
   * real Redis traffic match production.
   */
  requireDistributed?: boolean;
}

/**
 * Registers the shared rate-limit policy as an `onRequest` hook. Unlike
 * `@fastify/rate-limit`'s one-bucket-per-route model this reuses the exact
 * policy table and header formatting the Vercel handlers use, so both
 * surfaces enforce and advertise the same numbers.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  options: RateLimitPluginOptions = {}
): Promise<void> {
  const distributed = options.store;
  const store = distributed ?? new InMemoryRateLimitStore();

  app.addHook("onRequest", async (req, reply) => {
    const policy = policyForRequest(req);
    const config = resolveRateLimitPolicy(policy);

    if (config.failClosed && options.requireDistributed && !distributed) {
      return reply.code(503).send({
        error:
          "Service Unavailable: Distributed rate limiting is required on deployed environments for this route.",
        code: "RATE_LIMIT_BACKEND_UNAVAILABLE",
      });
    }

    const outcome = await evaluateRateLimit({
      store,
      policy,
      ip: req.ip,
      wallet: walletForRequest(req, policy),
    });

    for (const [name, value] of Object.entries(
      buildRateLimitHeaders(outcome)
    )) {
      reply.header(name, value);
    }
    if (!outcome.allowed) {
      return reply.code(429).send(rateLimitBlockedBody(outcome));
    }
  });
}

/** Builds the Redis-backed store for a local ioredis client. */
export function redisRateLimitStore(
  client: ConstructorParameters<typeof RedisRateLimitStore>[0]
): RateLimitStore {
  return new RedisRateLimitStore(client);
}
