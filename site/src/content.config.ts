import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * `docs` collection — the operator guide. Phase 5 seeds it with a single page
 * (`what-is-relay`) as the reviewable spike; child 03 formalizes the schema
 * (ordering, groups, the full 11-page tree) and authors the rest.
 *
 * Minimal schema for now: enough to drive the page `<title>`, meta description,
 * and a sidebar nav stub. `order` lets the sidebar/pager sort deterministically
 * once more pages land.
 */
const docs = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    order: z.number().default(0),
  }),
});

export const collections = { docs };
