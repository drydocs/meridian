import { usePositions } from "../../hooks/usePositions";
import { useWalletStore } from "../../store/wallet";
import { useVaults } from "../../hooks/useVaults";
import { useWalletConnect } from "../../hooks/useWalletConnect";

function formatUsd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function PortfolioSummary() {
  const { connected, publicKey } = useWalletStore();
  const { handleConnect, status } = useWalletConnect();
  const { data: positions = [], isLoading } = usePositions(publicKey);
  const { data: vaults = [] } = useVaults();

  if (!connected) {
    return (
      <aside className="rounded-xl border border-gray-800 bg-[#161b22] p-5">
        <h2 className="text-sm font-semibold text-white mb-1">Your Portfolio</h2>
        <p className="text-xs text-gray-500 mb-5 leading-relaxed">
          Connect your Freighter wallet to track positions and earned yield.
        </p>
        <button
          onClick={handleConnect}
          disabled={status === "connecting"}
          className="w-full rounded-lg border border-gray-700 bg-transparent hover:border-gray-600 hover:text-white active:scale-[0.98] text-gray-300 text-sm font-medium py-2.5 transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === "connecting" ? "Connecting..." : "Connect Wallet"}
        </button>
      </aside>
    );
  }

  if (isLoading) {
    return (
      <aside className="rounded-xl border border-gray-800 bg-[#161b22] p-5 space-y-3">
        <div className="h-4 w-28 bg-gray-800 rounded animate-pulse" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 rounded-lg bg-gray-800 animate-pulse" />
        ))}
      </aside>
    );
  }

  const totalDeposited = positions.reduce((sum, p) => sum + p.deposited, 0);
  const totalEarned = positions.reduce((sum, p) => sum + p.earned, 0);

  if (positions.length === 0) {
    return (
      <aside className="rounded-xl border border-gray-800 bg-[#161b22] p-5">
        <h2 className="text-sm font-semibold text-white mb-1">Your Portfolio</h2>
        <p className="text-xs text-gray-500 leading-relaxed">
          No active positions yet. Deposit into a vault to start earning yield.
        </p>
      </aside>
    );
  }

  return (
    <aside className="rounded-xl border border-gray-800 bg-[#161b22] p-5 space-y-4">
      <h2 className="text-sm font-semibold text-white">Your Portfolio</h2>

      <div className="space-y-2">
        <StatRow label="Total Deposited" value={formatUsd(totalDeposited)} />
        <StatRow label="Total Earned" value={`+${formatUsd(totalEarned)}`} accent />
        <StatRow label="Positions" value={String(positions.length)} />
      </div>

      <div className="border-t border-gray-800 pt-4 space-y-2">
        {positions.map((pos) => {
          const vault = vaults.find((v) => v.id === pos.vaultId);
          if (!vault) return null;
          return (
            <div
              key={pos.vaultId}
              className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 px-3 py-3"
            >
              <div>
                <p className="text-xs font-medium text-white">{vault.name}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">{vault.asset}</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-semibold text-white">{formatUsd(pos.deposited)}</p>
                <p className="text-[11px] text-emerald-400">+{formatUsd(pos.earned)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function StatRow({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xs font-semibold ${accent ? "text-emerald-400" : "text-white"}`}>{value}</p>
    </div>
  );
}
