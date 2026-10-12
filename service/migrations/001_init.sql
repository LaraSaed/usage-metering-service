-- 001_init.sql
-- Usage Metering and Quota Service: initial schema + predefined plans.
-- Target: PostgreSQL 16 (uses gen_random_uuid() and UNIQUE NULLS NOT DISTINCT).

BEGIN;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Who a plan (or a rejection) applies to.
CREATE TYPE plan_scope AS ENUM ('account', 'user');

CREATE TYPE request_status AS ENUM ('accepted', 'rejected');

-- The rule that rejected a request. Add values here when you add new rule types.
CREATE TYPE rule_type AS ENUM ('monthly_allowance', 'max_units_per_request');


-- ---------------------------------------------------------------------------
-- Plans
-- owner_account_id IS NULL  -> predefined plan (global, read-only via the API)
-- owner_account_id NOT NULL -> custom plan, visible/usable only by that account
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id      uuid,       -- FK added after accounts exists (circular reference)
    scope                 plan_scope  NOT NULL,
    name                  text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    monthly_allowance     bigint      NOT NULL CHECK (monthly_allowance >= 0),
    max_units_per_request bigint      NOT NULL CHECK (max_units_per_request > 0),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    -- Plan names are unique per owner and scope; NULLS NOT DISTINCT makes
    -- predefined plan names unique too (and lets the seed use ON CONFLICT).
    CONSTRAINT plans_name_unique UNIQUE NULLS NOT DISTINCT (owner_account_id, scope, name),

    -- Target for composite FKs so an account can only get an 'account' plan
    -- and a user only a 'user' plan.
    CONSTRAINT plans_id_scope_unique UNIQUE (id, scope)
);


-- ---------------------------------------------------------------------------
-- Accounts (the calling applications)
-- The raw API key is shown once at creation; only its SHA-256 hash is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    api_key_hash   bytea       NOT NULL UNIQUE,          -- sha256(raw_key), looked up on every request
    api_key_prefix text        NOT NULL,                 -- first few chars, safe to show/log
    plan_id        uuid        NOT NULL,
    plan_scope     plan_scope  NOT NULL DEFAULT 'account' CHECK (plan_scope = 'account'),
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT accounts_plan_fk FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

CREATE INDEX accounts_plan_id_idx ON accounts (plan_id);

ALTER TABLE plans
    ADD CONSTRAINT plans_owner_fk FOREIGN KEY (owner_account_id) REFERENCES accounts (id);

CREATE INDEX plans_owner_idx ON plans (owner_account_id);


-- ---------------------------------------------------------------------------
-- Users (end users of an account's application)
-- external_id is the identifier the calling application uses for its user.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  uuid        NOT NULL REFERENCES accounts (id),
    external_id text        NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 200),
    plan_id     uuid        NOT NULL,
    plan_scope  plan_scope  NOT NULL DEFAULT 'user' CHECK (plan_scope = 'user'),
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_external_id_unique UNIQUE (account_id, external_id),

    -- Lets child tables prove (account_id, user_id) belong together.
    CONSTRAINT users_account_id_unique UNIQUE (account_id, id),

    CONSTRAINT users_plan_fk FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

CREATE INDEX users_plan_id_idx ON users (plan_id);


-- ---------------------------------------------------------------------------
-- Guard: a custom plan can only be assigned inside the account that owns it.
-- Predefined plans (owner_account_id IS NULL) can be assigned by anyone.
-- ---------------------------------------------------------------------------
CREATE FUNCTION enforce_plan_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_account_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'accounts' THEN
        v_account_id := NEW.id;
    ELSE
        v_account_id := NEW.account_id;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM plans p
        WHERE p.id = NEW.plan_id
          AND (p.owner_account_id IS NULL OR p.owner_account_id = v_account_id)
    ) THEN
        RAISE EXCEPTION 'plan % is not available to account %', NEW.plan_id, v_account_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_plan_ownership
    BEFORE INSERT OR UPDATE OF plan_id ON accounts
    FOR EACH ROW EXECUTE FUNCTION enforce_plan_ownership();

CREATE TRIGGER users_plan_ownership
    BEFORE INSERT OR UPDATE OF plan_id, account_id ON users
    FOR EACH ROW EXECUTE FUNCTION enforce_plan_ownership();


