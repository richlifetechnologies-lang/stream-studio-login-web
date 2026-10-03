// Hosts the admin panel as an Edge Function so it lives on the Supabase free
// tier at https://<project>.supabase.co/functions/v1/admin — no separate web
// host, and the anon key is injected at serve time (never committed).
//
// The page is static HTML. The Edge Runtime bundler rejects text import
// attributes, so index.html is inlined into html.ts (regenerate with
// scripts/gen-admin-html.mjs). It carries placeholder tokens (SUPABASE_URL /
// SUPABASE_ANON_KEY) which we replace on each response.
// Access is still gated by the admin's own login + the is_admin RLS policies,
// so serving the shell publicly (verify_jwt = false) is safe.
import { ADMIN_HTML } from "./html.ts";

const PLACEHOLDER_URL = "https://YOUR-PROJECT.supabase.co";
const PLACEHOLDER_KEY = "YOUR-ANON-KEY";

Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors(req) });
  }

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const supabaseUrl =
    Deno.env.get("SUPABASE_PUBLIC_URL") ||
    Deno.env.get("SUPABASE_URL") ||
    new URL(req.url).origin;

  const page = ADMIN_HTML
    .replace(PLACEHOLDER_URL, supabaseUrl)
    .replace(PLACEHOLDER_KEY, anonKey);

  return new Response(page, {
    headers: {
      ...cors(req),
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
});

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  return origin ? { "access-control-allow-origin": origin } : {};
}
