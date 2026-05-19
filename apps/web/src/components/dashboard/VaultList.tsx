import { useVaults } from "../../hooks/useVaults";
import { useWalletStore } from "../../store/wallet";
import { VaultCard } from "./VaultCard";
import { EmptyState } from "../ui/EmptyState";

function VaultSkeleton() {
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5 flex flex-col gap-5 animate-pulse">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="h-3 w-10 bg-gray-700 rounded" />
          <div className="h-4 w-32 bg-gray-700 rounded" />
        </div>
        <div className="h-6 w-16 bg-gray-700 rounded-full" />
      </div>
      <div className="flex gap-8">
        <div className="space-y-2">
          <div className="h-3 w-8 bg-gray-700 rounded" />
          <div className="h-8 w-20 bg-gray-700 rounded" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-8 bg-gray-700 rounded" />
          <div className="h-6 w-24 bg-gray-700 rounded" />
        </div>
      </div>
      <div className="h-10 w-full bg-gray-700 rounded-xl" />
    </div>
  );
}

export function VaultList() {
  const { data: vaults, isLoading, isError } = useVaults();
  const { connected } = useWalletStore();

  function handleDeposit(vaultId: string) {
    if (!connected) return;
    // TODO(#issue-7): open deposit modal and build unsigned tx
    console.log("deposit", vaultId);
  }

  return (
    <section>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-white">Available Vaults</h2>
        <p className="text-sm text-gray-500 mt-1">Live yield from Blend Capital and DeFindex on Stellar.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {isLoading &&
          Array.from({ length: 4 }).map((_, i) => <VaultSkeleton key={i} />)}

        {vaults?.map((vault) => (
          <VaultCard
            key={vault.id}
            vault={vault}
            onDeposit={handleDeposit}
          />
        ))}

        {!isLoading && (isError || vaults?.length === 0) && (
          <EmptyState
            className="col-span-full"
            icon={
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
              </svg>
            }
            title="Vaults coming soon"
            description="Blend and DeFindex integrations are in progress. Live yield pools will appear here once connected."
          />
        )}
      </div>
    </section>
  );
}
