import { supabase } from '../supabase.js';

export async function getTopPlayers(limit = 10) {
  if (!supabase) return [];

  // Use server-side RPC — returns only name, department, high_score (no phone)
  const { data, error } = await supabase.rpc('get_live_leaderboard', {
    p_limit: limit
  });

  if (error || !data) return [];
  return data;
}

export async function getPlayerRank(playerId) {
  if (!supabase || !playerId) return null;

  // Use server-side RPC — returns only rank, high_score, name (no phone)
  const { data, error } = await supabase.rpc('get_live_player_rank', {
    p_player_id: playerId
  });

  if (error || !data) return null;
  return data;
}
