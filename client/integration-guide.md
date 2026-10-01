# Integration guide — wiring the desktop app to the gateway

This project is **separate** from the `stream-studio` desktop app. Nothing here
modifies that repo. When you're ready to switch the app from "user pastes their
own API key" to "user signs in with a subscription account", follow these steps
**in the `stream-studio` repo** (not here).

## What changes conceptually
| Today | After |
| --- | --- |
| User enters fal.ai key + ElevenLabs key in Settings | User signs in with email/password |
| Keys stored in `localStorage` on the user's machine | Keys live only in Supabase Edge Function secrets |
| `main.ts` mints the fal token from the user's key | App calls the `mint-fal-token` Edge Function |
| Client sends `xi-api-key` straight to ElevenLabs | Client calls the `proxy-voice` Edge Function |
| No usage limits | Server enforces plan minutes + device binding |

## Step-by-step
1. **Add the dependency** in `stream-studio`:
   ```bash
   npm i @supabase/supabase-js
   ```
2. **Copy the SDK**: copy `client/stream-studio-auth.ts` from this repo into
   `stream-studio/src/lib/stream-studio-auth.ts`.
3. **Create the client** once (e.g. in `App.tsx` or a small `gateway.ts`):
   ```ts
   import { StreamStudioAuth, deviceIdFrom } from "./lib/stream-studio-auth";
   import { machineIdSync } from "node-machine-id"; // or any stable id

   export const auth = new StreamStudioAuth({
     supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
     supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
     falAppId: "lucy-2-5",
   });
   export const DEVICE_ID = deviceIdFrom(machineIdSync());
   ```
4. **Replace the Settings key fields** with a sign-in / sign-up form that calls
   `auth.signIn(email, password)`. Keep the old BYO-key fields behind a hidden
   "advanced" toggle during the transition so existing installs don't break.
5. **Swap token minting.** In `stream.tsx`, `_mintToken(apiKey)` currently calls
   `electronAPI.getFalToken`. Replace the call site so that when signed in it uses:
   ```ts
   const { token, sessionId } = await auth.startVideo(DEVICE_ID, activeTab);
   ```
   and pass `token` into `_startVideoSession` exactly where the minted token is
   used today. The rest of the WebRTC flow is unchanged.
6. **Route voice through the proxy.** Replace the direct ElevenLabs calls
   (`stream.tsx` ~L278 TTS, ~L367 voice upload) with:
   ```ts
   const res = await auth.voice("/v1/text-to-speech/<voiceId>", ttsPayload, true, DEVICE_ID);
   ```
   Read the audio from `res.body` instead of the direct fetch.
7. **Stop metering on teardown.** In `teardownStream()` call `await auth.stopUsage();`.

## Fallback / gradual rollout
Gate the new path behind a flag (e.g. `VITE_USE_GATEWAY=1`). When off, the app
behaves exactly as it does today (BYO-key). This lets you ship the login build
to testers without cutting off existing users, then flip it on for everyone.

## Security notes
- The anon key is public by design; **authorization comes from the signed-in
  user's JWT + RLS + the `is_admin` flag**, not from the anon key.
- Master `FAL_KEY` / `ELEVENLABS_KEY` are set **only** in the Supabase dashboard
  (Edge Functions → Secrets). They never appear in this repo or the app bundle.
- Token minting and voice proxying are the chokepoints: a tampered client still
  can't get AI access without a valid, in-date subscription with minutes left.
