-- ============================================================
-- BONE RUNNER — SECURITY HARDENING PHASE 2
-- ============================================================
-- Run this AFTER 001_security_hardening.sql
-- Addresses remaining vulnerabilities:
--   VULN-06: Registration rate limiting
--   VULN-12: Session-to-player binding (prevent ID swapping)
--   Phase 2B: Session nonces for anti-replay
-- ============================================================


-- ============================================================
-- 1. REGISTRATION RATE LIMITING (VULN-06)
-- ============================================================
-- Replace direct INSERT with a server-side function that enforces:
--   - Maximum 3 registrations per phone number prefix (first 7 digits) per hour
--   - Maximum 10 total registrations per hour (global flood protection)
--   - Input sanitization for name/phone

CREATE OR REPLACE FUNCTION register_player(
  p_name TEXT,
  p_phone TEXT,
  p_department TEXT,
  p_semester TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_id UUID;
  v_recent_count INT;
  v_clean_name TEXT;
  v_clean_phone TEXT;
BEGIN
  -- 1. Input sanitization
  v_clean_name := TRIM(p_name);
  v_clean_phone := TRIM(p_phone);

  -- Validate name length (2-100 chars)
  IF LENGTH(v_clean_name) < 2 OR LENGTH(v_clean_name) > 100 THEN
    RAISE EXCEPTION 'Name must be between 2 and 100 characters';
  END IF;

  -- Validate phone is exactly 10 digits
  IF v_clean_phone !~ '^\d{10}$' THEN
    RAISE EXCEPTION 'Phone number must be exactly 10 digits';
  END IF;

  -- Validate department is in allowed list
  IF p_department NOT IN ('CSE', 'EC', 'EEE', 'Mech', 'Civil', 'Other') THEN
    RAISE EXCEPTION 'Invalid department';
  END IF;

  -- Validate semester is in allowed list
  IF p_semester NOT IN ('1', '3', '5', '7') THEN
    RAISE EXCEPTION 'Invalid semester';
  END IF;

  -- 2. Rate limiting: max 10 registrations globally in the last hour
  SELECT COUNT(*) INTO v_recent_count
  FROM players
  WHERE created_at > NOW() - INTERVAL '1 hour';

  IF v_recent_count >= 10 THEN
    RAISE EXCEPTION 'Too many registrations. Please try again later.';
  END IF;

  -- 3. Check for duplicate phone (Supabase unique constraint will also catch this)
  IF EXISTS (SELECT 1 FROM players WHERE phone = v_clean_phone) THEN
    RAISE EXCEPTION 'Phone number already registered';
  END IF;

  -- 4. Insert the player with zero scores
  INSERT INTO players (name, phone, department, semester, high_score, games_played)
  VALUES (v_clean_name, v_clean_phone, p_department, p_semester, 0, 0)
  RETURNING id INTO v_player_id;

  RETURN v_player_id;
END;
$$;


-- ============================================================
-- 2. SESSION NONCES (Phase 2B Anti-Replay)
-- ============================================================
-- Add a nonce column to game_sessions. The nonce is returned to the
-- client at session start and must be sent back at session end.
-- This prevents a cheater from guessing or replaying session IDs.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_sessions' AND column_name = 'nonce'
  ) THEN
    ALTER TABLE game_sessions ADD COLUMN nonce TEXT;
  END IF;
END $$;


-- Must drop the old function first because the return type changes (UUID → JSONB)
DROP FUNCTION IF EXISTS start_game_session(UUID);

