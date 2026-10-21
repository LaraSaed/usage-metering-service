# Usage Metering and Quota Service

A backend service that other applications call to track usage and decide whether a user may perform an action.

A calling application (an **account**) has a shared monthly allowance. Each of its **users** has an individual allowance. Before doing a billable action, the application asks this service to **consume units** for a user. The service checks both allowances, records the decision, and counts the units only if the request is accepted.

**Stack:** TypeScript, Express 5, PostgreSQL 16, Docker Compose.

---

## Contents

- [Quick start (Docker)](#quick-start-docker)
- [Running without Docker](#running-without-docker)
- [Project structure](#project-structure)
- [Concepts](#concepts)
- [Authentication](#authentication)
- [API reference](#api-reference)
- [How consumption works](#how-consumption-works)
- [Plan changes](#plan-changes)
- [Retries and duplicate requests](#retries-and-duplicate-requests)
- [Predefined plans](#predefined-plans)
- [Product assumptions](#product-assumptions)
- [Design decisions](#design-decisions)
- [Tests](#tests)
- [Load test](#load-test)
- [Example client](#example-client)
- [Configuration](#configuration)
- [Limitations](#limitations)

---

## Quick start (Docker)

Requirements: Docker Desktop.

```powershell
docker compose up --build
```

This starts three containers:

| Container | What it is | Port on your computer |
|---|---|---|
| `db` | PostgreSQL 16. Creates the tables and the predefined plans on first start. | 5433 |
| `service` | The metering service. Starts after the database is healthy. | 3000 |
| `client` | The example client. Runs the demo once, then exits. | none |

The client's output shows six steps, and ends with `All 6 steps behaved as expected.`

Useful commands:

```powershell
docker compose run --rm client     # run the demo again (the stack keeps running)
docker compose down                # stop everything, keep the data
docker compose down -v             # stop everything and delete the database (fresh start)
```

Check the service is up:

```powershell
curl.exe http://localhost:3000/health
```

It returns `{"status":"ok"}` when the database is reachable.

---

## Running without Docker

Start only the database, then run the service on your machine:

```powershell
docker compose up -d db
cd service
npm install
npm run dev          # service on http://localhost:3000, restarts on code changes
```

Use `npm run build && npm start` to run the compiled version instead.

---

## Project structure

```
usage-metering/
├── docker-compose.yml        # the full stack
├── service/
│   ├── Dockerfile
│   ├── migrations/
│   │   └── 001_init.sql      # tables, triggers, predefined plans
│   ├── src/
│   │   ├── server.ts         # starts the HTTP server
│   │   ├── app.ts            # Express app: routes, 404, error handling
│   │   ├── db.ts             # PostgreSQL connection pool
│   │   ├── auth.ts           # API key creation, hashing, and checking
│   │   └── routes/
│   │       ├── accounts.ts   # accounts and /me
│   │       ├── users.ts      # users and their plans
│   │       ├── plans.ts      # account and user plans
│   │       ├── consume.ts    # POST /consume, the core logic
│   │       └── usage.ts      # usage totals and request history
│   ├── tests/                # 27 automated API tests
│   ├── load-test/            # load test script and RESULTS.md
│   └── requests.http         # ready-made requests for VS Code REST Client
└── client/
    ├── Dockerfile
    └── src/demo.ts           # example client
```

---

## Concepts

| Term | Meaning |
|---|---|
| **Account** | A calling application or company. Has one account plan and one API key. |
| **User** | A user of that application, registered under one account by an `external_id` chosen by the caller. Has one user plan. |
| **Plan** | A named set of two rules: a monthly allowance and a maximum units per request. Can be an account plan or a user plan. |
| **Units** | The amount consumed by one action. Whole numbers, 1 or more. |
| **Predefined plan** | A ready-made plan created by the database setup. Read-only. |
| **Custom plan** | A plan created by an account through the API. Only that account can see and change it. |

An account's usage is the sum of its users' accepted usage. Users who share a plan keep separate totals.

---

## Authentication

1. Create an account with `POST /accounts`. The response contains an `api_key`.
2. **Save the key now.** It is shown only once. The service stores only a SHA-256 hash of it.
3. Send the key in the `x-api-key` header on every request except `POST /accounts` and `GET /health`.

```http
GET /me
x-api-key: mk_...
```

Errors:

- `401 missing_api_key`: no header was sent.
- `401 invalid_api_key`: the key is unknown.

Every operation only sees data that belongs to the account identified by the key. A user that exists under another account is reported as `404 user_not_found`.

---

## API reference

All request and response bodies are JSON. Errors have the form `{ "error": "code", "message": "..." }`.

| Method | Path | Purpose | Success |
|---|---|---|---|
| GET | `/health` | Check the service and database | `200` |
| POST | `/accounts` | Create an account and get its API key | `201` |
| GET | `/me` | Show the calling account and its plan | `200` |
| PUT | `/me/plan` | Switch the account to another account plan | `200` |
| POST | `/users` | Register a user under the account | `201` |
| GET | `/users/:externalId` | Show one user and their plan | `200` |
| PUT | `/users/:externalId/plan` | Switch a user to another user plan | `200` |
| GET | `/plans` | List plans (`?scope=account` or `?scope=user`) | `200` |
| GET | `/plans/:id` | Show one plan | `200` |
| POST | `/plans` | Create a custom plan | `201` |
| PATCH | `/plans/:id` | Change a custom plan | `200` |
| POST | `/consume` | Accept or reject units for a user | `200` |
| GET | `/usage` | Usage for the account and all its users | `200` |
| GET | `/users/:externalId/usage` | Usage for one user | `200` |
| GET | `/requests` | Request history for the account | `200` |
| GET | `/users/:externalId/requests` | Request history for one user | `200` |

`GET /usage`, `GET /users/:externalId/usage`, `GET /requests`, and `GET /users/:externalId/requests` accept `?month=YYYY-MM`. The default is the current UTC month.

The history endpoints also accept `?limit=` (1 to 100, default 20) and `?cursor=`. See [Pagination](#pagination).

### Example: create an account and a user

```http
POST /accounts
Content-Type: application/json

{ "name": "Acme Documents" }
```

```json
{
  "id": "…",
  "name": "Acme Documents",
  "api_key": "mk_…",
  "plan": { "name": "Starter" }
}
```

```http
POST /users
x-api-key: mk_…
Content-Type: application/json

{ "external_id": "alice", "plan": "Premium" }
```

### Example: create a custom plan and assign it

```http
POST /plans
x-api-key: mk_…
Content-Type: application/json

{ "name": "Team Large", "scope": "user", "monthly_allowance": 500, "max_units_per_request": 50 }
```

```http
PUT /users/alice/plan
x-api-key: mk_…
Content-Type: application/json

{ "plan": "Team Large" }
```

`PATCH /plans/:id` accepts any of `name`, `monthly_allowance`, and `max_units_per_request`. It does not accept `scope`.

### Example: consume units

```http
POST /consume
x-api-key: mk_…
Content-Type: application/json

{ "user_id": "alice", "units": 10, "request_id": "doc-2026-10-21-0001" }
```

Accepted response:

```json
{
  "request_id": "doc-2026-10-21-0001",
  "user_id": "alice",
  "status": "accepted",
  "units": 10,
  "period": "2026-10",
  "rejected_by": null,
  "user": { "plan": { "id": "…", "name": "Premium" }, "remaining": 4990 },
  "account": { "plan": { "id": "…", "name": "Starter" }, "remaining": 9990 },
  "created_at": "2026-10-21T09:00:00.000Z",
  "replayed": false
}
```

Rejected response: `status` is `"rejected"`, and `rejected_by` names the rule and the level:

```json
"rejected_by": { "level": "user", "rule": "max_units_per_request", "limit": 20 }
```

- `level` is `"user"` or `"account"`: which plan caused the rejection.
- `rule` is `"max_units_per_request"` or `"monthly_allowance"`.
- `limit` is the value that was exceeded.

### Pagination

`GET /requests` and `GET /users/:externalId/requests` return newest first:

```json
{
  "period": "2026-10",
  "requests": [ … ],
  "next_cursor": "41"
}
```

Send `?cursor=41` to get the next page. When `next_cursor` is `null`, there are no more pages. The cursor is a row id, so new requests arriving between page requests don't cause duplicates or gaps.

### Full list of requests

`requests.http` contains a ready-to-run example for every endpoint. In VS Code, install the **REST Client** extension, open the file, replace the `@key` placeholder with your API key, and click **Send Request** above any line.

---

## How consumption works

When `POST /consume` is called, the service:

1. Checks the input: `user_id` is text, `units` is a whole number of 1 or more, `request_id` is 1 to 200 characters.
2. Checks whether this `request_id` was already decided for this account. If so, it returns the saved answer (see [Retries](#retries-and-duplicate-requests)).
3. Finds the user inside the calling account. If the user doesn't exist, it returns `404`.
4. Starts a transaction and creates this month's counters if they don't exist, locking both the account's and the user's counters. Requests for the same account wait for each other here.
5. Reads both plans, so a plan change made a moment earlier already applies.
6. Checks four rules, in this order. The first one that fails decides the rejection:
   1. the user's per-request limit
   2. the account's per-request limit
   3. the user's monthly allowance
   4. the account's monthly allowance
7. If accepted, adds the units to both counters. In all cases, saves the decision and a snapshot of the plans and remaining units.
8. Commits and returns the decision.

**Example.** The account has 30 units per month and a 20-unit per-request limit. Bob is on a plan with a 5-unit per-request limit and 100 units per month.

| Request | Result | Why |
|---|---|---|
| Bob, 8 units | Rejected | 8 is more than Bob's per-request limit of 5 (`level: user`) |
| Bob, 5 units, after Bob moves to a 20-unit plan | Accepted | Both plans allow it |
| Bob, 1 unit, when the company has 0 units left | Rejected | Bob has room, but the shared allowance is used up (`level: account`) |

A rejection consumes nothing, but it is still saved in the history.

---

## Plan changes

- A plan change applies to the next request. No restart or redeploy is needed.
- Changing a custom plan (`PATCH /plans/:id`) affects every account or user that uses it.
- Switching a user or account to another plan keeps the units already used this month. It does not give a fresh allowance.
- If a monthly allowance is lowered below what has been used, `remaining` shows `0` and further consumption at that level is rejected until the allowance is raised again.
- Past request history is not changed by plan changes. Each history row stores the plan names and remaining units as they were when the request was decided.

---

## Retries and duplicate requests

Each request has a `request_id` that must be unique within an account. Use a new value for each new action.

| Situation | Result |
|---|---|
| Same `request_id`, same `user_id`, same `units` | Returns the saved decision with `"replayed": true`. Nothing is counted again. |
| Same `request_id`, but a different `user_id` or `units` | `409 request_id_reused`. |
| Two identical requests arrive at the same time | Only one is counted. The other receives the saved decision. |

The guarantee comes from two layers. The service first checks for an existing decision. If two requests race past that check, the database's unique constraint on `(account_id, request_id)` makes one of them fail, and that request returns the saved answer. The failed transaction counts nothing.

---

## Predefined plans

Created by `service/migrations/001_init.sql` when the database is first set up.

| Type | Name | Monthly allowance | Max units per request |
|---|---|---|---|
| Account | Starter | 10,000 | 100 |
| Account | Pro | 100,000 | 1,000 |
| User | Basic | 1,000 | 20 |
| User | Premium | 5,000 | 100 |

Predefined plans are read-only (`403 plan_read_only` if you try to change one). Accounts can create their own plans, and they are visible only to that account.

If an account creates a custom plan with the same name as a predefined plan, the account's own plan is used for that account.

Defaults: a new account starts on **Starter**, and a new user starts on **Basic**.

---

## Product assumptions

These decisions were not in the brief. Each one is applied the same way everywhere in the service.

| Topic | Assumption |
|---|---|
| Months | Calendar months in UTC. A new month starts with zero usage at both levels. |
| Rule order | Per-request limits are checked before monthly limits. User limits are checked before account limits. |
| Rejections | Consume nothing, but are recorded in the history with the rule that caused them. |
| Past months | Show only the units used. The plan is not stored per month, so the plan's limits for that month are not shown. |
| Account plan switch | Keeps the units already used this month. |
| Lowering an allowance | Shows `remaining: 0` and rejects further use until the allowance is raised. |
| Units | Whole numbers only, 1 or more. Each number is one unit. |
| `request_id` | 1 to 200 characters. Unique per account. |
| `external_id` | 1 to 200 characters. Unique per account. |
| Account creation | Open: anyone can create an account. |
| Plan names | Unique within each account and scope. Account plans and user plans can share a name. |
| Deletion | Accounts, users, and plans cannot be deleted through the API. |

---

## Design decisions

**PostgreSQL as the source of truth.** Every number that matters (usage, plans, decisions) is in the database. Restarting the service loses nothing.

**Snapshots in the history.** Each decision stores the plan ids and remaining units at the time. Changing a plan later does not rewrite the history.

**Row locks for counters.** Consuming units locks the account's counter row and the user's counter row for the month. Requests for the same account take turns, so two requests can't both see the same remaining units. The lock order is always account first, then user, which prevents deadlocks.

**One transaction per decision.** The counter updates and the history row are written together, or not at all.

**Composite foreign keys for isolation.** A user row references its account, and a plan row references its owner. The database refuses a user that points to another account's plan, so account isolation is enforced even if the application has a bug.

**Idempotency through a unique constraint.** `UNIQUE(account_id, request_id)` guarantees that a request is counted at most once, even if the application check is bypassed.

**Hashed API keys.** Keys are generated with 24 random bytes and stored as SHA-256 hashes. A database leak does not expose usable keys.

**Cursor pagination.** History is paged by the row id, not by offset. New rows don't shift the pages.

**Plain SQL instead of an ORM.** The rules are easier to read, and the database features (enums, triggers, `ON CONFLICT`, CTEs) are visible in the code.

**Fewer round trips per request.** The consume path makes about nine database queries. Counter creation and locking are one statement, and the counter updates and the history row are one statement. This was measured in the load test (see [Load test](#load-test)).

---

## Tests

27 automated API tests, run against a real PostgreSQL database.

```powershell
docker compose up -d db
cd service
npm test
```

The tests use a separate database, `metering_test`, which is recreated at the start of each run. Your development data is not touched.

The tests cover:

| Area | Examples |
|---|---|
| API keys | Missing key and invalid key are rejected. |
| Account isolation | An account cannot see or consume another account's users or usage. |
| Consumption rules | Each of the four rules, and rejection does not count. |
| Retries | Same request twice returns the saved answer. Same id with different data is rejected. |
| Concurrency | 100 simultaneous requests against a limit of 50 give exactly 50 accepted. 20 identical requests are counted once. |
| Plan changes | Switching keeps usage. Editing a custom plan applies to the next request. Past history is unchanged. Predefined plans are read-only. |
| Months and history | A new month starts at zero. Pagination returns newest first with no overlaps or gaps. |

**Mutation testing.** Important code paths were deliberately broken to confirm the tests catch the problem. Removing one retry safeguard still passed, because the database constraint is a second safeguard. Removing both made three tests fail.

---

## Load test

The load test sends many requests at once and then checks the database.

```powershell
docker compose up -d db
cd service
npm run build
npm start                 # keep this running in one terminal
```

In a second terminal, in `service`:

```powershell
npm run load-test
```

Each scenario runs for 15 seconds with 50 connections:

1. **Spread:** 20 accounts with 5 users each.
2. **Hot account:** 1 account with 50 users sharing one limit.
3. **Plan change under load:** the account's per-request limit drops halfway through.

After each scenario, the script checks that the account totals match the users' totals and the request history, that no limit was exceeded, and that no request was accepted after the plan change.

Results on one development machine (12th Gen Intel i5-1235U, 8 GB RAM, Windows 11, Docker Desktop):

| Scenario | Version | req/s | p50 ms | p99 ms | Errors |
|---|---|---|---|---|---|
| 1. Spread | before | 307 | 154 | 292 | 0 |
| 1. Spread | after | 413 | 110 | 218 | 0 |
| 2. Hot account | before | 125 | 374 | 670 | 0 |
| 2. Hot account | after | 149 | 315 | 636 | 0 |
| 3. Plan change | before | 158 | 293 | 534 | 0 |
| 3. Plan change | after | 164 | 286 | 547 | 0 |

Correctness: 23 of 23 checks passed in both runs. Full details and learnings are in `service/load-test/RESULTS.md`.

Results depend on the machine and run to run, so compare before and after on the same computer.

**What was learned:**

- Correctness held under load: totals matched, no limit was exceeded, and no request was accepted after a plan change.
- The hot account is the natural bottleneck, because every request must wait for the same counter row.
- Reducing database round trips gave the improvement. A bigger connection pool made the hot case worse in an earlier run, so the pool stays at 10.

---

## Example client

`client/src/demo.ts` is a command-line application that acts like a real calling application. It creates a company, two users on different plans, and runs six steps:

1. Alice uses 10 units. **Accepted.**
2. Bob asks for 8 units, but his plan allows 5 per request. **Rejected by a user limit.**
3. Bob's plan is upgraded. The client code does not change.
4. The same 8-unit request from Bob. **Accepted.**
5. Alice uses 12 more units. The company's shared allowance is used up.
6. Bob asks for 1 unit. He has room on his own plan, but the company is out of units. **Rejected by the shared account limit.**

It prints each decision with the remaining units, and ends with a summary from `GET /usage`. It exits with code 0 when all six steps behave as expected.

It runs in Docker with `docker compose up --build`, or locally with `npm install` and `npm start` in the `client` folder while the service is running on port 3000.

---

## Configuration

| Variable | Used by | Default |
|---|---|---|
| `DATABASE_URL` | service, load test | `postgres://metering:metering@localhost:5433/metering` |
| `PORT` | service | `3000` |
| `PG_POOL_MAX` | service | `10` |
| `TEST_DATABASE_URL` | tests | `postgres://metering:metering@localhost:5433/metering_test` |
| `METERING_URL` | client | `http://localhost:3000` |
| `BASE_URL` | load test | `http://localhost:3000` |
| `DURATION` | load test (seconds per scenario) | `15` |
| `CONNECTIONS` | load test | `50` |

In Docker Compose, the service and client receive their settings from `docker-compose.yml`, so no `.env` file is needed.

---

## Limitations

- **One row per account per month.** Every request for an account waits for the same counter row. This sets a throughput ceiling per account. Sharding the counter, or moving the counters to an in-memory store, would raise it, but adds complexity.
- **No authentication for account creation.** Anyone who can reach the service can create an account. A real deployment needs an admin key or a sign-up flow.
- **No key rotation or revocation.** A leaked key stays valid until the account is deleted, which is not supported.
- **No rate limiting.**
- **API key lookup on every request.** An in-memory cache would remove one query per request, at the cost of slightly stale data.
- **Predefined plans are created only on a new database.** An existing volume keeps its plans. Use `docker compose down -v` for a fresh start.
- **Accounts, users, and plans cannot be deleted.**
- **The load test creates data.** It adds `load-*` accounts to the development database. Use `docker compose down -v` to clean up.
- **Results are from one machine.** They show relative change, not production capacity.
- **Billing, payments, multiple resource types, end-user login, and distributed infrastructure are out of scope.**