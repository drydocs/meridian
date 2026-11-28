import { useEffect, useState } from "react";

/**
 * Tracks a CSS media query. Used to keep the oversized dashboard watermark
 * out of the DOM entirely on phones instead of merely hiding it with CSS, so
 * low-end Android devices never parse or paint it (#1428).
 */
export function useMediaQuery(query: string): boolean {
  const getMatches = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches;

  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mediaQuery = window.matchMedia(query);
    const update = () => setMatches(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, [query]);

  return matches;
}
