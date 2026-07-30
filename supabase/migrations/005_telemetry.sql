-- ============================================================
-- BONE RUNNER — SECURITY HARDENING PHASE 5
-- ============================================================
-- Adds game state telemetry validation.
-- Prevents "invincibility" cheats by tracking and validating
-- jumps and dodged obstacles.
-- ============================================================

-- 1. Add telemetry columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_sessions' AND column_name = 'jumps_made'
  ) THEN
    ALTER TABLE game_sessions ADD COLUMN jumps_made INT DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_sessions' AND column_name = 'obstacles_dodged'
  ) THEN
    ALTER TABLE game_sessions ADD COLUMN obstacles_dodged INT DEFAULT 0;
  END IF;
END $$;

-- 2. Update send_heartbeat to accept telemetry
-- Must drop the old one first due to signature change
DROP FUNCTION IF EXISTS send_heartbeat(UUID);

CREATE OR REPLACE FUNCTION send_heartbeat(
  p_session_id UUID,
  p_jumps_made INT DEFAULT 0,
  p_obstacles_dodged INT DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session RECORD;
  v_last_heartbeat TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_session
  FROM game_sessions
  WHERE id = p_session_id AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or inactive session';
  END IF;

  SELECT MAX(received_at) INTO v_last_heartbeat
  FROM session_heartbeats
  WHERE session_id = p_session_id;

  IF v_last_heartbeat IS NOT NULL AND v_last_heartbeat > NOW() - INTERVAL '3 seconds' THEN
    RETURN;
  END IF;

  INSERT INTO session_heartbeats (session_id, received_at)
  VALUES (p_session_id, NOW());

  -- Update heartbeat count and highest telemetry values seen so far
  UPDATE game_sessions
  SET heartbeat_count = COALESCE(heartbeat_count, 0) + 1,
      jumps_made = GREATEST(COALESCE(jumps_made, 0), p_jumps_made),
      obstacles_dodged = GREATEST(COALESCE(obstacles_dodged, 0), p_obstacles_dodged)
  WHERE id = p_session_id;
END;
$$;


-- 3. Update end_game_session to validate telemetry
-- Must drop old signatures
DROP FUNCTION IF EXISTS end_game_session(UUID, INT, TEXT);

CREATE OR REPLACE FUNCTION end_game_session(
  p_session_id UUID,
  p_client_score INT,
  p_nonce TEXT DEFAULT NULL,
  p_jumps_made INT DEFAULT 0,
  p_obstacles_dodged INT DEFAULT 0
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session RECORD;
  v_elapsed_seconds NUMERIC;
  v_capped_elapsed NUMERIC;
  v_max_possible_score INT;
  v_heartbeat_count INT;
  v_expected_heartbeats INT;
  v_final_score INT;
  v_final_jumps INT;
  v_final_dodges INT;
  v_max_duration CONSTANT NUMERIC := 300;
BEGIN
  -- Lock the session
  SELECT * INTO v_session
  FROM game_sessions
  WHERE id = p_session_id AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or already-ended session: %', p_session_id;
  END IF;

  -- Validate nonce
  IF v_session.nonce IS NOT NULL THEN
    IF p_nonce IS NULL OR p_nonce != v_session.nonce THEN
      UPDATE game_sessions
      SET status = 'abandoned', ended_at = NOW()
      WHERE id = p_session_id;
      RAISE EXCEPTION 'Invalid session nonce';
    END IF;
  END IF;

  v_elapsed_seconds := EXTRACT(EPOCH FROM (NOW() - v_session.started_at));

  -- Ensure telemetry values are at least what we received in heartbeats
  v_final_jumps := GREATEST(COALESCE(v_session.jumps_made, 0), p_jumps_made);
  v_final_dodges := GREATEST(COALESCE(v_session.obstacles_dodged, 0), p_obstacles_dodged);

  IF v_elapsed_seconds < 2 THEN
    UPDATE game_sessions
    SET status = 'completed', ended_at = NOW(), score = 0,
        client_score = p_client_score, elapsed_seconds = v_elapsed_seconds,
        jumps_made = v_final_jumps, obstacles_dodged = v_final_dodges
    WHERE id = p_session_id;
    RETURN 0;
  END IF;

  v_capped_elapsed := LEAST(v_elapsed_seconds, v_max_duration);

  v_max_possible_score := CEIL(
    (10.0 * v_capped_elapsed + 0.05 * v_capped_elapsed * v_capped_elapsed) * 1.25
  );

  SELECT COUNT(*) INTO v_heartbeat_count
  FROM session_heartbeats
  WHERE session_id = p_session_id;

  v_expected_heartbeats := GREATEST(0, FLOOR(v_elapsed_seconds / 5.0) - 1);

  -- Heartbeat penalty
  IF v_elapsed_seconds > 15 AND v_heartbeat_count < GREATEST(1, v_expected_heartbeats * 0.4) THEN
    v_max_possible_score := LEAST(v_max_possible_score, 50);
  END IF;

  -- TELEMETRY VALIDATION (Anti-Invincibility Cheat)
  -- A legitimate game lasting more than 10 seconds MUST have encountered obstacles
  -- and likely required jumps. If they just stood there, they cheated.
  IF v_elapsed_seconds > 15 AND (v_final_jumps = 0 OR v_final_dodges = 0) THEN
    -- If they claim to have survived 15s without jumping or dodging a single obstacle,
    -- they removed obstacles from the game client.
    v_max_possible_score := 0;
  END IF;

  v_final_score := LEAST(GREATEST(p_client_score, 0), v_max_possible_score);

  UPDATE game_sessions
  SET status = 'completed',
      ended_at = NOW(),
      score = v_final_score,
      client_score = p_client_score,
      elapsed_seconds = v_elapsed_seconds,
      heartbeat_count = v_heartbeat_count,
      jumps_made = v_final_jumps,
      obstacles_dodged = v_final_dodges
  WHERE id = p_session_id;

  UPDATE players
  SET high_score = GREATEST(COALESCE(high_score, 0), v_final_score),
      games_played = COALESCE(games_played, 0) + 1,
      updated_at = NOW()
  WHERE id = v_session.player_id;

  RETURN v_final_score;
END;
$$;
