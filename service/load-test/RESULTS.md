# Load test results

## How it was tested

- **Tool:** [autocannon](https://github.com/mcollina/autocannon), driven by `load-test/run.ts`.
  Every request gets a fresh `request_id`, so nothing is treated as a retry.
- **Command:** start the stack, then run `npm run load-test` in `service/`.
  Optional settings: `DURATION` (seconds per scenario, default 15), `CONNECTIONS` (default 50), `BASE_URL`, `DATABASE_URL`.
- **Machine:** 12th Gen Intel Core i5-1235U (10 cores, 12 threads), 8 GB RAM, Windows 11 Pro, Docker Desktop 27.5.1.
- **Setup:** the service ran natively (`npm run build && npm start`), and PostgreSQL 16 ran in Docker. The load generator ran on the same computer.

### Scenarios

| # | Scenario | What it shows |
|---|---|---|
| 1 | **Spread**: 20 accounts × 5 users, 1 unit per request | Best case: requests rarely compete for the same counter row |
| 2 | **Hot account**: 1 account × 50 users, account allowance 2,000 | Worst case: every request locks the same account row. The allowance runs out mid-test, so rejections happen under load |
| 3 | **Plan change mid-run**: 1 account × 20 users, 5 units per request; halfway through, the account's per-request limit drops from 10 to 1 | A rule change applies immediately, even under load |

### Correctness checks (after every scenario)

The script reads the database and verifies, for every account:
- account `used` = sum of its users' `used` = sum of accepted units in the request history
- no account or user went over its monthly allowance
- in scenario 3, **zero** requests were accepted after the plan change

## Results

Each version was run once, one after the other, with the same settings.

| Scenario | Version | req/s | p50 ms | p97.5 ms | p99 ms | Errors |
|---|---|---|---|---|---|---|
| 1. Spread | before | 307 | 154 | 233 | 292 | 0 |
| 1. Spread | after | 413 | 110 | 195 | 218 | 0 |
| 2. Hot account | before | 125 | 374 | 549 | 670 | 0 |
| 2. Hot account | after | 149 | 315 | 557 | 636 | 0 |
| 3. Plan change | before | 158 | 293 | 496 | 534 | 0 |
| 3. Plan change | after | 164 | 286 | 475 | 547 | 0 |

**Correctness:** 23/23 checks passed in both the before and after runs.

**Notes on the numbers:**
- Spread improved by about 35% in requests per second.
- The hot account improved by about 19%. Its gain is smaller because every request waits for the same account row.
- The plan change scenario is about the same. The difference is within normal run-to-run variation.
- In the "after" hot run, the account reached its 2,000-unit allowance, so 229 requests were rejected under load. The "before" run did not reach the limit, so the two runs did slightly different amounts of work.

## What I learned

1. **Correctness held under load.** Totals always matched across counters and history, no limit was exceeded, and no request was accepted after a plan change. The row lock (`SELECT … FOR UPDATE` / `INSERT … ON CONFLICT DO UPDATE`) makes requests for the same account take turns, so they can't both see the same "remaining".

2. **The hot account is the natural bottleneck.** All requests for one account must wait for the same row lock, one after another. Its throughput is limited by how long each transaction holds the lock, not by CPU or connections.

3. **A bigger connection pool did not help.** In an earlier test run on a different machine, a pool of 20 was slower than a pool of 10 for the hot account (263 → 218 req/s). More connections only means more requests waiting on the same lock. The pool stays at 10, and it can be changed with `PG_POOL_MAX`.

4. **Fewer database round trips helped.** Consume went from about 15 queries to about 9 by:
   - creating and locking each counter row in one query (`INSERT … ON CONFLICT … DO UPDATE … RETURNING`) instead of two
   - writing both counters and the history row in one statement (a CTE) instead of three
   - calculating the month in code instead of asking the database
   - building the reply from values already in memory instead of reading it back

5. **Measuring needs care.** The first version of the plan-change check compared the test's clock with the database's clock, and the two were slightly different. It reported 11 accepted requests after the change, which was a problem in the test, not the service. The check now uses the database's clock for both values.

## Limitations and next steps

- **Per-account throughput has a hard ceiling** because of the single locked counter row. If one account needed much more, options would be: sharding the account counter into N rows and summing them (checking against the allowance with a small reservation), or keeping counters in Redis with atomic scripts and writing history asynchronously. Both add complexity and new failure modes, so they are out of scope here.
- **The API key lookup and the retry check** are still separate queries before the transaction. An in-memory cache for API keys would remove one query per request, at the cost of extra code and slightly stale account data.
- **Results depend on the machine.** The load generator, service, and database all ran on the same computer, so these numbers show relative change, not production capacity.