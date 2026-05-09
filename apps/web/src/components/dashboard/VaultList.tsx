import { useVaults } from "../../hooks/useVaults";
import { VaultCard } from "./VaultCard";

function handleDeposit(vaultId: string) {
  // TODO(#issue-7): open deposit modal and build unsigned tx
  console.log("Deposit into", vaultId);
}

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
  const { data: vaults, isLoading, isError, error } = useVaults();

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Available Vaults</h2>

      {isError && (
        <div className="rounded-xl border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          Failed to load vaults: {error.message}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {isLoading &&
          Array.from({ length: 4 }).map((_, i) => <VaultSkeleton key={i} />)}

        {vaults?.map((vault) => (
          <VaultCard key={vault.id} vault={vault} onDeposit={handleDeposit} />
        ))}

        {!isLoading && !isError && vaults?.length === 0 && (
          <p className="text-gray-400 text-sm col-span-2">
            No vaults available at the moment.
          </p>
        )}
      </div>
    </section>
  );
}
