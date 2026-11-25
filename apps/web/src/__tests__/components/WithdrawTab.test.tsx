import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WithdrawTab } from "../../components/dashboard/WithdrawTab";

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

const onAmountKeyDown = vi.fn();
const onSubmit = vi.fn(async () => true);

function renderWithdrawTab(
  overrides: Partial<Parameters<typeof WithdrawTab>[0]> = {}
) {
  return render(
    <WithdrawTab
      position={POSITION}
      vault={VAULT}
      onAmountKeyDown={onAmountKeyDown}
      isWithdrawing={false}
      isSigning={false}
      onSubmit={onSubmit}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WithdrawTab", () => {
  it("fills this position's available shares when Max is clicked", () => {
    renderWithdrawTab();

    fireEvent.click(screen.getByTestId("vault-withdraw-max-meridian-usdc"));

    expect(screen.getByPlaceholderText("0.00")).toHaveProperty(
      "value",
      "50.0000000"
    );
  });

  it("renders the Max label through the translation key", () => {
    renderWithdrawTab();

    expect(
      screen.getByTestId("vault-withdraw-max-meridian-usdc").textContent
    ).toBe("vaultPanel.max: 50.00");
  });

  it("submits the entered shares for this position", () => {
    renderWithdrawTab();
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "10" },
    });

    fireEvent.click(screen.getByTestId("vault-withdraw-submit-meridian-usdc"));

    expect(onSubmit).toHaveBeenCalledWith("10");
  });

  it.each(["0", "-1", "999"])(
    "disables submit for an invalid amount (%s)",
    (amount) => {
      renderWithdrawTab();
      fireEvent.change(screen.getByPlaceholderText("0.00"), {
        target: { value: amount },
      });

      expect(
        screen.getByTestId("vault-withdraw-submit-meridian-usdc")
      ).toHaveProperty("disabled", true);
    }
  );

  it("disables submit while another withdrawal is in progress", () => {
    renderWithdrawTab({ isWithdrawing: true });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "10" },
    });

    const button = screen.getByTestId("vault-withdraw-submit-meridian-usdc");
    expect(button).toHaveProperty("disabled", true);
    expect(screen.getByText("vaultPanel.waiting")).toBeDefined();
  });

  it("disables withdraw when vault metadata is unavailable", () => {
    renderWithdrawTab({ vault: undefined });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "10" },
    });

    expect(
      screen.getByTestId("vault-withdraw-submit-meridian-usdc")
    ).toHaveProperty("disabled", true);
  });
});
