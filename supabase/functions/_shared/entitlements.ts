// Server-side entitlement + device-binding checks. This is the chokepoint that
// decides whether a user may start a session — a cracked client still cannot
// obtain AI tokens without passing these checks.
import { adminClient } from "./db.ts";

export type Feature = "video" | "voice" | "portrait_obs";

export type Entitlement = {
  allowed: boolean;
  reason?: string;
  planId?: string;
  unlimited?: boolean;
  minutesUsed?: number;
  monthlyMinutes?: number;
};

type SubRow = {
  plan_id: string;
  status: string;
  current_period_end: string | null;
  minutes_used: number;
  minutes_allocated: number | null;
  unlimited: boolean;
};
type PlanRow = {
  id: string;
  monthly_minutes: number;
  max_devices: number;
  features: string[];
};

/**
 * Resolve whether the user can use `feature` right now, optionally binding a
 * device. Returns a structured decision (never throws for "denied" — only for
 * infrastructure errors).
 */
export async function checkEntitlement(
  userId: string,
  feature: Feature,
  deviceId?: string,
): Promise<Entitlement> {
  const db = adminClient();

  const { data: sub, error: subErr } = await db
    .from("subscriptions")
    .select("plan_id, status, current_period_end, minutes_used, minutes_allocated, unlimited")
    .eq("user_id", userId)
    .maybeSingle();
  if (subErr) throw new Error(`subscription lookup failed: ${subErr.message}`);
  if (!sub) return { allowed: false, reason: "no_subscription" };

  const s = sub as SubRow;
  if (!["trialing", "active"].includes(s.status)) {
    return { allowed: false, reason: `status_${s.status}` };
  }
  if (s.current_period_end && new Date(s.current_period_end).getTime() <= Date.now()) {
    return { allowed: false, reason: "expired" };
  }

  const { data: plan, error: planErr } = await db
    .from("plans")
    .select("id, monthly_minutes, max_devices, features")
    .eq("id", s.plan_id)
    .single();
  if (planErr || !plan) return { allowed: false, reason: "no_plan" };

  const p = plan as PlanRow;
  if (!p.features.includes(feature)) {
    return { allowed: false, reason: "feature_not_included", planId: p.id };
  }

  // Prepaid minute wallet: admin-granted allocation overrides the plan default;
  // either the per-account unlimited flag or a 0-minute plan means unlimited.
  const unlimited = s.unlimited === true || p.monthly_minutes === 0;
  const allocated = s.minutes_allocated ?? p.monthly_minutes;
  if (!unlimited && s.minutes_used >= allocated) {
    return {
      allowed: false,
      reason: "out_of_minutes",
      planId: p.id,
      minutesUsed: s.minutes_used,
      monthlyMinutes: allocated,
    };
  }

  // Device binding: enforce max_devices unless this device is already known.
  if (deviceId) {
    const { data: existing } = await db
      .from("devices")
      .select("id, revoked")
      .eq("user_id", userId)
      .eq("device_id", deviceId)
      .maybeSingle();

    if (existing?.revoked) return { allowed: false, reason: "device_revoked" };

    if (!existing) {
      const { count } = await db
        .from("devices")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("revoked", false);
      if ((count ?? 0) >= p.max_devices) {
        return { allowed: false, reason: "device_limit_reached", planId: p.id };
      }
      const { error: insErr } = await db.from("devices").insert({
        user_id: userId,
        device_id: deviceId,
      });
      if (insErr) throw new Error(`device bind failed: ${insErr.message}`);
    } else {
      await db.from("devices").update({ last_seen: new Date().toISOString() })
        .eq("user_id", userId).eq("device_id", deviceId);
    }
  }

  return {
    allowed: true,
    planId: p.id,
    unlimited,
    minutesUsed: s.minutes_used,
    monthlyMinutes: allocated,
  };
}
