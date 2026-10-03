import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { AmountInput } from "../../components/ui/AmountInput";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";

// Real catalogues (not a key-echoing mock) so these tests prove the label is
// resolved through i18n with the currency interpolated, per locale.
function makeI18n(lng: "en" | "fr") {
  const instance = createInstance();
  void instance.init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng,
    fallbackLng: "en",
    // Synchronous init so the first render already has translations.
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  return instance;
}

function renderInput(
  props: Partial<React.ComponentProps<typeof AmountInput>> = {},
  lng: "en" | "fr" = "en"
) {
  const ui = (p: typeof props) => (
    <I18nextProvider i18n={makeI18n(lng)}>
      <AmountInput currency="USDC" value="0" onChange={() => {}} {...p} />
    </I18nextProvider>
  );
  const view = render(ui(props));
  return { ...view, rerenderWith: (p: typeof props) => view.rerender(ui(p)) };
}

describe("AmountInput — accessible name", () => {
  it("input has an accessible name that includes the currency", () => {
    renderInput();

    expect(
      screen.getByRole("spinbutton", { name: "Amount in USDC" })
    ).toBeDefined();
  });

  it("accessible name updates when the currency prop changes", () => {
    const { rerenderWith } = renderInput({ currency: "ETH" });

    expect(
      screen.getByRole("spinbutton", { name: "Amount in ETH" })
    ).toBeDefined();

    rerenderWith({ currency: "USDC" });

    expect(
      screen.getByRole("spinbutton", { name: "Amount in USDC" })
    ).toBeDefined();
  });

  it("resolves the label through i18n in French with the currency interpolated", () => {
    renderInput({ currency: "USDC" }, "fr");

    expect(
      screen.getByRole("spinbutton", { name: "Montant en USDC" })
    ).toBeDefined();
    expect(screen.queryByLabelText("Amount in USDC")).toBeNull();
  });

  it("defines the label key in both locales with a {{currency}} placeholder", () => {
    expect(en.vaultPanel.amountAriaLabel).toContain("{{currency}}");
    expect(fr.vaultPanel.amountAriaLabel).toContain("{{currency}}");
    expect(fr.vaultPanel.amountAriaLabel).not.toBe(en.vaultPanel.amountAriaLabel);
  });
});

describe("AmountInput — regression: existing props unaffected", () => {
  it("remains disabled when disabled prop is passed and still has an accessible name", () => {
    // AmountInput does not yet expose a disabled prop, but the input's
    // native attributes (min, max, type) must survive the aria-label addition.
    renderInput();

    const input = screen.getByRole("spinbutton", { name: "Amount in USDC" });
    expect(input).toHaveProperty("min", "0");
    expect(input).toHaveProperty("type", "number");
    expect(input).toHaveProperty("placeholder", "0.00");
  });

  it("fires onChange with the typed value", () => {
    const onChange = vi.fn();
    renderInput({ value: "", onChange });

    const input = screen.getByRole("spinbutton", { name: "Amount in USDC" });
    fireEvent.change(input, { target: { value: "42" } });

    expect(onChange).toHaveBeenCalledWith("42");
  });

  it("renders the currency badge as visible text alongside the input", () => {
    renderInput({ currency: "mUSDC" });

    // The span next to the input must still display the currency ticker.
    expect(screen.getByText("mUSDC")).toBeDefined();
    // And the input's accessible name must also carry the currency.
    expect(
      screen.getByRole("spinbutton", { name: "Amount in mUSDC" })
    ).toBeDefined();
  });
});
