import { Pool, types } from "pg";

// Return bigint columns (type id 20) as JS numbers instead of strings.
// Safe here: unit counts stay far below Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, (value) => parseInt(value, 10));

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://metering:metering@localhost:5433/metering",
  // Max open connections. Configurable so it can be tuned with the load test.
  max: Number(process.env.PG_POOL_MAX ?? 10),
});
