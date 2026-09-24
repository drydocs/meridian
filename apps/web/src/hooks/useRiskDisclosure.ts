import { useRef, useState } from "react";
import {
  hasAcceptedRiskDisclosure,
  setRiskDisclosureAccepted,
} from "../lib/wallet";

// Whatever the disclosure is guarding: a wallet connect, a deposit, etc.
// May be async so callers can await the gated work once it actually runs.
type GatedAction = () => void | Promise<void>;

// The single source of truth for the risk-disclosure gate (#814). Before
// this, useWalletConnect (connect flow) and VaultPanel (deposit flow, for
// wallets connected via AdminLogin's skipRiskDisclosure) each kept their
// own show-state and accept/cancel logic over the same localStorage flag.
//
// requireAcceptance runs the action straight away once the browser has
// accepted; otherwise it holds the action and shows the modal. accept
// persists the flag and then runs the held action; cancel drops it, so a
// cancelled gate never runs anything.
export function useRiskDisclosure() {
  const [show, setShow] = useState(false);
  // A ref, not state: the held action is never rendered, and a ref avoids
  // an extra re-render plus the functional-update quirk of storing a
  // function in useState.
  const pendingAction = useRef<GatedAction | null>(null);

  function requireAcceptance(action: GatedAction): void | Promise<void> {
    if (hasAcceptedRiskDisclosure()) return action();
    pendingAction.current = action;
    setShow(true);
  }

  // Returns the held action's result so callers (and tests) can await it.
  function accept(): void | Promise<void> {
    setRiskDisclosureAccepted();
    setShow(false);
    const action = pendingAction.current;
    pendingAction.current = null;
    return action?.();
  }

  function cancel(): void {
    pendingAction.current = null;
    setShow(false);
  }

  return { show, requireAcceptance, accept, cancel };
}
