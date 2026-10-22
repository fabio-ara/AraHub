-- Additive rollout: deploy readers first, then compact existing files explicitly.
-- Raw bytes remain the transactional upload staging area; completed writes compact.
create table public.hub_file_blobs (
  owner_id uuid not null references auth.users(id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes >= 0),
  content bytea not null,
  primary key(owner_id,sha256),
  unique(owner_id,sha256,bytes),
  check (octet_length(content)=bytes),
  check (encode(extensions.digest(content,'sha256'),'hex')=sha256)
);
alter table public.hub_file_blobs enable row level security;
alter table public.hub_file_blobs force row level security;
create policy owner_select on public.hub_file_blobs for select to authenticated
  using ((select auth.uid())=owner_id);
create policy owner_insert on public.hub_file_blobs for insert to authenticated
  with check ((select auth.uid())=owner_id);
create policy owner_delete on public.hub_file_blobs for delete to authenticated
  using ((select auth.uid())=owner_id);
revoke all on public.hub_file_blobs from public,anon,authenticated;
grant select,insert,delete on public.hub_file_blobs to authenticated;

alter table public.hub_files add column blob_sha256 text;
alter table public.hub_files add constraint hub_files_blob_hash_matches
  check (blob_sha256 is null or blob_sha256=sha256);
alter table public.hub_files add constraint hub_files_blob_reference
  foreign key(owner_id,blob_sha256,bytes)
  references public.hub_file_blobs(owner_id,sha256,bytes);
create index hub_files_blob_idx on public.hub_files(owner_id,blob_sha256,bytes)
  where blob_sha256 is not null;

-- Every read is subject to both underlying owner policies, including Data API.
create view public.hub_file_contents with (security_invoker=true) as
select f.id,f.owner_id,f.entity_id,f.name,f.mime_type,f.sha256,f.bytes,
  coalesce(f.binary_content,b.content) as binary_content,f.extracted_text,f.extraction
from public.hub_files f left join public.hub_file_blobs b
  on b.owner_id=f.owner_id and b.sha256=f.blob_sha256 and b.bytes=f.bytes;
revoke all on public.hub_file_contents from public,anon,authenticated;
grant select on public.hub_file_contents to authenticated;

-- No SECURITY DEFINER: caller ownership and RLS remain effective throughout.
create function public.hub_compact_file(file_id uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare f public.hub_files; principal uuid := auth.uid();
begin
  if principal is null then raise exception 'authentication_required'; end if;
  select * into f from public.hub_files where owner_id=principal and id=file_id for update;
  if not found then raise exception 'file_not_found'; end if;
  if f.binary_content is null then return false; end if;
  if octet_length(f.binary_content)<>f.bytes or
     encode(extensions.digest(f.binary_content,'sha256'),'hex')<>f.sha256 then
    raise exception 'binary_integrity_failed';
  end if;
  insert into public.hub_file_blobs(owner_id,sha256,bytes,content)
    values(principal,f.sha256,f.bytes,f.binary_content)
    on conflict(owner_id,sha256) do nothing;
  -- Compare bytes too: never merge unequal content even in a theoretical hash collision.
  if not exists(select 1 from public.hub_file_blobs b where b.owner_id=principal
    and b.sha256=f.sha256 and b.bytes=f.bytes and b.content=f.binary_content) then
    raise exception 'binary_integrity_failed';
  end if;
  update public.hub_files set blob_sha256=f.sha256,binary_content=null
    where owner_id=principal and id=file_id;
  return true;
end $$;
revoke all on function public.hub_compact_file(uuid) from public,anon,authenticated;
grant execute on function public.hub_compact_file(uuid) to authenticated;

-- Explicit collection: FK protection prevents deletion while any reference exists.
create function public.hub_prune_file_blobs() returns bigint
language plpgsql security invoker set search_path='' as $$
declare removed bigint; principal uuid := auth.uid();
begin
  if principal is null then raise exception 'authentication_required'; end if;
  delete from public.hub_file_blobs b where b.owner_id=principal and not exists
    (select 1 from public.hub_files f where f.owner_id=principal and f.blob_sha256=b.sha256);
  get diagnostics removed = row_count;
  return removed;
end $$;
revoke all on function public.hub_prune_file_blobs() from public,anon,authenticated;
grant execute on function public.hub_prune_file_blobs() to authenticated;
