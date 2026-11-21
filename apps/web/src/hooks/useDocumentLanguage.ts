import { useEffect } from "react";
import { useTranslation } from "react-i18next";

// The storage key the language toggle in App.tsx writes. Kept identical to
// the existing key so the fallback behaviour is unchanged.
const LANGUAGE_STORAGE_KEY = "language";

/**
 * Keeps document.documentElement.lang in sync with the active i18n
 * language, and the active language in sync across open tabs.
 *
 * The static index.html ships lang="en"; without this effect the document
 * language stays stale after the user switches language, which breaks
 * screen reader pronunciation and spell check. The storage listener picks
 * up changes made in another tab (the storage event only fires in tabs
 * other than the one that wrote the value).
 */
export function useDocumentLanguage() {
  const { i18n } = useTranslation();

  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LANGUAGE_STORAGE_KEY || !event.newValue) return;
      if (event.newValue === i18n.language) return;
      // Ignore junk values: only languages the app actually ships.
      if (!i18n.hasResourceBundle(event.newValue, "translation")) return;
      void i18n.changeLanguage(event.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [i18n]);
}
