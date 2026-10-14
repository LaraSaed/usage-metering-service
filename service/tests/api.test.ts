import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import {
  accountWithLimits, api, consume, createAccount, createPlan, createUser, server, usage, userUsage,
} from "./helpers";

afterAll(async () => {
  server.close();
  await pool.end();
});

describe("API keys", () => {
  it("rejects a request with no API key", async () => {
    const res = await api().get("/me");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_api_key");
  });

  it("rejects a request with a wrong API key", async () => {
    const res = await api().get("/me").set("x-api-key", "mk_not_a_real_key");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_api_key");
  });

  it("identifies the calling account from a valid key", async () => {
    const key = await createAccount("Pro");
    const res = await api().get("/me").set("x-api-key", key);
    expect(res.status).toBe(200);
    expect(res.body.plan.name).toBe("Pro");
  });
});

describe("Account isolation", () => {
  it("one account cannot see, change or consume for another account's user", async () => {
    const a = await createAccount();
    const b = await createAccount();
    await createUser(a, "alice");

    expect((await api().get("/users/alice").set("x-api-key", b)).status).toBe(404);
    expect((await api().put("/users/alice/plan").set("x-api-key", b).send({ plan: "Premium" })).status).toBe(404);
    expect((await consume(b, "alice", 1)).status).toBe(404);
    expect((await api().get("/users/alice/usage").set("x-api-key", b)).status).toBe(404);

    // B can have its own "alice": a different user.
    await createUser(b, "alice");
    await consume(a, "alice", 5);
    expect((await userUsage(b, "alice")).body.used).toBe(0);
    expect((await userUsage(a, "alice")).body.used).toBe(5);
  });

  it("one account cannot see, edit or use another account's custom plan", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const gold = await createPlan(a, "user", 2000, 50, "Gold");

    expect((await api().get(`/plans/${gold.id}`).set("x-api-key", b)).status).toBe(404);
    expect((await api().patch(`/plans/${gold.id}`).set("x-api-key", b).send({ monthly_allowance: 1 })).status).toBe(404);
    const list = await api().get("/plans").set("x-api-key", b);
    expect(list.body.plans.map((p: any) => p.id)).not.toContain(gold.id);
    const res = await api().post("/users").set("x-api-key", b).send({ external_id: "x", plan: "Gold" });
    expect(res.status).toBe(400);
  });

  it("one account's usage and history never include another account's data", async () => {
    const a = await createAccount();
    const b = await createAccount();
    await createUser(a, "alice");
    await consume(a, "alice", 7);

    const bUsage = await usage(b);
    expect(bUsage.body.account.used).toBe(0);
    expect(bUsage.body.users).toEqual([]);
    const bHistory = await api().get("/requests").set("x-api-key", b);
    expect(bHistory.body.requests).toEqual([]);
  });
});

