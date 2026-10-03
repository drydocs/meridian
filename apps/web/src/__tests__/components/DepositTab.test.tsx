import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DepositTab } from "../../components/dashboard/DepositTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

const VAULT = {
  id: "meridian-usdc",
  protocol: "meridian" as const,
  asset: "USDC",
  name: "Meridian",
  label: "USDC Vault",
  apy: 8,
  tvl: 10_000,
  userBalance: 0,
  riskLevel: "safe" as const,
};

const POSITION = {
  vaultId: "meridian-usdc",
  shares: 50,
  deposited: 100,
  earned: 5,
  entryTime: 1_700_000_000,
};

const onAmountChange = vi.fn();
const onAmountKeyDown = vi.fn();
const onSubmit = vi.fn();

function renderDepositTab(
  overrides: Partial<Parameters<typeof DepositTab>[0]> = {}
) {
  return render(
    <DepositTab
      amount=""
      onAmountChange={onAmountChange}
      onAmountKeyDown={onAmountKeyDown}
      bestVault={VAULT}
      position={undefined}
      hasPosition={false}
      isDepositing={false}
      onSubmit={onSubmit}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DepositTab", () => {
  it("calls onSubmit when the deposit button is clicked", () => {
    renderDepositTab({ amount: "25" });

    fireEvent.click(screen.getByTestId("vault-deposit-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables the submit button when amount is zero", () => {
    renderDepositTab({ amount: "0" });
    expect(screen.getByTestId("vault-deposit-submit")).toHaveProperty(
      "disabled",
      true
    );
  });

  it("disables the submit button when amount is negative", () => {
    renderDepositTab({ amount: "-1" });
    expect(screen.getByTestId("vault-deposit-submit")).toHaveProperty(
      "disabled",
      true
    );
  });

  it("disables the submit button when amount is empty", () => {
    renderDepositTab({ amount: "" });

    const button = screen.getByTestId("vault-deposit-submit");
    expect(button).toHaveProperty("disabled", true);
  });

  it("disables the submit button when isDepositing is true", () => {
    renderDepositTab({ amount: "25", isDepositing: true });

    const button = screen.getByTestId("vault-deposit-submit");
    expect(button).toHaveProperty("disabled", true);
    expect(screen.getByText("vaultPanel.waiting")).toBeDefined();
  });

  it("shows the current balance when hasPosition is true", () => {
    renderDepositTab({ hasPosition: true, position: POSITION });

    expect(screen.getByText(/vaultPanel.balance/)).toBeDefined();
  });

  it("does not show a balance line when hasPosition is false", () => {
    renderDepositTab({ hasPosition: false });

    expect(screen.queryByText(/vaultPanel.balance/)).toBeNull();
  });

  it("calls onAmountChange when the input value changes", () => {
    renderDepositTab();

    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "42" },
    });

    expect(onAmountChange).toHaveBeenCalledWith("42");
  });

  describe("inline validation", () => {
    const error = () => screen.queryByTestId("deposit-amount-error");

    it("shows no message on the untouched, empty form", () => {
      renderDepositTab({ amount: "" });
      expect(error()).toBeNull();
    });

    it("shows a required message once the field is touched and cleared", () => {
      const { rerender } = renderDepositTab({ amount: "5" });
      fireEvent.change(screen.getByPlaceholderText("0.00"), {
        target: { value: "" },
      });
      rerender(
        <DepositTab
          amount=""
          onAmountChange={onAmountChange}
          onAmountKeyDown={onAmountKeyDown}
          bestVault={VAULT}
          position={undefined}
          hasPosition={false}
          isDepositing={false}
          onSubmit={onSubmit}
        />
      );
      expect(error()?.textContent).toBe("vaultPanel.validation.required");
    });

    it("shows a non-positive message for zero and negative amounts", () => {
      const { unmount } = renderDepositTab({ amount: "0" });
      expect(error()?.textContent).toBe("vaultPanel.validation.nonPositive");
      unmount();
      renderDepositTab({ amount: "-3" });
      expect(error()?.textContent).toBe("vaultPanel.validation.nonPositive");
    });

    it("shows an invalid message for a non-numeric amount", () => {
      renderDepositTab({ amount: "abc" });
      expect(error()?.textContent).toBe("vaultPanel.validation.invalid");
      expect(screen.getByTestId("vault-deposit-submit")).toHaveProperty(
        "disabled",
        true
      );
    });

    it("shows a distinct message when the amount exceeds the available balance", () => {
      renderDepositTab({ amount: "150", availableBalance: 100 });
      expect(error()?.textContent).toBe("vaultPanel.validation.exceedsBalance");
      expect(screen.getByTestId("vault-deposit-submit")).toHaveProperty(
        "disabled",
        true
      );
    });

    it("accepts an amount equal to the available balance", () => {
      renderDepositTab({ amount: "100", availableBalance: 100 });
      expect(error()).toBeNull();
      expect(screen.getByTestId("vault-deposit-submit")).toHaveProperty(
        "disabled",
        false
      );
    });

    it("does not check the balance when none is provided", () => {
      renderDepositTab({ amount: "1000000" });
      expect(error()).toBeNull();
    });

    it("links the input to the message for assistive tech", () => {
      renderDepositTab({ amount: "0" });
      const input = screen.getByPlaceholderText("0.00");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toBe(
        "deposit-amount-error"
      );
    });
  });
});
