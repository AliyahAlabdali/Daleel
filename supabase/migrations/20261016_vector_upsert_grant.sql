-- Already applied to the existing project. Fresh deployments use schema.sql.
-- LangChain's Supabase Vector Store uses upsert(...).select(). PostgreSQL
-- requires UPDATE privilege on submitted columns even when inserting a row.
begin;

grant update (content, metadata, embedding) on public.documents to service_role;

-- The vector store does not submit an id. Reject the upsert conflict branch
-- and other direct API updates; activation's SECURITY DEFINER owner may still
-- assign chunk_index after every staged row has been inserted.
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
revoke all on function rag_private.reject_document_api_update()
  from public, anon, authenticated, service_role, rag_workflow;
drop trigger if exists documents_reject_api_update on public.documents;
create trigger documents_reject_api_update
  before update on public.documents
  for each row execute function rag_private.reject_document_api_update();

commit;
