import { supabase } from '../supabase.js';

export async function registerPlayer({ username, email, password }) {
  if (!supabase) return null;

  // 1. Sign up with Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        username: username
      }
    }
  });

  if (authError) throw authError;
  
  if (!authData.user) throw new Error("Signup failed. Please try again.");

  // Reset Turnstile widget if present
  if (typeof turnstile !== 'undefined') {
    try { turnstile.reset(); } catch (_) {}
  }

  // If email confirmation is enabled, session will be null.
  if (!authData.session) {
    throw new Error("Registration successful! Please check your email to confirm your account before logging in.");
  }

  // Ensure live_players profile exists (in addition to trigger)
  try {
    await supabase
      .from('live_players')
      .upsert({ id: authData.user.id, username }, { onConflict: 'id' });
  } catch (_) {}

  return { id: authData.user.id, name: username };
}

export async function loginPlayer({ email, password }) {
  if (!supabase) return null;

  // 1. Login with Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (authError) throw authError;

  if (!authData.user) throw new Error("Login failed.");

  // 2. Fetch from live_players table
  let { data: playerData, error: dbError } = await supabase
    .from('live_players')
    .select('id, username')
    .eq('id', authData.user.id)
    .maybeSingle();

  if (dbError) {
    console.error("Database error fetching player profile:", dbError);
    if (dbError.code === '42501' || dbError.message?.includes('permission denied')) {
      throw new Error("Database permission denied for 'live_players'. Please run the migration script (009_fix_permissions.sql) in your Supabase SQL Editor.");
    }
    throw dbError;
  }

  // 3. Fallback: If player profile row doesn't exist yet, auto-create it
  if (!playerData) {
    const fallbackUsername = authData.user.user_metadata?.username ||
      authData.user.email?.split('@')[0] ||
      `Player_${authData.user.id.slice(0, 6)}`;

    try {
      const { data: newPlayer, error: insertError } = await supabase
        .from('live_players')
        .upsert({ id: authData.user.id, username: fallbackUsername }, { onConflict: 'id' })
        .select('id, username')
        .maybeSingle();

      if (!insertError && newPlayer) {
        playerData = newPlayer;
      } else {
        playerData = { id: authData.user.id, username: fallbackUsername };
      }
    } catch (_) {
      playerData = { id: authData.user.id, username: fallbackUsername };
    }
  }

  return { id: playerData.id, name: playerData.username || playerData.name };
}

export async function getCurrentPlayer() {
  if (!supabase) return null;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  let { data: playerData, error: dbError } = await supabase
    .from('live_players')
    .select('id, username')
    .eq('id', session.user.id)
    .maybeSingle();
    
  if (dbError || !playerData) {
    const fallbackUsername = session.user.user_metadata?.username ||
      session.user.email?.split('@')[0] ||
      `Player_${session.user.id.slice(0, 6)}`;
    return { id: session.user.id, name: fallbackUsername };
  }
  return { id: playerData.id, name: playerData.username };
}

