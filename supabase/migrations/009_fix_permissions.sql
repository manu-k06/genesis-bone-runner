-- ============================================================
-- BONE RUNNER — FIX PERMISSIONS & PROFILE SYNC (MIGRATION 009)
-- ============================================================
-- Fixes "permission denied for table live_players" (code 42501).
-- In PostgreSQL/Supabase, RLS policies only filter rows if the
-- calling role (anon / authenticated) has table-level privileges.
-- This script grants appropriate table and schema privileges,
-- ensures new users are auto-provisioned, and backfills existing users.
-- ============================================================

-- 1. Ensure schema usage
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- 2. Grant privileges for live_players
GRANT SELECT ON TABLE public.live_players TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.live_players TO authenticated;
GRANT ALL ON TABLE public.live_players TO service_role;

-- 3. Grant privileges for live_game_sessions
GRANT SELECT ON TABLE public.live_game_sessions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.live_game_sessions TO authenticated;
GRANT ALL ON TABLE public.live_game_sessions TO service_role;

-- 4. Grant privileges for live_game_config
GRANT SELECT ON TABLE public.live_game_config TO anon, authenticated;
GRANT ALL ON TABLE public.live_game_config TO service_role;

-- 5. Grant execute permissions on RPC functions
GRANT EXECUTE ON FUNCTION public.get_live_leaderboard(INT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_live_player_rank(UUID) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_live_game_session(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.end_live_game_session(UUID, INT, NUMERIC) TO authenticated, service_role;

-- 6. Grant sequence privileges (if any are used)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- 7. Ensure future tables & sequences automatically receive permissions
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- 8. Backfill any existing auth.users who lack a row in live_players
INSERT INTO public.live_players (id, username)
SELECT 
  u.id,
  COALESCE(
    NULLIF(u.raw_user_meta_data->>'username', ''),
    'Player_' || substr(u.id::text, 1, 6)
  )
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.live_players lp WHERE lp.id = u.id
)
ON CONFLICT (id) DO NOTHING;

-- 9. Enhance trigger function to prevent unique constraint conflicts on username
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username TEXT;
BEGIN
  v_username := COALESCE(
    NULLIF(new.raw_user_meta_data->>'username', ''),
    'Player_' || substr(new.id::text, 1, 6)
  );

  -- If username already taken by another account, append a unique suffix
  IF EXISTS (SELECT 1 FROM public.live_players WHERE username = v_username AND id != new.id) THEN
    v_username := v_username || '_' || substr(new.id::text, 1, 4);
  END IF;

  INSERT INTO public.live_players (id, username)
  VALUES (new.id, v_username)
  ON CONFLICT (id) DO UPDATE
  SET username = EXCLUDED.username
  WHERE live_players.username IS NULL OR live_players.username = '';
  
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user();

-- 10. Provide send_heartbeat function that works with live_game_sessions
CREATE OR REPLACE FUNCTION public.send_heartbeat(
  p_session_id UUID,
  p_jumps_made INT DEFAULT 0,
  p_obstacles_dodged INT DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE live_game_sessions
  SET heartbeat_count = COALESCE(heartbeat_count, 0) + 1
  WHERE id = p_session_id AND status = 'active';

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'game_sessions') THEN
    UPDATE game_sessions
    SET heartbeat_count = COALESCE(heartbeat_count, 0) + 1,
        jumps_made = GREATEST(COALESCE(jumps_made, 0), p_jumps_made),
        obstacles_dodged = GREATEST(COALESCE(obstacles_dodged, 0), p_obstacles_dodged)
    WHERE id = p_session_id AND status = 'active';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_heartbeat(UUID, INT, INT) TO authenticated, anon, service_role;
