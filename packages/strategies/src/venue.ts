import { YEAR_MILLISECONDS } from "./accrual";
import type { PriceSet } from "./portfolio";
import {
  FixedPointDecimal,
  STROOPS_PER_UNIT,
  UnknownAssetError,
} from "./types";
import type { AssetSymbol } from "./types";

export type VenueId = string;

export class InvalidVenueOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVenueOperationError";
  }
}

export interface VenuePosition {
  readonly venueId: VenueId;
  readonly asset: AssetSymbol;
  readonly memberId?: string;
  readonly deployedPrincipal: FixedPointDecimal;
  readonly accruedYield: FixedPointDecimal;
}

export interface LinkedDebt {
  readonly debtId: string;
  readonly asset: AssetSymbol;
  readonly principal: FixedPointDecimal;
  readonly basis: FixedPointDecimal;
}

export interface VenueYieldRate {
  readonly ratePerSecond?: FixedPointDecimal;
  readonly annualRate?: FixedPointDecimal;
}

export interface VenuePortfolioView {
  getVenuePosition(
    venueId: VenueId,
    asset: AssetSymbol
  ): VenuePosition | undefined;
  venues(): readonly VenuePosition[];
}

interface VenueOrderBase {
  readonly venueId: VenueId;
  readonly asset: AssetSymbol;
  readonly reason?: string;
  readonly memberId?: string;
  readonly size?: never;
}

export interface VenueDeployOrder extends VenueOrderBase {
  readonly kind: "deploy";
  readonly amount: FixedPointDecimal;
}

export interface VenueHarvestOrder extends VenueOrderBase {
  readonly kind: "harvest";
  readonly amount?: FixedPointDecimal;
  readonly debtId?: string;
}

export interface VenueWithdrawOrder extends VenueOrderBase {
  readonly kind: "withdraw";
  readonly amount?: FixedPointDecimal;
}

export type VenueOrder =
  VenueDeployOrder | VenueHarvestOrder | VenueWithdrawOrder;

export function isVenueOrder(o: { readonly kind?: string }): o is VenueOrder {
  return o.kind === "deploy" || o.kind === "harvest" || o.kind === "withdraw";
}

interface InternalVenueEntry {
  readonly venueId: VenueId;
  readonly asset: AssetSymbol;
  readonly memberId?: string;
  readonly generation: bigint;
  principal: bigint;
  basis: bigint;
  accruedYield: bigint;
}

interface InternalDebtEntry {
  readonly debtId: string;
  readonly asset: AssetSymbol;
  principal: bigint;
  basis: bigint;
}

const MS_PER_SEC = 1_000n;
const ZERO = FixedPointDecimal.fromStroops(0n);
const notional = (s: bigint, p: bigint): bigint => (s * p) / STROOPS_PER_UNIT;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (v: VenueId, a: AssetSymbol, m?: string) =>
  JSON.stringify([m ?? null, v, a]);
const remainderKeyOf = (e: InternalVenueEntry, period: bigint) =>
  `venue:${period}:${JSON.stringify([
    e.memberId ?? "",
    e.venueId,
    e.asset,
    e.generation.toString(),
  ])}`;
const fail = (msg: string): never => {
  throw new InvalidVenueOperationError(msg);
};
const checkId = (v: string, label: string): void => {
  if (v.trim().length === 0) fail(`${label} must be a non-empty string`);
};
const checkMemberId = (memberId: string | undefined): void => {
  if (memberId !== undefined) checkId(memberId, "memberId");
};

/** Simulation-only ledger for venue principal, accrued yield, and linked debts. */
export class VenueLedger implements VenuePortfolioView {
  readonly #entries = new Map<string, InternalVenueEntry>();
  readonly #debts = new Map<string, InternalDebtEntry>();
  #nextGeneration = 0n;

  getVenuePosition(
    v: VenueId,
    a: AssetSymbol,
    m?: string
  ): VenuePosition | undefined {
    const e = this.#entries.get(keyOf(v, a, m));
    return e ? this.#toPosition(e) : undefined;
  }

