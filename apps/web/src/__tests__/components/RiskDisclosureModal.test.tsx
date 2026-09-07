import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RiskDisclosureModal } from "../../components/onboarding/RiskDisclosureModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const onAccept = vi.fn();
const onCancel = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

function renderModal() {
  return render(
    <RiskDisclosureModal onAccept={onAccept} onCancel={onCancel} />
  );
}

describe("RiskDisclosureModal", () => {
  it("renders the general usage copy, not deposit-specific copy", () => {
    renderModal();

    expect(screen.getByText("riskDisclosure.title")).toBeDefined();
    expect(screen.getByText("riskDisclosure.description")).toBeDefined();
    expect(screen.getByText("riskDisclosure.smartContractRisk")).toBeDefined();
    expect(screen.getByText("riskDisclosure.adapterRisk")).toBeDefined();
  });

  it("disables accept until the checkbox is checked", () => {
    renderModal();

    expect(screen.getByTestId("risk-disclosure-accept")).toHaveProperty(
      "disabled",
      true
    );

    fireEvent.click(screen.getByTestId("risk-disclosure-acknowledgement"));

    expect(screen.getByTestId("risk-disclosure-accept")).toHaveProperty(
      "disabled",
      false
    );
  });

  it("does not call onAccept from checking the box alone", () => {
    renderModal();

    fireEvent.click(screen.getByTestId("risk-disclosure-acknowledgement"));

    expect(onAccept).not.toHaveBeenCalled();
  });

  it("calls onAccept when accept is clicked after checking", () => {
    renderModal();

    fireEvent.click(screen.getByTestId("risk-disclosure-acknowledgement"));
    fireEvent.click(screen.getByTestId("risk-disclosure-accept"));

    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the cancel button is clicked, even without checking", () => {
    renderModal();

    fireEvent.click(screen.getByTestId("risk-disclosure-cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });
});
