/**
 * Shared markdown sanitizer.
 *
 * Uses DOMPurify to make HTML produced by `marked` safe for
 * `dangerouslySetInnerHTML`.  The default HTML profile blocks scripts, event
 * handlers, javascript:/data: URLs, iframes, objects, embeds, forms, and SVG
 * event handlers.  `style` tags and `style` attributes are also removed.
 * All <a> links are given `target="_blank"` and `rel="noopener noreferrer"`.
 *
 * Import in React components — never in Node.js server code (DOMPurify is
 * browser-only; the test suite exercises it via jsdom).
 */

import DOMPurify from 'dompurify';

// ── One-time hook: force every link to open in a new tab safely ──────────────
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const SANITIZE_CONFIG = {
  // Block <style> entirely (e.g. CSS-injection via @import or expression())
  // Block <form> to prevent data-exfiltration via action= submissions
  FORBID_TAGS: ['style', 'form'],
  // Block inline style attributes (can carry expression(), url(), etc.)
  FORBID_ATTR: ['style'],
};

/**
 * Sanitize HTML output from `marked`.
 *
 * @param {string} html - Raw HTML string produced by marked.parse()
 * @returns {string} Safe HTML suitable for dangerouslySetInnerHTML
 */
export function sanitizeMarkdown(html) {
  if (!html) return '';
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}
