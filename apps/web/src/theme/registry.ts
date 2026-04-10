export interface Theme {
  slug: string;
  name: string;
  shortName: string;
  colors: Record<string, string>;
  font: { display: string; body: string };
  logo: { file: string; alt: string; maxHeightPx: number };
  logoUrl: string;
  attribution?: string;
}

const themeJsons = import.meta.glob('@themes/*/theme.json', { eager: true }) as Record<
  string,
  { default: Omit<Theme, 'logoUrl'> }
>;
const logos = import.meta.glob('@themes/*/logo.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export const themes: Theme[] = Object.entries(themeJsons)
  .map(([jsonPath, mod]) => {
    const dir = jsonPath.replace(/\/theme\.json$/, '');
    const logoUrl = logos[`${dir}/logo.svg`] ?? '';
    return { ...(mod.default as Omit<Theme, 'logoUrl'>), logoUrl };
  })
  .sort((a, b) =>
    a.slug === 'default' ? -1 : b.slug === 'default' ? 1 : a.name.localeCompare(b.name),
  );

export function themeBySlug(slug: string | null | undefined): Theme {
  const found =
    themes.find((t) => t.slug === slug) ??
    themes.find((t) => t.slug === 'default') ??
    themes[0];
  if (!found) {
    throw new Error('No themes registered');
  }
  return found;
}
