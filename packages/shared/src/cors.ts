export function parseAllowedOrigins(
  value: string | undefined,
  defaultOrigin: string
): string[] {
  const origins = (value ?? defaultOrigin)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.some((origin) => origin.includes("*"))) {
    throw new Error("ALLOWED_ORIGIN must not contain wildcard origins");
  }

  return [...new Set(origins)];
}
