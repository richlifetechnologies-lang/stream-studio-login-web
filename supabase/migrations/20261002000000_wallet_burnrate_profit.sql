-- ─────────────────────────────────────────────────────────────────────────────
-- Prepaid minute wallet + burn-rate timer + profit/billing config.
--
-- Merges the RICH X CAM LIVE admin features into the account-based model:
--   * subscriptions.minutes_allocated / unlimited — admin grants a minute
--     balance straight into the account (prepaid wallet). The user consumes
--     exactly this until it hits zero. NULL allocated = fall back to the plan's
--     monthly_minutes.
--   * timer_config  — per-mode burn-rate multipliers (1 real minute = N wallet
--     minutes) + low-balance warning + auto-terminate. Applied by usage-heartbeat.
--   * billing_config — verified base API costs + target profit margin, used by
--     the admin panel's profit simulator / break-even matrix.
--   * gateway_keys.notes — parity with the old key vault.
--
-- NO license keys: access is account-only. These are singleton config tables
-- (id = 1) editable by admins from the panel.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── prepaid minute wallet on subscriptions ───────────────────────────────────
alter table public.subscriptions
  add column if not exists minutes_allocated integer,          -- null = use plan.monthly_minutes
  add column if not exists unlimited boolean not null default false;

-- ── vault parity: notes on key pairs ─────────────────────────────────────────
alter table public.gateway_keys
  add column if not exists notes text;

-- ── timer_config: how fast minutes burn per call mode (singleton) ────────────
create table if not exists public.timer_config (
  id                       integer primary key default 1 check (id = 1),
  video_only_multiplier    numeric(4,2) not null default 1.00,  -- video + natural mic
  audio_only_multiplier    numeric(4,2) not null default 0.50,  -- audio calls only
  video_voice_multiplier   numeric(4,2) not null default 1.50,  -- video + cloned voice
  warning_threshold_minutes integer not null default 5,
  auto_terminate_at_zero   boolean not null default true,
  updated_at               timestamptz not null default now()
);
insert into public.timer_config (id) values (1) on conflict (id) do nothing;

-- ── billing_config: verified base costs + margin (singleton) ─────────────────
create table if not exists public.billing_config (
  id                              integer primary key default 1 check (id = 1),
  lucy_video_per_sec_cost         numeric(8,5) not null default 0.04000,  -- $2.40/min
  voice_cloning_per_sec_cost      numeric(8,5) not null default 0.00250,  -- $0.15/min
  natural_audio_per_sec_cost      numeric(8,5) not null default 0.00010,  -- $0.006/min
  profit_margin_percent           integer not null default 40,
  min_guaranteed_margin_percent   integer not null default 25,
  last_verified_at                text not null default '2026-09-23',
  source_notes                    text not null default 'Verified via realtime GPU video streaming ($0.04/sec) and voice streaming ($0.12-$0.20/min).',
  updated_at                      timestamptz not null default now()
);
insert into public.billing_config (id) values (1) on conflict (id) do nothing;

-- ── RLS: admins read/write the config singletons; service role bypasses ──────
alter table public.timer_config   enable row level security;
alter table public.billing_config enable row level security;

drop policy if exists timer_admin_select on public.timer_config;
create policy timer_admin_select on public.timer_config
  for select using (public.is_admin(auth.uid()));
drop policy if exists timer_admin_write on public.timer_config;
create policy timer_admin_write on public.timer_config
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

drop policy if exists billing_admin_select on public.billing_config;
create policy billing_admin_select on public.billing_config
  for select using (public.is_admin(auth.uid()));
drop policy if exists billing_admin_write on public.billing_config;
create policy billing_admin_write on public.billing_config
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- devices: admins may unbind (delete) or revoke a user's devices from the panel.
drop policy if exists devices_admin_update on public.devices;
create policy devices_admin_update on public.devices
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
drop policy if exists devices_admin_delete on public.devices;
create policy devices_admin_delete on public.devices
  for delete using (public.is_admin(auth.uid()));

-- ── updated_at triggers for the config singletons ────────────────────────────
drop trigger if exists timer_touch on public.timer_config;
create trigger timer_touch before update on public.timer_config
  for each row execute function public.touch_updated_at();
drop trigger if exists billing_touch on public.billing_config;
create trigger billing_touch before update on public.billing_config
  for each row execute function public.touch_updated_at();
