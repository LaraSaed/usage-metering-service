import { defineConfig } from "vitest/config";

// Tests use their own database so they never touch your dev data.
// Default matches docker-compose.yml; override with TEST_DATABASE_URL if needed.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://metering:metering@localhost:5433/metering_test";

export default defineConfig({
  test: {
    globalSetup: "./tests/global-setup.ts",
    env: { DATABASE_URL: TEST_DATABASE_URL }, // db.ts reads this, so the app connects to the test DB
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});