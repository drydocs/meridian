/**
 * Composition lifecycle: initialize each member once, call `step` then
 * `rebalance` for each tick, and call `close` once at run end. Every phase
 * drives members in declaration order, and returned orders retain that order.
 */
import { FixedPointDecimal, STROOPS_PER_UNIT } from "../types";
import type { AssetSymbol } from "../types";
import type {
  Order,
  PortfolioView,
  PositionView,
  Strategy,
  StrategyContext,
  StrategyInitParams,
} from "../strategy";

/**
 * A member of a composed strategy. `allocation` is the fraction of the
 * composition's starting capital assigned to the member; allocations must
 * sum to one. Each member owns its strategy instance and its strategy config.
 */
export interface ComposedStrategyMember<TConfig = unknown> {
  readonly id: string;
  readonly strategy: Strategy<TConfig>;
  readonly allocation: FixedPointDecimal;
  readonly config: TConfig;
}

interface InitializedMember {
  readonly id: string;
  readonly strategy: Strategy<unknown>;
  readonly allocation: FixedPointDecimal;
  readonly config: unknown;
  readonly portfolio: (portfolio: PortfolioView) => PortfolioView;
}

/**
 * Composes multiple strategies into one `Strategy` suitable for `runBacktest`.
 *
 * Members are initialized and driven in declaration order. Each member gets
 * its allocated starting capital and a portfolio view containing only its
 * own positions; cash and total value remain views of the shared ledger.
 * Returned orders are tagged with the member id so same-asset positions stay
 * distinct in the runner's portfolio. Member ids cannot contain `/`, which
 * separates IDs in nested compositions.
 */
export class ComposedStrategy implements Strategy<unknown> {
  readonly name = "composed-strategy";
  readonly #members: readonly InitializedMember[];

  constructor(members: readonly ComposedStrategyMember<unknown>[]) {
    if (members.length === 0) {
      throw new RangeError("a composed strategy requires at least one member");
    }

    const ids = new Set<string>();
    let allocation = 0n;
    for (const member of members) {
      if (member.id.trim().length === 0 || member.id.includes("/")) {
        throw new TypeError(
          'composed strategy member ids must be non-empty and must not contain "/"'
        );
      }
      if (ids.has(member.id)) {
        throw new TypeError(
          `duplicate composed strategy member id "${member.id}"`
        );
      }
      ids.add(member.id);

      const amount = member.allocation.toStroops();
      if (amount < 0n || amount > STROOPS_PER_UNIT) {
        throw new RangeError(
          `allocation for member "${member.id}" must be between 0 and 1`
        );
      }
      allocation += amount;
    }
    if (allocation !== STROOPS_PER_UNIT) {
      throw new RangeError(
        "composed strategy member allocations must sum to 1"
      );
    }

    this.#members = members.map((member) => ({
      id: member.id,
      strategy: member.strategy,
      allocation: member.allocation,
      config: member.config,
      portfolio: (portfolio) => new MemberPortfolioView(portfolio, member.id),
    }));
  }

  init(_params: StrategyInitParams<unknown>): void {
    for (const member of this.#members) {
      member.strategy.init({
        startingCapital: _params.startingCapital.mul(member.allocation),
        config: member.config,
      });
    }
  }

  step(context: StrategyContext): void {
    for (const member of this.#members) {
      member.strategy.step(this.#memberContext(member, context));
    }
  }

  rebalance(context: StrategyContext): readonly Order[] {
    return this.#members.flatMap((member) =>
      this.#tagOrders(
        this.#memberNamespace(member.id, context.portfolio),
        member.strategy.rebalance(this.#memberContext(member, context))
      )
    );
  }

  close(context: StrategyContext): readonly Order[] {
    return this.#members.flatMap((member) =>
      this.#tagOrders(
        this.#memberNamespace(member.id, context.portfolio),
        member.strategy.close(this.#memberContext(member, context))
      )
    );
  }

  #memberContext(
    member: InitializedMember,
    context: StrategyContext
  ): StrategyContext {
    return {
      market: context.market,
      portfolio: member.portfolio(context.portfolio),
    };
  }

  #tagOrders(memberId: string, orders: readonly Order[]): Order[] {
    return orders.map((order) => ({
      ...order,
      memberId:
        order.memberId === memberId ||
        order.memberId?.startsWith(`${memberId}/`)
          ? order.memberId
          : memberId,
    }));
  }

  #memberNamespace(memberId: string, portfolio: PortfolioView): string {
    return portfolio instanceof MemberPortfolioView
      ? `${portfolio.namespace}/${memberId}`
      : memberId;
  }
}

class MemberPortfolioView implements PortfolioView {
  readonly #portfolio: PortfolioView;
  readonly namespace: string;

  constructor(portfolio: PortfolioView, memberId: string) {
    if (portfolio instanceof MemberPortfolioView) {
      this.#portfolio = portfolio.#portfolio;
      this.namespace = `${portfolio.namespace}/${memberId}`;
    } else {
      this.#portfolio = portfolio;
      this.namespace = memberId;
    }
  }

  get cash(): FixedPointDecimal {
    return this.#portfolio.cash;
  }

  getPosition(asset: AssetSymbol): PositionView | undefined {
    return this.positions().find((position) => position.asset === asset);
  }

  positions(): readonly PositionView[] {
    return this.#portfolio
      .positions()
      .filter((position) => position.memberId === this.namespace);
  }

  totalValue(
    prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>
  ): FixedPointDecimal {
    return this.#portfolio.totalValue(prices);
  }
}
