import { createHash } from "node:crypto";

export function createStrongETag(body: string): string {
  const hash = createHash("sha256").update(body).digest("hex");
  return `"${hash}"`;
}

export function ifNoneMatchMatches(
  header: string | string[] | undefined,
  etag: string
): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(",") : header;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;

  const target = etag.startsWith("W/") ? etag.slice(2) : etag;
  let cursor = 0;

  while (cursor < value.length) {
    while (
      cursor < value.length &&
      (value[cursor] === " " || value[cursor] === "\t" || value[cursor] === ",")
    ) {
      cursor++;
    }
    if (cursor >= value.length) break;

    if (value.startsWith("W/", cursor)) cursor += 2;
    if (value[cursor] !== '"') {
      while (cursor < value.length && value[cursor] !== ",") cursor++;
      continue;
    }

    cursor++;
    let opaqueTag = '"';
    let valid = true;
    while (cursor < value.length && value[cursor] !== '"') {
      const code = value.charCodeAt(cursor);
      if (!(code === 0x21 || (code >= 0x23 && code <= 0x7e) || code >= 0x80)) {
        valid = false;
      }
      opaqueTag += value[cursor];
      cursor++;
    }
    if (cursor >= value.length) break;

    opaqueTag += '"';
    cursor++;
    while (
      cursor < value.length &&
      (value[cursor] === " " || value[cursor] === "\t")
    ) {
      cursor++;
    }
    if (cursor < value.length && value[cursor] !== ",") {
      valid = false;
      while (cursor < value.length && value[cursor] !== ",") cursor++;
    }

    if (valid && opaqueTag === target) return true;
    if (value[cursor] === ",") cursor++;
  }

  return false;
}
