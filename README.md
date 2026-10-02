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
Administrator ──admin panel──▶ grants / edits / cancels ──▶ subscriptions
```

## Stack (chosen for low cost + low maintenance)
- **Supabase** — auth, Postgres, Row-Level Security, Edge Functions (Deno), and
  **Supabase Studio** as a day-one admin UI. Free tier to start.
- **Contact-the-administrator access** — there is **no online self-serve billing**.
  A user contacts you (email/DM/etc.), you agree payment offline, and you grant or
  extend their subscription from the admin panel. Simple, no card processing, no
  merchant-of-record, no webhook to maintain.
- **Admin panel** (`supabase/functions/admin/`) — a lightweight, `is_admin`-gated
  web page for granting/editing/canceling subscriptions and viewing usage. It is
  served by an Edge Function, so it is **hosted on Supabase's free tier** with no
  separate web host.

## Repository layout
```
supabase/
  migrations/            # SQL schema: profiles, plans, subscriptions, devices,
                         #   usage, gateway_keys + admin write policies
  functions/
    _shared/             # cors, auth, db clients, entitlement checks, key resolution
    mint-fal-token/      # authorize + mint short-lived fal JWT (the chokepoint)
    proxy-voice/         # authorize + proxy ElevenLabs (keeps voice key server-side)
    usage-heartbeat/     # meter minutes during/after a call
    admin/               # serves the admin panel HTML (index.ts + index.html)
client/
  stream-studio-auth.ts  # drop-in SDK for the desktop app
  integration-guide.md   # how to wire it into stream-studio later
```

## Admin panel
`supabase/functions/admin/` is a static, `is_admin`-gated page with five tabs,
served by an Edge Function. Access is **account-based — there are no license keys.**
- **Users** — grant/edit an account: plan, status, period end, and a **prepaid
  minute wallet** (allocated minutes, or unlimited). The plan sets capability
  (audio-only vs video+audio); the wallet is what you allocate and the user
  consumes until it hits zero. Per row: **top-up minutes**, reset, suspend/resume,
  **unbind devices**, delete, and an optional **linked API key pair**. Searchable.
- **Plans & Pricing** — edit each plan's price, monthly minutes (0 = unlimited),
  device limit, features (`video` / `voice` / `portrait_obs`), and active flag;
  add or delete plans.
- **API Key Vault** — store video (fal.ai) + voice (ElevenLabs) key pairs with
  notes, keep several on file, mark one as the **global default** (master
  fallback), edit, or delete. Readable only by admins and the server (RLS).
- **Pricing & Profit** — set verified base API costs (video / voice-clone /
  natural audio $ per sec) and target profit margin + safety floor; a live
  cost/profit table per call mode; and an interactive **session profit simulator**.
- **Timer & Burn Rates** — per-mode **burn-rate multipliers** (1 real minute = N
  wallet minutes: video+cloned-voice faster, audio-only slower), low-minutes
  warning, auto-terminate at zero; a **rule profit/loss tester** and a
  **minute-package pricing matrix** (break-even + recommended retail).

### How minutes drain (burn rate)
`usage-heartbeat` stores **real** elapsed minutes on the session, then credits
`real × multiplier` to the wallet, where the multiplier comes from `timer_config`
for that call mode (`video-audio` → video_voice, `audio-only` → audio_only,
`video-only` → video_only). Entitlement stops the call when the wallet is empty.

### How a key is chosen for a call
`_shared/keys.ts` resolves, in order: the key pair **linked to the user**
(`subscriptions.key_id`) → the **default** `gateway_keys` row → the
`FAL_KEY` / `ELEVENLABS_KEY` **env secret**. So the dashboard is optional; env
secrets remain the most secure fallback.


## Setup
### 1. Create a Supabase project
At [supabase.com](https://supabase.com), create a project. Grab the **URL**,
**anon key**, and **service_role key** from Settings → API.

### 2. Apply the schema
```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push          # applies all migrations
```
(Or paste the files in `supabase/migrations/` into the SQL editor, in order.)

### 3. Set Edge Function secrets (dashboard → Edge Functions → Secrets)
```
FAL_KEY=...                 # your master fal.ai key
ELEVENLABS_KEY=...          # your master ElevenLabs key
SUPABASE_SERVICE_ROLE_KEY=...
```
> These secrets never live in this repo. The anon key is the only value that ships
> to the client, and it grants nothing by itself (RLS + `is_admin` enforce access).

### 4. Deploy the functions
```bash
supabase functions deploy mint-fal-token
supabase functions deploy proxy-voice
supabase functions deploy usage-heartbeat
supabase functions deploy admin      # hosts the admin panel (see step 6)
```

### 5. Make yourself an admin
In Supabase Studio → Table editor → `profiles`, set `is_admin = true` for your
account (sign up once first so the row exists).

### 6. Open the hosted admin panel
The panel is served by the `admin` Edge Function on Supabase's free tier — no
separate web host, and you never commit your URL or anon key. Once deployed
(step 4), open:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/admin
```
The function injects the project URL and the public anon key at serve time, so
the page is ready to use. Sign in with your admin account (from step 5).

> Prefer to run it locally without deploying? Open
> `supabase/functions/admin/index.html` directly in a browser and paste your
> `SUPABASE_URL` + `SUPABASE_ANON_KEY` over the two placeholder tokens at the top.

### 7. Grant access (contact-the-administrator model)
There is no online checkout. When a user contacts you and you've agreed payment
offline:
1. They sign up once in the app (so a `profiles` row exists).
2. In the admin panel, find their account and **Grant / edit subscription** — pick a
   plan, set status `active`, and set `current_period_end`. This writes
   `billing_provider = 'manual'`.
3. To renew, extend `current_period_end`; to reset a metered plan, use **Reset
   minutes**; to cut access, **Cancel**.

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
- `usage-heartbeat` credits elapsed minutes every 30s and on stop, applying the
  per-mode **burn-rate multiplier** from `timer_config` to the prepaid wallet.

## Security notes & limits
- A short-lived fal token (≤120s, model-scoped) is still visible to its own client;
  that's inherent to browser WebRTC. Blast radius is small. Fully hiding it would
  require proxying media through your server (latency + cost) — not recommended.
- Keep `SUPABASE_SERVICE_ROLE_KEY`, `FAL_KEY`, and `ELEVENLABS_KEY` server-side only.
- This repo contains **no secrets**. `.env.example` lists the variables to set.

## Status
Phase 2: account-based access (no license keys) with a prepaid minute wallet,
per-mode burn rates, an API key vault, and a pricing/profit engine — merged from
the RICH X CAM LIVE admin. Schema (3 migrations), four Edge Functions (three
gateway functions + `admin`, which hosts the panel on Supabase's free tier), a
5-tab admin panel, and a client SDK.

**Live:** deployed to Supabase project `onhanfathvfkkliayvrn` via the GitHub
integration (push to `main` auto-applies migrations + redeploys functions).
Admin panel: `https://onhanfathvfkkliayvrn.supabase.co/functions/v1/admin`.
The `stream-studio` desktop app is unchanged.
