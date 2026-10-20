import { Router } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db";
import { requireApiKey } from "../auth";

export const consumeRouter = Router();

type Level = "account" | "user";
type Rule = "monthly_allowance" | "max_units_per_request";

type Plan = {
  id: string;
  name: string;
  monthly_allowance: number;
  max_units_per_request: number;
};

type Rejection = { level: Level; rule: Rule; limit: number };

// Remaining units can never be shown as negative (e.g. after a plan was lowered below usage).
function remaining(allowance: number, used: number): number {
  return Math.max(allowance - used, 0);
}

// Check the four rules in a fixed order and return the first one that fails, or null if all pass.
// Order: per-request limits before monthly limits; user before account.
export function checkRules(
  units: number,
  userPlan: Plan,
  userUsed: number,
  accountPlan: Plan,
  accountUsed: number,
): Rejection | null {
  if (units > userPlan.max_units_per_request) {
    return { level: "user", rule: "max_units_per_request", limit: userPlan.max_units_per_request };
  }
  if (units > accountPlan.max_units_per_request) {
    return { level: "account", rule: "max_units_per_request", limit: accountPlan.max_units_per_request };
  }
  if (units > remaining(userPlan.monthly_allowance, userUsed)) {
    return { level: "user", rule: "monthly_allowance", limit: userPlan.monthly_allowance };
  }
  if (units > remaining(accountPlan.monthly_allowance, accountUsed)) {
    return { level: "account", rule: "monthly_allowance", limit: accountPlan.monthly_allowance };
  }
  return null;
}

// Build the API response from a saved usage_requests row (used for new answers and for retries).
async function loadSavedDecision(db: PoolClient | typeof pool, accountId: string, requestId: string) {
  const result = await db.query(
    `SELECT r.request_id, r.status, r.units, r.rejected_by_level, r.rejected_by_rule, r.rule_limit,
            to_char(r.period_start, 'YYYY-MM') AS period,
            r.user_remaining, r.account_remaining, r.created_at,
            u.external_id,
            up.id AS user_plan_id, up.name AS user_plan_name,
            ap.id AS account_plan_id, ap.name AS account_plan_name
       FROM usage_requests r
       JOIN users u  ON u.id  = r.user_id
       JOIN plans up ON up.id = r.user_plan_id
       JOIN plans ap ON ap.id = r.account_plan_id
      WHERE r.account_id = $1 AND r.request_id = $2`,
    [accountId, requestId],
  );
  const row = result.rows[0];
  if (!row) return undefined;

  return {
    request_id: row.request_id,
    user_id: row.external_id,
    status: row.status,
    units: row.units,
    period: row.period,
    rejected_by:
      row.status === "rejected"
        ? { level: row.rejected_by_level, rule: row.rejected_by_rule, limit: row.rule_limit }
        : null,
    user: { plan: { id: row.user_plan_id, name: row.user_plan_name }, remaining: row.user_remaining },
    account: { plan: { id: row.account_plan_id, name: row.account_plan_name }, remaining: row.account_remaining },
    created_at: row.created_at,
  };
}

