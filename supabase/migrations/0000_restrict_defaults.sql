-- Supabase initially grants all public tables/sequences to API roles.
-- Remove defaults before 0001, without changing service_role or internal schemas.
-- Applies to the migration role (postgres), not Supabase-managed internal roles.
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
