import { serve } from "https://deno.land/std/http/server.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Shared secret for webhook authentication (set this in Supabase Edge Function secrets)
// Generate with: openssl rand -hex 32
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");

serve(async (req) => {
  // Validate the request is from a trusted source (Supabase DB webhook)
  // The webhook should include the secret in the Authorization header
  if (WEBHOOK_SECRET) {
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.includes(WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const payload = await req.json();
    const record = payload.record;

    if (!record || !record.player_id) {
      return new Response("Invalid payload", { status: 400 });
    }

    const playerRes = await fetch(
      `${SUPABASE_URL}/rest/v1/players?id=eq.${record.player_id}&select=*`,
      { headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const players = await playerRes.json();

    if (!Array.isArray(players) || players.length === 0) {
      return new Response("Player not found", { status: 404 });
    }

    const player = players[0];

    const message =
      `🏆 New High Score!\n\n` +
      `Name: ${player.name}\n` +
      `Phone: ${player.phone}\n` +
      `Score: ${record.score}\n` +
      `Elapsed time: ${Math.round(record.elapsed_seconds)}s\n` +
      `Player ID: ${player.id}\n\n` +
      `To delete: /delete ${player.id}`;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
    });

    return new Response("ok");
  } catch (err) {
    return new Response("Internal error", { status: 500 });
  }
});