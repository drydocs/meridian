import { MOCK_VAULTS } from "../../lib/mockData";
import { VaultCard } from "./VaultCard";

function handleDeposit(vaultId: string) {
  // TODO(#issue-7): open deposit modal and build unsigned tx
  console.log("Deposit into", vaultId);
}

export function VaultList() {
  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Available Vaults</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {MOCK_VAULTS.map((vault) => (
          <VaultCard key={vault.id} vault={vault} onDeposit={handleDeposit} />
        ))}
      </div>
    </section>
  );
}
