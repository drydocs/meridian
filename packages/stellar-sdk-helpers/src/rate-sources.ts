// Real RateSourceFn implementations for the migration keeper (#469), filling
// in the always-null stub that used to live in migration-keeper.ts (#511).
// See that file's RateQuery/RateSourceFn docs for the contract both sources
// below must honor: resolve a comparable annualized rate in basis points, or
// null when it genuinely can't be determined yet (never throw for "unknown",
// only for a failed lookup the keeper's own retry logic should handle).
//
// Deliberately does NOT catch-and-null network/RPC errors from either
// source: runMigrationKeeper wraps every rateSource() call in
// withKeeperRetry (see keeper-retry.ts), which classifies and retries
// transient failures. Swallowing them here would silently bypass that.

import { PoolV2, type Pool } from "@blend-capital/blend-sdk";
import { CONTRACT_ADDRESSES, withRaceTimeout } from "@meridian/shared";
import { getRpcServer } from "./internal";
import { withBlendTimeout } from "./blend";
import { getDefindexAssetAmountPerShares } from "./defindex";
import type { StellarNetwork } from "./types";
import { consoleLogger, type KeeperLogger } from "./keeper-retry";
import type { RateQuery, RateSourceFn } from "./migration-keeper";

const BPS_SCALAR = 10_000;

function toFiniteBps(rate: number): number | null {
  const bps = rate * BPS_SCALAR;
  return Number.isFinite(bps) ? Math.round(bps) : null;
}

// ---------------------------------------------------------------------------
// Blend
// ---------------------------------------------------------------------------

export interface BlendRateSourceOptions {
  network: StellarNetwork;
  // Fallback reserve asset to price when a query carries no assetId. The
  // per-query assetId (threaded from the vault's KNOWN_POOLS entry, #539)
  // wins when present; this option is kept for backwards compatibility with
  // the pre-#539 behavior, where every vault was USDC and this defaulted to
  // the network's USDC address.
  assetId?: string;
  // Injectable for tests; defaults to the real SDK loader.
  loadPool?: (network: StellarNetwork, poolId: string) => Promise<Pool>;
}

/**
 * Prices a Blend pool's current supply rate for the query's reserve asset
 * (`query.assetId`, falling back to `options.assetId` and then this
 * network's USDC) using @blend-capital/blend-sdk's own Reserve model
 * (`Reserve.setRates`, the same three-slope kinked-curve math Blend's own
 * indexer and UI read) rather than a hand-rolled reimplementation of it off
 * the raw fields BlendAdapter exposes. `estSupplyApy` (Blend's own
 * weekly-compounded estimate) is used rather than the raw `supplyApr` so the
 * comparison against DeFindex's realized, compounded rate below is
 * apples-to-apples: both are annualized yields, not one APR next to one APY.
 */
export function createBlendRateSource(
  options: BlendRateSourceOptions
): RateSourceFn {
  // Mirrors tx.ts's allowedContractIds: CONTRACT_ADDRESSES only has
  // testnet/mainnet entries, futurenet (used for local/CI RPC pointed at a
  // futurenet node) falls back to testnet's addresses.
  const addressKey =
    options.network.network === "mainnet" ? "mainnet" : "testnet";
  const defaultAssetId = CONTRACT_ADDRESSES[addressKey].usdc;
  const loadPool =
    options.loadPool ??
    ((network: StellarNetwork, poolId: string) =>
      withBlendTimeout(() =>
        PoolV2.load(
          { rpc: network.rpcUrl, passphrase: network.passphrase },
          poolId
        )
      ));

  return async (query: RateQuery) => {
    if (query.protocol !== "blend") return null;
    // Per-query assetId (the vault's own reserve asset, see migration-keeper.ts)
    // wins over the factory's fallback so a EURC vault prices the EURC reserve
    // in whichever pool it's evaluated against (#539).
    const assetId = query.assetId ?? options.assetId ?? defaultAssetId;
    const pool = await loadPool(options.network, query.poolId);
    const reserve = pool.reserves.get(assetId);
    if (!reserve) return null;
    return toFiniteBps(reserve.estSupplyApy);
  };
}

// ---------------------------------------------------------------------------
// DeFindex
// ---------------------------------------------------------------------------

// DeFindex's vault contract exposes no on-chain rate, only a live
// share-price snapshot (get_asset_amounts_per_shares). Deriving a rate needs
// two samples separated in time; RateSnapshotStore is the persistence seam
// for that. See createUpstashRateSnapshotStore for the answer this ships
// with, and createInMemoryRateSnapshotStore's own doc for why it is NOT a
// production substitute.
export interface RateSnapshot {
  timestampMs: number;
  // USDC stroops for REFERENCE_SHARES worth of dfTokens, at timestampMs.
  priceStroops: bigint;
}

export interface RateSnapshotStore {
  get(key: string): Promise<RateSnapshot | null>;
  set(key: string, snapshot: RateSnapshot): Promise<void>;
}

