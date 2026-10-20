// Load test for the metering service.
//
// Usage (service must be running, e.g. `npm run dev` or `docker compose up`):
//   npm run load-test
//
// Settings (environment variables, all optional):
//   BASE_URL      service URL                 (default http://localhost:3000)
//   DATABASE_URL  same DB the service uses    (default postgres://metering:metering@localhost:5433/metering)
//   DURATION      seconds per scenario        (default 15)
//   CONNECTIONS   concurrent connections      (default 50)
//
// Each scenario fires consume requests with unique request_ids, then a correctness
// check reads the database and verifies the totals add up and no limit was exceeded.

import autocannon from "autocannon";
import { randomUUID } from "crypto";
import { Client } from "pg";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://metering:metering@localhost:5433/metering";
const DURATION = Number(process.env.DURATION ?? 15);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);

type Target = { key: string; userId: string };

// ---------- small API helpers ----------

async function call(method: string, path: string, key: string | null, body?: unknown) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json();
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// An account on its own account plan, with `users` users on their own user plan.
async function setupAccount(users: number, accountMonthly: number, accountPerRequest: number, userMonthly: number) {
  const account = await call("POST", "/accounts", null, { name: "load-" + randomUUID().slice(0, 8) });
  const key: string = account.api_key;
  const accountPlan = await call("POST", "/plans", key, {
    name: "LoadAccount", scope: "account", monthly_allowance: accountMonthly, max_units_per_request: accountPerRequest,
  });
  await call("PUT", "/me/plan", key, { plan: "LoadAccount" });
  await call("POST", "/plans", key, {
    name: "LoadUser", scope: "user", monthly_allowance: userMonthly, max_units_per_request: 100,
  });
  const userIds: string[] = [];
  for (let i = 0; i < users; i++) {
    await call("POST", "/users", key, { external_id: "u" + i, plan: "LoadUser" });
    userIds.push("u" + i);
  }
  return { id: account.id as string, key, accountPlanId: accountPlan.id as string, userIds };
}

// ---------- running a scenario ----------

type Result = {
  name: string;
  requests: number;
  rps: number;
  p50: number;
  p97_5: number;
  p99: number;
  accepted: number;
  rejected: number;
  errors: number;
};

async function fire(name: string, targets: Target[], units: number, during?: (elapsedMs: number) => Promise<void>) {
  let accepted = 0;
  let rejected = 0;

 const instance: any = autocannon({
    url: BASE_URL,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [
      {
        method: "POST",
        path: "/consume",
        // Called before every request: pick a random user and a fresh request_id.
        setupRequest: (req: any) => {
          const t = targets[Math.floor(Math.random() * targets.length)];
          return {
            ...req,
            headers: { "content-type": "application/json", "x-api-key": t.key },
            body: JSON.stringify({ user_id: t.userId, units, request_id: randomUUID() }),
          };
        },
        onResponse: (status: number, body: string) => {
          if (status !== 200) return;
          if (body.includes('"status":"accepted"')) accepted++;
          else if (body.includes('"status":"rejected"')) rejected++;
        },
      },
    ],
  } as any);

  if (during) {
    const start = Date.now();
    const timer = setInterval(() => during(Date.now() - start).catch(console.error), 250);
    instance.on("done", () => clearInterval(timer));
  }

  const r: any = await instance;
  const result: Result = {
    name,
    requests: r.requests.total,
    rps: Math.round(r.requests.average),
    p50: r.latency.p50,
    p97_5: r.latency.p97_5,
    p99: r.latency.p99,
    accepted,
    rejected,
    errors: r.errors + r.timeouts + (r.non2xx ?? 0),
  };
  return result;
}

// ---------- correctness check ----------

async function checkAccount(db: Client, accountId: string, label: string) {
  const q = await db.query(
    `SELECT
        (SELECT COALESCE(SUM(units_used), 0) FROM account_usage WHERE account_id = $1)::bigint AS account_used,
        (SELECT COALESCE(SUM(units_used), 0) FROM user_usage    WHERE account_id = $1)::bigint AS users_used,
        (SELECT COALESCE(SUM(units), 0) FROM usage_requests WHERE account_id = $1 AND status = 'accepted')::bigint AS history_accepted,
        (SELECT p.monthly_allowance FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE a.id = $1) AS allowance,
        (SELECT COUNT(*) FROM user_usage uu JOIN users u ON u.id = uu.user_id JOIN plans p ON p.id = u.plan_id
          WHERE uu.account_id = $1 AND uu.units_used > p.monthly_allowance)::int AS users_over_limit`,
    [accountId],
  );
  const r = q.rows[0];
  const a = Number(r.account_used), u = Number(r.users_used), h = Number(r.history_accepted);
  const ok = a === u && u === h && a <= Number(r.allowance) && r.users_over_limit === 0;
  return { label, ok, detail: `account=${a} users=${u} history=${h} allowance=${r.allowance} usersOverLimit=${r.users_over_limit}` };
}