  venues(): VenuePosition[] {
    return [...this.#entries.values()]
      .map((e) => this.#toPosition(e))
      .sort(
        (a, b) =>
          cmp(a.venueId, b.venueId) ||
          cmp(a.asset, b.asset) ||
          cmp(a.memberId ?? "", b.memberId ?? "")
      );
  }

  getDebt(debtId: string): LinkedDebt | undefined {
    const d = this.#debts.get(debtId);
    return (
      d && {
        debtId: d.debtId,
        asset: d.asset,
        principal: FixedPointDecimal.fromStroops(d.principal),
        basis: FixedPointDecimal.fromStroops(d.basis),
      }
    );
  }

  openDebt(
    debtId: string,
    asset: AssetSymbol,
    amount: FixedPointDecimal,
    price: FixedPointDecimal
  ): bigint {
    checkId(debtId, "debtId");
    const delta = amount.toStroops();
    const p = price.toStroops();
    if (delta <= 0n || p < 0n) fail("invalid debt amount or price");
    const proceeds = notional(delta, p);
    const cur = this.#debts.get(debtId);
    if (cur && cur.asset !== asset) fail(`debt "${debtId}" asset mismatch`);
    if (cur) {
      cur.principal += delta;
      cur.basis += proceeds;
    } else {
      this.#debts.set(debtId, {
        debtId,
        asset,
        principal: delta,
        basis: proceeds,
      });
    }
    return proceeds;
  }

