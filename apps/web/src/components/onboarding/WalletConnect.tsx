import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";
import { shortenAddress } from "@meridian/shared";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { WALLETS, type WalletId } from "../../lib/wallet";
import { RiskDisclosureModal } from "./RiskDisclosureModal";
import { Copy, Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function WalletConnect() {
  const { t } = useTranslation();
  const { connected, publicKey, disconnect } = useWalletStore();
  const { push } = useToastStore();
  const {
    handleConnect,
    status,
    showRiskDisclosure,
    acceptRiskDisclosure,
    cancelRiskDisclosure,
  } = useWalletConnect();
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [installedById, setInstalledById] = useState<
    Partial<Record<WalletId, boolean>>
  >({});
  const pickerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Which option receives focus when the menu opens: the first for a click or
  // ArrowDown, the last for ArrowUp (WAI-ARIA menu button pattern).
  const openFocusRef = useRef<"first" | "last">("first");

  // Refreshed on every open rather than once on mount: extension install
  // state can change between opens without a page reload.
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    void Promise.all(
      WALLETS.map(async (w) => [w.id, await w.adapter.isInstalled()] as const)
    ).then((entries) => {
      if (!cancelled) setInstalledById(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen]);

  // Move focus into the menu when it opens so arrow keys work immediately.
  useEffect(() => {
    if (!pickerOpen) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]'
    );
    if (!items || items.length === 0) return;
    const target =
      openFocusRef.current === "last" ? items[items.length - 1] : items[0];
    target.focus();
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    function onOutsideClick(e: MouseEvent) {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [pickerOpen]);

  const handleCopy = async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      push("error", t("walletConnect.copyFailed"));
    }
  };

  function handleDisconnect() {
    disconnect();
    // So a later reconnect starts from a closed picker rather than one left
    // open from before this disconnect (the picker's own JSX isn't rendered
    // at all while connected, so it can't close itself via a click).
    setPickerOpen(false);
    push("info", t("walletConnect.walletDisconnected"));
  }

  function closePicker(restoreFocus: boolean) {
    setPickerOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  }

  function handleToggleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openFocusRef.current = e.key === "ArrowUp" ? "last" : "first";
      if (pickerOpen) {
        // Already open: just move focus into the menu.
        const items = menuRef.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"]'
        );
        if (items && items.length > 0) {
          (e.key === "ArrowUp" ? items[items.length - 1] : items[0]).focus();
        }
      } else {
        setPickerOpen(true);
      }
    } else if (e.key === "Escape" && pickerOpen) {
      e.preventDefault();
      closePicker(true);
    }
  }

  function handleMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    switch (e.key) {
      case "ArrowDown":
        next = items[(index + 1) % items.length];
        break;
      case "ArrowUp":
        next = items[(index - 1 + items.length) % items.length];
        break;
      case "Home":
        next = items[0];
        break;
      case "End":
        next = items[items.length - 1];
        break;
      case "Escape":
        e.preventDefault();
        closePicker(true);
        return;
      case "Tab":
        // Let focus move on naturally, but don't leave the menu open behind it.
        setPickerOpen(false);
        return;
      default:
        return;
    }
    e.preventDefault();
    next.focus();
  }

  function handlePick(wallet: (typeof WALLETS)[number]) {
    setPickerOpen(false);
    const cached = installedById[wallet.id];
    if (cached === true) {
      void handleConnect(wallet.id);
      return;
    }
    if (cached === false) {
      window.open(wallet.installUrl, "_blank", "noopener,noreferrer");
      return;
    }
    // Install state is still undefined right after the picker opens, before the
    // isInstalled() effect resolves. Resolve on demand so a fast click connects
    // an installed wallet rather than misrouting to its install page.
    void wallet.adapter.isInstalled().then((installed) => {
      if (installed) {
        void handleConnect(wallet.id);
      } else {
        window.open(wallet.installUrl, "_blank", "noopener,noreferrer");
      }
    });
  }

  if (connected && publicKey) {
    return (
      <div className="flex items-center gap-2 text-sm border border-gray-700 rounded-lg px-3 py-2 text-gray-300 hover:border-gray-600 hover:text-white transition-colors duration-150">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
        <span>{shortenAddress(publicKey)}</span>
        <button
          onClick={handleCopy}
          title={
            copied ? t("walletConnect.copied") : t("walletConnect.copyAddress")
          }
          aria-label={
            copied ? t("walletConnect.copied") : t("walletConnect.copyAddress")
          }
          className="text-gray-400 hover:text-white transition-colors duration-150"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>

        <span className="text-gray-600">·</span>
        <button
          onClick={handleDisconnect}
          className="text-gray-400 hover:text-white transition-colors duration-150"
        >
          {t("walletConnect.disconnect")}
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex" ref={pickerRef}>
      {showRiskDisclosure && (
        <RiskDisclosureModal
          onAccept={acceptRiskDisclosure}
          onCancel={cancelRiskDisclosure}
        />
      )}

      <button
        ref={toggleRef}
        data-testid="wallet-picker-toggle"
        onClick={() => {
          openFocusRef.current = "first";
          setPickerOpen((open) => !open);
        }}
        onKeyDown={handleToggleKeyDown}
        disabled={status === "connecting"}
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        className="text-sm border border-gray-700 rounded-lg pl-4 pr-3 py-2 font-medium text-gray-300 hover:border-gray-600 hover:text-white transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
      >
        {status === "connecting"
          ? t("common.connecting")
          : t("common.connectWallet")}
        <ChevronDown size={14} />
      </button>

      {pickerOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("common.connectWallet")}
          onKeyDown={handleMenuKeyDown}
          data-testid="wallet-picker-menu"
          className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-gray-800 bg-deep shadow-xl shadow-black/40 overflow-hidden z-10"
        >
          {WALLETS.map((w) => {
            const installed = installedById[w.id];
            return (
              <button
                key={w.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-testid={`wallet-picker-option-${w.id}`}
                onClick={() => handlePick(w)}
                className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white transition-colors duration-150"
              >
                <span>{w.name}</span>
                {installed === true && (
                  <span className="text-xs text-emerald-400">
                    {t("walletConnect.installed")}
                  </span>
                )}
                {installed === false && (
                  <span className="text-xs text-amber-400">
                    {t("walletConnect.install")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
