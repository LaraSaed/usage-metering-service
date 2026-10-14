import { readFileSync } from "fs";
import { join } from "path";
import { Client } from "pg";

// Runs once before all tests: (re)create the test database and load the schema + predefined plans.
export default async function setup() {
  const testUrl = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://metering:metering@localhost:5433/metering_test",
  );
  const testDbName = testUrl.pathname.slice(1);

  // Connect to the built-in "postgres" database to drop/create the test database.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDbName}"`);
  await admin.end();

  const db = new Client({ connectionString: testUrl.toString() });
  await db.connect();
  await db.query(readFileSync(join(__dirname, "../migrations/001_init.sql"), "utf8"));
  await db.end();
}