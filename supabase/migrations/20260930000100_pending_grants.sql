-- ─────────────────────────────────────────────────────────────────────────────
-- Optional: pending billing grants.
-- When a payment arrives BEFORE the buyer has created an account, we cannot
-- attach it to a user yet (FK). We stash it here keyed by lowercased email and
-- reconcile it into `subscriptions` the first time that email signs in.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.pending_grants (
  email                text primary key,          -- always stored lowercase
  plan_id              text not null references public.plans (id),
  status               sub_status not null default 'active',
  current_period_end   timestamptz,
  cancel_at_period_end boolean not null default false,
  billing_provider     text,
  billing_ref          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.pending_grants enable row level security;
-- No client policies: only the service role (Edge Functions) may read/write.

-- Reconcile a pending grant into a real subscription on first sign-in.
-- Called from an Edge Function (or a Post-signup hook) with the new user's id.
create or replace function public.reconcile_pending_grant(p_user uuid, p_email text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare g record;
begin
  delete from public.pending_grants
  where email = lower(coalesce(p_email, ''))
  returning plan_id, status, current_period_end, cancel_at_period_end,
            billing_provider, billing_ref
  into g;

  if found then
    insert into public.subscriptions
      (user_id, plan_id, status, current_period_end, cancel_at_period_end,
       billing_provider, billing_ref)
    values
      (p_user, g.plan_id, g.status, g.current_period_end, g.cancel_at_period_end,
       g.billing_provider, g.billing_ref)
    on conflict (user_id) do update set
      plan_id = excluded.plan_id,
      status = excluded.status,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      billing_provider = excluded.billing_provider,
      billing_ref = excluded.billing_ref;
  end if;
end;
$$;

drop trigger if exists pending_touch on public.pending_grants;
create trigger pending_touch before update on public.pending_grants
  for each row execute function public.touch_updated_at();

-- Auto-reconcile: when a new profile is created (i.e. a user signs up), attach
-- any pending grant that was paid for with that email before the account
-- existed. Runs as definer so it can write to subscriptions despite RLS.
create or replace function public.reconcile_on_signup()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.reconcile_pending_grant(new.id, new.email);
  return new;
end;
$$;

drop trigger if exists profiles_reconcile on public.profiles;
create trigger profiles_reconcile
  after insert on public.profiles
  for each row execute function public.reconcile_on_signup();
