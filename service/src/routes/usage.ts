import { Router } from "express";
import type { Response } from "express";
import { pool } from "../db";
import { requireApiKey } from "../auth";

export const usageRouter = Router();

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// The current UTC month as "YYYY-MM".
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// Read ?month=YYYY-MM (default: current month). Sends a 400 and returns null if it is invalid.
function readMonth(value: unknown, res: Response): { month: string; periodStart: string; current: boolean } | null {
  const month = value === undefined ? currentMonth() : String(value);
  if (!MONTH_PATTERN.test(month)) {
    res.status(400).json({ error: "invalid_month", message: "month must look like 2026-10." });
    return null;
  }
  return { month, periodStart: `${month}-01`, current: month === currentMonth() };
}

function remaining(allowance: number, used: number): number {
  return Math.max(allowance - used, 0);
}

// Current month: full picture. Past month: only what was used (the plan back then is not stored per month;
// each request in the history keeps its own snapshot instead).
function usageEntry(row: { used: number; plan_name?: string; monthly_allowance?: number }, current: boolean) {
  if (!current) return { used: row.used };
  return {
    plan: row.plan_name,
    monthly_allowance: row.monthly_allowance,
    used: row.used,
    remaining: remaining(row.monthly_allowance!, row.used),
    over_allowance: row.used > row.monthly_allowance!,
  };
}

// GET /usage?month=YYYY-MM — the calling account and all its users for one month.
usageRouter.get("/usage", requireApiKey, async (req, res) => {
  const period = readMonth(req.query.month, res);
  if (!period) return;
  const accountId = req.account!.id;

  const accountResult = await pool.query(
    `SELECT p.name AS plan_name, p.monthly_allowance, COALESCE(au.units_used, 0)::bigint AS used
       FROM accounts a
       JOIN plans p ON p.id = a.plan_id
       LEFT JOIN account_usage au ON au.account_id = a.id AND au.period_start = $2
      WHERE a.id = $1`,
    [accountId, period.periodStart],
  );

  const usersResult = await pool.query(
    `SELECT u.external_id, p.name AS plan_name, p.monthly_allowance, COALESCE(uu.units_used, 0)::bigint AS used
       FROM users u
       JOIN plans p ON p.id = u.plan_id
       LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.period_start = $2
      WHERE u.account_id = $1
      ORDER BY u.external_id`,
    [accountId, period.periodStart],
  );

  res.json({
    period: period.month,
    current: period.current,
    account: usageEntry(accountResult.rows[0], period.current),
    users: usersResult.rows.map((row) => ({ user_id: row.external_id, ...usageEntry(row, period.current) })),
  });
});

// GET /users/:externalId/usage?month=YYYY-MM — one user of the calling account for one month.
usageRouter.get("/users/:externalId/usage", requireApiKey, async (req, res) => {
  const period = readMonth(req.query.month, res);
  if (!period) return;
  const externalId = String(req.params.externalId);

  const result = await pool.query(
    `SELECT u.external_id, p.name AS plan_name, p.monthly_allowance, COALESCE(uu.units_used, 0)::bigint AS used
       FROM users u
       JOIN plans p ON p.id = u.plan_id
       LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.period_start = $3
      WHERE u.account_id = $1 AND u.external_id = $2`,
    [req.account!.id, externalId, period.periodStart],
  );
  const row = result.rows[0];
  if (!row) {
    return res.status(404).json({ error: "user_not_found", message: `User "${externalId}" not found.` });
  }

  res.json({ period: period.month, current: period.current, user_id: row.external_id, ...usageEntry(row, period.current) });
});

// Shared history query. Newest first, cursor-based pagination on the request's numeric id:
// the next page is "rows older than the last id you saw", which stays stable while new requests arrive.
async function sendHistory(req: any, res: Response, onlyUserId: string | null) {
  const period = readMonth(req.query.month, res);
  if (!period) return;

  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: "invalid_limit", message: "limit must be a whole number from 1 to 100." });
  }
  const cursor = req.query.cursor;
  if (cursor !== undefined && !/^\d+$/.test(String(cursor))) {
    return res.status(400).json({ error: "invalid_cursor", message: "cursor must be the next_cursor value from a previous page." });
  }

  // Fetch one extra row to know whether another page exists.
  const result = await pool.query(
    `SELECT r.id, r.request_id, u.external_id, r.units, r.status,
            r.rejected_by_level, r.rejected_by_rule, r.rule_limit,
            up.name AS user_plan_name, r.user_remaining,
            ap.name AS account_plan_name, r.account_remaining,
            r.created_at
       FROM usage_requests r
       JOIN users u  ON u.id  = r.user_id
       JOIN plans up ON up.id = r.user_plan_id
       JOIN plans ap ON ap.id = r.account_plan_id
      WHERE r.account_id = $1
        AND r.period_start = $2
        AND ($3::bigint IS NULL OR r.id < $3)
        AND ($4::uuid IS NULL OR r.user_id = $4)
      ORDER BY r.id DESC
      LIMIT $5`,
    [req.account.id, period.periodStart, cursor ?? null, onlyUserId, limit + 1],
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

  res.json({
    period: period.month,
    requests: rows.map((r) => ({
      request_id: r.request_id,
      user_id: r.external_id,
      units: r.units,
      status: r.status,
      rejected_by: r.status === "rejected" ? { level: r.rejected_by_level, rule: r.rejected_by_rule, limit: r.rule_limit } : null,
      user: { plan: r.user_plan_name, remaining: r.user_remaining },
      account: { plan: r.account_plan_name, remaining: r.account_remaining },
      created_at: r.created_at,
    })),
    next_cursor: hasMore ? String(rows[rows.length - 1].id) : null,
  });
}

// GET /requests?month=YYYY-MM&limit=20&cursor=... — request history of the calling account.
usageRouter.get("/requests", requireApiKey, async (req, res) => {
  await sendHistory(req, res, null);
});

// GET /users/:externalId/requests?month=YYYY-MM&limit=20&cursor=... — request history of one user.
usageRouter.get("/users/:externalId/requests", requireApiKey, async (req, res) => {
  const externalId = String(req.params.externalId);
  const result = await pool.query(
    "SELECT id FROM users WHERE account_id = $1 AND external_id = $2",
    [req.account!.id, externalId],
  );
  const user = result.rows[0];
  if (!user) {
    return res.status(404).json({ error: "user_not_found", message: `User "${externalId}" not found.` });
  }
  await sendHistory(req, res, user.id);
});