import { MOCK_POSITIONS, MOCK_VAULTS } from "../../lib/mockData";
import { formatUsdAmount } from "@meridian/shared";

export function PortfolioSummary() {
  const totalDeposited = MOCK_POSITIONS.reduce((sum, p) => sum + p.deposited, BigInt(0));
  const totalEarned = MOCK_POSITIONS.reduce((sum, p) => sum + p.earned, BigInt(0));

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Your Portfolio</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard label="Total Deposited" value={`$${formatUsdAmount(totalDeposited)}`} />
        <StatCard label="Total Earned" value={`$${formatUsdAmount(totalEarned)}`} accent />
        <StatCard label="Active Positions" value={String(MOCK_POSITIONS.length)} />
      </div>

      <div className="mt-4 space-y-3">
        {MOCK_POSITIONS.map((pos) => {
          const vault = MOCK_VAULTS.find((v) => v.id === pos.vaultId);
          if (!vault) return null;
          return (
            <div
              key={pos.vaultId}
              className="flex items-center justify-between rounded-xl border border-gray-800 bg-gray-900 px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium text-white">{pos.vaultId}</p>
                <p className="text-xs text-gray-400">{vault.protocol} · {vault.asset}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold text-white">${formatUsdAmount(pos.deposited)}</p>
                <p className="text-xs text-green-400">+${formatUsdAmount(pos.earned)} earned</p>
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
