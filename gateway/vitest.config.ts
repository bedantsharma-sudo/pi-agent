import { configDefaults, defineConfig } from "vitest/config";

// vitest's default exclude list only covers node_modules/ and .git/ — it does NOT exclude
// build output. Without this, `npm run build` followed by `npm test` silently doubles every
// test suite (compiled dist/*.test.js collected alongside the real src/*.test.ts), exactly
// the same class of bug the whole-branch review caught at the repo root for this package.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
