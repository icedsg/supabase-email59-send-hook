// supabase/functions/send-email/index.ts
// Entry point for the Edge Function. The work is in handler.ts.
import { handle } from "./handler.ts";

Deno.serve((req) =>
  handle(req, {
    hookSecret: Deno.env.get("SEND_EMAIL_HOOK_SECRET") ?? "",
    email59Key: Deno.env.get("EMAIL59_KEY") ?? "",
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    appName: Deno.env.get("APP_NAME") ?? "",
    from: Deno.env.get("EMAIL59_FROM") ?? "",
  })
);
