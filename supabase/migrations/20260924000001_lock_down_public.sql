-- Supabase exposes the public schema through PostgREST and grants the anon
-- and authenticated roles full access to it. The anon key is not a secret,
-- so without this anyone could read sessions and password hashes directly.
--
-- The Worker connects with the service role, which bypasses RLS, so enabling
-- RLS with no policies locks out every other role without changing the app.
alter table users         enable row level security;
alter table sessions      enable row level security;
alter table boards        enable row level security;
alter table board_members enable row level security;
alter table cards         enable row level security;

-- Defense in depth: also drop the grants, now and for objects created later.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
