-- ─────────────────────────────────────────────────────────────────────────────
-- STREAM STUDIO Login Web — initial schema
-- Subscription accounts + usage metering + device binding for the Stream Studio
-- desktop app. Master AI keys (fal.ai / ElevenLabs) live ONLY in Edge Function
-- secrets, never in this database and never in the client.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Enumerations ─────────────────────────────────────────────────────────────
do $$ begin
  create type sub_status as enum ('trialing', 'active', 'past_due', 'canceled', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type feature_flag as enum ('video', 'voice', 'portrait_obs');
exception when duplicate_object then null; end $$;

-- ── profiles: 1:1 with auth.users ────────────────────────────────────────────
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text,
  display_name  text,
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Auto-create a profile row when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(coalesce(new.email, ''), '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── plans: what a subscription grants ────────────────────────────────────────
create table if not exists public.plans (
  id              text primary key,              -- e.g. 'starter', 'pro'
  name            text not null,
  monthly_minutes integer not null default 0,    -- 0 = unlimited
  max_devices     integer not null default 1,
  features        feature_flag[] not null default '{video}',
  price_cents     integer not null default 0,
  currency        text not null default 'usd',
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

insert into public.plans (id, name, monthly_minutes, max_devices, features, price_cents) values
  ('starter', 'Starter', 300,  1, '{video}',            900),
  ('pro',     'Pro',     1500, 2, '{video,voice}',      2900),
  ('studio',  'Studio',  0,     3, '{video,voice,portrait_obs}', 7900)
on conflict (id) do nothing;

-- ── subscriptions: one active row per user ───────────────────────────────────
create table if not exists public.subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles (id) on delete cascade,
  plan_id              text not null references public.plans (id),
  status               sub_status not null default 'trialing',
  current_period_end   timestamptz,                 -- null = no expiry
  minutes_used         integer not null default 0,  -- resets each period
  billing_provider     text,                        -- 'manual' (admin-granted; no online billing)
  billing_ref          text,                        -- optional offline reference (invoice/receipt id)
  cancel_at_period_end boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (user_id)                                   -- one subscription per user
);

create index if not exists subscriptions_user_idx on public.subscriptions (user_id);
create index if not exists subscriptions_billing_ref_idx on public.subscriptions (billing_ref);

-- ── devices: bind activations to prevent account sharing ─────────────────────
create table if not exists public.devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  device_id     text not null,                      -- stable id from the desktop app
  label         text,                               -- e.g. hostname / OS
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  revoked       boolean not null default false,
  unique (user_id, device_id)
);

create index if not exists devices_user_idx on public.devices (user_id);

-- ── usage_sessions: metering ledger ──────────────────────────────────────────
create table if not exists public.usage_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  device_id    text,
  tab          text,                                -- 'video-audio' | 'video-only' | 'audio-only'
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  minutes      numeric(8,3) not null default 0,     -- credited on heartbeat/stop
  feature      feature_flag not null default 'video'
);

create index if not exists usage_user_started_idx on public.usage_sessions (user_id, started_at desc);

-- ── entitlement check helper (used by Edge Functions) ────────────────────────
create or replace function public.has_entitlement(p_user uuid, p_feature feature_flag)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
    where s.user_id = p_user
      and s.status in ('trialing', 'active')
      and (s.current_period_end is null or s.current_period_end > now())
      and (p.monthly_minutes = 0 or s.minutes_used < p.monthly_minutes)
      and p_feature = any (p.features)
  );
$$;

-- ── Row Level Security ───────────────────────────────────────────────────────
alter table public.profiles        enable row level security;
alter table public.plans           enable row level security;
alter table public.subscriptions   enable row level security;
alter table public.devices         enable row level security;
alter table public.usage_sessions  enable row level security;

-- profiles: a user reads/writes only their own row; admins read all.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (
    auth.uid() = id
    or exists (select 1 from public.profiles a where a.id = auth.uid() and a.is_admin)
  );
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- plans: readable by any signed-in user (needed to show plan info).
drop policy if exists plans_select on public.plans;
create policy plans_select on public.plans for select using (auth.role() = 'authenticated');

-- subscriptions: user reads own; admins read all. Writes only via service role
-- (Edge Functions / admin panel), so no insert/update policy for clients.
drop policy if exists subs_select_own on public.subscriptions;
create policy subs_select_own on public.subscriptions
  for select using (
    auth.uid() = user_id
    or exists (select 1 from public.profiles a where a.id = auth.uid() and a.is_admin)
  );

-- devices: user manages own; admins read all.
drop policy if exists devices_select_own on public.devices;
create policy devices_select_own on public.devices
  for select using (
    auth.uid() = user_id
    or exists (select 1 from public.profiles a where a.id = auth.uid() and a.is_admin)
  );
drop policy if exists devices_write_own on public.devices;
create policy devices_write_own on public.devices
  for insert with check (auth.uid() = user_id);
drop policy if exists devices_update_own on public.devices;
create policy devices_update_own on public.devices
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- usage_sessions: user reads own; admins read all. Writes via service role only.
drop policy if exists usage_select_own on public.usage_sessions;
create policy usage_select_own on public.usage_sessions
  for select using (
    auth.uid() = user_id
    or exists (select 1 from public.profiles a where a.id = auth.uid() and a.is_admin)
  );

-- ── updated_at trigger for subscriptions ─────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists subs_touch on public.subscriptions;
create trigger subs_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();
