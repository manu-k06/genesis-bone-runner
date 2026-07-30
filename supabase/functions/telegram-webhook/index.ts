import { serve } from "https://deno.land/std/http/server.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

serve(async (req) => {
  try {
    const update = await req.json();
    const message = update.message;

    // Only respond to messages from YOUR specific chat
    if (!message || String(message.chat.id) !== CHAT_ID) {
      return new Response("ignored");
    }

    const text = message.text?.trim() || "";

    if (text.startsWith("/delete ")) {
      const playerId = text.replace("/delete ", "").trim();

      // Validate playerId looks like a UUID to prevent injection
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(playerId)) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: CHAT_ID, text: `❌ Invalid player ID format: ${playerId}` }),
        });
        return new Response("invalid id");
      }

      const headers: Record<string, string> = {
        apikey: serviceKey!,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      };

      // Delete in correct order to respect foreign key constraints
      await fetch(`${supabaseUrl}/rest/v1/session_heartbeats?session_id=in.(select id from game_sessions where player_id=eq.${playerId})`, { method: "DELETE", headers });
      await fetch(`${supabaseUrl}/rest/v1/game_sessions?player_id=eq.${playerId}`, { method: "DELETE", headers });
      await fetch(`${supabaseUrl}/rest/v1/players?id=eq.${playerId}`, { method: "DELETE", headers });

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: `✅ Deleted player ${playerId}` }),
      });
    }

    return new Response("ok");
  } catch (err) {
    return new Response("Internal error", { status: 500 });
  }
});
