import type { VaultInfo } from "../../types";

interface VaultCardProps {
  vault: VaultInfo;
  onDeposit: (vaultId: string) => void;
}

const PROTOCOL_LABELS: Record<VaultInfo["protocol"], string> = {
  blend: "Blend",
  defindex: "DeFindex",
};

const PROTOCOL_COLORS: Record<VaultInfo["protocol"], string> = {
  blend: "bg-blue-900/50 text-blue-300 border-blue-700/50",
  defindex: "bg-violet-900/50 text-violet-300 border-violet-700/50",
};

export function VaultCard({ vault, onDeposit }: VaultCardProps) {
  const tvlDisplay = (Number(vault.tvl) / 1e7).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5 flex flex-col gap-5 hover:border-gray-700 transition">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-widest mb-1">{vault.asset}</p>
          <p className="font-semibold text-white text-sm">{vault.id}</p>
        </div>
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${PROTOCOL_COLORS[vault.protocol]}`}>
          {PROTOCOL_LABELS[vault.protocol]}
        </span>
      </div>

      <div className="flex gap-8">
        <div>
          <p className="text-xs text-gray-400 mb-1">APY</p>
          <p className="text-3xl font-bold text-green-400">{vault.apy.toFixed(2)}%</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-1">TVL</p>
          <p className="text-xl font-semibold text-white">{tvlDisplay}</p>
        </div>
      </div>

      <button
        onClick={() => onDeposit(vault.id)}
        className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white text-sm font-medium py-2.5 transition"
      >
        Deposit
      </button>
    </div>
  );
}
