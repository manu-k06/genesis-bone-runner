-- ============================================================
-- BONE RUNNER — REMOTE CONFIGURATION
-- ============================================================
-- Creates a table to hold remote configuration values (live-ops).
-- ============================================================

CREATE TABLE IF NOT EXISTS live_game_config (
  id INT PRIMARY KEY DEFAULT 1,
  gravity INT NOT NULL DEFAULT 1500,
  jump_velocity INT NOT NULL DEFAULT -700,
  speed INT NOT NULL DEFAULT 400,
  spawn_interval_min INT NOT NULL DEFAULT 1000,
  spawn_interval_max INT NOT NULL DEFAULT 2000,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Seed default values
INSERT INTO live_game_config (id, gravity, jump_velocity, speed, spawn_interval_min, spawn_interval_max)
VALUES (1, 1500, -700, 400, 1000, 2000)
ON CONFLICT (id) DO NOTHING;

-- Enable RLS
ALTER TABLE live_game_config ENABLE ROW LEVEL SECURITY;

-- Allow public read access to game config
CREATE POLICY "live_game_config_select_all" 
ON live_game_config FOR SELECT 
TO PUBLIC
USING (true);

-- Allow authenticated users to update (In a real app, restrict this to admins)
CREATE POLICY "live_game_config_update_all"
ON live_game_config FOR UPDATE
TO authenticated
USING (true);
