import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (supabaseUrl && supabaseAnonKey) 
  ? createClient(supabaseUrl, supabaseAnonKey) 
  : null;

/**
 * Initialize anonymous auth session.
 * This gives each browser a unique JWT without requiring login,
 * which prevents player ID spoofing via localStorage.
 * 
 * Prerequisites: Enable "Anonymous Sign-ins" in Supabase Dashboard:
 *   Authentication → Providers → Anonymous Sign-Ins → Enable
 */
export async function initAnonymousAuth() {
  if (!supabase) return;

  // Check if already signed in
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return;

  // Sign in anonymously — creates a persistent auth session
  const { error } = await supabase.auth.signInAnonymously();
  if (error) {
    // Auth not enabled — game still works, just without auth-based identity binding
  }
}
