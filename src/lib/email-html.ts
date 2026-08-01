const EMAIL_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "img-src data: cid:",
  "font-src data:",
  "style-src 'unsafe-inline'",
].join("; ");

const BLOCKED_ELEMENTS = [
  "audio",
  "base",
  "button",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "object",
  "option",
  "portal",
  "script",
  "select",
  "source",
  "svg",
  "textarea",
  "track",
  "video",
].join(",");

const URL_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "longdesc",
  "manifest",
  "ping",
  "poster",
  "src",
  "srcdoc",
  "srcset",
  "usemap",
  "xlink:href",
]);

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SAFE_DATA_IMAGE = /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/]*={0,2}$/i;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeEmailContentId(value: string): string {
  let normalized = value.trim().replace(/^cid:/i, "");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // A malformed escape sequence simply remains unmatched.
  }
  return normalized.replace(/^<|>$/g, "").trim().toLowerCase();
}

function safeLink(value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    [...trimmed].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return null;
  try {
    const parsed = new URL(trimmed);
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function sanitizeStyleSheet(css: string): string {
  return css
    .replace(/@import[\s\S]*?(?:;|$)/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/(?:behavior|-moz-binding)\s*:[^;}]+[;}]?/gi, "")
    .replace(/<\/style/gi, "<\\/style")
    .slice(0, 128_000);
}

function sanitizeEmailBody(
  html: string,
  inlineImages: ReadonlyMap<string, string>,
): { body: string; styles: string } {
  // DOMParser is used only when the user opens the HTML tab in a browser. If
  // this function is ever called during SSR, failing closed to escaped source
  // is safer than attempting to sanitize markup with regular expressions.
  if (typeof DOMParser === "undefined") {
    return { body: `<pre>${escapeHtml(html)}</pre>`, styles: "" };
  }

  const document = new DOMParser().parseFromString(html, "text/html");
  const styles = [...document.querySelectorAll("style")]
    .map((style) => sanitizeStyleSheet(style.textContent || ""))
    .filter(Boolean)
    .join("\n");
  document.querySelectorAll("style").forEach((style) => style.remove());
  document.querySelectorAll(BLOCKED_ELEMENTS).forEach((element) => element.remove());

  document.body.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name === "src" && element.tagName === "IMG" && /^cid:/i.test(attribute.value)) {
        const inlineImage = inlineImages.get(normalizeEmailContentId(attribute.value));
        if (inlineImage) {
          element.setAttribute(attribute.name, inlineImage);
          continue;
        }
      }
      if (name === "src" && element.tagName === "IMG" && SAFE_DATA_IMAGE.test(attribute.value)) {
        continue;
      }
      if (name === "href" && element.tagName === "A") {
        const href = safeLink(attribute.value);
        if (href) {
          element.setAttribute("href", href);
          element.setAttribute("target", "_blank");
          element.setAttribute("rel", "noopener noreferrer nofollow");
          continue;
        }
      }
      if (
        name.startsWith("on") ||
        URL_ATTRIBUTES.has(name) ||
        name === "autofocus" ||
        name === "contenteditable" ||
        name === "download" ||
        name === "target" ||
        (name === "style" &&
          /(?:url\s*\(|@import|expression\s*\(|behavior\s*:|-moz-binding)/i.test(attribute.value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  return { body: document.body.innerHTML, styles };
}

/**
 * Wrap untrusted email HTML in a document whose CSP blocks scripts, forms,
 * remote images, fonts, frames, and network requests. The iframe that renders
 * this document is also sandboxed; both layers are intentional defense in
 * depth because email bodies are attacker-controlled input.
 */
export function createIsolatedEmailDocument(
  html: string,
  inlineImages: ReadonlyMap<string, string> = new Map(),
): string {
  const sanitized = sanitizeEmailBody(html, inlineImages);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${EMAIL_CONTENT_SECURITY_POLICY}">
    <meta name="referrer" content="no-referrer">
    <meta name="color-scheme" content="light">
    <style>
      :root { color-scheme: light; background: #fff; }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; background: #fff; color: #172033; }
      body {
        margin: 0;
        padding: clamp(24px, 5vw, 64px);
        overflow-wrap: anywhere;
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 16px;
        line-height: 1.65;
      }
      body > * { max-width: 100%; }
      table { max-width: 100% !important; }
      td { overflow-wrap: anywhere; }
      img { max-width: 100%; height: auto; }
      pre { max-width: 100%; overflow: auto; white-space: pre-wrap; }
      a { color: #075bd8; text-decoration: underline; text-underline-offset: 2px; }
      a:hover { color: #003d99; }
      ${sanitized.styles}
      @media (max-width: 600px) {
        body { padding: 22px 18px; font-size: 16px; }
        table { width: 100% !important; }
      }
    </style>
  </head>
  <body>${sanitized.body}</body>
</html>`;
}
