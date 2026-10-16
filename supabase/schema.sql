-- RAG AI Assistant: use for a fresh Supabase project only.
-- The existing project has already applied this schema. Do not rerun it there.
-- The n8n Supabase Vector Store upserts (content, metadata, embedding).
-- The n8n Postgres node calls rag_private.activate_document after insertion succeeds.
-- Use a dedicated PostgreSQL login granted rag_workflow, not the Supabase API key.

begin;

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
-- Keep privileged functions separate from n8n's self-created chat tables.
create schema if not exists rag_private;
create schema if not exists rag_chat;
revoke all on schema rag_private from public, anon, authenticated, service_role;
revoke all on schema rag_chat from public, anon, authenticated, service_role;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'rag_workflow') then
    create role rag_workflow nologin;
  end if;
end $$;
set local search_path = public, extensions;

create table if not exists public.documents (
  id bigserial primary key,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  constraint documents_content_nonempty check (length(content) > 0),
  constraint documents_metadata_object check (jsonb_typeof(metadata) = 'object')
);

-- One active version for each category + filename source key. The key is the
-- JSON encoding of [category, filename], avoiding delimiter collisions.
create table if not exists public.document_registry (
  source_key text primary key,
  source_name text not null,
  category text not null,
  content_hash text not null,
  active_version uuid not null,
  chunk_count integer not null check (chunk_count > 0),
  updated_at timestamptz not null default now(),
  constraint document_registry_hash_sha256 check (content_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists documents_embedding_hnsw_idx
  on public.documents using hnsw (embedding vector_cosine_ops);
create index if not exists documents_metadata_gin_idx
  on public.documents using gin (metadata jsonb_path_ops);
create index if not exists documents_source_version_idx
  on public.documents ((metadata->>'source_key'), (metadata->>'version_id'));

alter table public.documents enable row level security;
alter table public.document_registry enable row level security;

-- n8n's Supabase Vector Store needs a server-side service-role credential.
-- No client-side anon/authenticated role receives document or registry access.
revoke all on public.documents from public, anon, authenticated, service_role;
revoke all on public.document_registry from public, anon, authenticated, service_role;
revoke all on sequence public.documents_id_seq from public, anon, authenticated;
grant usage on schema public to service_role;
grant usage on schema extensions to service_role;
grant select, insert on public.documents to service_role;
-- LangChain uses upsert(...).select(), which needs UPDATE on the submitted
-- columns even for a new row. The trigger below rejects direct row updates.
grant update (content, metadata, embedding) on public.documents to service_role;
grant select on public.document_registry to service_role;
grant usage, select on sequence public.documents_id_seq to service_role;
grant usage on schema public to rag_workflow;
grant select on public.document_registry to rag_workflow;
-- The workflow can call privileged functions but cannot create objects beside them.
revoke all on schema rag_private from rag_workflow;
grant usage on schema rag_private to rag_workflow;
-- LangChain creates its chat table on first use in this separate schema.
grant usage, create on schema rag_chat to rag_workflow;

-- Explicit policies document the intended server-only access. Supabase's
-- service_role bypasses RLS, so the grants and secret-key handling also matter.
drop policy if exists documents_service_role on public.documents;
create policy documents_service_role on public.documents
  for all to service_role using (true) with check (true);
drop policy if exists registry_service_role on public.document_registry;
create policy registry_service_role on public.document_registry
  for all to service_role using (true) with check (true);

-- Signature matches LangChain/n8n Supabase Vector Store RPC arguments.
-- Staged chunks are invisible until their version is in document_registry.
create or replace function public.match_documents(
  query_embedding vector(1536),
  match_count integer default 5,
  filter jsonb default '{}'::jsonb
)
returns table (
  id bigint,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql stable security invoker
set search_path = public, extensions
as $$
  select d.id, d.content, d.metadata,
         1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  join public.document_registry r
    on r.source_key = d.metadata->>'source_key'
   and r.active_version::text = d.metadata->>'version_id'
  where d.metadata @> coalesce(filter, '{}'::jsonb)
  order by d.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 5), 1), 20);
$$;

-- Call only after the vector-store insert node reports success. This function
-- validates staged rows, makes them searchable, and removes the previous active
-- version atomically. A failed insert cannot displace the old version.
create or replace function rag_private.activate_document(
  p_source_key text,
  p_content_hash text,
  p_version_id uuid,
  p_expected_chunks integer
)
returns table (status text, active_chunks bigint)
language plpgsql security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_old public.document_registry%rowtype;
  v_count bigint;
  v_valid bigint;
  v_source text;
  v_category text;
