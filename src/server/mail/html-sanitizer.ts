import "server-only";

const allowedElements = new Set([
  "address",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "ins",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "var",
]);

const voidElements = new Set(["br", "hr"]);
const rawTextElements = new Set(["script", "style", "template", "title"]);

/**
 * Converts provider HTML into a deliberately small, attribute-free subset.
 * Links, images, CSS, forms, metadata and active embeds are removed; their
 * readable text remains. The result is still rendered in a sandboxed frame.
 */
export function sanitizeMailHtml(
  input: string,
  { allowExternalImages = false }: { allowExternalImages?: boolean } = {},
): string {
  let result = "";
  let index = 0;
  let skippedRawTextElement: string | null = null;

  while (index < input.length) {
    if (skippedRawTextElement) {
      const closing = findRawTextClosing(input, index, skippedRawTextElement);
      if (closing < 0) break;
      index = closing;
      skippedRawTextElement = null;
      continue;
    }

    const tagStart = input.indexOf("<", index);
    if (tagStart < 0) {
      result += input.slice(index);
      break;
    }
    result += input.slice(index, tagStart);
    const tagEnd = findTagEnd(input, tagStart + 1);
    if (tagEnd < 0) {
      result += "&lt;" + escapeHtmlText(input.slice(tagStart + 1));
      break;
    }

    const token = input.slice(tagStart + 1, tagEnd);
    const parsed = parseTag(token);
    index = tagEnd + 1;
    if (!parsed) continue;
    if (!parsed.closing && rawTextElements.has(parsed.name)) {
      skippedRawTextElement = parsed.name;
      continue;
    }
    if (!parsed.closing && parsed.name === "img") {
      const image = safeImageAttributes(token, allowExternalImages);
      if (image) {
        result += `<img src="${escapeHtmlAttribute(image.src)}" alt="${escapeHtmlAttribute(image.alt)}" loading="lazy" referrerpolicy="no-referrer">`;
      }
      continue;
    }
    if (!allowedElements.has(parsed.name)) continue;
    if (parsed.closing) {
      if (!voidElements.has(parsed.name)) result += `</${parsed.name}>`;
    } else {
      result += `<${parsed.name}>`;
    }
  }

  return result;
}

function findTagEnd(input: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseTag(token: string): { name: string; closing: boolean } | null {
  const match = token.match(/^\s*(\/)?\s*([a-z][a-z0-9-]*)\b/iu);
  if (!match) return null;
  return { name: match[2].toLowerCase(), closing: Boolean(match[1]) };
}

function findRawTextClosing(input: string, start: number, name: string): number {
  const lower = input.toLowerCase();
  let candidate = lower.indexOf(`</${name}`, start);
  while (candidate >= 0) {
    const end = findTagEnd(input, candidate + 2 + name.length);
    if (end >= 0) return end + 1;
    candidate = lower.indexOf(`</${name}`, candidate + 2);
  }
  return -1;
}

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function safeImageAttributes(
  token: string,
  allowExternalImages: boolean,
): { src: string; alt: string } | null {
  const attributes = parseAttributes(token);
  const rawSource = attributes.get("src");
  if (!rawSource) return null;
  const decodedSource = decodeHtmlAttribute(rawSource).trim();
  let src: string;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/iu.test(decodedSource)) {
    src = decodedSource;
  } else {
    if (!allowExternalImages) return null;
    try {
      const url = new URL(decodedSource);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.href.length > 2_048
      ) {
        return null;
      }
      src = url.href;
    } catch {
      return null;
    }
  }
  const alt = decodeHtmlAttribute(attributes.get("alt") ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 500);
  return { src, alt };
}

function parseAttributes(token: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const tag = token.match(/^\s*\/?\s*[a-z][a-z0-9-]*/iu)?.[0] ?? "";
  let index = tag.length;
  while (index < token.length) {
    while (/\s/u.test(token[index] ?? "")) index += 1;
    if (token[index] === "/") {
      index += 1;
      continue;
    }
    const nameMatch = token.slice(index).match(/^[a-z_:][a-z0-9_.:-]*/iu);
    if (!nameMatch) {
      index += 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    while (/\s/u.test(token[index] ?? "")) index += 1;
    let value = "";
    if (token[index] === "=") {
      index += 1;
      while (/\s/u.test(token[index] ?? "")) index += 1;
      const quote = token[index] === '"' || token[index] === "'" ? token[index++] : null;
      const start = index;
      if (quote) {
        while (index < token.length && token[index] !== quote) index += 1;
        value = token.slice(start, index);
        if (token[index] === quote) index += 1;
      } else {
        while (index < token.length && !/[\s>]/u.test(token[index])) index += 1;
        value = token.slice(start, index);
      }
    }
    if (attributes.has(name)) attributes.set(name, "");
    else attributes.set(name, value);
  }
  return attributes;
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|#\d{1,7}|#x[0-9a-f]{1,6});/giu,
    (entity) => {
      const normalized = entity.toLowerCase();
      const named: Record<string, string> = {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
      };
      if (named[normalized]) return named[normalized];
      const numeric = normalized.startsWith("&#x")
        ? Number.parseInt(normalized.slice(3, -1), 16)
        : Number.parseInt(normalized.slice(2, -1), 10);
      return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : "";
    },
  );
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
