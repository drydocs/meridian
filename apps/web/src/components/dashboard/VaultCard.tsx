import type { ApiVault } from "../../lib/api";

interface VaultCardProps {
  vault: ApiVault;
  onDeposit: (vaultId: string) => void;
}

const PROTOCOL_COLORS: Record<string, { dot: string; badge: string }> = {
  "blend-USDC":    { dot: "bg-emerald-400", badge: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25" },
  "blend-EURC":    { dot: "bg-blue-400",    badge: "bg-blue-500/10 text-blue-300 border-blue-500/25"         },
  "ondo-USDY":     { dot: "bg-amber-400",   badge: "bg-amber-500/10 text-amber-300 border-amber-500/25"      },
  "defindex-USDC": { dot: "bg-violet-400",  badge: "bg-violet-500/10 text-violet-300 border-violet-500/25"   },
};

const DEFAULT_COLORS = { dot: "bg-gray-400", badge: "bg-gray-500/10 text-gray-300 border-gray-500/25" };

const CARD_BORDER: Record<ApiVault["riskLevel"], string> = {
  safe:    "border-gray-800 hover:border-gray-700",
  caution: "border-amber-900/60 hover:border-amber-800/60",
  risky:   "border-red-900/60 hover:border-red-800/60",
};

const DEPOSIT_BUTTON: Record<ApiVault["riskLevel"], { bg: string; icon: boolean; tip: string }> = {
  safe:    { bg: "bg-emerald-600 hover:bg-emerald-500 text-white",             icon: false, tip: "" },
  caution: { bg: "bg-yellow-400/10 hover:bg-yellow-400/20 text-yellow-300",   icon: true,  tip: "Smaller pool with rate variance. Review terms before depositing." },
  risky:   { bg: "bg-red-500/10 hover:bg-red-500/20 text-red-400",            icon: true,  tip: "Very low liquidity. Rates are volatile and exits may be difficult." },
};

function formatCompactUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function VaultCard({ vault, onDeposit }: VaultCardProps) {
  const colors = PROTOCOL_COLORS[`${vault.protocol}-${vault.asset}`] ?? DEFAULT_COLORS;
  const btn = DEPOSIT_BUTTON[vault.riskLevel];

  return (
    <div className={`rounded-xl border bg-[#161b22] p-5 flex flex-col gap-5 transition-colors duration-150 ${CARD_BORDER[vault.riskLevel]}`}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`w-2 h-2 rounded-full shrink-0 ${colors.dot}`} />
          <div>
            <p className="font-semibold text-white text-sm leading-tight">{vault.name}</p>
            <p className="text-xs text-gray-500 mt-0.5">{vault.label}</p>
          </div>
        </div>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${colors.badge}`}>
          {vault.asset}
        </span>
      </div>

      <div className="flex gap-8">
        <div>
          <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1.5">APY</p>
          <p className="text-3xl font-bold text-emerald-400">{vault.apy.toFixed(2)}%</p>
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

      <div className="relative group/deposit">
        <button
          onClick={() => onDeposit(vault.id)}
          className={`w-full rounded-lg active:scale-[0.98] text-sm font-medium py-2.5 transition-colors duration-150 flex items-center justify-center gap-1.5 ${btn.bg}`}
        >
          {btn.icon && (
            <svg className="w-3.5 h-3.5 shrink-0 translate-y-px" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.857 2.572a1.3 1.3 0 0 1 2.286 0l4.857 8.571A1.3 1.3 0 0 1 12.857 13H3.143a1.3 1.3 0 0 1-1.143-1.857l4.857-8.571Z" />
              <path d="M8 6.5v2.25M8 10.5v.25" />
            </svg>
          )}
          Deposit
        </button>
        {btn.tip && (
          <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border border-gray-700 bg-[#1c2128] px-3 py-2 text-[11px] text-gray-400 leading-relaxed z-20 pointer-events-none opacity-0 group-hover/deposit:opacity-100 transition-opacity duration-150">
            {btn.tip}
          </div>
        )}
      </div>
    </div>
  );
}