describe("Consuming units (the brief's examples: account 10000/100, user 1000/20)", () => {
  it("accepts 10 units and counts them for both the user and the account", async () => {
    const key = await createAccount("Starter");
    await createUser(key, "alice", "Basic");

    const res = await consume(key, "alice", 10);
    expect(res.body.status).toBe("accepted");
    expect(res.body.user.remaining).toBe(990);
    expect(res.body.account.remaining).toBe(9990);
  });

  it("rejects 25 units by the user's per-request limit", async () => {
    const key = await createAccount("Starter");
    await createUser(key, "alice", "Basic");

    const res = await consume(key, "alice", 25);
    expect(res.body.status).toBe("rejected");
    expect(res.body.rejected_by).toEqual({ level: "user", rule: "max_units_per_request", limit: 20 });
  });

  it("rejects by the user's monthly allowance when the user has run out", async () => {
    const key = await createAccount("Starter");
    const small = await createPlan(key, "user", 15, 20);
    await createUser(key, "alice", small.name);

    expect((await consume(key, "alice", 10)).body.status).toBe("accepted");
    const res = await consume(key, "alice", 10);
    expect(res.body.status).toBe("rejected");
    expect(res.body.rejected_by).toEqual({ level: "user", rule: "monthly_allowance", limit: 15 });
  });

  it("rejects by the shared account limit when only 5 units are left, even if the user has plenty", async () => {
    const { key } = await accountWithLimits(25, 100);
    await createUser(key, "alice", "Premium");
    await createUser(key, "bob", "Premium");
    expect((await consume(key, "bob", 20)).body.status).toBe("accepted"); // 5 left for the account

    const res = await consume(key, "alice", 10);
    expect(res.body.status).toBe("rejected");
    expect(res.body.rejected_by).toEqual({ level: "account", rule: "monthly_allowance", limit: 25 });
    expect(res.body.user.remaining).toBe(5000); // alice personally had plenty
  });

    it("rejects by the account's per-request limit even if the user's plan allows more", async () => {
    const { key } = await accountWithLimits(10000, 30);
    await createUser(key, "alice", "Premium"); // Premium allows 100 per request

    const res = await consume(key, "alice", 50);
    expect(res.body.status).toBe("rejected");
    expect(res.body.rejected_by).toEqual({ level: "account", rule: "max_units_per_request", limit: 30 });
  });

  it("users sharing the same plan keep separate usage totals", async () => {
    const key = await createAccount();
    await createUser(key, "alice", "Basic");
    await createUser(key, "bob", "Basic");
    await consume(key, "alice", 15);
    await consume(key, "bob", 5);

    expect((await userUsage(key, "alice")).body).toMatchObject({ used: 15, remaining: 985 });
    expect((await userUsage(key, "bob")).body).toMatchObject({ used: 5, remaining: 995 });
  });

  it("a rejected request consumes nothing", async () => {
    const key = await createAccount("Starter");
    await createUser(key, "alice", "Basic");
    await consume(key, "alice", 25); // rejected

    const res = await usage(key);
    expect(res.body.account.used).toBe(0);
    expect(res.body.users[0].used).toBe(0);
  });

  it("the account's usage is the sum of its users' accepted usage", async () => {
    const key = await createAccount("Starter");
    await createUser(key, "alice", "Basic");
    await createUser(key, "bob", "Premium");
    await consume(key, "alice", 10);
    await consume(key, "bob", 30);
    await consume(key, "bob", 500); // rejected (Premium max 100 per request)

    const res = await usage(key);
    const total = res.body.users.reduce((sum: number, u: any) => sum + u.used, 0);
    expect(res.body.account.used).toBe(40);
    expect(total).toBe(40);
  });

  it("validates input", async () => {
    const key = await createAccount();
    await createUser(key, "alice");
    expect((await consume(key, "alice", 0)).status).toBe(400);
    expect((await consume(key, "alice", 1.5)).status).toBe(400);
    expect((await consume(key, "nobody", 1)).status).toBe(404);
    const noId = await api().post("/consume").set("x-api-key", key).send({ user_id: "alice", units: 1 });
    expect(noId.status).toBe(400);
  });
});

