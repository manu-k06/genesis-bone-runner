import { supabase } from '../supabase.js';

export async function registerPlayer({ username, email, password }) {
  if (!supabase) return null;

  // 1. Sign up with Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
  });

  if (authError) throw authError;
  
  if (!authData.user) throw new Error("Signup failed. Please try again.");

  // 2. Insert into live_players table
  const { data: playerData, error: dbError } = await supabase
    .from('live_players')
    .insert([{ id: authData.user.id, username }])
    .select()
    .single();

  if (dbError) throw dbError;

  // Reset Turnstile widget if present
  if (typeof turnstile !== 'undefined') {
    try { turnstile.reset(); } catch (_) {}
  }

  return { id: playerData.id, name: playerData.username };
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
