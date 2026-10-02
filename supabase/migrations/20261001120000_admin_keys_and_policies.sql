-- ─────────────────────────────────────────────────────────────────────────────
-- Admin-managed API keys + dashboard write access.
--
-- Adds:
--   * public.is_admin(uid)               — reusable admin check for RLS
--   * public.gateway_keys                — video (fal.ai) + voice (ElevenLabs)
--                                          key pairs, managed from the admin
--                                          panel; one row may be the default
--   * public.subscriptions.key_id        — optional per-user key override
--   * admin WRITE policies on plans / subscriptions / gateway_keys so the
--     admin panel (anon key + is_admin) can actually save changes
--   * a seeded "Voice Only" plan for audio-only users
--
-- Key resolution order used by the Edge Functions (see _shared/keys.ts):
--   subscription.key_id  →  default gateway_keys row  →  env FAL_KEY/ELEVENLABS_KEY
--
-- SECURITY: gateway_keys is readable ONLY by admins (RLS) and the service role
-- (Edge Functions). Regular users can never select it. Admins are trusted, so
-- the raw key values are visible to them in the panel; the table is masked in
-- the UI. Env secrets remain the fallback and are the most secure option.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── is_admin helper ──────────────────────────────────────────────────────────
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p where p.id = uid and p.is_admin = true
  );
$$;

-- ── gateway_keys: admin-managed master AI keys ───────────────────────────────
create table if not exists public.gateway_keys (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,                     -- e.g. "Primary fal + ElevenLabs"
  fal_key        text,                              -- video key (fal.ai); null = not provided
  elevenlabs_key text,                              -- voice key (ElevenLabs); null = not provided
  is_default     boolean not null default false,    -- the global fallback pair
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- At most one default key pair.
create unique index if not exists one_default_gateway_key
  on public.gateway_keys (is_default) where is_default;

-- ── per-user key override on subscriptions ───────────────────────────────────
alter table public.subscriptions
  add column if not exists key_id uuid references public.gateway_keys (id) on delete set null;

-- ── seed an audio-only plan (voice feature, no video) ────────────────────────
insert into public.plans (id, name, monthly_minutes, max_devices, features, price_cents) values
  ('voice', 'Voice Only', 300, 1, '{voice}', 900)
on conflict (id) do nothing;

-- ── Row Level Security ───────────────────────────────────────────────────────
alter table public.gateway_keys enable row level security;

-- gateway_keys: admins only (service role bypasses RLS for the Edge Functions).
drop policy if exists gwkeys_admin_select on public.gateway_keys;
create policy gwkeys_admin_select on public.gateway_keys
  for select using (public.is_admin(auth.uid()));
drop policy if exists gwkeys_admin_insert on public.gateway_keys;
create policy gwkeys_admin_insert on public.gateway_keys
  for insert with check (public.is_admin(auth.uid()));
drop policy if exists gwkeys_admin_update on public.gateway_keys;
create policy gwkeys_admin_update on public.gateway_keys
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
drop policy if exists gwkeys_admin_delete on public.gateway_keys;
create policy gwkeys_admin_delete on public.gateway_keys
  for delete using (public.is_admin(auth.uid()));

-- plans: admins may create/edit/delete (read is already open to authenticated).
drop policy if exists plans_admin_insert on public.plans;
create policy plans_admin_insert on public.plans
  for insert with check (public.is_admin(auth.uid()));
drop policy if exists plans_admin_update on public.plans;
create policy plans_admin_update on public.plans
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
drop policy if exists plans_admin_delete on public.plans;
create policy plans_admin_delete on public.plans
  for delete using (public.is_admin(auth.uid()));

-- subscriptions: admins may grant/edit/cancel from the panel.
-- (Fixes the previous scaffold where the panel's anon-key upsert would be
--  rejected because only the service role could write.)
drop policy if exists subs_admin_insert on public.subscriptions;
create policy subs_admin_insert on public.subscriptions
  for insert with check (public.is_admin(auth.uid()));
drop policy if exists subs_admin_update on public.subscriptions;
create policy subs_admin_update on public.subscriptions
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
drop policy if exists subs_admin_delete on public.subscriptions;
create policy subs_admin_delete on public.subscriptions
  for delete using (public.is_admin(auth.uid()));

-- ── updated_at trigger for gateway_keys ──────────────────────────────────────
drop trigger if exists gwkeys_touch on public.gateway_keys;
create trigger gwkeys_touch before update on public.gateway_keys
  for each row execute function public.touch_updated_at();
