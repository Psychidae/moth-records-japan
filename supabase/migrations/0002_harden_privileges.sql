-- Defense for existing installs that previously inherited broad public ACLs.
-- Restore only the canonical allowlist. Do not touch service_role or RLS policies.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all (id, display_name, orcid, affiliation, public_credit, status, trust_level, created_at)
  on public.profiles from public, anon, authenticated;

alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;

grant select on public.taxa, public.taxon_names, public.regions, public.journals, public.reference_authors,
  public.external_resources, public.feature_flags, public.journal_issues, public.document_parts,
  public.document_issues to authenticated;

grant select on public.profiles to authenticated;
grant insert (id, display_name, orcid, affiliation, public_credit) on public.profiles to authenticated;
grant update (display_name, orcid, affiliation, public_credit) on public.profiles to authenticated;

grant select, insert, update on public.records, public.references_, public.type_records, public.host_records
  to authenticated;
grant usage on all sequences in schema public to authenticated;

grant select on public.suggestions, public.ai_runs, public.audit_log, public.role_assignments, public.releases
  to authenticated;
grant select, insert, update on public.content_pages, public.site_settings to authenticated;
grant update on public.feature_flags to authenticated;
grant select on public.documents, public.rights_policies, public.takedown_requests to authenticated;
grant insert on public.rights_policies to authenticated;
