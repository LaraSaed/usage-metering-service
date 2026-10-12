import express from "express";
import { pool } from "./db";

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

  return app;
}