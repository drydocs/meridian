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

const onAmountChange = vi.fn();
const onAmountKeyDown = vi.fn();
const onSubmit = vi.fn();

function renderDepositTab(
  props: Partial<Parameters<typeof DepositTab>[0]> = {}
) {
  return render(
    <DepositTab
      amount=""
      onAmountChange={onAmountChange}
      onAmountKeyDown={onAmountKeyDown}
      bestVault={VAULT}
      isDepositing={false}
      onSubmit={onSubmit}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DepositTab", () => {
  it("renders the amount label", () => {
    renderDepositTab();

    expect(screen.getByText("vaultPanel.amount")).toBeDefined();
  });

  it("renders the deposit submit button", () => {
    renderDepositTab();

    expect(screen.getByTestId("vault-deposit-submit")).toBeDefined();
    expect(screen.getByText("vaultPanel.deposit")).toBeDefined();
  });

  it("calls onSubmit when the deposit button is clicked", () => {
    renderDepositTab({ amount: "25" });

    fireEvent.click(screen.getByTestId("vault-deposit-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not call onSubmit when amount is empty", () => {
    renderDepositTab({ amount: "" });

    fireEvent.click(screen.getByTestId("vault-deposit-submit"));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables the submit button when amount is empty", () => {
    renderDepositTab({ amount: "" });

    const button = screen.getByTestId("vault-deposit-submit");
    expect(button).toHaveProperty("disabled", true);
  });

  it("disables the submit button when bestVault is undefined", () => {
    renderDepositTab({ amount: "25", bestVault: undefined });

    const button = screen.getByTestId("vault-deposit-submit");
    expect(button).toHaveProperty("disabled", true);
  });

  it("disables the submit button when isDepositing is true", () => {
    renderDepositTab({ amount: "25", isDepositing: true });

    const button = screen.getByTestId("vault-deposit-submit");
    expect(button).toHaveProperty("disabled", true);
    expect(screen.getByText("vaultPanel.waiting")).toBeDefined();
  });

  it("shows the wallet spendable balance when availableBalance is provided", () => {
    renderDepositTab({ availableBalance: 100 });

    expect(screen.getByText(/vaultPanel\.balance:/)).toBeDefined();
  });

  it("does not show a balance line when availableBalance is undefined", () => {
    renderDepositTab({ availableBalance: undefined });

    expect(screen.queryByText(/vaultPanel\.balance:/)).toBeNull();
  });

  it("calls onAmountChange with spendable balance when Max button is clicked", () => {
    renderDepositTab({ availableBalance: 100 });

    fireEvent.click(screen.getByTestId("vault-deposit-max"));

    expect(onAmountChange).toHaveBeenCalledWith("100");
  });

  it("calls onAmountChange with 0 when Max button is clicked with zero balance", () => {
    renderDepositTab({ availableBalance: 0 });

    fireEvent.click(screen.getByTestId("vault-deposit-max"));

    expect(onAmountChange).toHaveBeenCalledWith("0");
  });

  it("shows a retryable error message rather than a zero balance when balance read fails", () => {
    const onRetryBalance = vi.fn();
    renderDepositTab({
      availableBalance: 0,
      isBalanceError: true,
      onRetryBalance,
    });

    expect(screen.getByTestId("vault-balance-error")).toBeDefined();
    expect(screen.getByText("vaultPanel.balanceError")).toBeDefined();
    expect(screen.getByText("common.retry")).toBeDefined();
    expect(screen.queryByText(/vaultPanel\.balance:/)).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByTestId("vault-deposit-max")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "vaultPanel.retryBalance" })
    );
    expect(onRetryBalance).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
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
          isDepositing={false}
          onSubmit={onSubmit}
        />
      );
      expect(error()?.textContent).toBe("vaultPanel.validation.required");
      expect(
        (screen.getByTestId("vault-deposit-submit") as HTMLButtonElement)
          .disabled
      ).toBe(true);
    });

    it("shows an invalid message for non-numeric input", () => {
      renderDepositTab({ amount: "abc" });
      expect(error()?.textContent).toBe("vaultPanel.validation.invalid");
      expect(
        (screen.getByTestId("vault-deposit-submit") as HTMLButtonElement)
          .disabled
      ).toBe(true);
    });

    it("shows a non-positive message for zero or negative numbers", () => {
      const { rerender } = renderDepositTab({ amount: "0" });
      expect(error()?.textContent).toBe("vaultPanel.validation.nonPositive");
      expect(
        (screen.getByTestId("vault-deposit-submit") as HTMLButtonElement)
          .disabled
      ).toBe(true);

      rerender(
        <DepositTab
          amount="-5"
          onAmountChange={onAmountChange}
          onAmountKeyDown={onAmountKeyDown}
          bestVault={VAULT}
          isDepositing={false}
          onSubmit={onSubmit}
        />
      );
      expect(error()?.textContent).toBe("vaultPanel.validation.nonPositive");
      expect(
        (screen.getByTestId("vault-deposit-submit") as HTMLButtonElement)
          .disabled
      ).toBe(true);
    });

    it("clears the error message once the user provides a valid positive amount", () => {
      const { rerender } = renderDepositTab({ amount: "0" });
      expect(error()?.textContent).toBe("vaultPanel.validation.nonPositive");

      rerender(
        <DepositTab
          amount="10"
          onAmountChange={onAmountChange}
          onAmountKeyDown={onAmountKeyDown}
          bestVault={VAULT}
          isDepositing={false}
          onSubmit={onSubmit}
        />
      );
      expect(error()).toBeNull();
      expect(
        (screen.getByTestId("vault-deposit-submit") as HTMLButtonElement)
          .disabled
      ).toBe(false);
    });

    it("shows an exceedsBalance error when the amount is greater than the available balance", () => {
      renderDepositTab({ amount: "100", availableBalance: 50 });
      expect(error()?.textContent).toBe("vaultPanel.validation.exceedsBalance");
      expect(
        (screen.getByTestId("vault-deposit-submit") as HTMLButtonElement)
          .disabled
      ).toBe(true);
    });

    it("allows the deposit when amount equals the available balance", () => {
      renderDepositTab({ amount: "50", availableBalance: 50 });
      expect(error()).toBeNull();
      expect(
        (screen.getByTestId("vault-deposit-submit") as HTMLButtonElement)
          .disabled
      ).toBe(false);
    });

    it("does not check against balance when availableBalance is undefined", () => {
      renderDepositTab({ amount: "5000", availableBalance: undefined });
      expect(error()).toBeNull();
      expect(
        (screen.getByTestId("vault-deposit-submit") as HTMLButtonElement)
          .disabled
      ).toBe(false);
    });
  });
});
