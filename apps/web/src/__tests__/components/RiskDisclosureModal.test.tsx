import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("RiskDisclosureModal focus management", () => {
  function renderWithTrigger() {
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.appendChild(trigger);
    trigger.focus();
    const view = renderModal();
    return { trigger, ...view };
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("moves focus into the dialog when it opens", () => {
    renderWithTrigger();

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    // First focusable element is the close button.
    expect(document.activeElement).toBe(
      screen.getByTestId("risk-disclosure-cancel")
    );
  });

  it("closes on Escape", () => {
    renderWithTrigger();

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("wraps Tab from the last focusable element to the first", () => {
    renderWithTrigger();
    fireEvent.click(screen.getByTestId("risk-disclosure-acknowledgement"));
    const accept = screen.getByTestId("risk-disclosure-accept");
    accept.focus();

    fireEvent.keyDown(accept, { key: "Tab" });

    expect(document.activeElement).toBe(
      screen.getByTestId("risk-disclosure-cancel")
    );
  });

  it("wraps Shift+Tab from the first focusable element to the last", () => {
    renderWithTrigger();
    fireEvent.click(screen.getByTestId("risk-disclosure-acknowledgement"));
    const cancel = screen.getByTestId("risk-disclosure-cancel");
    cancel.focus();

    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(
      screen.getByTestId("risk-disclosure-accept")
    );
  });

  it("leaves Tab alone between elements in the middle of the dialog", () => {
    renderWithTrigger();
    const checkbox = screen.getByTestId("risk-disclosure-acknowledgement");
    // Enable accept so the checkbox is a middle stop, not the last one.
    fireEvent.click(checkbox);
    checkbox.focus();

    const notPrevented = fireEvent.keyDown(checkbox, { key: "Tab" });

    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(checkbox);
  });

  it("skips the disabled accept button when it is the trap boundary", () => {
    renderWithTrigger();
    const checkbox = screen.getByTestId("risk-disclosure-acknowledgement");
    checkbox.focus();

    // Accept is disabled (not acknowledged), so the checkbox is the last stop.
    fireEvent.keyDown(checkbox, { key: "Tab" });

    expect(document.activeElement).toBe(
      screen.getByTestId("risk-disclosure-cancel")
    );
  });

  it("restores focus to the trigger when the dialog closes", () => {
    const { trigger, unmount } = renderWithTrigger();
    expect(document.activeElement).not.toBe(trigger);

    unmount();

    expect(document.activeElement).toBe(trigger);
  });
});
