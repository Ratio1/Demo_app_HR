import { defineConfig } from "vitest/config";

/**
 * Two projects, run separately by `npm run test:unit` and `npm run test:int`.
 *
 * The integration project talks to the shared dev PostgreSQL as the `hr_test` owner and
 * runtime roles, so its files run one at a time: they create and drop the same tables.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "int",
          environment: "node",
          include: ["tests/int/**/*.test.ts"],
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
