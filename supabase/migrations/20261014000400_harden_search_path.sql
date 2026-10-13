-- Indicazioni del linter di sicurezza Supabase: search_path fisso sulle funzioni di supporto.
alter function app.current_station() set search_path = pg_catalog;
alter function app.enable_audit(regclass) set search_path = public;
alter function app.movement_fill_facility() set search_path = public;
revoke execute on function app.enable_audit(regclass) from authenticated, anon, public;
