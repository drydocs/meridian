import { useRef, useState } from "react";
import { useWalletStore } from "../store/wallet";
import {
  getSelectedWalletId,
  getWalletAdapter,
  isWalletCancellation,
  isWalletTimeout,
  setSelectedWalletId,
  type WalletId,
} from "../lib/wallet";
import { useRiskDisclosure } from "./useRiskDisclosure";
import { useToastStore } from "../store/toast";
import { useTranslation } from "react-i18next";

export type ConnectStatus = "idle" | "connecting" | "no-extension" | "timeout";

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
  // status is "connecting" or "no-extension", so the UI knows which
  // wallet's install link to show. Defaults to the persisted selection so a
  // returning user's plain "Connect Wallet" click (no explicit walletId)
  // still resolves to the right wallet from the very first render.
  const [attemptedWalletId, setAttemptedWalletId] =
    useState<WalletId>(getSelectedWalletId);
  // Aborts the in-flight connect. The adapter's own promise cannot be
  // cancelled, so aborting only stops this hook waiting on it (#1301).
  const abortRef = useRef<AbortController | null>(null);
  // The risk-disclosure gate lives here, not in each component that can
  // trigger a connect (#720): there is more than one such call site
  // (WalletConnect.tsx's own button, VaultPanel.tsx's inline connect
  // prompt), and gating only one of them would let the other silently skip
  // the disclosure entirely. The show/accept/cancel state itself comes
  // from the shared useRiskDisclosure hook (#814), which VaultPanel's
  // deposit gate uses too; the requested wallet id is captured in the
  // gated callback instead of a separate walletIdToConnect state.
  const riskDisclosure = useRiskDisclosure();

  async function connectNow(walletId: WalletId) {
    setAttemptedWalletId(walletId);
    const adapter = getWalletAdapter(walletId);
    // One controller per attempt: cancelling or superseding a connect aborts
    // exactly the attempt it belongs to.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    try {
      const installed = await adapter.isInstalled({ signal });
      if (signal.aborted) return;
      if (!installed) {
        setStatus("no-extension");
        return;
      }

      setStatus("connecting");
      const key = await adapter.connect({ signal });
      // A cancelled attempt must not connect, persist a selection, or fire a
      // toast: the user already asked to go back to idle.
      if (signal.aborted) return;
      // Only persisted on success: a failed or cancelled connect attempt
      // must not silently switch which wallet future sign/reconnect calls
      // (which dispatch off the persisted selection) go through.
      setSelectedWalletId(walletId);
      connect(key);
      setStatus("idle");
      push("success", t("walletConnect.walletConnected"));
    } catch (err) {
      if (signal.aborted || isWalletCancellation(err)) {
        setStatus("idle");
        return;
      }
      if (isWalletTimeout(err)) {
        // A wallet window can be behind the browser or blocked entirely, so
        // the recovery is "look for the wallet, then retry" rather than a
        // generic failure toast.
        setStatus("timeout");
        push("error", t("walletConnect.timeout"));
        return;
      }
      const message = err instanceof Error ? err.message : "";
      // User closed the popup — not an error worth surfacing
      if (!message || /cancel|decline|reject/i.test(message)) {
        setStatus("idle");
        return;
      }
      push("error", message);
      setStatus("idle");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  // Returns the UI to idle immediately without touching the persisted
  // selection, which only ever changes on a successful connect.
  function cancelConnect() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
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

  // Same return shape as before #814, so WalletConnect, VaultPanel and
  // AdminLogin keep consuming these names unchanged.
  return {
    handleConnect,
    status,
    attemptedWalletId,
    cancelConnect,
    showRiskDisclosure: riskDisclosure.show,
    acceptRiskDisclosure: riskDisclosure.accept,
    cancelRiskDisclosure: riskDisclosure.cancel,
  };
}
