import { supabase } from '../supabase.js';

export async function getGameConfig() {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('live_game_config')
      .select('*')
      .eq('id', 1)
      .single();
    
    if (error) {
      console.warn('Failed to fetch remote config. Falling back to local defaults.', error);
      return null;
    }
    
    return data;
  } catch (err) {
    console.error('Error fetching game config', err);
    return null;
  }
}
