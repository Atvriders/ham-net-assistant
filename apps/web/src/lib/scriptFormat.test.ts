import { describe, it, expect } from 'vitest';
import { looksLikeHtml, scriptToHtml } from './scriptFormat.js';

describe('looksLikeHtml', () => {
  it('detects HTML', () => {
    expect(looksLikeHtml('<p>hello</p>')).toBe(true);
    expect(looksLikeHtml('<strong>x</strong>')).toBe(true);
  });
  it('treats markdown / plain text as not-HTML', () => {
    expect(looksLikeHtml('# Heading')).toBe(false);
    expect(looksLikeHtml('**bold** text')).toBe(false);
    expect(looksLikeHtml('plain line')).toBe(false);
  });
});

describe('scriptToHtml', () => {
  it('returns empty string for empty input', () => {
    expect(scriptToHtml('')).toBe('');
  });

  it('renders markdown headings and emphasis to HTML, not raw syntax', () => {
    const html = scriptToHtml('# Hello\n\n**world**');
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('<strong>world</strong>');
    // The literal markdown characters must be gone from the rendered output.
    expect(html).not.toContain('# Hello');
    expect(html).not.toContain('**world**');
  });

  it('renders markdown lists to <ul><li>', () => {
    const html = scriptToHtml('- one\n- two');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('linkifies bare URLs', () => {
    const html = scriptToHtml('See https://example.com for details');
    expect(html).toContain('<a href="https://example.com"');
  });

  it('turns single newlines into <br> (breaks: true)', () => {
    const html = scriptToHtml('line one\nline two');
    expect(html).toContain('<br>');
  });

  it('escapes literal HTML in markdown (html: false)', () => {
    const html = scriptToHtml('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('returns legacy HTML unchanged (looksLikeHtml branch)', () => {
    const input = '<p>already <b>html</b></p>';
    expect(scriptToHtml(input)).toBe(input);
  });
});
