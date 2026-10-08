/**
 * PostCSS configuration for Tailwind CSS v4 (M9, Part 1.1).
 *
 * Next.js picks this up automatically. `@tailwindcss/postcss` is the v4
 * PostCSS plugin; `autoprefixer` is kept explicit for older-browser prefixes.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: {},
  },
};
