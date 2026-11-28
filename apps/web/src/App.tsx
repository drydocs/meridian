import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient, setQueryClient } from "./lib/queryClient";
import { VaultPanel } from "./components/dashboard/VaultPanel";
import { WalletConnect } from "./components/onboarding/WalletConnect";
import { Toasts } from "./components/ui/Toasts";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { useWalletStore } from "./store/wallet";
import { useDocumentLanguage } from "./hooks/useDocumentLanguage";
import { useTranslation } from "react-i18next";
import { NotFound } from "./pages/NotFound";
import { useConnectivity } from "./hooks/useConnectivity";

const AdminLogin = lazy(() =>
  import("./pages/AdminLogin").then((m) => ({ default: m.AdminLogin }))
);

const StatusPage = lazy(() =>
  import("./pages/StatusPage").then((m) => ({ default: m.StatusPage }))
);

const queryClient = createQueryClient();
setQueryClient(queryClient);

function OfflineBanner({ online }: { online: boolean }) {
  const { t } = useTranslation();
  if (online) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-50 bg-amber-900 text-amber-100 text-sm text-center py-2 px-4"
    >
      {t("status.offlineBanner")}
    </div>
  );
}

type AppRoute = "admin" | "status" | "dashboard" | "notFound";

// No router dependency for a few extra routes: the app has a handful of
// pages, and pulling in react-router for a couple of static path splits
// would be a heavier change than the admin dashboard itself (#615) needs.
//
// The public dashboard and status page stay under /app/*, which the existing
// Vercel rewrite serves from /app/index.html. Admin is canonical at /admin;
// the legacy /app/admin path is also recognized if Vercel's redirect is not
// applied before the SPA loads.
function isAdminRoute(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/app/admin" ||
    pathname.startsWith("/app/admin/")
  );
}

function isStatusRoute(pathname: string): boolean {
  return pathname.startsWith("/app/status");
}

// The SPA is served under /app/; only the dashboard root is a real page there.
// Anything else (an unknown /app/* path or any other unmatched route) renders
// the 404 page instead of silently falling back to the dashboard.
function isDashboardRoute(pathname: string): boolean {
  return pathname === "/app" || pathname === "/app/";
}

function resolveRoute(pathname: string): AppRoute {
  if (isAdminRoute(pathname)) return "admin";
  if (isStatusRoute(pathname)) return "status";
  if (isDashboardRoute(pathname)) return "dashboard";
  return "notFound";
}

function Dashboard({ online }: { online: boolean }) {
  const { t, i18n } = useTranslation();
  const [resetKey, setResetKey] = useState(0);
  const toggleLanguage = useCallback(() => {
    const newLang = i18n.language === "en" ? "fr" : "en";
    i18n.changeLanguage(newLang);
    localStorage.setItem("language", newLang);
  }, [i18n]);

  return (
    <div className="relative min-h-screen bg-night text-paper overflow-hidden">
      <svg
        aria-hidden="true"
        viewBox="4 4 32 17"
        fill="none"
        className="pointer-events-none fixed left-[6vw] top-1/2 z-0 h-[170vh] w-auto max-w-none -translate-y-1/2 opacity-[0.055]"
      >
        <defs>
          <linearGradient
            id="app-bg-convergence"
            x1="34"
            y1="20"
            x2="17"
            y2="17"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="var(--color-entry)" />
            <stop offset="100%" stopColor="var(--color-settled)" />
          </linearGradient>
        </defs>
        <path
          d="M34 20 A14 14 0 0 0 6 20 A11 11 0 0 1 28 20 A8 8 0 0 0 12 20 A5 5 0 0 1 22 20"
          stroke="url(#app-bg-convergence)"
          strokeWidth="2.25"
          strokeLinecap="butt"
        />
        <circle cx="17" cy="17.3" r="2.6" fill="url(#app-bg-convergence)" />
      </svg>

      <header className="sticky top-0 z-50 border-b border-gray-800 bg-night/95 backdrop-blur-sm pb-4">
        <div className="max-w-xl mx-auto px-6 h-20 flex items-end justify-between pb-4">
          <span className="font-extrabold text-lg tracking-tight text-paper">
            {t("header.title")}
          </span>
          <div className="flex items-center gap-2">
            <WalletConnect />
            <button
              onClick={toggleLanguage}
              className="text-sm border border-gray-700 rounded-lg px-3 py-1.5 text-gray-300 hover:border-gray-600 hover:text-paper transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
            >
              {i18n.language === "en" ? "FR" : "EN"}
            </button>
          </div>
        </div>
      </header>

      <OfflineBanner online={online} />

      <main
        id="main-content"
        tabIndex={-1}
        className="relative z-10 max-w-xl mx-auto px-6 py-10 outline-none"
      >
        <h1 className="sr-only">{t("header.title")}</h1>
        <ErrorBoundary showHome onReset={() => setResetKey((k) => k + 1)}>
          <div key={resetKey}>
            <VaultPanel />
          </div>
        </ErrorBoundary>
      </main>
    </div>
  );
}

