import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultList } from "./components/dashboard/VaultList";
import { PortfolioSummary } from "./components/dashboard/PortfolioSummary";
import { WalletConnect } from "./components/onboarding/WalletConnect";

const queryClient = new QueryClient();

function Dashboard() {
  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <header className="sticky top-0 z-50 border-b border-gray-800 bg-[#0d1117]/95 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <span className="font-extrabold text-lg tracking-tight text-white">Meridian</span>
          <WalletConnect />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex flex-col lg:flex-row gap-8 items-start">
          <div className="flex-1 min-w-0">
            <VaultList />
          </div>
          <div className="w-full lg:w-72 shrink-0">
            <PortfolioSummary />
          </div>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  );
}
