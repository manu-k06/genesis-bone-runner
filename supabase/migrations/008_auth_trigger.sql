-- ============================================================
-- BONE RUNNER — AUTH TRIGGER
-- ============================================================
-- Automatically creates a live_players profile when a new user signs up.
-- This bypasses RLS issues if email confirmations are enabled.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.live_players (id, username)
  VALUES (
    new.id,
    COALESCE(
      new.raw_user_meta_data->>'username',
      'Player_' || substr(new.id::text, 1, 6)
    )
  )
  ON CONFLICT (id) DO NOTHING;
  
  RETURN new;
END;
$$;

-- Drop the trigger if it already exists to prevent errors
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user();
