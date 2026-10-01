// POST/GET proxy-voice
// Forwards allowed ElevenLabs API calls using the server-side ELEVENLABS_KEY so
// the voice key never reaches the desktop client. Enforces the 'voice' feature
// entitlement. The target path is restricted to an allow-list to prevent this
// function from being abused as an open proxy (SSRF).
//
// Body (POST): { path: string, method?: "POST"|"GET", body?: unknown, isStream?: boolean }
//   path examples: "/v1/text-to-speech/<voiceId>", "/v1/voices/add", "/v1/voices"
import { corsHeaders, preflight, json, fail } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { checkEntitlement } from "../_shared/entitlements.ts";

const ELEVEN_BASE = "https://api.elevenlabs.io";

// Only these path prefixes may be proxied.
const ALLOWED_PREFIXES = [
  "/v1/text-to-speech/",
  "/v1/voices",
  "/v1/speech-to-speech/",
];

function isAllowed(path: string): boolean {
  return ALLOWED_PREFIXES.some((p) => path.startsWith(p));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method not allowed", 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const path = typeof body.path === "string" ? body.path : "";
    const method = body.method === "GET" ? "GET" : "POST";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : undefined;

    if (!path || !isAllowed(path)) return fail("path not allowed", 403);

    const ent = await checkEntitlement(user.id, "voice", deviceId);
    if (!ent.allowed) return fail("not entitled", 403, { reason: ent.reason });

    const key = Deno.env.get("ELEVENLABS_KEY");
    if (!key) return fail("server missing ELEVENLABS_KEY", 500);

    const upstream = await fetch(ELEVEN_BASE + path, {
      method,
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: body.isStream ? "audio/mpeg" : "application/json",
      },
      body: method === "POST" && body.body !== undefined ? JSON.stringify(body.body) : undefined,
    });

    // Stream audio back verbatim; otherwise pass JSON through.
    const ct = upstream.headers.get("content-type") ?? "";
    if (ct.startsWith("audio/") || body.isStream) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...corsHeaders, "Content-Type": ct || "audio/mpeg" },
      });
    }
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...corsHeaders, "Content-Type": ct || "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unauthorized";
    const status = /authoriz|session|token/i.test(msg) ? 401 : 500;
    return fail(msg, status);
  }
});
