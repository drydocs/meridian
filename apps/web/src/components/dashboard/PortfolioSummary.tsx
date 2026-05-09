import { usePositions } from "../../hooks/usePositions";
import { useWalletStore } from "../../store/wallet";
import { useVaults } from "../../hooks/useVaults";

function formatUsd(stroops: number): string {
  return (stroops / 1e7).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function PortfolioSummary() {
  const { publicKey } = useWalletStore();
  const { data: positions = [], isLoading } = usePositions(publicKey);
  const { data: vaults = [] } = useVaults();

  const totalDeposited = positions.reduce((sum, p) => sum + p.deposited, 0);
  const totalEarned = positions.reduce((sum, p) => sum + p.earned, 0);

  if (isLoading) {
    return (
      <section className="animate-pulse space-y-4">
        <div className="h-5 w-32 bg-gray-700 rounded" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-gray-800" />
          ))}
        </div>
      </section>
    );
  }

  if (positions.length === 0) {
    return (
      <section>
        <h2 className="text-lg font-semibold mb-4">Your Portfolio</h2>
        <p className="text-gray-400 text-sm">
          No active positions. Deposit into a vault below to get started.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Your Portfolio</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
        <StatCard label="Total Deposited" value={formatUsd(totalDeposited)} />
        <StatCard label="Total Earned" value={formatUsd(totalEarned)} accent />
        <StatCard label="Active Positions" value={String(positions.length)} />
      </div>

      <div className="mt-4 space-y-3">
        {positions.map((pos) => {
          const vault = vaults.find((v) => v.id === pos.vaultId);
          return (
            <div
              key={pos.vaultId}
              className="flex items-center justify-between rounded-xl border border-gray-800 bg-gray-900 px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium text-white">{pos.vaultId}</p>
                <p className="text-xs text-gray-400">
                  {vault ? `${vault.protocol} · ${vault.asset}` : "—"}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold text-white">{formatUsd(pos.deposited)}</p>
                <p className="text-xs text-green-400">+{formatUsd(pos.earned)} earned</p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StatCard({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-4">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-xl font-bold ${accent ? "text-green-400" : "text-white"}`}>{value}</p>
    </div>
  );
}
