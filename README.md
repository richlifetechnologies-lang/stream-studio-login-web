# STREAM STUDIO Login Web

Auth, licensing gateway, and subscription/usage backend for the **Stream Studio**
desktop app. This is a **separate project** from the `stream-studio` app — it does
not modify that repo. Its job is to move the AI API keys off users' machines and
onto a server you control, and to gate access with subscription accounts, plan
minutes, and device binding.

## Why this exists
Today each Stream Studio user pastes their **own** fal.ai and ElevenLabs keys into
the app, stored in plaintext `localStorage`. That means:
- You have no central control and no usage metering.
- Keys are exposed on every user's machine.
- The voice key is sent in a raw header straight to ElevenLabs.

This backend fixes all three: users **sign in** instead of pasting keys; the master
keys live only in server-side secrets; and every call is authorized + metered at a
single chokepoint.

## Architecture
```
Desktop app ──sign in──▶ Supabase Auth (email/password)
     │                          │
     │  Bearer <user JWT>       ▼
     ├──mint-fal-token──▶ Edge Function ──checks plan/minutes/device──▶ mints ≤120s fal JWT (master FAL_KEY)
     ├──proxy-voice─────▶ Edge Function ──checks 'voice' entitlement──▶ forwards to ElevenLabs (master key)
     ├──usage-heartbeat─▶ Edge Function ──credits minutes to subscription──▶ Postgres
     │
Lemon Squeezy / Paddle ──webhook──▶ billing-webhook ──upserts──▶ subscriptions
```

## Stack (chosen for low cost + low maintenance)
- **Supabase** — auth, Postgres, Row-Level Security, Edge Functions (Deno), and
  **Supabase Studio** as a day-one admin UI. Free tier to start.
- **Lemon Squeezy or Paddle** — merchant-of-record subscriptions (they handle
  global tax, invoicing, dunning). You only mirror state via a webhook.
- **Admin panel** (`admin/index.html`) — a lightweight, `is_admin`-gated web page
  for granting/editing/canceling subscriptions and viewing usage.

## Repository layout
```
supabase/
  migrations/            # SQL schema: profiles, plans, subscriptions, devices, usage
  functions/
    _shared/             # cors, auth, db clients, entitlement checks
    mint-fal-token/      # authorize + mint short-lived fal JWT (the chokepoint)
    proxy-voice/         # authorize + proxy ElevenLabs (keeps voice key server-side)
    usage-heartbeat/     # meter minutes during/after a call
    billing-webhook/     # Lemon Squeezy / Paddle → subscriptions
admin/index.html         # admin control panel
client/
  stream-studio-auth.ts  # drop-in SDK for the desktop app
  integration-guide.md   # how to wire it into stream-studio later
```

## Setup
### 1. Create a Supabase project
At [supabase.com](https://supabase.com), create a project. Grab the **URL**,
**anon key**, and **service_role key** from Settings → API.

### 2. Apply the schema
```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push          # applies both migrations
```
(Or paste the two files in `supabase/migrations/` into the SQL editor.)

### 3. Set Edge Function secrets (dashboard → Edge Functions → Secrets)
```
FAL_KEY=...                 # your master fal.ai key
ELEVENLABS_KEY=...          # your master ElevenLabs key
SUPABASE_SERVICE_ROLE_KEY=...
BILLING_PROVIDER=lemonsqueezy
BILLING_WEBHOOK_SECRET=...
PLAN_MAP=ls_variant_123=starter,ls_variant_456=pro
```
> These secrets never live in this repo. The anon key is the only value that ships
> to the client, and it grants nothing by itself (RLS + `is_admin` enforce access).

### 4. Deploy the functions
```bash
supabase functions deploy mint-fal-token
supabase functions deploy proxy-voice
supabase functions deploy usage-heartbeat
supabase functions deploy billing-webhook
```

### 5. Make yourself an admin
In Supabase Studio → Table editor → `profiles`, set `is_admin = true` for your
account (sign up once first so the row exists).

### 6. Host the admin panel
`admin/index.html` is a static file. Open it, set `SUPABASE_URL` and
`SUPABASE_ANON_KEY` at the top, and host it anywhere static (or just open locally).
Sign in with your admin account.

### 7. Wire up billing
Create products in Lemon Squeezy/Paddle matching the `plans` table, set
`PLAN_MAP`, and point the provider's webhook at:
```
https://YOUR-PROJECT.supabase.co/functions/v1/billing-webhook
```
If a customer pays **before** signing up, the grant is stashed in `pending_grants`
and auto-attaches the first time that email creates an account.

### 8. Connect the desktop app
See [`client/integration-guide.md`](client/integration-guide.md). The existing
`stream-studio` repo is untouched until you choose to wire it up; a
`VITE_USE_GATEWAY` flag lets you roll out gradually and keep BYO-key as a fallback.

## Usage-control model
- **Plans** define `monthly_minutes` (0 = unlimited), `max_devices`, and `features`
  (`video`, `voice`, `portrait_obs`).
- On each call start, `mint-fal-token` checks: subscription active? not expired?
  feature included? minutes left? device under the limit? Only then does it mint a
  token — so time/feature control is enforced server-side and can't be bypassed by
  editing the client.
- `usage-heartbeat` credits elapsed minutes every 30s and on stop.

## Security notes & limits
- A short-lived fal token (≤120s, model-scoped) is still visible to its own client;
  that's inherent to browser WebRTC. Blast radius is small. Fully hiding it would
  require proxying media through your server (latency + cost) — not recommended.
- Keep `SUPABASE_SERVICE_ROLE_KEY`, `FAL_KEY`, and `ELEVENLABS_KEY` server-side only.
- This repo contains **no secrets**. `.env.example` lists the variables to set.

## Status
Phase 1 scaffold: schema, four Edge Functions, admin panel, and client SDK. Not yet
deployed — follow Setup above. The `stream-studio` desktop app is unchanged.
