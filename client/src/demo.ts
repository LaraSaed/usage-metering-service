// Example client: a company ("account") that uses the metering service
// for two of its users, Alice and Bob.
//
// Run it while the service is running (see the service folder):
//   npm start
//
// Each run creates a new company, so you can run it as many times as you like.

import { randomUUID } from "node:crypto";

const BASE_URL = process.env.METERING_URL ?? "http://localhost:3000";

type Decision = {
  status: "accepted" | "rejected";
  rejected_by: {
    level: "user" | "account";
    rule: "max_units_per_request" | "monthly_allowance";
    limit: number;
  } | null;
  user: { plan: { name: string }; remaining: number };
  account: { plan: { name: string }; remaining: number };
};

// Calls the service. Throws if the service answers with an error status.
async function api(method: string, path: string, apiKey: string | null, body?: unknown): Promise<any> {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

// Sends one consume request for one user of the company.
function consume(apiKey: string, userId: string, units: number): Promise<Decision> {
  return api("POST", "/consume", apiKey, { user_id: userId, units, request_id: randomUUID() });
}

// Creates a company with its own account plan, two user plans and two users.
async function setupCompany(): Promise<string> {
  const account = await api("POST", "/accounts", null, { name: "Demo Company " + randomUUID().slice(0, 6) });
  const key: string = account.api_key;

  // Shared company limit: 30 units per month, at most 20 per request.
  await api("POST", "/plans", key, {
    name: "Demo Company", scope: "account", monthly_allowance: 30, max_units_per_request: 20,
  });
  await api("PUT", "/me/plan", key, { plan: "Demo Company" });

  // Two user plans. They differ only in the per-request limit.
  await api("POST", "/plans", key, {
    name: "Demo Small", scope: "user", monthly_allowance: 100, max_units_per_request: 5,
  });
  await api("POST", "/plans", key, {
    name: "Demo Large", scope: "user", monthly_allowance: 100, max_units_per_request: 20,
  });

  await api("POST", "/users", key, { external_id: "alice", plan: "Demo Large" });
  await api("POST", "/users", key, { external_id: "bob", plan: "Demo Small" });
  return key;
}

// Prints one step: the decision, and what is left.
function show(step: string, userId: string, units: number, d: Decision) {
  let outcome = "ACCEPTED";
  if (d.status === "rejected" && d.rejected_by) {
    const { level, rule, limit } = d.rejected_by;
    outcome = rule === "max_units_per_request"
      ? `REJECTED by the ${level} per-request limit (max ${limit})`
      : `REJECTED by the ${level} monthly allowance (${limit})`;
  }
  console.log(`${step} ${userId.padEnd(6)} uses ${String(units).padStart(2)} units -> ${outcome}`);
  console.log(`      ${userId} left: ${d.user.remaining} (plan: ${d.user.plan.name}) | company left: ${d.account.remaining}\n`);
}

async function main() {
  console.log(`Example client using the service at ${BASE_URL}\n`);
  const key = await setupCompany();
  console.log("Company: 30 units per month shared, max 20 per request.");
  console.log("Alice:   Demo Large (100 per month, max 20 per request).");
  console.log("Bob:     Demo Small (100 per month, max 5 per request).\n");

  const checks: boolean[] = [];

  // 1. Alice's request fits both plans, so it is accepted.
  let d = await consume(key, "alice", 10);
  show("1.", "alice", 10, d);
  checks.push(d.status === "accepted");

  // 2. Bob asks for 8 units, but his plan allows at most 5 per request.
  d = await consume(key, "bob", 8);
  show("2.", "bob", 8, d);
  checks.push(d.status === "rejected" && d.rejected_by?.level === "user" && d.rejected_by.rule === "max_units_per_request");

  // 3. Upgrade Bob's plan. The client code does not change.
  console.log("3.  Upgrading bob to Demo Large...\n");
  await api("PUT", "/users/bob/plan", key, { plan: "Demo Large" });

  // 4. The same request is now accepted.
  d = await consume(key, "bob", 8);
  show("4.", "bob", 8, d);
  checks.push(d.status === "accepted");

  // 5. Alice uses the rest of the company's allowance.
  d = await consume(key, "alice", 12);
  show("5.", "alice", 12, d);
  checks.push(d.status === "accepted");

  // 6. Bob has plenty left on his own plan, but the company's shared allowance is used up.
  d = await consume(key, "bob", 1);
  show("6.", "bob", 1, d);
  checks.push(d.status === "rejected" && d.rejected_by?.level === "account" && d.rejected_by.rule === "monthly_allowance");

  // Summary of this month, from the usage endpoint.
  const usage = await api("GET", "/usage", key);
  console.log("This month:");
  console.log(`  Company: ${usage.account.used} of ${usage.account.monthly_allowance} used`);
  for (const u of usage.users) {
    console.log(`  ${u.user_id}: ${u.used} of ${u.monthly_allowance} used (plan: ${u.plan})`);
  }

  const allOk = checks.every(Boolean);
  console.log(allOk ? "\nAll 6 steps behaved as expected." : "\nSome steps did NOT behave as expected.");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});