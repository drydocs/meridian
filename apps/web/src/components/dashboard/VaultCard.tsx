import type { ApiVault } from "../../lib/api";

interface VaultCardProps {
  vault: ApiVault;
  onDeposit: (vaultId: string) => void;
}

const VAULT_META: Record<string, { name: string; subtitle: string; dot: string; badge: string }> = {
  "blend-usdc": {
    name: "Blend Capital",
    subtitle: "USDC Lending Pool",
    dot: "bg-emerald-400",
    badge: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25",
  },
  "blend-eurc": {
    name: "Blend Capital",
    subtitle: "EURC Lending Pool",
    dot: "bg-blue-400",
    badge: "bg-blue-500/10 text-blue-300 border-blue-500/25",
  },
  "defindex-usdc": {
    name: "DeFindex",
    subtitle: "USDC Yield Strategy",
    dot: "bg-violet-400",
    badge: "bg-violet-500/10 text-violet-300 border-violet-500/25",
  },
};

const DEFAULT_META = {
  name: "Yield Vault",
  subtitle: "USDC Pool",
  dot: "bg-blue-400",
  badge: "bg-blue-500/10 text-blue-300 border-blue-500/25",
};

function formatCompactUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function VaultCard({ vault, onDeposit }: VaultCardProps) {
  const meta = VAULT_META[vault.id] ?? DEFAULT_META;

  return (
    <div className="rounded-xl border border-gray-800 bg-[#161b22] p-5 flex flex-col gap-5 hover:border-gray-700 transition-colors duration-150">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />
          <div>
            <p className="font-semibold text-white text-sm leading-tight">{meta.name}</p>
            <p className="text-xs text-gray-500 mt-0.5">{meta.subtitle}</p>
          </div>
        </div>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${meta.badge}`}>
          {vault.asset}
        </span>
      </div>

      <div className="flex gap-8">
        <div>
          <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1.5">APY</p>
          <p className="text-3xl font-bold text-emerald-400">
            {vault.apy.toFixed(2)}%
          </p>
        </div>
        <div>
          <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1.5">TVL</p>
          <p className="text-xl font-semibold text-white">{formatCompactUsd(vault.tvl)}</p>
        </div>
      </div>

      {vault.userBalance > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5">
          <p className="text-xs text-gray-400">Your deposit</p>
          <p className="text-xs font-semibold text-white">{formatCompactUsd(vault.userBalance)}</p>
        </div>
      )}

      <button
        onClick={() => onDeposit(vault.id)}
        className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] text-white text-sm font-medium py-2.5 transition-colors duration-150"
      >
        Deposit
      </button>
    </div>
  );
}