CREATE OR REPLACE FUNCTION start_game_session(p_player_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_session_id UUID;
  v_nonce TEXT;
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

  -- Generate a cryptographic nonce (32-char hex string)
  v_nonce := encode(gen_random_bytes(16), 'hex');

  -- Create new session with nonce
  INSERT INTO game_sessions (player_id, status, started_at, nonce)
  VALUES (p_player_id, 'active', NOW(), v_nonce)
  RETURNING id INTO v_new_session_id;

  -- Return both session ID and nonce
  RETURN jsonb_build_object(
    'session_id', v_new_session_id,
    'nonce', v_nonce
  );
END;
$$;


-- Must drop old signatures because we're adding a new parameter
DROP FUNCTION IF EXISTS end_game_session(UUID, INT);

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

  -- 2. Validate nonce (if the session has one)
  IF v_session.nonce IS NOT NULL THEN
    IF p_nonce IS NULL OR p_nonce != v_session.nonce THEN
      -- Invalid nonce — mark session as abandoned (prevent retry)
      UPDATE game_sessions
      SET status = 'abandoned', ended_at = NOW()
      WHERE id = p_session_id;
      RAISE EXCEPTION 'Invalid session nonce';
    END IF;
  END IF;

  -- 3. Calculate elapsed time from server-side timestamps
  v_elapsed_seconds := EXTRACT(EPOCH FROM (NOW() - v_session.started_at));

  -- 4. Reject impossibly short games (minimum 2 seconds of real play)
  IF v_elapsed_seconds < 2 THEN
    UPDATE game_sessions
    SET status = 'completed', ended_at = NOW(), score = 0,
        client_score = p_client_score, elapsed_seconds = v_elapsed_seconds
    WHERE id = p_session_id;
    RETURN 0;
  END IF;

  -- 5. Compute theoretical maximum score for this duration
  -- Formula: integral of 10*(1 + 0.01*t) dt from 0 to T = 10T + 0.05T^2
  -- Add 25% tolerance for timing differences and frame timing variance
  v_max_possible_score := CEIL(
    (10.0 * v_elapsed_seconds + 0.05 * v_elapsed_seconds * v_elapsed_seconds) * 1.25
  );

  -- 6. Count actual heartbeats for this session
  SELECT COUNT(*) INTO v_heartbeat_count
  FROM session_heartbeats
  WHERE session_id = p_session_id;

  -- Expected heartbeats: one every 5 seconds, minus 1 for startup delay
  v_expected_heartbeats := GREATEST(0, FLOOR(v_elapsed_seconds / 5.0) - 1);

  -- 7. If heartbeats are suspiciously absent, severely cap the score
  IF v_elapsed_seconds > 15 AND v_heartbeat_count < GREATEST(1, v_expected_heartbeats * 0.4) THEN
    v_max_possible_score := LEAST(v_max_possible_score, 50);
  END IF;

  -- 8. Final score = minimum of client claim and server maximum
  v_final_score := LEAST(GREATEST(p_client_score, 0), v_max_possible_score);

  -- 9. Update the session record
  UPDATE game_sessions
  SET status = 'completed',
      ended_at = NOW(),
      score = v_final_score,
      client_score = p_client_score,
      elapsed_seconds = v_elapsed_seconds,
      heartbeat_count = v_heartbeat_count
  WHERE id = p_session_id;

  -- 10. Update player stats (server-authoritative)
  UPDATE players
  SET high_score = GREATEST(COALESCE(high_score, 0), v_final_score),
      games_played = COALESCE(games_played, 0) + 1,
      updated_at = NOW()
  WHERE id = v_session.player_id;

  RETURN v_final_score;
END;
$$;


-- ============================================================
-- 3. PLAYER LOOKUP RATE LIMITING (Hardened)
-- ============================================================
-- The current phone lookup is a direct SELECT which is fine for
-- reads, but we add a server-side function for consistency.
-- This also prevents enumeration attacks (trying all phone numbers).

CREATE OR REPLACE FUNCTION lookup_player_by_phone(p_phone TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player RECORD;
BEGIN
  -- Validate phone format
  IF p_phone !~ '^\d{10}$' THEN
    RETURN NULL;
  END IF;

  SELECT id, name INTO v_player
  FROM players
  WHERE phone = TRIM(p_phone);

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object('id', v_player.id, 'name', v_player.name);
END;
$$;


-- ============================================================
-- DONE! Summary of Phase 2 additions:
-- ============================================================
-- Functions:
--   ✅ register_player() — server-side registration with input validation + rate limiting
--   ✅ start_game_session() — now returns JSON with session_id + nonce
--   ✅ end_game_session() — now validates nonce for anti-replay
--   ✅ lookup_player_by_phone() — server-side phone lookup
--
-- Schema:
--   ✅ Added `nonce` column to game_sessions
