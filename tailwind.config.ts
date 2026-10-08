import type { Config } from 'tailwindcss';

/**
 * Tailwind CSS v4 configuration (M9, Part 1.1).
 *
 * v4 is CSS-first: `src/app/globals.css` imports Tailwind and loads this file
 * with `@config`. The content globs cover the App Router pages and the React
 * components; the theme uses Tailwind defaults (light mode only for the MVP).
 */
const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/lib/frontend/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
