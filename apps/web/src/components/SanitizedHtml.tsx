import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';

interface Props {
  html: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Renders HTML content after sanitizing it with DOMPurify. Preserves the
 * `style` attribute so inline font colors/backgrounds from Google Docs /
 * Word imports survive, but still strips <script> and on* event handlers.
 *
 * All input is run through DOMPurify before being set as innerHTML, so there
 * is no unsanitized content path into React's dangerously-set inner HTML.
 */
export function SanitizedHtml({ html, className, style }: Props): React.ReactElement {
  const safe = useMemo(
    () => DOMPurify.sanitize(html ?? '', { ADD_ATTR: ['style'] }),
    [html],
  );
  const innerHtmlProp = { __html: safe };
  return React.createElement('div', {
    className,
    style,
    dangerouslySetInnerHTML: innerHtmlProp,
  });
}
