// Sends one signed test call to a running function, the way Supabase Auth would.
//   deno run --allow-net --allow-env scripts/send-test-call.ts http://localhost:54321/functions/v1/send-email you@example.com
//   node scripts/send-test-call.ts <function url> <email>            (Node 22.18+)
// Needs SEND_EMAIL_HOOK_SECRET in the environment (the same value the function has).
import process from "node:process";
import { sign } from "../supabase/functions/send-email/handler.ts";

const [url, email] = process.argv.slice(2);
const secret = process.env.SEND_EMAIL_HOOK_SECRET;
if (!url || !email || !secret) {
  console.error("usage: SEND_EMAIL_HOOK_SECRET=v1,whsec_... node scripts/send-test-call.ts <function url> <email>");
  process.exit(1);
}

const body = JSON.stringify({
  user: { email },
  email_data: { token: "123456", token_hash: "test-hash", redirect_to: "https://example.com/", email_action_type: "magiclink", site_url: "https://example.com" },
});
const id = "msg_test_" + Date.now();
const timestamp = String(Math.floor(Date.now() / 1000));
const res = await fetch(url, {
  method: "POST",
  body,
  headers: { "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": await sign(secret, id, timestamp, body) },
});
console.log(res.status, await res.text());
