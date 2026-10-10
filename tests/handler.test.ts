// node --test tests/   (Node 22.18+; no dependencies, no network)
import assert from "node:assert/strict";
import { test } from "node:test";
import { handle, sign } from "../supabase/functions/send-email/handler.ts";

// a made-up secret for the tests, not a real one
const SECRET = "v1,whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const NOW = 1_760_000_000;

type Sent = { url: string; auth: string; body: Record<string, string> };

function setup(answer: () => Response | Promise<Response> = () => Response.json({ id: "m1", status: "sent" })) {
  const sent: Sent[] = [];
  const env = {
    hookSecret: SECRET,
    email59Key: "e59_live_test",
    supabaseUrl: "https://abcdefghij.supabase.co/",
    appName: "Acme",
    from: "",
    now: () => NOW,
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(String(init.body)) });
      return await answer();
    }) as unknown as typeof fetch,
  };
  return { env, sent };
}

async function call(payload: unknown, opts: { secret?: string; timestamp?: number; raw?: string } = {}) {
  const body = opts.raw ?? JSON.stringify(payload);
  const ts = String(opts.timestamp ?? NOW);
  return new Request("https://example.functions.supabase.co/send-email", {
    method: "POST",
    body,
    headers: { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": await sign(opts.secret ?? SECRET, "msg_1", ts, body) },
  });
}

const signup = {
  user: { email: "new.user@example.com" },
  email_data: { token: "123456", token_hash: "hash+/1", redirect_to: "https://acme.app/welcome?a=1", email_action_type: "signup", site_url: "https://acme.app" },
};

test("signup: one email with the link and the code", async () => {
  const { env, sent } = setup();
  const res = await handle(await call(signup), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://email59.com/v1/send");
  assert.equal(sent[0].auth, "Bearer e59_live_test");
  const b = sent[0].body;
  assert.equal(b.from, "auth");
  assert.equal(b.to, "new.user@example.com");
  assert.equal(b.subject, "Confirm your email for Acme");
  const link = "https://abcdefghij.supabase.co/auth/v1/verify?token=hash%2B%2F1&type=signup&redirect_to=https%3A%2F%2Facme.app%2Fwelcome%3Fa%3D1";
  assert.ok(b.text.includes(link));
  assert.ok(b.text.includes("123456"));
  assert.ok(b.html.includes(link.replaceAll("&", "&amp;")));
});

test("signature matches the Standard Webhooks reference vector", async () => {
  // from the standard-webhooks test suite
  const s = await sign("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", "1614265330", '{"test": 2432232314}');
  assert.equal(s, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("wrong secret, stale timestamp, tampered body and missing headers are refused, nothing is sent", async () => {
  const { env, sent } = setup();
  const other = "v1,whsec_" + Buffer.from("ffffffffffffffffffffffffffffffff").toString("base64");
  assert.equal((await handle(await call(signup, { secret: other }), env)).status, 401);
  assert.equal((await handle(await call(signup, { timestamp: NOW - 301 }), env)).status, 401);
  const good = await call(signup);
  const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: JSON.stringify({ ...signup, user: { email: "attacker@example.com" } }) });
  const res = await handle(tampered, env);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: { http_code: 401, message: "invalid webhook signature" } });
  assert.equal((await handle(new Request(good.url, { method: "POST", body: "{}" }), env)).status, 401);
  assert.equal(sent.length, 0);
});

test("a second signature in the header (secret rotation) is accepted", async () => {
  const { env, sent } = setup();
  const req = await call(signup);
  req.headers.set("webhook-signature", "v1,AAAA " + req.headers.get("webhook-signature"));
  assert.equal((await handle(req, env)).status, 200);
  assert.equal(sent.length, 1);
});

test("secure email change: current address gets token + token_hash_new, new address gets token_new + token_hash", async () => {
  const { env, sent } = setup();
  const res = await handle(await call({
    user: { email: "old@example.com", new_email: "new@example.com" },
    email_data: { token: "111111", token_hash: "h_for_new", token_new: "222222", token_hash_new: "h_for_current", redirect_to: "", email_action_type: "email_change", site_url: "https://acme.app" },
  }), env);
  assert.equal(res.status, 200);
  assert.equal(sent.length, 2);
  const [cur, neu] = sent.map((s) => s.body);
  assert.equal(cur.to, "old@example.com");
  assert.ok(cur.text.includes("111111") && cur.text.includes("token=h_for_current&type=email_change"));
  assert.ok(!cur.text.includes("222222"));
  assert.equal(neu.to, "new@example.com");
  assert.ok(neu.text.includes("222222") && neu.text.includes("token=h_for_new&type=email_change"));
  // no redirect_to in the payload: site_url is used
  assert.ok(neu.text.includes("redirect_to=https%3A%2F%2Facme.app"));
});

test("email change without the secure option: one email, to the new address", async () => {
  const { env, sent } = setup();
  await handle(await call({
    user: { email: "old@example.com", new_email: "new@example.com" },
    email_data: { token: "111111", token_hash: "h1", token_new: "", token_hash_new: "", redirect_to: "", email_action_type: "email_change" },
  }), env);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.to, "new@example.com");
  assert.ok(sent[0].body.text.includes("111111") && sent[0].body.text.includes("token=h1&"));
});

test("reauthentication is code only", async () => {
  const { env, sent } = setup();
  await handle(await call({ user: { email: "u@example.com" }, email_data: { token: "654321", token_hash: "h", email_action_type: "reauthentication" } }), env);
  assert.equal(sent[0].body.subject, "Your Acme confirmation code");
  assert.ok(sent[0].body.text.includes("Code: 654321"));
  assert.ok(!sent[0].body.text.includes("/auth/v1/verify"));
});

test("the app name is escaped in HTML and EMAIL59_FROM is used", async () => {
  const { env, sent } = setup();
  await handle(await call(signup), { ...env, appName: "Tom & <Co>", from: "hello" });
  assert.equal(sent[0].body.from, "hello");
  assert.ok(sent[0].body.html.includes("Tom &amp; &lt;Co&gt;"));
  assert.ok(!sent[0].body.html.includes("<Co>"));
});

test("email59 errors reach Supabase in its error shape", async () => {
  let s = setup(() => Response.json({ detail: "daily_limit_reached" }, { status: 429 }));
  let res = await handle(await call(signup), s.env);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: { http_code: 429, message: "email59 answered 429 (daily_limit_reached)" } });
  s = setup(() => Response.json({ detail: "invalid_api_key" }, { status: 401 }));
  res = await handle(await call(signup), s.env);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /401 \(invalid_api_key\)/);
});

test("bad input: not JSON, no email, no action type, GET, missing or malformed secrets", async () => {
  const { env, sent } = setup();
  assert.equal((await handle(await call(null, { raw: "not json" }), env)).status, 400);
  assert.equal((await handle(await call({ user: {}, email_data: { email_action_type: "signup", token_hash: "h" } }), env)).status, 400);
  assert.equal((await handle(await call({ user: { email: "u@example.com" }, email_data: {} }), env)).status, 400);
  assert.equal((await handle(new Request("https://x.example/", { method: "GET" }), env)).status, 405);
  assert.equal((await handle(await call(signup), { ...env, email59Key: "" })).status, 500);
  assert.equal((await handle(await call(signup), { ...env, hookSecret: "not base64 !!" })).status, 500);
  assert.equal(sent.length, 0);
});
