import { Router } from "express";
import { pool } from "../db";
import { generateApiKey, hashApiKey, requireApiKey } from "../auth";

export const accountsRouter = Router();

// POST /accounts — create an account and return its API key (shown only once).
// Open on purpose: no admin login in this project (see README).
accountsRouter.post("/accounts", async (req, res) => {
  const { name, plan = "Starter" } = req.body ?? {};

  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 200) {
    return res.status(400).json({ error: "invalid_name", message: "name must be 1-200 characters." });
  }
  if (typeof plan !== "string") {
    return res.status(400).json({ error: "invalid_plan", message: "plan must be the name of an account plan." });
  }

  // New accounts can only start on a predefined account plan (they have no custom plans yet).
  const planResult = await pool.query(
    `SELECT id, name, monthly_allowance, max_units_per_request
       FROM plans
      WHERE owner_account_id IS NULL AND scope = 'account' AND name = $1`,
    [plan],
  );
  const chosenPlan = planResult.rows[0];
  if (!chosenPlan) {
    return res.status(400).json({ error: "unknown_plan", message: `No predefined account plan named "${plan}".` });
  }

  const apiKey = generateApiKey();
  const accountResult = await pool.query(
    `INSERT INTO accounts (name, api_key_hash, api_key_prefix, plan_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, created_at`,
    [name.trim(), hashApiKey(apiKey), apiKey.slice(0, 10), chosenPlan.id],
  );
  const account = accountResult.rows[0];

  res.status(201).json({
    id: account.id,
    name: account.name,
    plan: chosenPlan,
    api_key: apiKey, // the only time the raw key is ever returned
    created_at: account.created_at,
  });
});

// GET /me — who am I? Returns the calling account and its current plan.
accountsRouter.get("/me", requireApiKey, async (req, res) => {
  const account = req.account!;
  const planResult = await pool.query(
    "SELECT id, name, monthly_allowance, max_units_per_request FROM plans WHERE id = $1",
    [account.plan_id],
  );
  res.json({ id: account.id, name: account.name, plan: planResult.rows[0] });
});

// PUT /me/plan — switch the calling account to another account plan (predefined or its own custom one).
// Usage already consumed this month is kept.
accountsRouter.put("/me/plan", requireApiKey, async (req, res) => {
  const account = req.account!;
  const { plan } = req.body ?? {};
  if (typeof plan !== "string" || plan.length === 0) {
    return res.status(400).json({ error: "invalid_plan", message: "plan must be the name of an account plan." });
  }

  // The account's own plan wins if it has the same name as a predefined one.
  const planResult = await pool.query(
    `SELECT id, name, monthly_allowance, max_units_per_request
       FROM plans
      WHERE scope = 'account' AND name = $2
        AND (owner_account_id IS NULL OR owner_account_id = $1)
      ORDER BY owner_account_id NULLS LAST
      LIMIT 1`,
    [account.id, plan],
  );
  const chosenPlan = planResult.rows[0];
  if (!chosenPlan) {
    return res.status(400).json({ error: "unknown_plan", message: `No account plan named "${plan}" is available to this account.` });
  }

  await pool.query("UPDATE accounts SET plan_id = $2 WHERE id = $1", [account.id, chosenPlan.id]);
  res.json({ id: account.id, name: account.name, plan: chosenPlan });
});