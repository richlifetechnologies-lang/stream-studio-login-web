// POST billing-webhook
// Receives subscription lifecycle events from a merchant-of-record provider
// (Lemon Squeezy or Paddle) and upserts the local `subscriptions` row. This is
// the entire billing integration: the provider handles checkout, tax, dunning
// and cancellation; we only mirror the resulting state.
//
// Security: validate the provider signature (X-Signature for Lemon Squeezy,
// Paddle-Signature for Paddle) using the shared webhook secret before trusting
// the payload. Map the provider's customer email to an existing auth user; if
// none exists yet, store a pending row keyed by email for reconciliation on
// first sign-in (see README "Billing → account linking").
//
// Env: BILLING_WEBHOOK_SECRET, BILLING_PROVIDER ('lemonsqueezy'|'paddle')
import { preflight, json, fail } from "../_shared/cors.ts";
import { adminClient } from "../_shared/db.ts";

const PROVIDER = (Deno.env.get("BILLING_PROVIDER") ?? "lemonsqueezy").toLowerCase();
const SECRET = Deno.env.get("BILLING_WEBHOOK_SECRET") ?? "";

async function hmacSha256Hex(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Normalise both providers into a common event shape.
type Normalized = {
  ref: string;
  email: string;
  planId: string | null;
  status: "trialing" | "active" | "past_due" | "canceled" | "expired";
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

function normalizeLemonSqueezy(ev: any): Normalized | null {
  const name: string = ev?.meta?.event_name ?? "";
  const attrs = ev?.data?.attributes ?? {};
  const email = attrs.customer_email ?? ev?.data?.relationships?.customer?.data?.email ?? "";
  const statusMap: Record<string, Normalized["status"]> = {
    subscription_created: attrs.trial_ends_at ? "trialing" : "active",
    subscription_updated: attrs.status === "past_due" ? "past_due" : attrs.status === "cancelled" ? "canceled" : "active",
    subscription_resumed: "active",
    subscription_unpaused: "active",
    subscription_cancelled: attrs.ends_at ? "active" : "canceled", // cancel_at_period_end vs immediate
    subscription_expired: "expired",
    subscription_paused: "canceled",
    subscription_payment_failed: "past_due",
  };
  const status = statusMap[name];
  if (!status) return null;
  return {
    ref: String(attrs.id ?? ev?.data?.id ?? ""),
    email,
    planId: mapPlan(attrs.variant_id ?? attrs.product_id),
    status,
    periodEnd: attrs.renews_at ?? attrs.ends_at ?? null,
    cancelAtPeriodEnd: name === "subscription_cancelled" && !!attrs.ends_at,
  };
}

function normalizePaddle(ev: any): Normalized | null {
  const type: string = ev?.event_type ?? "";
  const d = ev?.data ?? {};
  const email = d.customer?.email ?? "";
  const statusMap: Record<string, Normalized["status"]> = {
    "subscription.created": d.status === "trialing" ? "trialing" : "active",
    "subscription.updated": d.status === "past_due" ? "past_due" : d.status === "canceled" ? "canceled" : "active",
    "subscription.activated": "active",
    "subscription.canceled": "canceled",
    "subscription.past_due": "past_due",
  };
  const status = statusMap[type];
  if (!status) return null;
  return {
    ref: String(d.id ?? ""),
    email,
    planId: mapPlan(d.items?.[0]?.price?.product_id),
    status,
    periodEnd: d.current_billing_period?.ends_at ?? d.scheduled_change?.effective_at ?? null,
    cancelAtPeriodEnd: d.scheduled_change?.type === "cancel",
  };
}

// Map a provider product/variant id to one of our plan ids via env, e.g.
// PLAN_MAP="ls_variant_123=pro,ls_variant_456=studio". Falls back to 'starter'.
function mapPlan(providerId: unknown): string {
  const raw = Deno.env.get("PLAN_MAP") ?? "";
  const id = String(providerId ?? "");
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=");
    if (k && k.trim() === id) return v.trim();
  }
  return "starter";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);
  if (!SECRET) return fail("server missing BILLING_WEBHOOK_SECRET", 500);

  const raw = await req.text();

  // Signature verification.
  if (PROVIDER === "lemonsqueezy") {
    const provided = req.headers.get("X-Signature") ?? "";
    const digest = await hmacSha256Hex(SECRET, raw);
    if (provided !== digest) return fail("invalid signature", 401);
  } else if (PROVIDER === "paddle") {
    const hdr = req.headers.get("Paddle-Signature") ?? "";
    const parts = Object.fromEntries(hdr.split(";").map((p) => p.split("=")) as Iterable<[string, string]>);
    const signed = `${parts.ts}:${raw}`;
    const digest = await hmacSha256Hex(SECRET, signed);
    if ((parts.h1 ?? "") !== digest) return fail("invalid signature", 401);
  } else {
    return fail("unknown BILLING_PROVIDER", 500);
  }

  let ev: any;
  try { ev = JSON.parse(raw); } catch { return fail("invalid JSON", 400); }

  const norm = PROVIDER === "paddle" ? normalizePaddle(ev) : normalizeLemonSqueezy(ev);
  if (!norm) return json({ ignored: true }); // event we don't track

  const db = adminClient();

  // Resolve the auth user by email (case-insensitive).
  const { data: profiles } = await db.from("profiles").select("id, email").ilike("email", norm.email);
  const userId = profiles?.[0]?.id ?? null;

  const row = {
    plan_id: norm.planId ?? "starter",
    status: norm.status,
    current_period_end: norm.periodEnd,
    cancel_at_period_end: norm.cancelAtPeriodEnd,
    billing_provider: PROVIDER,
    billing_ref: norm.ref,
  };

  if (userId) {
    await db.from("subscriptions").upsert({ user_id: userId, ...row }, { onConflict: "user_id" });
  } else {
    // No account yet: stash the pending grant so it can be attached on first
    // sign-in. Uses a simple table-less approach — store on a pending row with
    // a null user is not allowed by FK, so we record it in billing_ref index
    // and reconcile via the reconcile-on-login helper described in the README.
    await db.from("pending_grants").upsert(
      { email: norm.email.toLowerCase(), ...row },
      { onConflict: "email" },
    ).then(async (r) => {
      if (r.error && /pending_grants/.test(r.error.message)) {
        // Table not created yet — operator must run the optional migration.
        // Fail loudly so this is not silently lost.
        throw new Error("pending_grants table missing; run optional migration 20260930000100");
      }
    });
  }

  return json({ ok: true, userId, status: norm.status, plan: norm.planId });
});
