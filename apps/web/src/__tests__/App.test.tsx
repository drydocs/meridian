import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import App from "../App";

vi.mock("../pages/AdminLogin", () => ({
  AdminLogin: () => (
    <main id="main-content" tabIndex={-1}>
      <h1>admin.access</h1>
    </main>
  ),
}));
vi.mock("../components/dashboard/VaultPanel", () => ({
  VaultPanel: () => <div data-testid="vault-panel" />,
}));
vi.mock("../components/onboarding/WalletConnect", () => ({
  WalletConnect: () => <button type="button">Connect</button>,
}));
vi.mock("../components/ui/Toasts", () => ({
  Toasts: () => null,
}));
vi.mock("../hooks/useVaultState", () => ({
  useVaultState: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("../components/admin/VaultStatePanel", () => ({
  VaultStatePanel: () => <div data-testid="vault-state-panel" />,
}));
vi.mock("../components/dashboard/AdminActionHistory", () => ({
  AdminActionHistory: () => <div data-testid="admin-action-history" />,
}));
vi.mock("../store/wallet", () => ({
  useWalletStore: Object.assign(
    () => ({
      publicKey: null,
      connected: false,
      disconnect: vi.fn(),
    }),
    {
      getState: () => ({
        revalidate: vi.fn(),
      }),
    }
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withTranslation: () => (WrappedComponent: any) => {
    function Wrapped(props: Record<string, unknown>) {
      return <WrappedComponent {...props} t={(key: string) => key} />;
    }
    return Wrapped;
  },
}));

function navigateTo(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

describe("App focus management and skip link", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/app/");
    document.title = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a skip link that targets and focuses the main content region", () => {
    render(<App />);

    const skipLink = screen.getByRole("link", { name: "a11y.skipToMain" });
    expect(skipLink.getAttribute("href")).toBe("#main-content");

    const main = document.getElementById("main-content");
    expect(main).not.toBeNull();
    expect(main?.tagName).toBe("MAIN");

    fireEvent.click(skipLink);
    expect(document.activeElement).toBe(main);
  });

  it("sets document.title to reflect the active route", () => {
    render(<App />);
    expect(document.title).toBe("a11y.titles.dashboard");

    act(() => {
      navigateTo("/app/status");
    });
    expect(document.title).toBe("a11y.titles.status");

    act(() => {
      navigateTo("/admin");
    });
    expect(document.title).toBe("a11y.titles.admin");

    act(() => {
      navigateTo("/app/does-not-exist");
    });
    expect(document.title).toBe("a11y.titles.notFound");
  });

  it("moves focus to the new page heading on route change", () => {
    render(<App />);

    act(() => {
      navigateTo("/app/status");
    });

    const statusHeading = screen.getByRole("heading", {
      level: 1,
      name: "status.title",
    });
    expect(document.activeElement).toBe(statusHeading);
    expect(statusHeading.getAttribute("tabindex")).toBe("-1");

    act(() => {
      navigateTo("/app/unknown");
    });

    const notFoundHeading = screen.getByRole("heading", {
      level: 1,
      name: "Page not found",
    });
    expect(document.activeElement).toBe(notFoundHeading);
  });

  it("keeps focus inside an open modal dialog across route updates", () => {
    render(<App />);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const button = document.createElement("button");
    button.textContent = "Inside dialog";
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();

    expect(document.activeElement).toBe(button);

    act(() => {
      navigateTo("/app/status");
    });

    expect(document.activeElement).toBe(button);
  });
});
