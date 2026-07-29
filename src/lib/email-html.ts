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

function sanitizeEmailBody(html: string, inlineImages: ReadonlyMap<string, string>): string {
  // DOMParser is used only when the user opens the HTML tab in a browser. If
  // this function is ever called during SSR, failing closed to escaped source
  // is safer than attempting to sanitize markup with regular expressions.
  if (typeof DOMParser === "undefined") return `<pre>${escapeHtml(html)}</pre>`;

  const document = new DOMParser().parseFromString(html, "text/html");
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

  return document.body.innerHTML;
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
      @media (max-width: 600px) {
        body { padding: 22px 18px; font-size: 16px; }
        table { width: 100% !important; }
      }
    </style>
  </head>
  <body>${sanitized}</body>
</html>`;
}
