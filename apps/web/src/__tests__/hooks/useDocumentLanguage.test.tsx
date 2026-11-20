import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import i18n, { initialiseI18n } from "../../i18n";
import { useDocumentLanguage } from "../../hooks/useDocumentLanguage";

function fireStorageEvent(newValue: string | null, key = "language") {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

describe("useDocumentLanguage", () => {
  beforeAll(async () => {
    localStorage.clear();
    await initialiseI18n();
  });

  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
    document.documentElement.lang = "";
  });

  it("sets the document language to the active language on load", () => {
    renderHook(() => useDocumentLanguage());
    expect(document.documentElement.lang).toBe("en");
  });

  it("uses the stored language on load", async () => {
    localStorage.setItem("language", "fr");
    await i18n.changeLanguage("fr");
    renderHook(() => useDocumentLanguage());
    expect(document.documentElement.lang).toBe("fr");
  });

  it("updates the attribute when the language changes", async () => {
    renderHook(() => useDocumentLanguage());
    expect(document.documentElement.lang).toBe("en");
    await act(() => i18n.changeLanguage("fr"));
    expect(document.documentElement.lang).toBe("fr");
    await act(() => i18n.changeLanguage("en"));
    expect(document.documentElement.lang).toBe("en");
  });

  it("follows a language change from another tab", async () => {
    renderHook(() => useDocumentLanguage());
    await act(async () => fireStorageEvent("fr"));
    expect(i18n.language).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
  });

  it("ignores storage events for other keys", async () => {
    renderHook(() => useDocumentLanguage());
    await act(async () => fireStorageEvent("fr", "theme"));
    expect(i18n.language).toBe("en");
  });

  it("ignores unsupported language values", async () => {
    renderHook(() => useDocumentLanguage());
    await act(async () => fireStorageEvent("klingon"));
    expect(i18n.language).toBe("en");
  });

  it("ignores cleared values", async () => {
    renderHook(() => useDocumentLanguage());
    await act(async () => fireStorageEvent(null));
    expect(i18n.language).toBe("en");
  });
});
