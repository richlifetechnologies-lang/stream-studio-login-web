// ─────────────────────────────────────────────────────────────────────────────
// Stream Studio Login Web — client SDK (drop-in for the desktop app)
// ─────────────────────────────────────────────────────────────────────────────
// This module replaces the "user pastes their own API key" flow. Instead the
// user signs in with an email/password subscription account; the master AI keys
// stay on the server. The app asks the gateway for short-lived tokens and
// reports usage. Copy this file into the desktop app's src/lib and wire it in
// per client/integration-guide.md. The existing stream-studio repo is NOT
// modified by this project.
//
// Requires: @supabase/supabase-js (add to the desktop app's dependencies).

import { createClient, type SupabaseClient, type Session } from "@supabase/supabase-js";

export type GatewayConfig = {
  supabaseUrl: string;      // https://YOUR-PROJECT.supabase.co
  supabaseAnonKey: string;  // public anon key (safe in the client)
  falAppId: string;         // fal model alias, e.g. "lucy-2-5"
};

export type Entitlement = {
  planId?: string;
  unlimited?: boolean;
  minutesUsed?: number;
  monthlyMinutes?: number;
};

export class StreamStudioAuth {
  private sb: SupabaseClient;
  private cfg: GatewayConfig;
  private session: Session | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private activeSessionId: string | null = null;

  constructor(cfg: GatewayConfig) {
    this.cfg = cfg;
    this.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  async signIn(email: string, password: string): Promise<void> {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.session = data.session;
  }

  async signUp(email: string, password: string): Promise<void> {
    const { error } = await this.sb.auth.signUp({ email, password });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    await this.stopUsage();
    await this.sb.auth.signOut();
    this.session = null;
  }

  async restore(): Promise<Session | null> {
    const { data } = await this.sb.auth.getSession();
    this.session = data.session;
    return this.session;
  }

  getAccessToken(): string | null {
    return this.session?.access_token ?? null;
  }

  // ── Video: mint a short-lived fal token (starts a metered session) ─────────
  async startVideo(deviceId?: string, tab = "video-audio"): Promise<{ token: string; sessionId: string; entitlement: Entitlement }> {
    const res = await this.invoke("mint-fal-token", { appId: this.cfg.falAppId, deviceId, tab });
    this.activeSessionId = res.sessionId;
    this.beginHeartbeat();
    return res;
  }

  // ── Voice: proxied ElevenLabs call (key never touches the client) ──────────
  async voice(path: string, body?: unknown, isStream = false, deviceId?: string): Promise<Response> {
    const token = this.getAccessToken();
    if (!token) throw new Error("not signed in");
    return fetch(`${this.cfg.supabaseUrl}/functions/v1/proxy-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path, method: "POST", body, isStream, deviceId }),
    });
  }

  // ── Usage metering ────────────────────────────────────────────────────────
  private beginHeartbeat(intervalMs = 30_000) {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => { void this.ping(false); }, intervalMs);
  }
  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
  private async ping(end: boolean) {
    if (!this.activeSessionId) return;
    try { await this.invoke("usage-heartbeat", { sessionId: this.activeSessionId, end }); }
    catch { /* best-effort; the stop call reconciles elapsed time anyway */ }
  }
  async stopUsage(): Promise<void> {
    this.stopHeartbeat();
    await this.ping(true);
    this.activeSessionId = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private async invoke<T = any>(fn: string, body: unknown): Promise<T> {
    const token = this.getAccessToken();
    if (!token) throw new Error("not signed in");
    const res = await fetch(`${this.cfg.supabaseUrl}/functions/v1/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text }; }
    if (!res.ok) {
      const reason = parsed?.reason ? ` (${parsed.reason})` : "";
      throw new Error(`${fn} failed [${res.status}]${reason}: ${parsed?.error ?? text}`);
    }
    return parsed as T;
  }
}

// Stable per-install device id for device binding (persisted by the caller).
export function deviceIdFrom(seed: string): string {
  // Simple, dependency-free stable hash. The desktop app should pass a real
  // machine id (e.g. Electron's machineId) as the seed.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "dev_" + (h >>> 0).toString(16).padStart(8, "0");
}