begin
  if p_source_key is null or length(p_source_key) < 1
     or p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$'
     or p_version_id is null or p_expected_chunks not between 1 and 10000 then
    raise exception 'Invalid document activation arguments';
  end if;

  -- Serialize activation of one logical source; different sources can proceed.
  perform pg_advisory_xact_lock(hashtextextended(p_source_key, 0));
  select * into v_old from public.document_registry
   where source_key = p_source_key for update;

  if v_old.active_version = p_version_id and v_old.content_hash = p_content_hash
     and v_old.chunk_count = p_expected_chunks then
    return query select 'already_active'::text, v_old.chunk_count::bigint;
    return;
  end if;

  -- Count every row carrying this opaque version ID, including malformed rows.
  -- The n8n insert output supplies the expected number of prepared chunks.
  select count(*),
         count(*) filter (where d.metadata->>'source_key' = p_source_key
           and d.metadata->>'content_hash' = p_content_hash
           and nullif(d.metadata->>'source', '') is not null
           and nullif(d.metadata->>'category', '') is not null
           and length(d.content) > 0),
         min(d.metadata->>'source'), min(d.metadata->>'category')
    into v_count, v_valid, v_source, v_category
  from public.documents d
  where d.metadata->>'version_id' = p_version_id::text;

  if v_count <> p_expected_chunks or v_valid <> p_expected_chunks
     or v_source is null or v_category is null
     or exists (
       select 1 from public.documents d
       where d.metadata->>'version_id' = p_version_id::text
         and (d.metadata->>'source' <> v_source
           or d.metadata->>'category' <> v_category)
     )
     or p_source_key::jsonb <> jsonb_build_array(v_category, v_source) then
    raise exception 'Incomplete or inconsistent staged document';
  end if;

  if v_old.content_hash = p_content_hash then
    delete from public.documents d
    where d.metadata->>'source_key' = p_source_key
      and d.metadata->>'version_id' = p_version_id::text;
    return query select 'duplicate'::text, v_old.chunk_count::bigint;
    return;
  end if;

  -- Insert order gives a stable chunk reference. PDF page numbers are unavailable
  -- because the configured extractor joins pages before splitting.
  with numbered as (
    select d.id, (row_number() over (order by d.id) - 1)::integer as chunk_index
    from public.documents d
    where d.metadata->>'source_key' = p_source_key
      and d.metadata->>'version_id' = p_version_id::text
  )
  update public.documents d
     set metadata = d.metadata || jsonb_build_object('chunk_index', n.chunk_index)
  from numbered n where n.id = d.id;

  insert into public.document_registry
    (source_key, source_name, category, content_hash, active_version, chunk_count)
  values
    (p_source_key, v_source, v_category, p_content_hash, p_version_id, v_count)
  on conflict (source_key) do update set
    source_name = excluded.source_name,
    category = excluded.category,
    content_hash = excluded.content_hash,
    active_version = excluded.active_version,
    chunk_count = excluded.chunk_count,
    updated_at = now();

  if v_old.active_version is not null then
    delete from public.documents d
    where d.metadata->>'source_key' = p_source_key
      and d.metadata->>'version_id' = v_old.active_version::text;
  end if;

  return query select
    case when v_old.active_version is null then 'inserted' else 'replaced' end::text,
    v_count;
end;
$$;
-- SQL Editor runs as postgres; pin ownership because this function writes the
-- registry and chunks while its caller has no direct table-write grant.
alter function rag_private.activate_document(text, text, uuid, integer)
  owner to postgres;

-- The vector store never supplies an id, so its upsert should only insert.
-- Keep its required UPDATE privilege from changing existing (including active)
-- chunks. Activation runs as postgres and may assign chunk_index metadata.
create or replace function rag_private.reject_document_api_update()
returns trigger
language plpgsql security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if current_user <> 'postgres' then
    raise exception 'Direct document updates are forbidden' using errcode = '42501';
  end if;
  return new;
end;
$$;
alter function rag_private.reject_document_api_update() owner to postgres;
drop trigger if exists documents_reject_api_update on public.documents;
create trigger documents_reject_api_update
  before update on public.documents
  for each row execute function rag_private.reject_document_api_update();

-- Admin maintenance only. Registry and document table locks serialize this
-- cleanup with inserts and activation; old active versions are never selected.
-- The seven-day floor avoids deleting a normal upload still in progress.
create or replace function public.purge_abandoned_chunks(p_before timestamptz)
returns bigint
language plpgsql security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_deleted bigint;
begin
  if p_before is null or p_before > now() - interval '7 days' then
    raise exception 'Cleanup cutoff must be at least seven days old';
  end if;
  lock table public.document_registry, public.documents in share row exclusive mode;
  delete from public.documents d
  where d.created_at < p_before
    and not exists (
      select 1 from public.document_registry r
      where r.source_key = d.metadata->>'source_key'
        and r.active_version::text = d.metadata->>'version_id'
    );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- PostgreSQL grants function EXECUTE to PUBLIC by default. Explicitly remove it
-- from each sensitive function before granting the intended caller.
revoke all on function public.match_documents(vector, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.match_documents(vector, integer, jsonb)
  to service_role;
revoke all on function rag_private.activate_document(text, text, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function rag_private.activate_document(text, text, uuid, integer)
  to rag_workflow;
revoke all on function rag_private.reject_document_api_update()
  from public, anon, authenticated, service_role, rag_workflow;
revoke all on function public.purge_abandoned_chunks(timestamptz)
  from public, anon, authenticated, service_role, rag_workflow;

commit;
