// Supabase Send Email Hook -> email59.
// No imports: signature check with Web Crypto, one HTTPS call per email. Runs on Deno (Edge Functions) and Node 22+.

export type Env = {
  hookSecret: string; // "v1,whsec_<base64>", from Authentication -> Hooks
  email59Key: string; // "e59_live_..."
  supabaseUrl: string; // https://<ref>.supabase.co (set for you inside Edge Functions)
  appName?: string; // used in subjects and bodies, e.g. "Acme"
  from?: string; // name before the @; mail goes out as <from>@email59.com
  fetch?: typeof fetch; // for tests
  now?: () => number; // for tests, seconds
};

type Message = { to: string; token: string; link: string };

const TOLERANCE_S = 5 * 60; // how old a signed call may be
const SEND_TIMEOUT_MS = 4000; // Supabase gives the hook 5 s in total
const SEND_URL = "https://email59.com/v1/send";

// subject, button label, first line. {app} is replaced with APP_NAME.
const COPY: Record<string, [string, string, string]> = {
  signup: ["Confirm your email for {app}", "Confirm your email", "Thanks for signing up for {app}. Confirm this is your email address:"],
  invite: ["You're invited to {app}", "Accept the invite", "You've been invited to {app}. Accept the invite to set up your account:"],
  magiclink: ["Your sign-in link for {app}", "Sign in", "Use this link to sign in to {app}. It works once:"],
  recovery: ["Reset your {app} password", "Reset password", "Someone asked to reset the password for this {app} account. If it was you:"],
  email_change: ["Confirm your new email for {app}", "Confirm the change", "Confirm the email change on your {app} account:"],
  reauthentication: ["Your {app} confirmation code", "", "Enter this code to confirm it's you:"],
};
const FALLBACK: [string, string, string] = ["Your {app} code", "Continue", "Here is your {app} code:"];

class HookError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The Standard Webhooks signature Supabase sends: "v1,<base64 HMAC-SHA256 of 'id.timestamp.body'>". */
export async function sign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const raw = secret.trim().replace(/^v1,/, "").replace(/^whsec_/, "");
  const key = await crypto.subtle.importKey("raw", fromBase64(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return "v1," + toBase64(new Uint8Array(mac));
}

async function verify(env: Env, headers: Headers, body: string): Promise<void> {
  const id = headers.get("webhook-id") ?? "";
  const timestamp = headers.get("webhook-timestamp") ?? "";
  const signatures = headers.get("webhook-signature") ?? "";
  if (!id || !timestamp || !signatures) throw new HookError(401, "missing webhook signature headers");
  const now = env.now ? env.now() : Date.now() / 1000;
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > TOLERANCE_S) {
    throw new HookError(401, "webhook-timestamp is too old or in the future");
  }
  let expected: string;
  try {
    expected = await sign(env.hookSecret, id, timestamp, body);
  } catch (_) {
    throw new HookError(500, "send-email: SEND_EMAIL_HOOK_SECRET is not a v1,whsec_... secret");
  }
  // the header can carry several space-separated signatures while a secret is being rotated
  if (!signatures.split(" ").some((s) => sameString(s, expected))) throw new HookError(401, "invalid webhook signature");
}

function verifyLink(base: string, tokenHash: string, type: string, redirectTo: string): string {
  let link = `${base.replace(/\/+$/, "")}/auth/v1/verify?token=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(type)}`;
  if (redirectTo) link += `&redirect_to=${encodeURIComponent(redirectTo)}`;
  return link;
}

