// POST usage-heartbeat
// The desktop app calls this periodically during a call and once on stop.
// It credits elapsed minutes to the open usage_session and adds them to the
// subscription's minutes_used (skipped for unlimited plans). This is what makes
// "control user usage time" enforceable server-side.
//
// Body: { sessionId: string, end?: boolean }
// Resp: { minutes: number, totalUsed: number, monthlyMinutes: number|null, ended: boolean }
import { preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { adminClient } from "../_shared/db.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const end = body.end === true;
    if (!sessionId) return fail("sessionId is required");

    const db = adminClient();
    const { data: session, error: sErr } = await db
      .from("usage_sessions")
      .select("id, user_id, started_at, ended_at, minutes")
      .eq("id", sessionId)
      .maybeSingle();
    if (sErr) return fail(sErr.message, 500);
    if (!session || session.user_id !== user.id) return fail("session not found", 404);
    if (session.ended_at) {
      return json({ minutes: Number(session.minutes), totalUsed: null, monthlyMinutes: null, ended: true });
    }

    // Minutes elapsed since the session started (or since last credit) — we
    // recompute from started_at each time and store the cumulative total, so
    // repeated heartbeats are idempotent.
    const elapsedMin = Math.max(0, (Date.now() - new Date(session.started_at).getTime()) / 60000);
    const rounded = Math.round(elapsedMin * 1000) / 1000;
    const previouslyCredited = Number(session.minutes) || 0;
    const delta = Math.max(0, rounded - previouslyCredited);

    const patch: Record<string, unknown> = { minutes: rounded };
    if (end) patch.ended_at = new Date().toISOString();

    const { error: uErr } = await db.from("usage_sessions").update(patch).eq("id", sessionId);
    if (uErr) return fail(uErr.message, 500);

    // Credit the delta to the subscription counter (unlimited plans store 0 cap).
    let totalUsed: number | null = null;
    let monthlyMinutes: number | null = null;
    if (delta > 0 || end) {
      const { data: sub } = await db
        .from("subscriptions")
        .select("plan_id, minutes_used")
        .eq("user_id", user.id)
        .maybeSingle();
      if (sub) {
        const { data: plan } = await db.from("plans").select("monthly_minutes").eq("id", sub.plan_id).single();
        monthlyMinutes = plan?.monthly_minutes ?? null;
        if (monthlyMinutes !== 0) {
          if (delta > 0) {
            await db.from("subscriptions")
              .update({ minutes_used: (sub.minutes_used || 0) + delta })
              .eq("user_id", user.id);
          }
          totalUsed = (sub.minutes_used || 0) + delta;
        }
      }
    }

    return json({ minutes: rounded, totalUsed, monthlyMinutes, ended: end });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unauthorized";
    const status = /authoriz|session|token/i.test(msg) ? 401 : 500;
    return fail(msg, status);
  }
});
