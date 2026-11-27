import { useRef, useState } from "react";
import { useWalletStore } from "../store/wallet";
import {
  getSelectedWalletId,
  getWalletAdapter,
  setSelectedWalletId,
  WalletCancelledError,
  WalletTimeoutError,
  type WalletId,
} from "../lib/wallet";
import { useRiskDisclosure } from "./useRiskDisclosure";
import { useToastStore } from "../store/toast";
import { useTranslation } from "react-i18next";
import { mapError } from "../lib/errorMapper";

// "timed-out" is distinct from "idle" so the UI can explain the likely cause
// (a wallet window hidden behind the browser) and offer a retry.
export type ConnectStatus =
  "idle" | "connecting" | "no-extension" | "timed-out";

interface UseWalletConnectOptions {
  // For call sites where connecting isn't a deposit action, e.g. AdminLogin.
  skipRiskDisclosure?: boolean;
}

export function useWalletConnect(options: UseWalletConnectOptions = {}) {
  const { skipRiskDisclosure = false } = options;
  const { t } = useTranslation();
  const { connect } = useWalletStore();
  const { push } = useToastStore();
  const [status, setStatus] = useState<ConnectStatus>("idle");
  // The wallet handleConnect most recently attempted — meaningful once
  // status is "connecting", "no-extension" or "timed-out", so the UI knows
  // which wallet's install link to show and which wallet to retry.
  // Defaults to the persisted selection so a returning user's plain
  // "Connect Wallet" click (no explicit walletId) still resolves to the
  // right wallet from the very first render.
  const [attemptedWalletId, setAttemptedWalletId] =
    useState<WalletId>(getSelectedWalletId);
  // The in-flight connect attempt. A cancel aborts it; a superseded attempt
  // must not overwrite the status of the one that replaced it.
  const controllerRef = useRef<AbortController | null>(null);
  // The risk-disclosure gate lives here, not in each component that can
  // trigger a connect (#720): there is more than one such call site
  // (WalletConnect.tsx's own button, VaultPanel.tsx's inline connect
  // prompt), and gating only one of them would let the other silently skip
  // the disclosure entirely. The show/accept/cancel state itself comes
  // from the shared useRiskDisclosure hook (#814), which VaultPanel's
  // deposit gate uses too; the requested wallet id is captured in the
  // gated callback instead of a separate walletIdToConnect state.
  const riskDisclosure = useRiskDisclosure();

  function isCurrent(controller: AbortController) {
    return controllerRef.current === controller;
  }

  async function connectNow(walletId: WalletId) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setAttemptedWalletId(walletId);
    setStatus("connecting");
    try {
      const adapter = getWalletAdapter(walletId);
      const installed = await adapter.isInstalled({
        signal: controller.signal,
      });
      if (!installed) {
        if (isCurrent(controller)) setStatus("no-extension");
        return;
      }

      const key = await adapter.connect({ signal: controller.signal });
      if (typeof adapter.getNetwork === "function") {
        try {
          const reportedNetwork = await adapter.getNetwork();
          if (reportedNetwork === "mainnet" || reportedNetwork === "testnet") {
            useWalletStore.setState({ network: reportedNetwork });
          }
        } catch {
          // Ignore passive reporting errors
        }
      }
      // Only persisted on success: a failed or cancelled connect attempt
      // must not silently switch which wallet future sign/reconnect calls
      // (which dispatch off the persisted selection) go through.
      setSelectedWalletId(walletId);
      connect(key);
      setStatus("idle");
      push("success", t("walletConnect.walletConnected"));
    } catch (err) {
      if (!isCurrent(controller)) return;
      // A cancel returns to idle without touching the persisted selection.
      if (err instanceof WalletCancelledError) {
        setStatus("idle");
        return;
      }
      if (err instanceof WalletTimeoutError) {
        // Keep the attempted wallet so the UI can offer a retry, and explain
        // that the wallet window may simply be behind the browser.
        setStatus("timed-out");
        push("error", mapError(err, t).message);
        return;
      }
      const message = err instanceof Error ? err.message : "";
      // User closed the popup — not an error worth surfacing
      if (!message || /cancel|decline|reject/i.test(message)) {
        setStatus("idle");
        return;
      }
      push("error", mapError(err, t).message);
      setStatus("idle");
    } finally {
      if (isCurrent(controller)) controllerRef.current = null;
    }
  }

  // Never connects directly: the actual connection only ever starts from
  // acceptRiskDisclosure below, once accepted (or immediately, for a
  // browser that already has). Cancelling never calls connectNow at all,
  // rejecting the connection request outright rather than disconnecting
  // something that was never connected. Still async and awaitable, same as
  // before this gate existed: it resolves once connectNow finishes, or
  // immediately if only the risk prompt was shown.
  async function handleConnect(walletId: WalletId = getSelectedWalletId()) {
    if (skipRiskDisclosure) {
      await connectNow(walletId);
      return;
    }
    await riskDisclosure.requireAcceptance(() => connectNow(walletId));
  }

  // Aborts an in-flight connect and returns to idle. The persisted wallet
  // selection is untouched, so a later connect still targets the same wallet.
  function cancelConnect() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus("idle");
  }

  // Re-runs the last attempt after a timeout, without asking the user to
  // reopen the picker.
  function retryConnect() {
    void handleConnect(attemptedWalletId);
  }

  // Same return shape as before #814, so WalletConnect, VaultPanel and
  // AdminLogin keep consuming these names unchanged.
  return {
    handleConnect,
    cancelConnect,
    retryConnect,
    status,
    attemptedWalletId,
    showRiskDisclosure: riskDisclosure.show,
    acceptRiskDisclosure: riskDisclosure.accept,
    cancelRiskDisclosure: riskDisclosure.cancel,
  };
}
