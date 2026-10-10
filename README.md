# Supabase Send Email Hook for email59

A small Supabase Edge Function that sends your project's auth emails (sign-up confirmation, magic link, password
reset, invite, email change, reauthentication code) through the [email59](https://email59.com) API.

It exists for one situation: Supabase's built-in email sender stops at **2 emails an hour** and only delivers to
your team's addresses, and you'd like real sign-ups to work today, before you've set up a domain, DNS records or an
SMTP provider. Mail goes out from `<name>@email59.com`, so there is nothing to verify.

- One file of logic, no dependencies, no SDK. The signature check uses Web Crypto.
- Checks Supabase's signature (Standard Webhooks) and refuses calls older than five minutes.
- Sends every auth email type, including both halves of a secure email change.
- Gives up after 4 seconds and returns an error Supabase can show, instead of a silent timeout.
- MIT licensed. Copy it, change the wording, swap the email API for another one.

*Disclosure: this repo is maintained by Biz59 LLC, the company that runs email59.*

## Two ways to use it

| | A. Hosted hook (no code) | B. This Edge Function |
|---|---|---|
| What you deploy | Nothing | One function in your Supabase project |
| Where the email wording lives | email59's defaults, with your app name | Your code: edit `COPY` or `render()` |
| Where the hook secret lives | Stored at email59, so it can check signatures | Only in your Supabase project |
| Time | About 2 minutes | About 10 minutes |

Pick A if you just want sign-ups to work tonight. Pick B if you want the code and the secret in your own project,
or your own wording.

Both need an email59 API key. Getting one takes two calls and no credit card:

```bash
# 1. Ask for a 6-digit code
curl -s https://email59.com/v1/auth -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'

# 2. Send the code back; the answer has a session key (e59s_...)
curl -s https://email59.com/v1/auth -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","otp":"123456"}'

# 3. Make a long-lived key for the server (shown once)
curl -s https://email59.com/v1/keys -H 'Authorization: Bearer e59s_...' \
  -H 'Content-Type: application/json' -d '{"label":"supabase"}'
```

Or sign in at [email59.com/account.html](https://email59.com/account.html) and create a key there.

## A. Hosted hook (no code)

1. In the Supabase dashboard: **Authentication → Hooks → Send Email Hook**, type **HTTPS**. Click *Generate secret*
   and copy it (`v1,whsec_...`). Leave the URL empty for now.
2. Register the hook with email59. `supabase_url` is your project URL (Project Settings → API).

   ```bash
   curl -s https://email59.com/v1/hooks/supabase \
     -H 'Authorization: Bearer e59_live_...' -H 'Content-Type: application/json' \
     -d '{"secret":"v1,whsec_...","supabase_url":"https://abcdefghij.supabase.co","app_name":"Acme","from":"auth"}'
   ```

   The answer has a `url` like `https://email59.com/v1/hooks/supabase/sbh_...`.
3. Paste that URL into the Supabase hook and save.
4. Under **Authentication → Rate Limits**, raise the email limit. It becomes adjustable once a hook (or custom
   SMTP) is in place. Sign up with a test address.

`GET /v1/hooks/supabase` lists your hooks with a call count. `DELETE /v1/hooks/supabase/{id}` turns one off; the
URL stops working at once. Details: [email59 docs, Supabase auth emails](https://email59.com/docs.html#supabase).

## B. This Edge Function

You need the [Supabase CLI](https://supabase.com/docs/guides/cli), logged in and linked to your project
(`supabase login`, `supabase link --project-ref <ref>`).

1. Copy the function into your project:

   ```bash
   npx degit icedsg/supabase-email59-send-hook/supabase/functions/send-email supabase/functions/send-email
   ```

   (Or copy `index.ts` and `handler.ts` by hand; that's all there is.)

2. In the dashboard: **Authentication → Hooks → Send Email Hook**, type **HTTPS**. Click *Generate secret* and copy
   it. Leave the URL empty for now.

3. Set the secrets. `SUPABASE_URL` is already there inside Edge Functions.

   ```bash
   supabase secrets set \
     SEND_EMAIL_HOOK_SECRET='v1,whsec_...' \
     EMAIL59_KEY='e59_live_...' \
     APP_NAME='Acme' \
     EMAIL59_FROM='auth'
   ```

4. Deploy. The function checks the hook signature itself, so Supabase's JWT check is switched off for it:

   ```bash
   supabase functions deploy send-email --no-verify-jwt
   ```

   To keep that setting in the repo instead of on the command line, add the block from
   [`supabase/config.toml.example`](supabase/config.toml.example) to your `supabase/config.toml`.

5. Back in the hook settings, set the URL to `https://<ref>.supabase.co/functions/v1/send-email` and save.

6. Under **Authentication → Rate Limits**, raise the email limit. It becomes adjustable once a hook (or custom
   SMTP) is in place.

7. Sign up with a test address. If nothing arrives, `supabase functions logs send-email` shows why.

### Settings

| Secret | Required | What it does |
|---|---|---|
| `SEND_EMAIL_HOOK_SECRET` | yes | The secret Supabase generated for the hook, as shown (`v1,whsec_...`). |
| `EMAIL59_KEY` | yes | Your email59 API key. |
| `APP_NAME` | no | Used in subjects and the first line: "Confirm your email for Acme". |
| `EMAIL59_FROM` | no | The name before the @. Default `auth`, so mail comes from `auth@email59.com`. |

### Changing the emails

Subjects, button labels and first lines are in the `COPY` table at the top of
[`handler.ts`](supabase/functions/send-email/handler.ts). For a different layout, rewrite `render()`: it gets the
action type, your app name, the 6-digit code and the link, and returns `{ subject, html, text }`. Keep it light;
Supabase waits about five seconds for the whole hook.

### Trying it without Supabase

```bash
npm test          # Node 22.18 or newer; no install step, no network
```

To send one real email through a function you're serving locally (`supabase functions serve send-email
--no-verify-jwt --env-file supabase/functions/.env`, see [`.env.example`](.env.example)):

```bash
SEND_EMAIL_HOOK_SECRET='v1,whsec_...' node scripts/send-test-call.ts \
  http://localhost:54321/functions/v1/send-email you@example.com
```

The link in that email is a dummy; the point is to see it arrive.

## What to expect

- **Every email is one HTTPS call.** A secure email change is two (current and new address).
- **Errors are passed on.** If email59 refuses a send, the function answers with
  `{"error": {"http_code": ..., "message": ...}}` and Supabase shows your user an error rather than "check your
  inbox". A used-up sending allowance comes back as `429`.
- **The sender is always `@email59.com`.** You choose the name before the @. Replies aren't received, and every
  email carries a short "system generated" line. When you're ready for your own domain, change the `fetch` call in
  `send()` to your provider, or switch Supabase to custom SMTP; nothing else here is email59-specific.
- **There is a free daily allowance** and credits after that, with no subscription. The current numbers are on the
  [pricing page](https://email59.com/pricing.html). If a launch could bring more sign-ups in a day than the
  allowance covers, sort that out before you post the link. Today the allowance is 200 emails a day; accounts made
  through the API start at 50 a day until they've signed in on the website (or paid, or built up a week of use).
- **The email text is fixed on the hosted hook** (your app name in the subject, a button, the code). For your own
  wording, use the Edge Function.

## What email59 sees and keeps

Your users' auth codes and verify links pass through email59 and its sending provider, as they would through any
hook or SMTP provider.

- The message log keeps the recipient address and the subject of each email, not the body, the code or the link.
- Hosted hook only: the hook secret is stored at email59 so it can check Supabase's signature.
  `DELETE /v1/hooks/supabase/{id}` turns the URL off at once. With the Edge Function the secret stays in your
  Supabase project.
- The email59 service itself is closed source; this function is the public part.
- **Links go through your project's `/auth/v1/verify`**, the same as Supabase's own emails, so your redirect URLs
  and allow-list work unchanged.

## How it works

Supabase Auth POSTs a JSON payload (`user`, and `email_data` with `token`, `token_hash`, `email_action_type`,
`redirect_to`, ...) with three headers: `webhook-id`, `webhook-timestamp` and `webhook-signature`. The signature is
`v1,` plus the base64 HMAC-SHA256 of `id.timestamp.body`, keyed with the base64-decoded part of the secret after
`whsec_`. The function recomputes it, compares in constant time, builds the verify link and calls
`POST https://email59.com/v1/send` once per recipient.

For a secure email change Supabase sends two codes and two hashes, and the field names are historical: the
**current** address gets `token` with `token_hash_new`, the **new** address gets `token_new` with `token_hash`.
The function follows that pairing.

Reference: [Supabase docs, Send Email Hook](https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook).
Background on the 2-an-hour limit and the other way out (custom SMTP):
[Supabase stops at 2 emails an hour](https://email59.com/articles/supabase-email-rate-limit-2-an-hour-fix.html).

## Licence

[MIT](LICENSE). Issues and pull requests are welcome.