// ---------- main ----------

async function main() {
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  console.log(`Load test against ${BASE_URL} — ${DURATION}s per scenario, ${CONNECTIONS} connections\n`);

  const results: Result[] = [];
  const checks: { label: string; ok: boolean; detail: string }[] = [];

  // 1. Spread load: 20 accounts x 5 users. Requests rarely compete for the same row.
  console.log("Setting up scenario 1 (spread: 20 accounts x 5 users)...");
  const spread = [];
  for (let i = 0; i < 20; i++) spread.push(await setupAccount(5, 1_000_000_000, 100, 1_000_000_000));
  const spreadTargets = spread.flatMap((a) => a.userIds.map((userId) => ({ key: a.key, userId })));
  results.push(await fire("1. Spread: 20 accounts x 5 users", spreadTargets, 1));
  for (const a of spread) checks.push(await checkAccount(db, a.id, "spread account"));

  // 2. Hot account: 1 account, 50 users. Every request locks the same account row.
  //    The account allowance is small enough to run out, so rejections happen under load too.
  console.log("Setting up scenario 2 (hot account: 1 account x 50 users)...");
  const hot = await setupAccount(50, 2_000, 100, 1_000_000_000);
  results.push(await fire("2. Hot: 1 account x 50 users", hot.userIds.map((userId) => ({ key: hot.key, userId })), 1));
  checks.push(await checkAccount(db, hot.id, "hot account"));

  // 3. Plan change under load: halfway through, the account's per-request limit drops from 10 to 1
  //    while every request asks for 5 units. After the change, nothing may be accepted.
  console.log("Setting up scenario 3 (plan change under load)...");
  const change = await setupAccount(20, 1_000_000_000, 10, 1_000_000_000);
  let changedAt: Date | null = null;
  results.push(
    await fire("3. Plan change mid-run", change.userIds.map((userId) => ({ key: change.key, userId })), 5, async (ms) => {
      if (!changedAt && ms >= (DURATION * 1000) / 2) {
        changedAt = new Date(0); // mark as in progress so we only change once
        await call("PATCH", `/plans/${change.accountPlanId}`, change.key, { max_units_per_request: 1 });
        const clock = await db.query("SELECT clock_timestamp() AS t");
        changedAt = clock.rows[0].t;
      }
    }),
  );
  checks.push(await checkAccount(db, change.id, "plan-change account"));
  const after = await db.query(
    `SELECT COUNT(*)::int AS accepted_after,
            (SELECT COUNT(*)::int FROM usage_requests WHERE account_id = $1 AND created_at > $2) AS total_after
       FROM usage_requests
      WHERE account_id = $1 AND created_at > $2 AND status = 'accepted'`,
    [change.id, changedAt],
  );
  checks.push({
    label: "plan change applied",
    ok: after.rows[0].accepted_after === 0 && after.rows[0].total_after > 0,
    detail: `requests started after the change=${after.rows[0].total_after}, accepted after the change=${after.rows[0].accepted_after}`,
  });

  await db.end();

  // ---------- report ----------
  console.log("\n=== Throughput and latency ===");
  console.table(
    results.map((r) => ({
      scenario: r.name,
      "req/s": r.rps,
      "p50 ms": r.p50,
      "p97.5 ms": r.p97_5,
      "p99 ms": r.p99,
      requests: r.requests,
      accepted: r.accepted,
      rejected: r.rejected,
      errors: r.errors,
    })),
  );

  const failed = checks.filter((c) => !c.ok);
  console.log("=== Correctness ===");
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  for (const c of [...new Map(checks.map((c) => [c.label, c])).values()]) {
    const group = checks.filter((x) => x.label === c.label);
    const allOk = group.every((x) => x.ok);
    console.log(`  ${allOk ? "OK  " : "FAIL"} ${c.label}${group.length > 1 ? ` (x${group.length})` : ""}: ${group[0].detail}`);
  }
  for (const c of failed) console.log("  FAILED:", c.label, c.detail);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});