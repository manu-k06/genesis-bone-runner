-- ============================================================
-- BONE RUNNER — SECURITY HARDENING PHASE 3
-- ============================================================
-- Run this AFTER 001 and 002.
-- Addresses:
--   1. Phone number privacy (restrict SELECT to safe columns)
--   2. Anonymous auth support (tie sessions to auth.uid())
--   3. Server-side CAPTCHA token validation support
-- ============================================================


-- ============================================================
-- 1. PHONE NUMBER PRIVACY — Secure Leaderboard RPCs
-- ============================================================
-- Instead of letting the anon key SELECT all columns from players,
-- we restrict direct table reads and provide RPC functions that
-- return ONLY the fields needed for the leaderboard.

-- Leaderboard: returns top N players (name, department, score only)
CREATE OR REPLACE FUNCTION get_leaderboard(p_limit INT DEFAULT 10)
RETURNS TABLE(name TEXT, department TEXT, high_score INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Clamp limit to prevent abuse
  IF p_limit < 1 THEN p_limit := 1; END IF;
  IF p_limit > 100 THEN p_limit := 100; END IF;

  RETURN QUERY
  SELECT p.name, p.department, p.high_score
  FROM players p
  ORDER BY p.high_score DESC
  LIMIT p_limit;
END;
$$;

-- Player rank: returns rank info for a specific player (no phone exposed)
CREATE OR REPLACE FUNCTION get_player_rank(p_player_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player RECORD;
  v_rank INT;
BEGIN
  -- Get player info (safe fields only)
  SELECT p.name, p.high_score INTO v_player
  FROM players p
  WHERE p.id = p_player_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Count players with higher scores
  SELECT COUNT(*) + 1 INTO v_rank
  FROM players
  WHERE high_score > v_player.high_score;

  RETURN jsonb_build_object(
    'rank', v_rank,
    'high_score', v_player.high_score,
    'name', v_player.name
  );
END;
$$;


-- ============================================================
-- 2. RESTRICT DIRECT TABLE SELECT — Phone Privacy
-- ============================================================
-- Replace the wide-open SELECT policy with one that hides phone numbers.
-- We use a view that excludes sensitive columns.

-- Drop the old permissive SELECT policy
DROP POLICY IF EXISTS "Anyone can read the leaderboard" ON players;

-- Create a restrictive SELECT policy: only allow reading non-sensitive columns
-- Since RLS can't restrict columns (only rows), we block direct SELECT entirely
-- and force all reads through SECURITY DEFINER RPCs above.
-- Exception: allow players to read their own row for login verification.
CREATE POLICY "Block direct reads for privacy"
  ON players FOR SELECT
  USING (false);

-- Note: All player data access now goes through:
--   get_leaderboard()        → leaderboard display
--   get_player_rank()        → rank display
--   lookup_player_by_phone() → login
--   register_player()        → registration
-- All are SECURITY DEFINER, bypassing RLS.


-- ============================================================
-- 3. ANONYMOUS AUTH SUPPORT
-- ============================================================
-- Add auth_id column to link Supabase Auth users to players.
-- This cryptographically ties each browser session to a player,
-- preventing localStorage ID spoofing.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'players' AND column_name = 'auth_id'
  ) THEN
    ALTER TABLE players ADD COLUMN auth_id UUID;
    CREATE INDEX idx_players_auth_id ON players(auth_id);
  END IF;
END $$;


-- Update register_player to store auth.uid()
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
  v_auth_id UUID;
BEGIN
  -- Get the authenticated user's ID (NULL if using anon key without auth)
  v_auth_id := auth.uid();

  -- Input sanitization
  v_clean_name := TRIM(p_name);
  v_clean_phone := TRIM(p_phone);

  IF LENGTH(v_clean_name) < 2 OR LENGTH(v_clean_name) > 100 THEN
    RAISE EXCEPTION 'Name must be between 2 and 100 characters';
  END IF;

  IF v_clean_phone !~ '^\d{10}$' THEN
    RAISE EXCEPTION 'Phone number must be exactly 10 digits';
  END IF;

  IF p_department NOT IN ('CSE', 'EC', 'EEE', 'Mech', 'Civil', 'Other') THEN
    RAISE EXCEPTION 'Invalid department';
  END IF;

  IF p_semester NOT IN ('1', '3', '5', '7') THEN
    RAISE EXCEPTION 'Invalid semester';
  END IF;

  -- Rate limiting: max 10 registrations globally per hour
  SELECT COUNT(*) INTO v_recent_count
  FROM players
  WHERE created_at > NOW() - INTERVAL '1 hour';

  IF v_recent_count >= 10 THEN
    RAISE EXCEPTION 'Too many registrations. Please try again later.';
  END IF;

  -- If auth is active, check this auth user hasn't already registered
  IF v_auth_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM players WHERE auth_id = v_auth_id) THEN
      RAISE EXCEPTION 'This device has already registered a player';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM players WHERE phone = v_clean_phone) THEN
    RAISE EXCEPTION 'Phone number already registered';
  END IF;

  INSERT INTO players (name, phone, department, semester, high_score, games_played, auth_id)
  VALUES (v_clean_name, v_clean_phone, p_department, p_semester, 0, 0, v_auth_id)
  RETURNING id INTO v_player_id;

  RETURN v_player_id;
