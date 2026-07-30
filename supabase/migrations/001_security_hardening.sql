-- ============================================================
-- BONE RUNNER — SERVER-SIDE SECURITY HARDENING
-- ============================================================
-- Run this entire file in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- This creates/replaces all security-critical database objects.
--
-- IMPORTANT: Back up your data before running this migration.
-- ============================================================


-- ============================================================
-- 1. ENSURE REQUIRED TABLES EXIST
-- ============================================================
-- If these tables already exist, these statements will be skipped.
-- Adjust column types/defaults if your existing schema differs.

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  department TEXT,
  semester TEXT,
  high_score INT DEFAULT 0,
  games_played INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  score INT,
  client_score INT,            -- Store the raw client claim for auditing
  elapsed_seconds NUMERIC,
  heartbeat_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_heartbeats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add columns that may not exist on older schemas
DO $$
BEGIN
  -- Add client_score column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_sessions' AND column_name = 'client_score'
  ) THEN
    ALTER TABLE game_sessions ADD COLUMN client_score INT;
  END IF;

  -- Add elapsed_seconds column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_sessions' AND column_name = 'elapsed_seconds'
  ) THEN
    ALTER TABLE game_sessions ADD COLUMN elapsed_seconds NUMERIC;
  END IF;

  -- Add heartbeat_count column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_sessions' AND column_name = 'heartbeat_count'
  ) THEN
    ALTER TABLE game_sessions ADD COLUMN heartbeat_count INT DEFAULT 0;
  END IF;

  -- Add score column if it doesn't exist  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_sessions' AND column_name = 'score'
  ) THEN
    ALTER TABLE game_sessions ADD COLUMN score INT;
  END IF;
END $$;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_game_sessions_player_status
  ON game_sessions(player_id, status);