  deploy(o: VenueDeployOrder, price: FixedPointDecimal): { cashCost: bigint } {
    checkId(o.venueId, "venueId");
    checkMemberId(o.memberId);
    const amount = o.amount.toStroops();
    const p = price.toStroops();
    if (amount <= 0n || p < 0n) fail("invalid deploy amount or price");
    const cost = notional(amount, p);
    const key = keyOf(o.venueId, o.asset, o.memberId);
    const cur = this.#entries.get(key);
    if (cur) {
      cur.principal += amount;
      cur.basis += cost;
    } else {
      this.#entries.set(key, {
        venueId: o.venueId,
        asset: o.asset,
        ...(o.memberId === undefined ? {} : { memberId: o.memberId }),
        generation: this.#nextGeneration++,
        principal: amount,
        basis: cost,
        accruedYield: 0n,
      });
    }
    return { cashCost: cost };
  }

  accrueYield(
    v: VenueId,
    a: AssetSymbol,
    amount: FixedPointDecimal,
    m?: string
  ): void {
    checkId(v, "venueId");
    checkMemberId(m);
    const delta = amount.toStroops();
    if (delta < 0n) fail("accrued yield cannot be negative");
    this.#requireEntry(v, a, m).accruedYield += delta;
  }

  accrueTick(
    elapsedMs: number,
    rates: Readonly<Record<VenueId, VenueYieldRate>> | undefined,
    remainders: Readonly<Record<string, bigint>>
  ): Readonly<Record<string, bigint>> {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      fail("elapsed milliseconds must be a non-negative safe integer");
    }
    const configuredRates = rates ?? {};
    for (const [venueId, cfg] of Object.entries(configuredRates)) {
      checkId(venueId, "venueId");
      if (
        cfg === null ||
        typeof cfg !== "object" ||
        (cfg.annualRate !== undefined && cfg.ratePerSecond !== undefined)
      ) {
        fail(`invalid yield-rate configuration for venue "${venueId}"`);
      }
      if (
        (cfg.annualRate !== undefined && cfg.annualRate.compareTo(ZERO) < 0) ||
        (cfg.ratePerSecond !== undefined &&
          cfg.ratePerSecond.compareTo(ZERO) < 0)
      ) {
        fail(`yield rate for venue "${venueId}" cannot be negative`);
      }
    }
    const elapsed = BigInt(elapsedMs);
    const next: Record<string, bigint> = {};
    for (const [key, remainder] of Object.entries(remainders)) {
      if (!key.startsWith("venue:")) next[key] = remainder;
    }
    for (const e of this.#entries.values()) {
      const cfg = Object.prototype.hasOwnProperty.call(
        configuredRates,
        e.venueId
      )
        ? configuredRates[e.venueId]
        : undefined;
      const r = cfg?.annualRate ?? cfg?.ratePerSecond;
      if (!r) continue;
      const period =
        cfg?.annualRate !== undefined ? YEAR_MILLISECONDS : MS_PER_SEC;
      const key = remainderKeyOf(e, period);
      const num =
        e.principal * r.toStroops() * elapsed + (remainders[key] ?? 0n);
      const den = STROOPS_PER_UNIT * period;
      e.accruedYield += num / den;
      next[key] = num % den;
    }
    return next;
  }

  harvest(
    o: VenueHarvestOrder,
    price: FixedPointDecimal
  ): { cashProceeds: bigint; realizedGain: bigint } {
    checkId(o.venueId, "venueId");
    checkMemberId(o.memberId);
    const p = price.toStroops();
    if (p < 0n) fail("harvest price must be >= 0");
    const cur = this.#requireEntry(o.venueId, o.asset, o.memberId);
    const req = o.amount?.toStroops() ?? cur.accruedYield;
    if (req < 0n || req > cur.accruedYield)
      fail("harvest amount exceeds accrued yield");
    if (o.debtId !== undefined) {
      const debt = this.#debts.get(o.debtId);
      if (!debt || debt.asset !== o.asset) {
        throw new InvalidVenueOperationError(`invalid debt "${o.debtId}"`);
      }
      cur.accruedYield -= req;
      const repaid = req <= debt.principal ? req : debt.principal;
      const rel =
        repaid === debt.principal
          ? debt.basis
          : (debt.basis * repaid) / debt.principal;
      debt.principal -= repaid;
      debt.basis -= rel;
      if (debt.principal === 0n) this.#debts.delete(o.debtId);
      const surplus = notional(req - repaid, p);
      return { cashProceeds: surplus, realizedGain: rel + surplus };
    }
    cur.accruedYield -= req;
    const cashProceeds = notional(req, p);
    return { cashProceeds, realizedGain: cashProceeds };
  }

  withdraw(
    o: VenueWithdrawOrder,
    price: FixedPointDecimal
  ): { cashProceeds: bigint; realizedGain: bigint } {
    checkId(o.venueId, "venueId");
    checkMemberId(o.memberId);
    const p = price.toStroops();
    if (p < 0n) fail("withdraw price must be >= 0");
    const cur = this.#requireEntry(o.venueId, o.asset, o.memberId);
    const out = o.amount?.toStroops() ?? cur.principal;
    if (out <= 0n || out > cur.principal)
      fail("invalid withdraw principal amount");
    const rel =
      out === cur.principal ? cur.basis : (cur.basis * out) / cur.principal;
    const cashProceeds = notional(out + cur.accruedYield, p);
    cur.principal -= out;
    cur.basis -= rel;
    cur.accruedYield = 0n;
    if (cur.principal === 0n)
      this.#entries.delete(keyOf(o.venueId, o.asset, o.memberId));
    return { cashProceeds, realizedGain: cashProceeds - rel };
  }

  venueValue(prices: PriceSet): FixedPointDecimal {
    let total = 0n;
    for (const e of this.#entries.values())
      total += notional(
        e.principal + e.accruedYield,
        this.#price(prices, e.asset)
      );
    for (const d of this.#debts.values())
      total -= notional(d.principal, this.#price(prices, d.asset));
    return FixedPointDecimal.fromStroops(total);
  }

  unrealized(prices: PriceSet): FixedPointDecimal {
    let total = 0n;
    for (const e of this.#entries.values())
      total +=
        notional(e.principal + e.accruedYield, this.#price(prices, e.asset)) -
        e.basis;
    for (const d of this.#debts.values())
      total += d.basis - notional(d.principal, this.#price(prices, d.asset));
    return FixedPointDecimal.fromStroops(total);
  }

  #price(prices: PriceSet, asset: AssetSymbol): bigint {
    const price = prices.get(asset);
    if (!price) throw new UnknownAssetError(asset);
    return price.toStroops();
  }

  #requireEntry(v: VenueId, a: AssetSymbol, m?: string): InternalVenueEntry {
    return this.#entries.get(keyOf(v, a, m)) ?? fail(`no position at "${v}"`);
  }

  #toPosition(e: InternalVenueEntry): VenuePosition {
    return {
      venueId: e.venueId,
      asset: e.asset,
      ...(e.memberId === undefined ? {} : { memberId: e.memberId }),
      deployedPrincipal: FixedPointDecimal.fromStroops(e.principal),
      accruedYield: FixedPointDecimal.fromStroops(e.accruedYield),
    };
  }
}
