// POST mint-fal-token
// Authenticated desktop app asks for a short-lived fal.ai JWT so it can open the
// realtime WebRTC session. The master FAL_KEY lives only here (Edge Function
// secret). Before minting we enforce subscription status, feature access,
// remaining minutes, and device binding, then open a metered usage session.
//
// Body: { appId: string, deviceId?: string, tab?: string }
// Resp: { token: string, sessionId: string, expiresInSeconds: number,
//         entitlement: { planId, unlimited, minutesUsed, monthlyMinutes } }
import { corsHeaders, preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";
import { checkEntitlement } from "../_shared/entitlements.ts";

const TOKEN_TTL_SECONDS = 120;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);

  try {
    const user = await requireUser(req);

    const body = await req.json().catch(() => ({}));
    const appId = typeof body.appId === "string" ? body.appId.trim() : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : undefined;
    const tab = typeof body.tab === "string" ? body.tab : "video-audio";
    if (!appId) return fail("appId is required");

    const ent = await checkEntitlement(user.id, "video", deviceId);
    if (!ent.allowed) return fail("not entitled", 403, { reason: ent.reason });

    const falKey = Deno.env.get("FAL_KEY");
    if (!falKey) return fail("server missing FAL_KEY", 500);

    // Open a metered session before minting (so we can credit minutes on stop).
    const db = adminClient();
    const { data: session, error: sesErr } = await db
      .from("usage_sessions")
      .insert({ user_id: user.id, device_id: deviceId ?? null, tab, feature: "video" })
      .select("id")
      .single();
    if (sesErr || !session) return fail("could not start usage session", 500);

    // Mint the short-lived fal token with the master key.
    const res = await fetch("https://rest.fal.ai/tokens/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Key ${falKey}` },
      body: JSON.stringify({ allowed_apps: [appId], token_expiration: TOKEN_TTL_SECONDS }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      // Roll back the session we just opened.
      await db.from("usage_sessions").delete().eq("id", session.id);
      return fail(`fal token error (${res.status})`, 502, { detail: txt.slice(0, 300) });
    }

    const raw = await res.text();
    let token = raw.trim();
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") token = parsed;
      else if (parsed?.detail) token = String(parsed.detail);
      else if (parsed?.token) token = String(parsed.token);
      else token = raw.replace(/^"|"$/g, "");
    } catch { /* plain-text token */ }

    return json({
      token,
      sessionId: session.id,
      expiresInSeconds: TOKEN_TTL_SECONDS,
      entitlement: {
        planId: ent.planId,
        unlimited: !!ent.unlimited,
        minutesUsed: ent.minutesUsed,
        monthlyMinutes: ent.monthlyMinutes,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unauthorized";
    const status = /authoriz|session|token/i.test(msg) ? 401 : 500;
    return fail(msg, status);
  }
});
