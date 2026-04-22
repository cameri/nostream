const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escape a string for safe interpolation into HTML text or attribute values.
 */
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch])

/**
 * Serialize a value for safe embedding inside an inline <script> block.
 *
 * JSON.stringify alone is NOT sufficient: it leaves `<` unescaped, so a value
 * containing `</script>` would terminate the script block and allow injection.
 * After serializing, replace every `<` with the Unicode escape `\u003C`, which
 * is valid JSON and prevents the browser from treating the character as markup.
 */
export const safeJsonForScript = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003C')
