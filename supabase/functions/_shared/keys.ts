// Resolve which master AI key to use for a given user.
//
// Precedence:
//   1. The key pair linked to the user's subscription (subscriptions.key_id)
//   2. The default gateway_keys row (is_default = true)
//   3. The Edge Function env secret (FAL_KEY / ELEVENLABS_KEY)
//
// This lets an admin manage keys from the dashboard while keeping env secrets
// as a secure fallback. Uses the service-role client, so RLS never blocks it.
import { adminClient } from "./db.ts";

type KeyRow = { fal_key: string | null; elevenlabs_key: string | null };

async function resolveKeyRow(userId: string): Promise<KeyRow | null> {
  const db = adminClient();

  // 1. Per-user override via their subscription.
  const { data: sub } = await db
    .from("subscriptions")
    .select("key_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (sub?.key_id) {
    const { data: k } = await db
      .from("gateway_keys")
      .select("fal_key, elevenlabs_key")
      .eq("id", sub.key_id)
      .maybeSingle();
    if (k && (k.fal_key || k.elevenlabs_key)) return k as KeyRow;
  }

  // 2. Global default pair.
  const { data: d } = await db
    .from("gateway_keys")
    .select("fal_key, elevenlabs_key")
    .eq("is_default", true)
    .maybeSingle();
  if (d && (d.fal_key || d.elevenlabs_key)) return d as KeyRow;

  return null;
}

/** fal.ai (video) key for a user, falling back to the env secret. */
export async function resolveFalKey(userId: string): Promise<string | null> {
  const row = await resolveKeyRow(userId);
  return row?.fal_key || Deno.env.get("FAL_KEY") || null;
}

/** ElevenLabs (voice) key for a user, falling back to the env secret. */
export async function resolveElevenlabsKey(userId: string): Promise<string | null> {
  const row = await resolveKeyRow(userId);
  return row?.elevenlabs_key || Deno.env.get("ELEVENLABS_KEY") || null;
}
