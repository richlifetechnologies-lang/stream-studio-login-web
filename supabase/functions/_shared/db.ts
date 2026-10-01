// Supabase clients for Edge Functions.
// - userClient: scoped to the caller's JWT (RLS applies). Use for reads that
//   should respect the user's own permissions.
// - adminClient: uses the service-role key (bypasses RLS). Use ONLY inside
//   trusted Edge Functions for metering writes and entitlement checks.
// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export function adminClient(): SupabaseClient {
  if (!url || !serviceKey) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function userClient(authHeader: string | null): SupabaseClient {
  if (!url || !anonKey) throw new Error("Missing SUPABASE_URL / SUPABASE_ANON_KEY");
  return createClient(url, anonKey, {
    global: { headers: authHeader ? { Authorization: authHeader } : {} },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