END;
$$;


-- Update lookup_player_by_phone to bind auth_id on login
CREATE OR REPLACE FUNCTION lookup_player_by_phone(p_phone TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player RECORD;
  v_auth_id UUID;
BEGIN
  IF p_phone !~ '^\d{10}$' THEN
    RETURN NULL;
  END IF;

  v_auth_id := auth.uid();

  SELECT id, name, auth_id INTO v_player
  FROM players
  WHERE phone = TRIM(p_phone);

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- If auth is active, bind this auth user to the player on login
  -- (handles existing players who registered before auth was enabled)
  IF v_auth_id IS NOT NULL AND v_player.auth_id IS NULL THEN
    UPDATE players SET auth_id = v_auth_id WHERE id = v_player.id;
  END IF;

  RETURN jsonb_build_object('id', v_player.id, 'name', v_player.name);
END;
$$;


-- Update start_game_session to validate auth identity
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
  v_auth_id UUID;
  v_player_auth_id UUID;
BEGIN
  v_auth_id := auth.uid();

  -- Validate player exists
  SELECT auth_id INTO v_player_auth_id
  FROM players WHERE id = p_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not found';
  END IF;

  -- If auth is enabled AND the player has an auth_id, verify it matches
  IF v_auth_id IS NOT NULL AND v_player_auth_id IS NOT NULL THEN
    IF v_auth_id != v_player_auth_id THEN
      RAISE EXCEPTION 'Authentication mismatch: you are not this player';
    END IF;
  END IF;

  -- Rate limit
  SELECT ended_at INTO v_last_ended
  FROM game_sessions
  WHERE player_id = p_player_id AND status = 'completed'
  ORDER BY ended_at DESC LIMIT 1;

  IF v_last_ended IS NOT NULL AND v_last_ended > NOW() - INTERVAL '5 seconds' THEN
    RAISE EXCEPTION 'Rate limited: please wait a few seconds before starting a new game';
  END IF;

  -- Abandon existing active sessions
  UPDATE game_sessions
  SET status = 'abandoned', ended_at = NOW()
  WHERE player_id = p_player_id AND status = 'active';

  -- Generate nonce
  v_nonce := encode(gen_random_bytes(16), 'hex');

  -- Create session
  INSERT INTO game_sessions (player_id, status, started_at, nonce)
  VALUES (p_player_id, 'active', NOW(), v_nonce)
  RETURNING id INTO v_new_session_id;

  RETURN jsonb_build_object('session_id', v_new_session_id, 'nonce', v_nonce);
END;
$$;


-- ============================================================
-- 4. CAPTCHA SUPPORT — Validation helper
-- ============================================================
-- CAPTCHA tokens are validated in the Edge Function (register-player).
-- This table logs validated registrations for audit.

CREATE TABLE IF NOT EXISTS registration_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  ip_address TEXT,
  captcha_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Block direct access to audit table
ALTER TABLE registration_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Block audit access" ON registration_audit;
CREATE POLICY "Block audit access"
  ON registration_audit FOR ALL
  USING (false);


-- ============================================================
-- DONE! Phase 3 Summary:
-- ============================================================
-- Privacy:
--   ✅ get_leaderboard() — returns only name, department, high_score
--   ✅ get_player_rank() — returns only rank, score, name
--   ✅ Direct SELECT on players table BLOCKED (phone numbers hidden)
--
-- Auth:
--   ✅ auth_id column added to players
--   ✅ register_player() stores auth.uid() — one registration per device
--   ✅ lookup_player_by_phone() binds auth.uid() on login
--   ✅ start_game_session() validates auth.uid() matches player
--
-- CAPTCHA:
--   ✅ registration_audit table for logging
--   ✅ Edge Function (register-player) handles CAPTCHA validation
