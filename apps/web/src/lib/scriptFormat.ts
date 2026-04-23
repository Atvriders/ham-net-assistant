/**
 * Helpers for rendering script content that may be either HTML (from .docx
 * imports via mammoth) or plain text / markdown (from older entries).
 */
export function looksLikeHtml(s: string): boolean {
  return /<(p|h[1-6]|div|span|ul|ol|li|strong|em|br|table|td)[\s>]/i.test(s);
}