CREATE INDEX IF NOT EXISTS idx_game_sessions_player_ended
  ON game_sessions(player_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_session_heartbeats_session
  ON session_heartbeats(session_id);


-- ============================================================
-- 2. START GAME SESSION (Hardened)
-- ============================================================
-- Enforces single active session per player.
-- Rate-limits session creation (minimum 5s between sessions).

CREATE OR REPLACE FUNCTION start_game_session(p_player_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_session_id UUID;
  v_last_ended TIMESTAMPTZ;
BEGIN
  -- Validate player exists
  IF NOT EXISTS (SELECT 1 FROM players WHERE id = p_player_id) THEN
    RAISE EXCEPTION 'Player not found';
  END IF;

  -- Rate limit: reject if the player ended a session less than 5 seconds ago
  SELECT ended_at INTO v_last_ended
  FROM game_sessions
  WHERE player_id = p_player_id
    AND status = 'completed'
  ORDER BY ended_at DESC
  LIMIT 1;

  IF v_last_ended IS NOT NULL AND v_last_ended > NOW() - INTERVAL '5 seconds' THEN
    RAISE EXCEPTION 'Rate limited: please wait a few seconds before starting a new game';
  END IF;

  -- Abandon any existing active sessions for this player
  UPDATE game_sessions
  SET status = 'abandoned', ended_at = NOW()
  WHERE player_id = p_player_id AND status = 'active';

  -- Create new session
  INSERT INTO game_sessions (player_id, status, started_at)
  VALUES (p_player_id, 'active', NOW())
  RETURNING id INTO v_new_session_id;

  RETURN v_new_session_id;
END;
$$;


-- ============================================================
-- 3. SEND HEARTBEAT (Hardened)
-- ============================================================
-- Records a heartbeat and validates the session is active.
-- Rate-limits heartbeats to at most 1 per 3 seconds per session.

CREATE OR REPLACE FUNCTION send_heartbeat(p_session_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session RECORD;
  v_last_heartbeat TIMESTAMPTZ;
BEGIN
  -- Validate session exists and is active
  SELECT * INTO v_session
  FROM game_sessions
  WHERE id = p_session_id AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or inactive session';
  END IF;

  -- Rate limit: at most one heartbeat every 3 seconds
  SELECT MAX(received_at) INTO v_last_heartbeat
  FROM session_heartbeats
  WHERE session_id = p_session_id;

  IF v_last_heartbeat IS NOT NULL AND v_last_heartbeat > NOW() - INTERVAL '3 seconds' THEN
    -- Silently ignore duplicate heartbeats (don't error, just skip)
    RETURN;
  END IF;

  -- Record heartbeat
  INSERT INTO session_heartbeats (session_id, received_at)
  VALUES (p_session_id, NOW());

  -- Update heartbeat count on the session
  UPDATE game_sessions
  SET heartbeat_count = COALESCE(heartbeat_count, 0) + 1
  WHERE id = p_session_id;
END;
$$;


-- ============================================================
-- 4. END GAME SESSION (Hardened — Core Anti-Cheat)
-- ============================================================
-- This is the most critical function. It:
--   1. Validates the session is active
--   2. Computes elapsed time from server timestamps
--   3. Calculates the theoretical maximum score for that duration
--   4. Validates heartbeat count against expected frequency
--   5. Caps the client's claimed score to the server-computed maximum
--   6. Updates the player's high_score using only the validated score
--   7. Returns the validated score so the client displays it
--
-- Score formula (matching client-side):
--   score += dt * 10 * speedMultiplier
--   speedMultiplier starts at 1, increases by 0.01 per second
--   Integral: S_max = 10*T + 0.05*T^2
--   With 25% tolerance: S_max * 1.25

CREATE OR REPLACE FUNCTION end_game_session(p_session_id UUID, p_client_score INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session RECORD;
  v_elapsed_seconds NUMERIC;
  v_max_possible_score INT;
  v_heartbeat_count INT;
  v_expected_heartbeats INT;
  v_final_score INT;
BEGIN
  -- 1. Fetch and lock the session (prevent concurrent end calls)
  SELECT * INTO v_session
  FROM game_sessions
  WHERE id = p_session_id AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or already-ended session: %', p_session_id;
  END IF;

  -- 2. Calculate elapsed time from server-side timestamps
  v_elapsed_seconds := EXTRACT(EPOCH FROM (NOW() - v_session.started_at));

  -- 3. Reject impossibly short games (minimum 2 seconds of real play)
  IF v_elapsed_seconds < 2 THEN
    -- Mark session completed but with zero score
    UPDATE game_sessions
    SET status = 'completed', ended_at = NOW(), score = 0,
        client_score = p_client_score, elapsed_seconds = v_elapsed_seconds
    WHERE id = p_session_id;

    RETURN 0;
  END IF;

  -- 4. Compute theoretical maximum score for this duration
  -- Formula: integral of 10*(1 + 0.01*t) dt from 0 to T = 10T + 0.05T^2
  -- Add 25% tolerance for timing differences and frame timing variance
  v_max_possible_score := CEIL(
    (10.0 * v_elapsed_seconds + 0.05 * v_elapsed_seconds * v_elapsed_seconds) * 1.25
  );

  -- 5. Count actual heartbeats for this session
  SELECT COUNT(*) INTO v_heartbeat_count
  FROM session_heartbeats
  WHERE session_id = p_session_id;

  -- Expected heartbeats: one every 5 seconds, minus 1 for startup delay
  v_expected_heartbeats := GREATEST(0, FLOOR(v_elapsed_seconds / 5.0) - 1);

  -- 6. If heartbeats are suspiciously absent, severely cap the score
  -- A legitimate game of >15 seconds should have at least a couple heartbeats
  IF v_elapsed_seconds > 15 AND v_heartbeat_count < GREATEST(1, v_expected_heartbeats * 0.4) THEN
    -- Suspiciously few heartbeats — cap score to a minimal amount
    v_max_possible_score := LEAST(v_max_possible_score, 50);
  END IF;

  -- 7. Final score = minimum of client claim and server maximum
  v_final_score := LEAST(GREATEST(p_client_score, 0), v_max_possible_score);

  -- 8. Update the session record
  UPDATE game_sessions
  SET status = 'completed',
      ended_at = NOW(),
      score = v_final_score,
      client_score = p_client_score,
      elapsed_seconds = v_elapsed_seconds,
      heartbeat_count = v_heartbeat_count
  WHERE id = p_session_id;

  -- 9. Update player stats (server-authoritative — ONLY path to update high_score)
  UPDATE players
  SET high_score = GREATEST(COALESCE(high_score, 0), v_final_score),
      games_played = COALESCE(games_played, 0) + 1,
      updated_at = NOW()
  WHERE id = v_session.player_id;

  -- 10. Return the validated score so the client displays the correct number
  RETURN v_final_score;
END;
$$;


-- ============================================================
-- 5. ROW-LEVEL SECURITY POLICIES
-- ============================================================
-- These policies ensure the anon key (which is embedded in the client
-- and visible to anyone) cannot directly modify scores or sessions.

-- Enable RLS on all tables
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_heartbeats ENABLE ROW LEVEL SECURITY;

-- ---- PLAYERS TABLE ----

-- Drop existing policies to avoid conflicts (safe to run if they don't exist)
DROP POLICY IF EXISTS "Anyone can read the leaderboard" ON players;
DROP POLICY IF EXISTS "Players can register with zero score" ON players;
DROP POLICY IF EXISTS "Block direct score updates" ON players;
DROP POLICY IF EXISTS "Block direct deletes" ON players;

-- SELECT: Anyone can read (for leaderboard display)
CREATE POLICY "Anyone can read the leaderboard"
  ON players FOR SELECT
  USING (true);

-- INSERT: Allow registration, but ONLY with high_score=0 and games_played=0
-- This prevents a cheater from inserting a player with a pre-set high score
CREATE POLICY "Players can register with zero score"
  ON players FOR INSERT
  WITH CHECK (high_score = 0 AND games_played = 0);

-- UPDATE: Block ALL direct updates from anon key
-- Only SECURITY DEFINER functions (end_game_session) can update
CREATE POLICY "Block direct score updates"
  ON players FOR UPDATE
  USING (false);

-- DELETE: Block direct deletes from anon key
CREATE POLICY "Block direct deletes"
  ON players FOR DELETE
  USING (false);


-- ---- GAME SESSIONS TABLE ----

DROP POLICY IF EXISTS "Block direct session access" ON game_sessions;

-- Block ALL direct access to game_sessions from anon key
-- Only SECURITY DEFINER functions can read/write sessions
CREATE POLICY "Block direct session access"
  ON game_sessions FOR ALL
  USING (false);


-- ---- SESSION HEARTBEATS TABLE ----

DROP POLICY IF EXISTS "Block direct heartbeat access" ON session_heartbeats;

-- Block ALL direct access to session_heartbeats from anon key
CREATE POLICY "Block direct heartbeat access"
  ON session_heartbeats FOR ALL
  USING (false);


-- ============================================================
-- 6. ANOMALY DETECTION VIEW
-- ============================================================
-- Use this view to monitor for cheating attempts.
-- Query: SELECT * FROM suspicious_scores LIMIT 50;

CREATE OR REPLACE VIEW suspicious_scores AS
SELECT
  gs.id AS session_id,
  p.name AS player_name,
  p.phone,
  gs.client_score,
  gs.score AS server_score,
  gs.elapsed_seconds,
  gs.heartbeat_count,
  gs.started_at,
  gs.ended_at,
  CASE
    WHEN gs.client_score > gs.score * 2 THEN '🔴 MAJOR SCORE INFLATION'
    WHEN gs.client_score > gs.score * 1.3 THEN '🟠 SCORE INFLATION ATTEMPT'
    WHEN gs.elapsed_seconds < 3 THEN '🔴 IMPOSSIBLY SHORT GAME'
    WHEN gs.heartbeat_count < GREATEST(1, FLOOR(gs.elapsed_seconds / 5.0) - 1) * 0.4
      AND gs.elapsed_seconds > 15 THEN '🟡 MISSING HEARTBEATS'
    ELSE '✅ NORMAL'
  END AS flag
FROM game_sessions gs
JOIN players p ON gs.player_id = p.id
WHERE gs.status = 'completed'
  AND (
    gs.client_score > COALESCE(gs.score, 0) * 1.1
    OR gs.elapsed_seconds < 3
    OR (gs.heartbeat_count < GREATEST(1, FLOOR(gs.elapsed_seconds / 5.0) - 1) * 0.4
        AND gs.elapsed_seconds > 15)
  )
ORDER BY gs.ended_at DESC;


-- ============================================================
-- 7. CLEANUP: AUTO-ABANDON STALE SESSIONS
-- ============================================================
-- Sessions that have been active for more than 30 minutes with no
-- heartbeat are almost certainly abandoned. Run this periodically
-- (e.g., via a Supabase cron job or Edge Function).

CREATE OR REPLACE FUNCTION cleanup_stale_sessions()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  WITH stale AS (
    UPDATE game_sessions
    SET status = 'abandoned', ended_at = NOW()
    WHERE status = 'active'
      AND started_at < NOW() - INTERVAL '30 minutes'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM stale;

  RETURN v_count;
END;
$$;


-- ============================================================
-- DONE! Summary of what was created/modified:
-- ============================================================
-- Functions:
--   ✅ start_game_session(p_player_id) — single session + rate limit
--   ✅ send_heartbeat(p_session_id)    — rate-limited heartbeats
--   ✅ end_game_session(p_session_id, p_client_score) — server-side score cap
--   ✅ cleanup_stale_sessions()        — auto-abandon old sessions
--
-- RLS Policies:
--   ✅ players: read=all, insert=zero-score-only, update=blocked, delete=blocked
--   ✅ game_sessions: all direct access blocked (RPC only)
--   ✅ session_heartbeats: all direct access blocked (RPC only)
--
-- Views:
--   ✅ suspicious_scores — anomaly detection dashboard
--
-- All score-modifying functions use SECURITY DEFINER to bypass RLS.
-- The anon key can ONLY: read players, insert zero-score players, call RPCs.
