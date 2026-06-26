/**
 * Docs nav system — the single ordering that both the docs route and the
 * `/docs` index redirect derive from, so the sidebar, prev/next pager, and
 * landing target can never disagree. Child 03 owns this; pages added in later
 * phases pick up grouping and pagination automatically by setting frontmatter.
 */
import { getCollection, type CollectionEntry } from 'astro:content';
import { DOC_GROUPS } from '../content.config.ts';
import { withBase } from './nav.ts';

export type DocEntry = CollectionEntry<'docs'>;

/** Drafts are hidden from the published build (`import.meta.env.PROD`) but stay
 *  visible under `astro dev` so in-progress pages can be previewed locally. */
function isVisible(entry: DocEntry): boolean {
  return import.meta.env.PROD ? !entry.data.draft : true;
}

/**
 * All visible docs in canonical flattened order: by nav group (DOC_GROUPS
 * order), then `order` within the group, then title as a stable tiebreak. This
 * one array drives both the sidebar grouping and the prev/next pager.
 */
export async function getOrderedDocs(): Promise<DocEntry[]> {
  const entries = (await getCollection('docs')).filter(isVisible);
  return entries.sort(
    (a, b) =>
      DOC_GROUPS.indexOf(a.data.group) - DOC_GROUPS.indexOf(b.data.group) ||
      a.data.order - b.data.order ||
      a.data.title.localeCompare(b.data.title),
  );
}

export interface SidebarLink {
  title: string;
  href: string;
  current: boolean;
}
export interface SidebarGroup {
  group: (typeof DOC_GROUPS)[number];
  items: SidebarLink[];
}

/**
 * Group an already-ordered doc list into sidebar sections, preserving
 * DOC_GROUPS order and dropping groups that have no pages yet.
 */
export function buildSidebar(ordered: DocEntry[], currentId: string): SidebarGroup[] {
  return DOC_GROUPS.map((group) => ({
    group,
    items: ordered
      .filter((entry) => entry.data.group === group)
      .map((entry) => ({
        title: entry.data.title,
        href: withBase(`docs/${entry.id}`),
        current: entry.id === currentId,
      })),
  })).filter((section) => section.items.length > 0);
}
