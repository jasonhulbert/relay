// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://jasonhulbert.github.io',
  base: '/relay/',
  integrations: [mdx()],
  vite: {
    plugins: [tailwindcss()],
  },
});