// POST /consume — try to consume units for one user of the calling account.
consumeRouter.post("/consume", requireApiKey, async (req, res) => {
  const accountId = req.account!.id;
  const { user_id, units, request_id } = req.body ?? {};

  // 1. Validate input.
  if (typeof user_id !== "string" || user_id.length === 0) {
    return res.status(400).json({ error: "invalid_user_id", message: "user_id is required." });
  }
  if (typeof units !== "number" || !Number.isSafeInteger(units) || units < 1) {
    return res.status(400).json({ error: "invalid_units", message: "units must be a whole number >= 1." });
  }
  if (typeof request_id !== "string" || request_id.length < 1 || request_id.length > 200) {
    return res.status(400).json({ error: "invalid_request_id", message: "request_id must be 1-200 characters." });
  }

  // 2. Retry? If this request_id was already decided, return the saved answer and count nothing.
  const saved = await loadSavedDecision(pool, accountId, request_id);
  if (saved) {
    if (saved.user_id !== user_id || saved.units !== units) {
      return res.status(409).json({
        error: "request_id_reused",
        message: "This request_id was already used with a different user_id or units.",
      });
    }
    return res.json({ ...saved, replayed: true });
  }

  // 3. Find the user inside this account.
  const userResult = await pool.query(
    "SELECT id FROM users WHERE account_id = $1 AND external_id = $2",
    [accountId, user_id],
  );
  const user = userResult.rows[0];
  if (!user) {
    return res.status(404).json({ error: "user_not_found", message: `User "${user_id}" not found.` });
  }

  // 4. Decide inside one transaction, holding row locks so concurrent requests can't overspend.
  //    Kept to a few round trips: the counter rows stay locked for as short a time as possible.
  const month = new Date().toISOString().slice(0, 7); // current UTC month, e.g. "2026-10"
  const periodStart = `${month}-01`;

  const client = await pool.connect();
  let response;
  try {
    await client.query("BEGIN");

    // 5. Create this month's counter row if needed AND lock it, in one query.
    //    "ON CONFLICT ... DO UPDATE" takes a row lock even when the row already exists.
    //    Always account first, then user (same order everywhere = no deadlocks).
    //    Other requests for this account wait here until we commit.
    const accountUsage = await client.query(
      `INSERT INTO account_usage (account_id, period_start) VALUES ($1, $2)
       ON CONFLICT (account_id, period_start) DO UPDATE SET units_used = account_usage.units_used
       RETURNING units_used`,
      [accountId, periodStart],
    );
    const userUsage = await client.query(
      `INSERT INTO user_usage (user_id, account_id, period_start) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, period_start) DO UPDATE SET units_used = user_usage.units_used
       RETURNING units_used`,
      [user.id, accountId, periodStart],
    );
    const accountUsed: number = accountUsage.rows[0].units_used;
    const userUsed: number = userUsage.rows[0].units_used;

    // 6. Read both plans now, so a plan change made a moment ago already applies.
    const plansResult = await client.query(
      `SELECT ap.id AS a_id, ap.name AS a_name, ap.monthly_allowance AS a_allowance, ap.max_units_per_request AS a_max,
              up.id AS u_id, up.name AS u_name, up.monthly_allowance AS u_allowance, up.max_units_per_request AS u_max
         FROM accounts a
         JOIN users u  ON u.id = $2
         JOIN plans ap ON ap.id = a.plan_id
         JOIN plans up ON up.id = u.plan_id
        WHERE a.id = $1`,
      [accountId, user.id],
    );
    const p = plansResult.rows[0];
    const accountPlan: Plan = { id: p.a_id, name: p.a_name, monthly_allowance: p.a_allowance, max_units_per_request: p.a_max };
    const userPlan: Plan = { id: p.u_id, name: p.u_name, monthly_allowance: p.u_allowance, max_units_per_request: p.u_max };

    // 7. Decide.
    const rejection = checkRules(units, userPlan, userUsed, accountPlan, accountUsed);
    const accepted = rejection === null;
    const added = accepted ? units : 0;
    const accountRemaining = remaining(accountPlan.monthly_allowance, accountUsed + added);
    const userRemaining = remaining(userPlan.monthly_allowance, userUsed + added);

    // 8 + 9. In ONE statement: add the units to both counters (only if accepted)
    //        and record the decision with a snapshot of the plans and remaining units.
    const saved = await client.query(
      `WITH add_account AS (
         UPDATE account_usage SET units_used = units_used + $4
          WHERE $14::boolean AND account_id = $1 AND period_start = $9
       ), add_user AS (
         UPDATE user_usage SET units_used = units_used + $4
          WHERE $14::boolean AND user_id = $2 AND period_start = $9
       )
       INSERT INTO usage_requests
         (account_id, user_id, request_id, units, status,
          rejected_by_level, rejected_by_rule, rule_limit,
          period_start, account_plan_id, user_plan_id, account_remaining, user_remaining)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING created_at`,
      [
        accountId, user.id, request_id, units, accepted ? "accepted" : "rejected",
        rejection?.level ?? null, rejection?.rule ?? null, rejection?.limit ?? null,
        periodStart, accountPlan.id, userPlan.id, accountRemaining, userRemaining,
        accepted,
      ],
    );

    await client.query("COMMIT");

    // 10. Build the reply from what we already know (no extra query).
    response = {
      request_id,
      user_id,
      status: accepted ? "accepted" : "rejected",
      units,
      period: month,
      rejected_by: rejection,
      user: { plan: { id: userPlan.id, name: userPlan.name }, remaining: userRemaining },
      account: { plan: { id: accountPlan.id, name: accountPlan.name }, remaining: accountRemaining },
      created_at: saved.rows[0].created_at,
      replayed: false,
    };
  } catch (err: any) {
    await client.query("ROLLBACK");
    // Two requests with the same request_id arrived at the same time: the other one won.
    // Our transaction was rolled back (nothing counted), so return the winner's saved answer.
    // Reuse this client: asking the pool for a second connection here could deadlock under load.
    if (err.code === "23505" && err.constraint === "usage_requests_idempotency") {
      const winner = await loadSavedDecision(client, accountId, request_id);
      if (winner && (winner.user_id !== user_id || winner.units !== units)) {
        return res.status(409).json({
          error: "request_id_reused",
          message: "This request_id was already used with a different user_id or units.",
        });
      }
      return res.json({ ...winner, replayed: true });
    }
    throw err;
  } finally {
    client.release();
  }

  res.json(response);
});