export default function App() {
  const online = useConnectivity(queryClient);
  const { t } = useTranslation();
  useDocumentLanguage();
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const lastPathnameRef = useRef(pathname);

  useEffect(() => {
    const revalidate = () => void useWalletStore.getState().revalidate();
    revalidate();
    // Re-check authorization when the window regains focus. Freighter opens
    // as an extension popup (separate window), so the page loses focus while
    // the popup is open and regains it when it closes — this catches revoked
    // site access without requiring a page reload.
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, []);

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const route = resolveRoute(pathname);

  useEffect(() => {
    document.title = t(`a11y.titles.${route}`);
  }, [route, t]);

  useEffect(() => {
    // Compare with the last handled pathname instead of a "has mounted" flag,
    // so React StrictMode's second effect run on first load does not move
    // focus off the skip link.
    if (lastPathnameRef.current === pathname) return;
    lastPathnameRef.current = pathname;

    const activeDialog = document.querySelector(
      '[role="dialog"][aria-modal="true"]'
    );
    if (activeDialog && activeDialog.contains(document.activeElement)) {
      return;
    }

    const target =
      document.querySelector<HTMLElement>("#main-content h1, main h1, h1") ??
      document.getElementById("main-content");
    if (!target) return;

    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
    }
    target.focus();
  }, [pathname]);

  const handleSkipToMain = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      const main = document.getElementById("main-content");
      if (!main) return;
      event.preventDefault();
      if (!main.hasAttribute("tabindex")) {
        main.setAttribute("tabindex", "-1");
      }
      main.focus();
    },
    []
  );

  const [pageResetKey, setPageResetKey] = useState(0);

  const rawPage =
    route === "admin" ? (
      <Suspense
        fallback={
          <div className="min-h-screen bg-night text-paper flex items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          </div>
        }
      >
        <AdminLogin />
      </Suspense>
    ) : route === "status" ? (
      <Suspense
        fallback={
          <div className="min-h-screen bg-night text-paper flex items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          </div>
        }
      >
        <StatusPage />
      </Suspense>
    ) : route === "dashboard" ? (
      <Dashboard online={online} />
    ) : (
      <NotFound />
    );

  const page = (
    <ErrorBoundary showHome onReset={() => setPageResetKey((k) => k + 1)}>
      <div key={pageResetKey}>{rawPage}</div>
    </ErrorBoundary>
  );

  return (
    <QueryClientProvider client={queryClient}>
      <a
        href="#main-content"
        onClick={handleSkipToMain}
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-emerald-700 focus:text-white focus:rounded-md focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-emerald-400 font-medium text-sm"
      >
        {t("common.skipToContent")}
      </a>
      {page}
      <Toasts />
    </QueryClientProvider>
  );
}
