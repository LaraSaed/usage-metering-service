import { buildApp } from "./app";
import { pool } from "./db";

const port = Number(process.env.PORT ?? 3000);
const app = buildApp();

const server = app.listen(port, () => {
  console.log(`Metering service listening on port ${port}`);
});

// Close cleanly on Ctrl+C or when Docker stops the container.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}