import { useState } from "react";
import { useWalletStore } from "../store/wallet";
import {
  getSelectedWalletId,
  getWalletAdapter,
  setSelectedWalletId,
  hasAcceptedRiskDisclosure,
  setRiskDisclosureAccepted,
  type WalletId,
} from "../lib/wallet";
import { useToastStore } from "../store/toast";
import { useTranslation } from "react-i18next";

export type ConnectStatus = "idle" | "connecting" | "no-extension";

export function useWalletConnect() {
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
  // The risk-disclosure gate lives here, not in each component that can
  // trigger a connect (#720): there is more than one such call site
  // (WalletConnect.tsx's own button, VaultPanel.tsx's inline connect
  // prompt), and gating only one of them would let the other silently skip
  // the disclosure entirely. undefined means "the default/selected
  // wallet," matching what an omitted handleConnect argument already means.
  const [showRiskDisclosure, setShowRiskDisclosure] = useState(false);
  const [walletIdToConnect, setWalletIdToConnect] = useState<
    WalletId | undefined
  >(undefined);

  async function connectNow(walletId: WalletId) {
    setAttemptedWalletId(walletId);
    const adapter = getWalletAdapter(walletId);
    const installed = await adapter.isInstalled();
    if (!installed) {
      setStatus("no-extension");
      return;
    }

    setStatus("connecting");
    try {
      const key = await adapter.connect();
      // Only persisted on success: a failed or cancelled connect attempt
      // must not silently switch which wallet future sign/reconnect calls
      // (which dispatch off the persisted selection) go through.
      setSelectedWalletId(walletId);
      connect(key);
      setStatus("idle");
      push("success", t("walletConnect.walletConnected"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // User closed the popup — not an error worth surfacing
      if (!message || /cancel|decline|reject/i.test(message)) {
        setStatus("idle");
        return;
      }
      push("error", message);
      setStatus("idle");
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
    if (hasAcceptedRiskDisclosure()) {
      await connectNow(walletId);
      return;
    }
    setWalletIdToConnect(walletId);
    setShowRiskDisclosure(true);
  }

  async function acceptRiskDisclosure() {
    setRiskDisclosureAccepted();
    setShowRiskDisclosure(false);
    await connectNow(walletIdToConnect ?? getSelectedWalletId());
  }

  function cancelRiskDisclosure() {
    setShowRiskDisclosure(false);
  }

  return {
    handleConnect,
    status,
    attemptedWalletId,
    showRiskDisclosure,
    acceptRiskDisclosure,
    cancelRiskDisclosure,
  };
}