/**
 * Per-process, in-memory only: on a serverless deployment (this repo runs on
 * Vercel, see vercel.json) each invocation is a fresh process, so a snapshot
 * written here never survives to be read by the next scheduled run. Useful
 * for local dev and tests; createDefaultRateSource only falls back to this
 * when Upstash credentials aren't configured (see below), and logs nothing
 * migrates as a result, exactly the same "rate unknown" outcome as before
 * this file existed, never a hard failure.
 */
export function createInMemoryRateSnapshotStore(): RateSnapshotStore {
  const store = new Map<string, RateSnapshot>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, snapshot) {
      store.set(key, snapshot);
    },
  };
}

export interface UpstashRateSnapshotStoreOptions {
  restUrl: string;
  restToken: string;
  // Keys expire after this long: an adapter/pool nobody has evaluated in a
  // while shouldn't hold a snapshot forever that a much-later comparison
  // would wrongly treat as a live "prior sample" spanning the gap.
  ttlSeconds?: number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

// Matches keeper-state.ts's DEFAULT_STORE_TIMEOUT_MS: this call sits on the
// same deadline-budget-constrained hot path (findBestCandidate), so a hung
// Upstash request shouldn't be able to stall the run past it.
const DEFAULT_UPSTASH_TIMEOUT_MS = 5_000;

/**
 * Persists snapshots via Upstash's plain HTTP REST API rather than the
 * @upstash/redis SDK: this package has no Redis dependency today, and the
 * two commands needed (GET/SET) don't need one. Reuses the same
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN credentials
 * api/_lib/middleware.ts already requires in production for its rate
 * limiter, so wiring this up needs no new infrastructure, just an existing
 * Upstash instance.
 */
export function createUpstashRateSnapshotStore(
  options: UpstashRateSnapshotStoreOptions
): RateSnapshotStore {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_SNAPSHOT_TTL_SECONDS;
  const fetchFn = options.fetchFn ?? fetch;
  const restUrl = options.restUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${options.restToken}` };
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPSTASH_TIMEOUT_MS;

  return {
    async get(key) {
      const res = await withRaceTimeout(
        () =>
          fetchFn(`${restUrl}/get/${encodeURIComponent(key)}`, {
            headers,
            // Belt and braces with the race below: this also frees the
            // socket rather than leaving a hung request running past the
            // run, matching keeper-state.ts's command().
            signal: AbortSignal.timeout(timeoutMs),
          }),
        timeoutMs,
        "Upstash Redis"
      );
      if (!res.ok) {
        throw new Error(`Upstash GET failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { result: string | null };
      if (!body.result) return null;
      const [timestampMsRaw, priceStroopsRaw] = body.result.split(":");
      if (!timestampMsRaw || !priceStroopsRaw) return null;
      return {
        timestampMs: Number(timestampMsRaw),
        priceStroops: BigInt(priceStroopsRaw),
      };
    },
    async set(key, snapshot) {
      const value = `${snapshot.timestampMs}:${snapshot.priceStroops}`;
      // All-path-segments form, per Upstash's documented REST API
      // (`REST_URL/set/foo/bar/EX/100`). The POST-with-body form
      // (`POST /set/foo?EX=100`, value in the request body) is the other
      // documented shape; a POST with the value already in the path AND EX
      // as a query string, which is what this used to send, is neither.
      const res = await withRaceTimeout(
        () =>
          fetchFn(
            `${restUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${ttlSeconds}`,
            {
              method: "POST",
              headers,
              signal: AbortSignal.timeout(timeoutMs),
            }
          ),
        timeoutMs,
        "Upstash Redis"
      );
      if (!res.ok) {
        throw new Error(`Upstash SET failed: HTTP ${res.status}`);
      }
    },
  };
}

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

// get_asset_amounts_per_shares is a pure proportional query (see
// MeridianDefindexAdapter::total_assets, packages/contracts/defindex-adapter
// /src/lib.rs, which calls it with the adapter's own live share balance to
// price whatever it happens to hold) — any fixed share count works equally
// well as a price probe here. 1.0 unit at the 7-decimal stroop scale every
// other Meridian amount uses keeps a persisted snapshot's magnitude easy to
// sanity-check by hand.
const REFERENCE_SHARES = 10_000_000n;

// Below this, two samples are too close together for their price delta to
// be a meaningful annualized signal: ordinary rounding in a single-digit-bps
// share-price move gets amplified enormously once extrapolated out to a
// full year. The keeper runs hourly in production (see
// apps/docs/operations/migration-keeper.md's Schedule section), comfortably
// above this floor in normal operation.
const MIN_SAMPLE_INTERVAL_MS = 10 * 60 * 1_000;

