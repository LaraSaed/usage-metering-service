import express from "express";
import type { NextFunction, Request, Response } from "express";
import { pool } from "./db";
import { accountsRouter } from "./routes/accounts";
import { usersRouter } from "./routes/users";
import { plansRouter } from "./routes/plans";
import { consumeRouter } from "./routes/consume";
import { usageRouter } from "./routes/usage";

// Builds the app without starting it, so tests can use it too.
export function buildApp() {
  const app = express();
  app.use(express.json()); // read JSON request bodies

  // Health check: is the service up, and can it reach the database?
  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", database: "up" });
    } catch {
      res.status(503).json({ status: "error", database: "down" });
    }
  });

  app.use(accountsRouter);
  app.use(usersRouter);
  app.use(plansRouter);
  app.use(consumeRouter);
  app.use(usageRouter);
  // Unknown route
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "No such endpoint." });
  });

  // Any unexpected error (bad JSON, database error, bug) ends up here.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid_json", message: "Request body is not valid JSON." });
    }
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Something went wrong." });
  });

  return app;
}