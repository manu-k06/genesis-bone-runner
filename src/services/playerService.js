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

  // The Postgres trigger 'on_auth_user_created' will automatically insert 
  // the row into live_players using the username we passed in raw_user_meta_data.

  // Reset Turnstile widget if present
  if (typeof turnstile !== 'undefined') {
    try { turnstile.reset(); } catch (_) {}
  }

  // If email confirmation is enabled, session will be null.
  if (!authData.session) {
    throw new Error("Registration successful! Please check your email to confirm your account before logging in.");
  }

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
  const { data: playerData, error: dbError } = await supabase
    .from('live_players')
    .select('id, username')
    .eq('id', authData.user.id)
    .single();

  if (dbError) throw dbError;

  return { id: playerData.id, name: playerData.username };
}

export async function getCurrentPlayer() {
  if (!supabase) return null;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const { data: playerData } = await supabase
    .from('live_players')
    .select('id, username')
    .eq('id', session.user.id)
    .single();
    
  if (!playerData) return null;
  return { id: playerData.id, name: playerData.username };
}
