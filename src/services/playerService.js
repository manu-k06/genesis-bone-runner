import { supabase } from '../supabase.js';

const EVENT_DEADLINE = new Date('2026-08-02T20:00:00+05:30').getTime();

export async function registerPlayer(playerData) {
  if (Date.now() >= EVENT_DEADLINE) throw new Error("Event has ended. Registration is closed.");
  if (!supabase) return null;

  // Get the Turnstile CAPTCHA token (if widget is active)
  let captchaToken = null;
  const turnstileResponse = document.querySelector('[name="cf-turnstile-response"]');
  if (turnstileResponse && turnstileResponse.value) {
    captchaToken = turnstileResponse.value;
  }

  // Use the Edge Function for registration (handles CAPTCHA validation server-side)
  const { data, error } = await supabase.functions.invoke('register-player', {
    body: {
      name: playerData.name,
      phone: playerData.phone,
      department: playerData.department,
      semester: playerData.semester,
      captchaToken: captchaToken
    }
  });

  if (error) {
    throw error;
  }

  // Reset Turnstile widget for next attempt
  if (typeof turnstile !== 'undefined') {
    try { turnstile.reset(); } catch (_) {}
  }

  return data;
}

export async function lookupPlayerByPhone(phone) {
  if (!supabase || !phone) return null;

  // Use server-side RPC function for phone lookup
  const { data, error } = await supabase.rpc('lookup_player_by_phone', {
    p_phone: phone
  });

  if (error || !data) return null;
  return data;
}

// REMOVED: updatePlayerStats()
// Score updates are now handled exclusively by the server-side
// end_game_session RPC function.
