import type { NextPage } from "next";
import Head from "next/head";
import { VaultList } from "../components/dashboard/VaultList";
import { PortfolioSummary } from "../components/dashboard/PortfolioSummary";
import { WalletConnect } from "../components/onboarding/WalletConnect";
import { useWalletStore } from "../store/wallet";

const Home: NextPage = () => {
  const { connected } = useWalletStore();

  return (
    <>
      <Head>
        <title>Meridian — Stablecoin Yield on Stellar</title>
        <meta
          name="description"
          content="Earn the best stablecoin yields on Stellar. Powered by Blend and DeFindex."
        />
      </Head>

      <main className="min-h-screen bg-gray-950 text-white">
        <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
          <span className="font-bold text-xl tracking-tight">Meridian</span>
          <WalletConnect />
        </header>

        <div className="max-w-5xl mx-auto px-6 py-10 space-y-10">
          {connected && <PortfolioSummary />}
          <VaultList />
        </div>
      </main>
    </>
  );
};

export default Home;
