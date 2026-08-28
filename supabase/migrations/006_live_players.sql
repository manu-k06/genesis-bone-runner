-- ============================================================
-- BONE RUNNER — LIVE GAME SCHEMA
-- ============================================================
-- Creates new tables to cleanly deprecate the event tables.
-- Uses standard Supabase Auth for security.
-- ============================================================

-- 1. Create live_players table
CREATE TABLE IF NOT EXISTS live_players (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  high_score INT DEFAULT 0,
  games_played INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create live_game_sessions table
CREATE TABLE IF NOT EXISTS live_game_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES live_players(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  score INT,
  client_score INT,
  elapsed_seconds NUMERIC,
  heartbeat_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Enable RLS
ALTER TABLE live_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_game_sessions ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies for live_players
-- Anyone can view profiles (for leaderboards)
CREATE POLICY "live_players_select_all" 
ON live_players FOR SELECT 
TO PUBLIC
USING (true);

-- Users can only insert/update their own profile
CREATE POLICY "live_players_insert_self" 
ON live_players FOR INSERT 
TO authenticated 
WITH CHECK (auth.uid() = id);

CREATE POLICY "live_players_update_self" 
ON live_players FOR UPDATE 
TO authenticated 
USING (auth.uid() = id);

-- 5. RLS Policies for live_game_sessions
-- Users can manage their own sessions
CREATE POLICY "live_game_sessions_all_self"
ON live_game_sessions FOR ALL
TO authenticated
USING (auth.uid() = player_id)
WITH CHECK (auth.uid() = player_id);

-- 6. RPC: Start Live Game Session
CREATE OR REPLACE FUNCTION start_live_game_session(p_player_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id UUID;
BEGIN
  -- Security check: Must be called by the logged-in user
  IF auth.uid() IS NULL OR auth.uid() != p_player_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Abandon any active sessions for this player
  UPDATE live_game_sessions
  SET status = 'abandoned', ended_at = NOW()
  WHERE player_id = p_player_id AND status = 'active';

  -- Create new session
  INSERT INTO live_game_sessions (player_id)
  VALUES (p_player_id)
  RETURNING id INTO v_session_id;

  RETURN v_session_id;
END;
$$;

-- 7. RPC: End Live Game Session
CREATE OR REPLACE FUNCTION end_live_game_session(
  p_session_id UUID,
  p_score INT,
  p_elapsed_seconds NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session RECORD;
  v_current_high_score INT;
  v_new_high_score BOOLEAN := FALSE;
  v_time_passed NUMERIC;
BEGIN
  -- Get the session
  SELECT * INTO v_session
  FROM live_game_sessions
  WHERE id = p_session_id AND status = 'active' AND player_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or unauthorized session';
  END IF;

  -- End session
  UPDATE live_game_sessions
  SET status = 'completed',
      score = p_score,
      client_score = p_score,
      elapsed_seconds = p_elapsed_seconds,
      ended_at = NOW()
  WHERE id = p_session_id;

  -- Check high score
  SELECT high_score INTO v_current_high_score
  FROM live_players
  WHERE id = v_session.player_id;

  IF p_score > v_current_high_score THEN
    UPDATE live_players
    SET high_score = p_score,
        games_played = games_played + 1,
        updated_at = NOW()
    WHERE id = v_session.player_id;
    v_new_high_score := TRUE;
  ELSE
    UPDATE live_players
    SET games_played = games_played + 1,
        updated_at = NOW()
    WHERE id = v_session.player_id;
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'new_high_score', v_new_high_score,
    'score', p_score
  );
END;
$$;

-- 8. RPC: Get Live Leaderboard
CREATE OR REPLACE FUNCTION get_live_leaderboard(p_limit INT DEFAULT 10)
RETURNS TABLE(username TEXT, high_score INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_limit < 1 THEN p_limit := 1; END IF;
  IF p_limit > 100 THEN p_limit := 100; END IF;

  RETURN QUERY
  SELECT p.username, p.high_score
  FROM live_players p
  ORDER BY p.high_score DESC, p.updated_at ASC
  LIMIT p_limit;
END;
$$;

-- 9. RPC: Get Live Player Rank
CREATE OR REPLACE FUNCTION get_live_player_rank(p_player_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player RECORD;
  v_rank INT;
BEGIN
  -- Get player info
  SELECT p.username, p.high_score INTO v_player
  FROM live_players p
  WHERE p.id = p_player_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Count players with higher scores
  SELECT COUNT(*) + 1 INTO v_rank
  FROM live_players p
  WHERE p.high_score > v_player.high_score
     OR (p.high_score = v_player.high_score AND p.updated_at < (SELECT updated_at FROM live_players WHERE id = p_player_id));

  RETURN jsonb_build_object(
    'rank', v_rank,
    'high_score', v_player.high_score,
    'username', v_player.username
  );
END;
$$;