/** The emails one hook call asks for: one, or two for a secure email change (current and new address). */
// deno-lint-ignore no-explicit-any
export function messages(payload: any, supabaseUrl: string): Message[] {
  const user = payload?.user ?? {};
  const data = payload?.email_data ?? {};
  const type = String(data.email_action_type ?? "");
  if (!type) throw new HookError(400, "email_data.email_action_type is missing");
  const redirectTo = String(data.redirect_to || data.site_url || "");
  const link = (hash: string) => verifyLink(supabaseUrl, hash, type, redirectTo);

  if (type === "email_change" && user.new_email) {
    // Supabase's pairing (the field names are historical):
    //   current address: token     + token_hash_new
    //   new address:     token_new + token_hash
    // With secure email change off there is one email, to the new address, with token + token_hash.
    const out: Message[] = [];
    if (data.token_hash_new && user.email) {
      out.push({ to: user.email, token: data.token ?? "", link: link(data.token_hash_new) });
      if (data.token_hash) out.push({ to: user.new_email, token: data.token_new ?? "", link: link(data.token_hash) });
    } else if (data.token_hash) {
      out.push({ to: user.new_email, token: data.token || data.token_new || "", link: link(data.token_hash) });
    }
    if (!out.length) throw new HookError(400, "nothing to send");
    return out;
  }

  if (!user.email) throw new HookError(400, "user.email is missing");
  // reauthentication is code only: there is nothing to click
  const withLink = data.token_hash && type !== "reauthentication";
  return [{ to: user.email, token: data.token ?? "", link: withLink ? link(data.token_hash) : "" }];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Subject, HTML and plain text for one auth email. Edit COPY above, or replace this function with your own template. */
export function render(type: string, appName: string, m: Message): { subject: string; html: string; text: string } {
  const [subjectT, button, introT] = COPY[type] ?? FALLBACK;
  const app = appName || "your account";
  const intro = introT.replace("{app}", app);
  const note = "If you didn't ask for this, you can ignore this email.";
  const text = [intro, ""];
  const html = [`<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;line-height:1.5">`, `<p>${escapeHtml(intro)}</p>`];
  const showLink = Boolean(m.link && button);
  if (showLink) {
    html.push(
      `<p><a href="${escapeHtml(m.link)}" style="display:inline-block;background:#111;color:#fff;` +
        `padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(button)}</a></p>`,
    );
    text.push(m.link, "");
  }
  if (m.token) {
    const label = showLink ? "Or enter this code:" : "Code:";
    html.push(`<p>${label} <strong style="font-size:20px;letter-spacing:2px">${escapeHtml(m.token)}</strong></p>`);
    text.push(`${label} ${m.token}`, "");
  }
  html.push(`<p style="color:#555">${note}</p></div>`);
  text.push(note);
  return { subject: subjectT.replace("{app}", app), html: html.join(""), text: text.join("\n") };
}

async function send(env: Env, type: string, m: Message, signal: AbortSignal): Promise<void> {
  const res = await (env.fetch ?? fetch)(SEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.email59Key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.from || "auth", to: m.to, ...render(type, env.appName ?? "", m) }),
    signal,
  });
  if (res.ok) return;
  let detail = "";
  try {
    detail = String((await res.json()).detail ?? "");
  } catch (_) {
    // not JSON: the status is enough
  }
  // 429 = the sending allowance is used up; pass it on so Supabase shows a clear error instead of "check your inbox"
  throw new HookError(res.status === 429 ? 429 : 502, `email59 answered ${res.status}${detail ? ` (${detail})` : ""}`);
}

function reply(status: number, message?: string): Response {
  // the error shape Supabase Auth expects from a hook
  const body = message ? { error: { http_code: status, message } } : {};
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handle(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return reply(405, "POST only");
  if (!env.hookSecret || !env.email59Key || !env.supabaseUrl) {
    return reply(500, "send-email: set SEND_EMAIL_HOOK_SECRET and EMAIL59_KEY (supabase secrets set ...)");
  }
  const body = await req.text();
  const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS);
  try {
    await verify(env, req.headers, body);
    const payload = JSON.parse(body);
    const type = String(payload?.email_data?.email_action_type ?? "");
    for (const m of messages(payload, env.supabaseUrl)) await send(env, type, m, timeout);
    return reply(200);
  } catch (e) {
    if (e instanceof HookError) return reply(e.status, e.message);
    if (e instanceof SyntaxError) return reply(400, "body is not JSON");
    if (timeout.aborted) return reply(504, "email59 was slow to answer; the email may still arrive");
    console.error(e);
    return reply(500, "send-email: unexpected error, see the function logs");
  }
}