-- ---------------------------------------------------------------------------
-- Monthly usage counters (one row per account/user per UTC month)
-- These are the rows locked during consumption, so totals stay correct under
-- concurrency. period_start is the first day of the UTC month.
-- ---------------------------------------------------------------------------
CREATE TABLE account_usage (
    account_id   uuid        NOT NULL REFERENCES accounts (id),
    period_start date        NOT NULL CHECK (EXTRACT(DAY FROM period_start) = 1),
    units_used   bigint      NOT NULL DEFAULT 0 CHECK (units_used >= 0),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (account_id, period_start)
);

CREATE TABLE user_usage (
    user_id      uuid        NOT NULL,
    account_id   uuid        NOT NULL,
    period_start date        NOT NULL CHECK (EXTRACT(DAY FROM period_start) = 1),
    units_used   bigint      NOT NULL DEFAULT 0 CHECK (units_used >= 0),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, period_start),
    CONSTRAINT user_usage_user_fk FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, id)
);

-- "Usage of all users in this account for month X"
CREATE INDEX user_usage_account_period_idx ON user_usage (account_id, period_start);


-- ---------------------------------------------------------------------------
-- Request history + idempotency
-- Every decision (accepted or rejected) is stored once. (account_id, request_id)
-- is unique, so a retried request returns the stored outcome instead of
-- consuming twice. Plan ids and the limit that blocked the request are
-- snapshotted so later plan edits don't rewrite history.
-- ---------------------------------------------------------------------------
CREATE TABLE usage_requests (
    id                bigint         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id        uuid           NOT NULL,
    user_id           uuid           NOT NULL,
    request_id        text           NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
    units             bigint         NOT NULL CHECK (units > 0),
    status            request_status NOT NULL,

    -- Set only for rejections: which level and which rule, and the limit value at that moment.
    rejected_by_level plan_scope,
    rejected_by_rule  rule_type,
    rule_limit        bigint,

    period_start      date           NOT NULL CHECK (EXTRACT(DAY FROM period_start) = 1),
    account_plan_id   uuid           NOT NULL REFERENCES plans (id),
    user_plan_id      uuid           NOT NULL REFERENCES plans (id),
    account_remaining bigint         NOT NULL CHECK (account_remaining >= 0),  -- after the decision
    user_remaining    bigint         NOT NULL CHECK (user_remaining >= 0),     -- after the decision
    created_at        timestamptz    NOT NULL DEFAULT now(),

    CONSTRAINT usage_requests_idempotency UNIQUE (account_id, request_id),
    CONSTRAINT usage_requests_user_fk FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, id),
    CONSTRAINT usage_requests_rejection_consistent CHECK (
        (status = 'accepted'
            AND rejected_by_level IS NULL AND rejected_by_rule IS NULL AND rule_limit IS NULL)
     OR (status = 'rejected'
            AND rejected_by_level IS NOT NULL AND rejected_by_rule IS NOT NULL AND rule_limit IS NOT NULL)
    )
);

-- Keyset pagination: WHERE account_id = $1 AND period_start = $2 AND id < $cursor ORDER BY id DESC
CREATE INDEX usage_requests_account_history_idx ON usage_requests (account_id, period_start, id DESC);
CREATE INDEX usage_requests_user_history_idx    ON usage_requests (user_id, period_start, id DESC);


-- ---------------------------------------------------------------------------
-- Keep updated_at current automatically on every UPDATE
-- ---------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER plans_set_updated_at
    BEFORE UPDATE ON plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER account_usage_set_updated_at
    BEFORE UPDATE ON account_usage
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER user_usage_set_updated_at
    BEFORE UPDATE ON user_usage
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------------
-- Predefined plans (idempotent: safe to run again)
-- ---------------------------------------------------------------------------
INSERT INTO plans (owner_account_id, scope, name, monthly_allowance, max_units_per_request) VALUES
    (NULL, 'account', 'Starter',  10000,  100),
    (NULL, 'account', 'Pro',     100000, 1000),
    (NULL, 'user',    'Basic',     1000,   20),
    (NULL, 'user',    'Premium',   5000,  100)
ON CONFLICT ON CONSTRAINT plans_name_unique DO NOTHING;

COMMIT;