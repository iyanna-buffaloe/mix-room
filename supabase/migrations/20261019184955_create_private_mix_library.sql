-- Development schema for private saved mixes. All mutations go through the
-- verified server API; browser clients can read only their own library rows.
create table public.saved_mixes (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  place smallint not null check (place between 1 and 3),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  object_id uuid not null unique,
  object_key text not null,
  bytes bigint not null check (bytes between 57 and 167772160),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, place),
  check (object_key = 'saved/' || owner_id::text || '/' || object_id::text || '.mixroom')
);
create index saved_mixes_owner_updated on public.saved_mixes (owner_id, updated_at desc);
alter table public.saved_mixes enable row level security;
revoke all on public.saved_mixes from public, anon, authenticated;
grant select on public.saved_mixes to authenticated;
grant all on public.saved_mixes to service_role;
create policy saved_mix_owner_read on public.saved_mixes for select to authenticated using ((select auth.uid()) = owner_id);

create table public.mix_uploads (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  mix_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  expected_revision bigint check (expected_revision > 0),
  bytes bigint not null check (bytes between 57 and 167772160),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  committed_at timestamptz
);
create index mix_uploads_owner_created on public.mix_uploads (owner_id, created_at desc);
alter table public.mix_uploads enable row level security;
revoke all on public.mix_uploads from public, anon, authenticated;
grant all on public.mix_uploads to service_role;

-- The per-owner lock serializes saves from multiple devices. The unique place
-- constraint independently prevents a fourth mix even under concurrent writes.
create function public.commit_saved_mix(p_owner uuid, p_upload uuid, p_bytes bigint)
returns setof public.saved_mixes language plpgsql security invoker set search_path = '' as $$
declare
  pending public.mix_uploads;
  previous public.saved_mixes;
  result public.saved_mixes;
  available_place smallint;
  used_bytes bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text, 0));
  select * into pending from public.mix_uploads where id = p_upload and owner_id = p_owner for update;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  select * into result from public.saved_mixes where owner_id = p_owner and object_id = p_upload;
  if found then return next result; return; end if;
  if pending.committed_at is not null then raise exception 'MIX_CHANGED'; end if;
  if pending.expires_at <= now() then raise exception 'UPLOAD_EXPIRED'; end if;
  if p_bytes <> pending.bytes then raise exception 'UPLOAD_SIZE'; end if;
  select * into previous from public.saved_mixes where id = pending.mix_id and owner_id = p_owner for update;
  if pending.expected_revision is null and previous.id is not null then raise exception 'MIX_CHANGED'; end if;
  if pending.expected_revision is not null and (previous.id is null or previous.revision <> pending.expected_revision) then raise exception 'MIX_CHANGED'; end if;
  if previous.id is not null then available_place := previous.place;
  else
    select n::smallint into available_place from pg_catalog.generate_series(1, 3) n
    where not exists (select 1 from public.saved_mixes where owner_id = p_owner and place = n) order by n limit 1;
  end if;
  if available_place is null then raise exception 'MIX_LIMIT'; end if;
  select coalesce(sum(bytes), 0) into used_bytes from public.saved_mixes where owner_id = p_owner;
  if used_bytes - coalesce(previous.bytes, 0) + p_bytes > 503316480 then raise exception 'STORAGE_LIMIT'; end if;
  insert into public.saved_mixes(id, owner_id, place, name, object_id, object_key, bytes, revision)
    values(pending.mix_id, p_owner, available_place, pending.name, p_upload, 'saved/' || p_owner::text || '/' || p_upload::text || '.mixroom', p_bytes, 1)
    on conflict(id) do update set name = excluded.name, object_id = excluded.object_id, object_key = excluded.object_key,
      bytes = excluded.bytes, revision = public.saved_mixes.revision + 1, updated_at = now()
    where public.saved_mixes.owner_id = p_owner
    returning * into result;
  if result.id is null then raise exception 'MIX_CHANGED'; end if;
  update public.mix_uploads set committed_at = now() where id = p_upload and owner_id = p_owner;
  return next result;
end;
$$;
revoke all on function public.commit_saved_mix(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.commit_saved_mix(uuid, uuid, bigint) to service_role;

create function public.reserve_mix_upload(p_owner uuid, p_upload uuid, p_mix uuid, p_name text, p_bytes bigint, p_expected bigint default null)
returns setof public.mix_uploads language plpgsql security invoker set search_path = '' as $$
declare pending public.mix_uploads;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text, 0));
  select * into pending from public.mix_uploads where id = p_upload and owner_id = p_owner;
  if found then
    if pending.mix_id <> p_mix or pending.name <> p_name or pending.bytes <> p_bytes or pending.expected_revision is distinct from p_expected then raise exception 'UPLOAD_CHANGED'; end if;
    return next pending; return;
  end if;
  if (select count(*) from public.mix_uploads where owner_id = p_owner and committed_at is null and expires_at > now()) >= 3 then raise exception 'UPLOAD_LIMIT'; end if;
  if (select count(*) from public.mix_uploads where owner_id = p_owner and created_at > now() - interval '1 hour') >= 20 then raise exception 'UPLOAD_RATE_LIMIT'; end if;
  insert into public.mix_uploads(id, owner_id, mix_id, name, bytes, expected_revision, expires_at)
  values (p_upload, p_owner, p_mix, p_name, p_bytes, p_expected, now() + interval '15 minutes') returning * into pending;
  return next pending;
end;
$$;
revoke all on function public.reserve_mix_upload(uuid, uuid, uuid, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.reserve_mix_upload(uuid, uuid, uuid, text, bigint, bigint) to service_role;
