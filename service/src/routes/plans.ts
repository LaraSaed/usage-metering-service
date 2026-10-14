import { Router } from "express";
import { pool } from "../db";
import { requireApiKey } from "../auth";

export const plansRouter = Router();

const SCOPES = ["account", "user"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Columns we return for every plan.
const PLAN_COLUMNS = `id, name, scope, monthly_allowance, max_units_per_request,
                      owner_account_id IS NULL AS predefined, created_at, updated_at`;

// A whole number in the allowed range (rejects 1.5, "10", NaN, Infinity...).
function isWholeNumber(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function isValidName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 100;
}

// Find a plan this account can see: predefined, or its own custom plan.
async function findVisiblePlan(accountId: string, planId: string) {
  if (!UUID_PATTERN.test(planId)) return undefined; // not a valid id → treat as not found
  const result = await pool.query(
    `SELECT ${PLAN_COLUMNS}
       FROM plans
      WHERE id = $2 AND (owner_account_id IS NULL OR owner_account_id = $1)`,
    [accountId, planId],
  );
  return result.rows[0];
}

// GET /plans?scope=user|account — predefined plans + this account's custom plans.
plansRouter.get("/plans", requireApiKey, async (req, res) => {
  const scope = req.query.scope;
  if (scope !== undefined && !SCOPES.includes(String(scope))) {
    return res.status(400).json({ error: "invalid_scope", message: 'scope must be "account" or "user".' });
  }

  const result = await pool.query(
    `SELECT ${PLAN_COLUMNS}
       FROM plans
      WHERE (owner_account_id IS NULL OR owner_account_id = $1)
        AND ($2::text IS NULL OR scope::text = $2)
      ORDER BY scope, predefined DESC, monthly_allowance, name`,
    [req.account!.id, scope === undefined ? null : String(scope)],
  );
  res.json({ plans: result.rows });
});

// GET /plans/:id — one plan, if this account can see it.
plansRouter.get("/plans/:id", requireApiKey, async (req, res) => {
  const plan = await findVisiblePlan(req.account!.id, String(req.params.id));
  if (!plan) {
    return res.status(404).json({ error: "plan_not_found", message: "Plan not found." });
  }
  res.json(plan);
});

// POST /plans — create a custom plan owned by this account.
plansRouter.post("/plans", requireApiKey, async (req, res) => {
  const { name, scope, monthly_allowance, max_units_per_request } = req.body ?? {};

  if (!isValidName(name)) {
    return res.status(400).json({ error: "invalid_name", message: "name must be 1-100 characters." });
  }
  if (!SCOPES.includes(scope)) {
    return res.status(400).json({ error: "invalid_scope", message: 'scope must be "account" or "user".' });
  }
  if (!isWholeNumber(monthly_allowance, 0)) {
    return res.status(400).json({ error: "invalid_monthly_allowance", message: "monthly_allowance must be a whole number >= 0." });
  }
  if (!isWholeNumber(max_units_per_request, 1)) {
    return res.status(400).json({ error: "invalid_max_units_per_request", message: "max_units_per_request must be a whole number >= 1." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO plans (owner_account_id, scope, name, monthly_allowance, max_units_per_request)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PLAN_COLUMNS}`,
      [req.account!.id, scope, name.trim(), monthly_allowance, max_units_per_request],
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "plan_exists", message: `You already have a ${scope} plan named "${name.trim()}".` });
    }
    throw err;
  }
});

// PATCH /plans/:id — change a custom plan. Takes effect immediately for everyone on it.
plansRouter.patch("/plans/:id", requireApiKey, async (req, res) => {
  const accountId = req.account!.id;
  const plan = await findVisiblePlan(accountId, String(req.params.id));
  if (!plan) {
    return res.status(404).json({ error: "plan_not_found", message: "Plan not found." });
  }
  if (plan.predefined) {
    return res.status(403).json({ error: "plan_read_only", message: "Predefined plans cannot be changed." });
  }

  const { name, monthly_allowance, max_units_per_request, scope } = req.body ?? {};
  if (scope !== undefined) {
    return res.status(400).json({ error: "scope_read_only", message: "A plan's scope cannot be changed." });
  }
  if (name === undefined && monthly_allowance === undefined && max_units_per_request === undefined) {
    return res.status(400).json({ error: "nothing_to_update", message: "Send name, monthly_allowance and/or max_units_per_request." });
  }
  if (name !== undefined && !isValidName(name)) {
    return res.status(400).json({ error: "invalid_name", message: "name must be 1-100 characters." });
  }
  if (monthly_allowance !== undefined && !isWholeNumber(monthly_allowance, 0)) {
    return res.status(400).json({ error: "invalid_monthly_allowance", message: "monthly_allowance must be a whole number >= 0." });
  }
  if (max_units_per_request !== undefined && !isWholeNumber(max_units_per_request, 1)) {
    return res.status(400).json({ error: "invalid_max_units_per_request", message: "max_units_per_request must be a whole number >= 1." });
  }

  try {
    // COALESCE keeps the current value for any field that was not sent (NULL).
    const result = await pool.query(
      `UPDATE plans
          SET name                  = COALESCE($3, name),
              monthly_allowance     = COALESCE($4, monthly_allowance),
              max_units_per_request = COALESCE($5, max_units_per_request)
        WHERE id = $2 AND owner_account_id = $1
        RETURNING ${PLAN_COLUMNS}`,
      [accountId, plan.id, name?.trim() ?? null, monthly_allowance ?? null, max_units_per_request ?? null],
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "plan_exists", message: `You already have a ${plan.scope} plan named "${name.trim()}".` });
    }
    throw err;
  }
});