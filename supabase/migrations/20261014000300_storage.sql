-- Ordivia — Archivio file privato (foto attività, documenti di consegna).
-- Percorso obbligatorio: <org_id>/<area>/<file>. L'accesso segue l'appartenenza all'organizzazione.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'Schema storage assente (ambiente di test): migrazione saltata';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('ordivia-files', 'ordivia-files', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  execute $p$
    create policy ordivia_files_read on storage.objects for select to authenticated
    using (bucket_id = 'ordivia-files' and app.is_member(((storage.foldername(name))[1])::uuid))
  $p$;
  execute $p$
    create policy ordivia_files_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'ordivia-files' and app.is_member(((storage.foldername(name))[1])::uuid)
                and (storage.foldername(name))[2] in ('tasks','receipts'))
  $p$;
  -- Nessun update/delete dai client: i file sono prove (foto di completamento, documenti).
end $$;
