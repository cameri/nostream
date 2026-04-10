const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escape a string for safe interpolation into HTML text or attribute values.
 * Always use this (or JSON.stringify for JS contexts) on any value before
 * inserting it into an HTML template via string replacement.
 */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch])
