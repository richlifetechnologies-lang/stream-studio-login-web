// Authenticate the caller from the Authorization: Bearer <user JWT> header.
// Returns the user id, or throws (caller turns it into a 401).
import { userClient } from "./db.ts";

export type AuthUser = { id: string; email?: string };

export function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization");
  return h && h.toLowerCase().startsWith("bearer ") ? h : null;
}

export async function requireUser(req: Request): Promise<AuthUser> {
  const authHeader = bearer(req);
  if (!authHeader) throw new Error("missing Authorization bearer token");
  const { data, error } = await userClient(authHeader).auth.getUser();
  if (error || !data?.user) throw new Error("invalid or expired session");
  return { id: data.user.id, email: data.user.email ?? undefined };
}
