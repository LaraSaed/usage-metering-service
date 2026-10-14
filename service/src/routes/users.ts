import { Router } from "express";
import { pool } from "../db";
import { requireApiKey } from "../auth";

export const usersRouter = Router();

// Find a user plan this account is allowed to use: a predefined one, or one of its own custom plans.
// If both exist with the same name, the account's own plan wins.
async function findUserPlan(accountId: string, planName: string) {
  const result = await pool.query(
    `SELECT id, name, monthly_allowance, max_units_per_request,
            owner_account_id IS NULL AS predefined
       FROM plans
      WHERE scope = 'user'
        AND name = $2
        AND (owner_account_id IS NULL OR owner_account_id = $1)
      ORDER BY owner_account_id NULLS LAST
      LIMIT 1`,
    [accountId, planName],
  );
  return result.rows[0];
}

// Find one user of this account, together with their current plan.
async function findUser(accountId: string, externalId: string) {
  const result = await pool.query(
    `SELECT u.external_id, u.created_at,
            p.id AS plan_id, p.name AS plan_name,
            p.monthly_allowance, p.max_units_per_request
       FROM users u
       JOIN plans p ON p.id = u.plan_id
      WHERE u.account_id = $1 AND u.external_id = $2`,
    [accountId, externalId],
  );
  return result.rows[0];
}

// Shape of a user in every response.
function toUserResponse(row: any) {
  return {
    external_id: row.external_id,
    plan: {
      id: row.plan_id,
      name: row.plan_name,
      monthly_allowance: row.monthly_allowance,
      max_units_per_request: row.max_units_per_request,
    },
    created_at: row.created_at,
  };
}

// POST /users — register a user under the calling account.
usersRouter.post("/users", requireApiKey, async (req, res) => {
  const accountId = req.account!.id;
  const { external_id, plan = "Basic" } = req.body ?? {};

  if (typeof external_id !== "string" || external_id.trim().length < 1 || external_id.trim().length > 200) {
    return res.status(400).json({ error: "invalid_external_id", message: "external_id must be 1-200 characters." });
  }
  if (typeof plan !== "string") {
    return res.status(400).json({ error: "invalid_plan", message: "plan must be the name of a user plan." });
  }

  const chosenPlan = await findUserPlan(accountId, plan);
  if (!chosenPlan) {
    return res.status(400).json({ error: "unknown_plan", message: `No user plan named "${plan}" is available to this account.` });
  }

  try {
    await pool.query(
      "INSERT INTO users (account_id, external_id, plan_id) VALUES ($1, $2, $3)",
      [accountId, external_id.trim(), chosenPlan.id],
    );
  } catch (err: any) {
    // 23505 = unique violation: this account already has a user with this external_id.
    if (err.code === "23505") {
      return res.status(409).json({ error: "user_exists", message: `User "${external_id.trim()}" already exists.` });
    }
    throw err;
  }

  const user = await findUser(accountId, external_id.trim());
  res.status(201).json(toUserResponse(user));
});

// GET /users/:externalId — one user of the calling account, with their current plan.
usersRouter.get("/users/:externalId", requireApiKey, async (req, res) => {
  const externalId = String(req.params.externalId);
  const user = await findUser(req.account!.id, externalId);
  if (!user) {
    return res.status(404).json({ error: "user_not_found", message: `User "${externalId}" not found.` });
  }
  res.json(toUserResponse(user));
});

// PUT /users/:externalId/plan — switch a user to another plan.
// Usage already consumed this month is kept (it lives in user_usage, not on the plan).
usersRouter.put("/users/:externalId/plan", requireApiKey, async (req, res) => {
  const accountId = req.account!.id;
  const externalId = String(req.params.externalId);
  const { plan } = req.body ?? {};

  if (typeof plan !== "string" || plan.length === 0) {
    return res.status(400).json({ error: "invalid_plan", message: "plan must be the name of a user plan." });
  }

  const chosenPlan = await findUserPlan(accountId, plan);
  if (!chosenPlan) {
    return res.status(400).json({ error: "unknown_plan", message: `No user plan named "${plan}" is available to this account.` });
  }

  const result = await pool.query(
    "UPDATE users SET plan_id = $3 WHERE account_id = $1 AND external_id = $2",
    [accountId, externalId, chosenPlan.id],
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: "user_not_found", message: `User "${externalId}" not found.` });
  }

  const user = await findUser(accountId, externalId);
  res.json(toUserResponse(user));
});