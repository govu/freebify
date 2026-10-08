import { defineConfig } from "vitest/config"

// Unit tests live next to the code under src/. Discovery is scoped so the
// gitignored agent/.claude tool dirs (which ship unrelated *.test.mjs
// helpers) never get picked up by the suite. The DOM environment is
// declared per-file via the `// @vitest-environment happy-dom` pragma.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
