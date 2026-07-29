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

function sanitizeEmailBody(html: string): string {
  // DOMParser is used only when the user opens the HTML tab in a browser. If
  // this function is ever called during SSR, failing closed to escaped source
  // is safer than attempting to sanitize markup with regular expressions.
  if (typeof DOMParser === "undefined") return `<pre>${escapeHtml(html)}</pre>`;

  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll(BLOCKED_ELEMENTS).forEach((element) => element.remove());

  document.body.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
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
export function createIsolatedEmailDocument(html: string): string {
  const sanitized = sanitizeEmailBody(html);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${EMAIL_CONTENT_SECURITY_POLICY}">
    <meta name="referrer" content="no-referrer">
    <meta name="color-scheme" content="light dark">
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; overflow-wrap: anywhere; }
      img { max-width: 100%; height: auto; }
      pre { white-space: pre-wrap; }
    </style>
  </head>
  <body>${sanitized}</body>
</html>`;
}