describe("Safe retries", () => {
  it("returns the same answer for a repeated request_id and counts it only once", async () => {
    const key = await createAccount();
    await createUser(key, "alice");
    const requestId = randomUUID();

    const first = await consume(key, "alice", 10, requestId);
    const second = await consume(key, "alice", 10, requestId);
    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
    expect(second.body.status).toBe(first.body.status);
    expect(second.body.user.remaining).toBe(first.body.user.remaining);
    expect((await userUsage(key, "alice")).body.used).toBe(10);
  });

  it("rejects a reused request_id with different units", async () => {
    const key = await createAccount();
    await createUser(key, "alice");
    const requestId = randomUUID();
    await consume(key, "alice", 10, requestId);

    const res = await consume(key, "alice", 11, requestId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("request_id_reused");
  });
});

describe("Concurrency", () => {
  it("never goes over the account limit when many requests arrive at once", async () => {
    const { key } = await accountWithLimits(50, 10);
    for (let i = 0; i < 5; i++) await createUser(key, "u" + i, "Premium");

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => consume(key, "u" + (i % 5), 1)),
    );
    const accepted = results.filter((r) => r.body.status === "accepted").length;
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(accepted).toBe(50);

    const res = await usage(key);
    expect(res.body.account.used).toBe(50);
    expect(res.body.users.reduce((sum: number, u: any) => sum + u.used, 0)).toBe(50);
  });

  it("counts a request_id sent many times at once exactly once", async () => {
    const key = await createAccount();
    await createUser(key, "alice", "Premium");
    const requestId = randomUUID();

    const results = await Promise.all(Array.from({ length: 20 }, () => consume(key, "alice", 7, requestId)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect((await userUsage(key, "alice")).body.used).toBe(7);
  });
});

describe("Plan changes", () => {
  it("an edited plan applies to the very next request", async () => {
    const key = await createAccount();
    const plan = await createPlan(key, "user", 1000, 5);
    await createUser(key, "alice", plan.name);
    expect((await consume(key, "alice", 8)).body.status).toBe("rejected");

    await api().patch(`/plans/${plan.id}`).set("x-api-key", key).send({ max_units_per_request: 10 });
    expect((await consume(key, "alice", 8)).body.status).toBe("accepted");
  });

  it("lowering an allowance below usage shows 0 remaining and rejects further requests", async () => {
    const key = await createAccount();
    const plan = await createPlan(key, "user", 100, 50);
    await createUser(key, "alice", plan.name);
    await consume(key, "alice", 40);

    await api().patch(`/plans/${plan.id}`).set("x-api-key", key).send({ monthly_allowance: 30 });
    const u = await userUsage(key, "alice");
    expect(u.body).toMatchObject({ used: 40, remaining: 0, over_allowance: true });
    const res = await consume(key, "alice", 1);
    expect(res.body.rejected_by).toEqual({ level: "user", rule: "monthly_allowance", limit: 30 });
  });

  it("switching plans keeps the units already used this month", async () => {
    const key = await createAccount();
    await createUser(key, "alice", "Premium");
    await consume(key, "alice", 50);
    await consume(key, "alice", 50);

    await api().put("/users/alice/plan").set("x-api-key", key).send({ plan: "Basic" });
    const u = await userUsage(key, "alice");
    expect(u.body).toMatchObject({ plan: "Basic", used: 100, remaining: 900 });
  });

    it("editing the account's custom plan applies to the account's next request", async () => {
    const { key, plan } = await accountWithLimits(10000, 5);
    await createUser(key, "alice", "Premium");
    expect((await consume(key, "alice", 8)).body.rejected_by.level).toBe("account");

    await api().patch(`/plans/${plan.id}`).set("x-api-key", key).send({ max_units_per_request: 10 });
    expect((await consume(key, "alice", 8)).body.status).toBe("accepted");
  });

  it("plan changes do not rewrite past request history", async () => {
    const key = await createAccount();
    const plan = await createPlan(key, "user", 1000, 5);
    await createUser(key, "alice", plan.name);
    await consume(key, "alice", 8, "before-change"); // rejected with limit 5

    await api().patch(`/plans/${plan.id}`).set("x-api-key", key).send({ max_units_per_request: 50 });
    await api().put("/users/alice/plan").set("x-api-key", key).send({ plan: "Premium" });

    const history = await api().get("/users/alice/requests").set("x-api-key", key);
    const old = history.body.requests.find((r: any) => r.request_id === "before-change");
    expect(old.status).toBe("rejected");
    expect(old.rejected_by).toEqual({ level: "user", rule: "max_units_per_request", limit: 5 });
  });

  it("predefined plans are read-only", async () => {
    const key = await createAccount();
    const list = await api().get("/plans?scope=user").set("x-api-key", key);
    const basic = list.body.plans.find((p: any) => p.name === "Basic" && p.predefined);
    const res = await api().patch(`/plans/${basic.id}`).set("x-api-key", key).send({ monthly_allowance: 1 });
    expect(res.status).toBe(403);
  });
});

describe("Months and history", () => {
  it("a new month starts at 0 while previous months stay available", async () => {
    const key = await createAccount();
    await createUser(key, "alice");
    const me = await api().get("/me").set("x-api-key", key);

    // Simulate usage in an earlier month directly in the database.
    await pool.query(
      "INSERT INTO account_usage (account_id, period_start, units_used) VALUES ($1, '2000-01-01', 777)",
      [me.body.id],
    );

    const past = await usage(key, "2000-01");
    expect(past.body).toMatchObject({ current: false, account: { used: 777 } });
    const now = await usage(key);
    expect(now.body).toMatchObject({ current: true, account: { used: 0 } });
  });

  it("paginates history newest first without overlaps or gaps", async () => {
    const key = await createAccount();
    await createUser(key, "alice");
    const ids = Array.from({ length: 7 }, (_, i) => "req-" + i);
    for (const id of ids) await consume(key, "alice", 1, id);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: any = await api()
        .get("/requests?limit=3" + (cursor ? `&cursor=${cursor}` : ""))
        .set("x-api-key", key);
      seen.push(...res.body.requests.map((r: any) => r.request_id));
      cursor = res.body.next_cursor;
    } while (cursor);

    expect(seen).toEqual([...ids].reverse());
  });
});