// Even at the MIN_SAMPLE_INTERVAL_MS floor, extrapolating to a full year
// means raising (1 + growth) to a power of roughly 52,000. A single large
// deposit/withdrawal skewing get_asset_amounts_per_shares within one sample
// window (not necessarily a DeFindex bug) is enough to produce a finite but
// absurd APY that would otherwise win the migration comparison outright
// against Blend's real rate (see PR #538 review). No real stablecoin yield
// source approaches this, so treat anything above it as an untrustworthy
// extrapolation rather than a real rate.
const MAX_PLAUSIBLE_APY = 5; // 500% annualized

export function defindexRateSnapshotKey(
  poolId: string,
  network: string
): string {
  return `migration-keeper:defindex-rate:${network}:${poolId}`;
}

const snapshotKey = defindexRateSnapshotKey;

export interface DefindexRateSourceOptions {
  network: StellarNetwork;
  store: RateSnapshotStore;
  now?: () => number;
}

/**
 * Takes a fresh DeFindex share-price snapshot on every call, persists it via
 * `store`, and returns a comparable annualized rate only once a second,
 * sufficiently time-separated snapshot already exists for the same DeFindex
 * vault. The first time a given vault is evaluated (or any time after its
 * snapshot has expired, see createUpstashRateSnapshotStore's ttlSeconds),
 * this returns null — "rate unknown", the same outcome the always-null stub
 * always produced, not a failure.
 *
 * This is the explicit answer to "where does the time-series sample live"
 * that #469 asked this issue to resolve: in `store`, keyed by the DeFindex
 * vault's own contract address (query.poolId), never on this otherwise
 * stateless keeper process. createDefaultRateSource below wires `store` to
 * Upstash Redis when configured (see createUpstashRateSnapshotStore).
 */
export function createDefindexRateSource(
  options: DefindexRateSourceOptions
): RateSourceFn {
  const now = options.now ?? Date.now;
  return async (query: RateQuery) => {
    if (query.protocol !== "defindex") return null;
    const key = snapshotKey(query.poolId, options.network.network);
    const priceStroops = await getDefindexAssetAmountPerShares(
      options.network,
      query.poolId,
      REFERENCE_SHARES
    );
    const timestampMs = now();
    const current: RateSnapshot = { timestampMs, priceStroops };

    const prior = await options.store.get(key);
    await options.store.set(key, current);

    if (!prior) return null;
    const elapsedMs = timestampMs - prior.timestampMs;
    if (elapsedMs < MIN_SAMPLE_INTERVAL_MS) return null;
    if (prior.priceStroops <= 0n) return null;

    const growth =
      Number(current.priceStroops - prior.priceStroops) /
      Number(prior.priceStroops);
    const periodsPerYear = SECONDS_PER_YEAR / (elapsedMs / 1_000);
    const apy = Math.pow(1 + growth, periodsPerYear) - 1;
    if (!Number.isFinite(apy)) return null;
    if (apy > MAX_PLAUSIBLE_APY || apy < -MAX_PLAUSIBLE_APY) return null;
    return toFiniteBps(apy);
  };
}

// ---------------------------------------------------------------------------
// Default wiring
// ---------------------------------------------------------------------------

export interface DefaultRateSourceOptions {
  network: StellarNetwork;
  logger?: KeeperLogger;
  // Injected in tests; in production read from UPSTASH_REDIS_REST_URL /
  // UPSTASH_REDIS_REST_TOKEN (the same credentials api/_lib/middleware.ts
  // requires) via createDefaultRateSource.
  upstash?: { restUrl: string; restToken: string };
  fetchFn?: typeof fetch;
}

/**
 * Picks the snapshot store and returns a composed RateSourceFn that routes
 * each query to the right protocol-specific source. Uses Upstash when its
 * credentials are configured; otherwise falls back to the in-memory store
 * and logs a warning, since DeFindex rates will then always read null on
 * serverless invocations (see createInMemoryRateSnapshotStore).
 */
export function createDefaultRateSource(
  options: DefaultRateSourceOptions
): RateSourceFn {
  const logger = options.logger ?? consoleLogger;
  const upstashUrl = options.upstash?.restUrl ?? process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken =
    options.upstash?.restToken ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  let store: RateSnapshotStore;
  if (upstashUrl && upstashToken) {
    store = createUpstashRateSnapshotStore({
      restUrl: upstashUrl,
      restToken: upstashToken,
      fetchFn: options.fetchFn,
    });
  } else {
    logger.warn(
      "UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set: DeFindex rate snapshots will not persist across serverless invocations"
    );
    store = createInMemoryRateSnapshotStore();
  }

  const blend = createBlendRateSource({ network: options.network });
  const defindex = createDefindexRateSource({
    network: options.network,
    store,
  });

  return async (query: RateQuery) => {
    if (query.protocol === "blend") return blend(query);
    if (query.protocol === "defindex") return defindex(query);
    return null;
  };
}

// getRpcServer is re-exported here so callers wiring the keeper's dry-run
// planning path can reuse the same RPC handle without a second import.
export { getRpcServer };
