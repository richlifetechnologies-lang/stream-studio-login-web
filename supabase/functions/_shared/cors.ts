// Shared CORS helpers for Supabase Edge Functions.
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export function preflight(): Response {
  return new Response("ok", { headers: corsHeaders });
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, { status });
}
