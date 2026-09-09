import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/**/tests/**/*.test.ts", "apps/cli/tests/**/*.test.ts"],
  },
})
