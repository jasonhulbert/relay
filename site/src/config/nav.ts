/**
 * Site navigation source of truth, shared by the desktop Header and MobileNav
 * so the two never drift. Child 04 formalizes the broader sitemap; this is the
 * minimal primary nav the chrome needs to render.
 */
export interface NavLink {
  label: string;
  href: string;
  external?: boolean;
}

const base = import.meta.env.BASE_URL;

/** Join the configured `base` (`/relay/`) with a relative path, collapsing any
 * accidental double slash. External/absolute URLs should bypass this. */
export function withBase(path: string): string {
  return `${base}/${path}`.replace(/\/{2,}/g, '/');
}

export const homeHref = withBase('');

export const nav: NavLink[] = [
  { label: 'Docs', href: withBase('docs/what-is-relay') },
  { label: 'GitHub', href: 'https://github.com/jasonhulbert/relay', external: true },
];
