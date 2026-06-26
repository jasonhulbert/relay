import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Canonical docs nav groups, in sidebar display order. The `docs` schema
 * constrains `group` to this set, and the docs route (`pages/docs/[...slug].astro`
 * via `config/docs.ts`) iterates it to build the grouped sidebar and the
 * flattened prev/next order. Single source of truth for which groups exist and
 * in what order they render.
 */
export const DOC_GROUPS = [
  'Getting Started',
  'Concepts',
  'Reference',
  'Advanced',
  'Glossary',
] as const;

/**
 * `docs` collection — the operator guide. Child 01 seeded it with one page
 * (`what-is-relay`) as the reviewable spike; this is child 03's formal schema.
 *
 * Frontmatter drives nav: `group` places the page in a sidebar section, `order`
 * sorts within that section (and feeds prev/next), and `draft` hides a page from
 * the published build while leaving it visible in `astro dev`.
 */
const docs = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    group: z.enum(DOC_GROUPS),
    order: z.number().default(0),
    draft: z.boolean().default(false),
  }),
});

export const collections = { docs };
