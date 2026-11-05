-- Fix function resolution independently of the caller-controlled search_path.
-- All referenced application/Auth objects are already schema-qualified.
alter function app.is_mfa() set search_path = '';
alter function app.require_mfa_role(text[]) set search_path = '';
alter function app.block_audit_change() set search_path = '';
alter function app.guard_submission() set search_path = '';

-- Move the relocatable extension without rebuilding its existing index OIDs.
create schema if not exists extensions;
alter extension pg_trgm set schema extensions;
grant usage on schema extensions to authenticated, service_role;
