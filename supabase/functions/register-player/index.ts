import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "@supabase/supabase-js";

// Cloudflare Turnstile secret key
// Set this in: Supabase Dashboard → Edge Functions → register-player → Secrets
// Get a free key at: https://dash.cloudflare.com/ → Turnstile → Add Site
const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { name, phone, department, semester, captchaToken } = await req.json();

    // 1. Validate CAPTCHA token with Cloudflare Turnstile
    if (TURNSTILE_SECRET) {
      if (!captchaToken) {
        return new Response(
          JSON.stringify({ error: "CAPTCHA verification required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: TURNSTILE_SECRET,
          response: captchaToken,
        }),
      });

      const verifyData = await verifyRes.json();

      if (!verifyData.success) {
        return new Response(
          JSON.stringify({ error: "CAPTCHA verification failed. Please try again." }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 2. Get the user's auth token from the request (for auth.uid() binding)
    const authHeader = req.headers.get("Authorization") || "";
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    // 3. Call the DB function to register the player
    const { data, error } = await supabase.rpc("register_player", {
      p_name: name,
      p_phone: phone,
      p_department: department,
      p_semester: semester,
    });

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ id: data }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Registration failed. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
