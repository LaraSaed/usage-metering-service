import { createHash, randomBytes } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { pool } from "./db";

// The calling account, attached to the request by requireApiKey.
export type Account = {
  id: string;
  name: string;
  plan_id: string;
};

// Tell TypeScript that req.account can exist on Express requests.
declare global {
  namespace Express {
    interface Request {
      account?: Account;
    }
  }
}

// A new random key, e.g. "mk_3q2Vx...". 24 random bytes = 192 bits, impossible to guess.
export function generateApiKey(): string {
  return "mk_" + randomBytes(24).toString("base64url");
}

// One-way hash of a key. We store this, never the key itself.
export function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

// Middleware: runs before protected routes and rejects requests without a valid key.
export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header("x-api-key");
  if (!key) {
    return res.status(401).json({ error: "missing_api_key", message: "Send your API key in the x-api-key header." });
  }

  const result = await pool.query<Account>(
    "SELECT id, name, plan_id FROM accounts WHERE api_key_hash = $1",
    [hashApiKey(key)],
  );
  const account = result.rows[0];
  if (!account) {
    return res.status(401).json({ error: "invalid_api_key", message: "This API key is not valid." });
  }

  req.account = account; // routes after this know who is calling
  next();
}