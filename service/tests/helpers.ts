import { randomUUID } from "crypto";
import type { Server } from "http";
import request from "supertest";
import { buildApp } from "../src/app";

// One real HTTP server for the whole test file (needed for true concurrent requests).
export const server: Server = buildApp().listen(0);
export const api = () => request(server);

// Create an account and return its API key.
export async function createAccount(plan = "Starter"): Promise<string> {
  const res = await api().post("/accounts").send({ name: "Test " + randomUUID().slice(0, 8), plan });
  if (res.status !== 201) throw new Error("createAccount failed: " + JSON.stringify(res.body));
  return res.body.api_key;
}

export async function createUser(key: string, externalId: string, plan = "Basic") {
  const res = await api().post("/users").set("x-api-key", key).send({ external_id: externalId, plan });
  if (res.status !== 201) throw new Error("createUser failed: " + JSON.stringify(res.body));
  return res.body;
}

export async function createPlan(
  key: string,
  scope: "account" | "user",
  monthly_allowance: number,
  max_units_per_request: number,
  name = "Plan " + randomUUID().slice(0, 8),
) {
  const res = await api().post("/plans").set("x-api-key", key)
    .send({ name, scope, monthly_allowance, max_units_per_request });
  if (res.status !== 201) throw new Error("createPlan failed: " + JSON.stringify(res.body));
  return res.body;
}

// An account with its own account plan, so tests control the account limits exactly.
export async function accountWithLimits(monthly: number, perRequest: number) {
  const key = await createAccount();
  const plan = await createPlan(key, "account", monthly, perRequest);
  await api().put("/me/plan").set("x-api-key", key).send({ plan: plan.name });
  return { key, plan };
}

export function consume(key: string, userId: string, units: number, requestId: string = randomUUID()) {
  return api().post("/consume").set("x-api-key", key).send({ user_id: userId, units, request_id: requestId });
}

export function usage(key: string, month?: string) {
  return api().get("/usage" + (month ? `?month=${month}` : "")).set("x-api-key", key);
}

export function userUsage(key: string, userId: string) {
  return api().get(`/users/${userId}/usage`).set("x-api-key", key);
}