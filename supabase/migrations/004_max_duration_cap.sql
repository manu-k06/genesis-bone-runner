-- ============================================================
-- BONE RUNNER — SECURITY HARDENING PHASE 4
-- ============================================================
-- Caps maximum game duration to prevent "invincibility" cheats.
-- A cheater who clears obstacles client-side can survive forever,
-- so we cap the elapsed time used in score calculation.
-- ============================================================

-- Maximum allowed game duration in seconds.
-- Beyond this, the score formula stops growing.
-- 300 seconds (5 minutes) is extremely generous for an endless runner.
-- The theoretical max score at 5 min = (10*300 + 0.05*300²) * 1.25 = 9375

CREATE OR REPLACE FUNCTION end_game_session(
  p_session_id UUID,
  p_client_score INT,
  p_nonce TEXT DEFAULT NULL
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
  v_max_duration CONSTANT NUMERIC := 300; -- 5 minutes max
BEGIN
  -- 1. Fetch and lock the session
  SELECT * INTO v_session
  FROM game_sessions
  WHERE id = p_session_id AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or already-ended session: %', p_session_id;
  END IF;

  -- 2. Validate nonce
  IF v_session.nonce IS NOT NULL THEN
    IF p_nonce IS NULL OR p_nonce != v_session.nonce THEN
      UPDATE game_sessions
      SET status = 'abandoned', ended_at = NOW()
      WHERE id = p_session_id;
      RAISE EXCEPTION 'Invalid session nonce';
    END IF;
  END IF;

  -- 3. Calculate elapsed time
  v_elapsed_seconds := EXTRACT(EPOCH FROM (NOW() - v_session.started_at));

  -- 4. Reject impossibly short games
  IF v_elapsed_seconds < 2 THEN
    UPDATE game_sessions
    SET status = 'completed', ended_at = NOW(), score = 0,
        client_score = p_client_score, elapsed_seconds = v_elapsed_seconds
    WHERE id = p_session_id;
    RETURN 0;
  END IF;

  -- 5. CAP elapsed time for score calculation
  -- Even if someone plays for 30 minutes, score is calculated
  -- as if they played for at most 5 minutes.
  v_capped_elapsed := LEAST(v_elapsed_seconds, v_max_duration);

  -- 6. Compute max score using CAPPED elapsed time
  v_max_possible_score := CEIL(
    (10.0 * v_capped_elapsed + 0.05 * v_capped_elapsed * v_capped_elapsed) * 1.25
  );

  -- 7. Heartbeat validation
  SELECT COUNT(*) INTO v_heartbeat_count
  FROM session_heartbeats
  WHERE session_id = p_session_id;

  v_expected_heartbeats := GREATEST(0, FLOOR(v_elapsed_seconds / 5.0) - 1);

  IF v_elapsed_seconds > 15 AND v_heartbeat_count < GREATEST(1, v_expected_heartbeats * 0.4) THEN
    v_max_possible_score := LEAST(v_max_possible_score, 50);
  END IF;

  -- 8. Final score
  v_final_score := LEAST(GREATEST(p_client_score, 0), v_max_possible_score);

  -- 9. Update session
  UPDATE game_sessions
  SET status = 'completed',
      ended_at = NOW(),
      score = v_final_score,
      client_score = p_client_score,
      elapsed_seconds = v_elapsed_seconds,
      heartbeat_count = v_heartbeat_count
  WHERE id = p_session_id;

  -- 10. Update player stats
  UPDATE players
  SET high_score = GREATEST(COALESCE(high_score, 0), v_final_score),
      games_played = COALESCE(games_played, 0) + 1,
      updated_at = NOW()
  WHERE id = v_session.player_id;

  RETURN v_final_score;
END;
$$;


-- ============================================================
-- DONE! What changed:
-- ============================================================
-- The score formula now uses LEAST(elapsed_seconds, 300) instead
-- of raw elapsed_seconds. This means:
--
--   Max score at 1 min:    ~938 points
--   Max score at 2 min:   ~2,625 points  
--   Max score at 5 min:   ~9,375 points (HARD CAP)
--   Max score at 30 min:  ~9,375 points (same — capped at 5 min)
--
-- A cheater who removes all obstacles and survives for 30 minutes
-- gets the SAME score as someone who survived for 5 minutes.
-- And 5 minutes of genuine survival in an endless runner is
-- already extremely impressive.
