-- Read-only checks after schema.sql and, for existing databases, the approved
-- vector-upsert migration have been run.
-- Every "present" result below should be true. This script does not call mutating functions.
set search_path = public, extensions;
with expected(name, present) as (
  values
    ('vector extension', exists (select 1 from pg_extension where extname = 'vector')),
    ('documents table', to_regclass('public.documents') is not null),
    ('registry table', to_regclass('public.document_registry') is not null),
    ('privileged function schema', to_regnamespace('rag_private') is not null),
    ('private chat schema', to_regnamespace('rag_chat') is not null),
    ('workflow role', exists (select 1 from pg_roles where rolname = 'rag_workflow')),
    ('match RPC', to_regprocedure('public.match_documents(vector,integer,jsonb)') is not null),
    ('private activation function', to_regprocedure('rag_private.activate_document(text,text,uuid,integer)') is not null),
    ('document update guard', to_regprocedure('rag_private.reject_document_api_update()') is not null),
    ('document update trigger', exists (select 1 from pg_trigger
      where tgrelid = 'public.documents'::regclass
        and tgname = 'documents_reject_api_update' and tgenabled = 'O' and not tgisinternal)),
    ('admin cleanup RPC', to_regprocedure('public.purge_abandoned_chunks(timestamptz)') is not null),
    ('HNSW index', to_regclass('public.documents_embedding_hnsw_idx') is not null),
    ('metadata index', to_regclass('public.documents_metadata_gin_idx') is not null),
    ('source/version index', to_regclass('public.documents_source_version_idx') is not null)
)
select name, present as passed from expected order by name;

select c.relname as table_name, c.relrowsecurity as rls_enabled,
       exists (select 1 from pg_policies p where p.schemaname = 'public'
               and p.tablename = c.relname
               and p.roles::text[] @> array['service_role']::text[]) as service_policy_exists
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('documents', 'document_registry')
order by c.relname;

select a.attname as column_name, format_type(a.atttypid, a.atttypmod) as data_type,
       a.attnotnull as not_null
from pg_attribute a
where a.attrelid = 'public.documents'::regclass
  and a.attname in ('content', 'metadata', 'embedding', 'created_at')
  and a.attnum > 0
order by a.attname;
-- Expected embedding data_type: vector(1536).

select n.nspname as function_schema, p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer, p.provolatile as volatility,
       pg_get_userbyid(p.proowner) as owner
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'public' and p.proname in ('match_documents', 'purge_abandoned_chunks'))
   or (n.nspname = 'rag_private' and p.proname in ('activate_document', 'reject_document_api_update'))
order by p.proname;
-- Expected: match_documents security_definer=false, volatility=s;
-- activate_document security_definer=true and owner=postgres.

-- PostgreSQL grants EXECUTE to PUBLIC by default; all four results must be true.
select n.nspname as function_schema, p.proname as function_name,
       not exists (
         select 1
         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
         where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
       ) as public_execute_revoked
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'public' and p.proname in ('match_documents', 'purge_abandoned_chunks'))
   or (n.nspname = 'rag_private' and p.proname in ('activate_document', 'reject_document_api_update'))
order by p.proname;

select rolname, rolcanlogin, rolsuper, rolbypassrls
from pg_roles
where rolname in ('anon', 'authenticated', 'service_role', 'rag_workflow')
order by rolname;
-- Expected: rag_workflow NOLOGIN, not superuser, and no RLS bypass.

select role_name,
       has_table_privilege(role_name, 'public.documents', 'SELECT') as documents_select,
       has_table_privilege(role_name, 'public.documents', 'INSERT') as documents_insert,
       has_table_privilege(role_name, 'public.documents', 'UPDATE') as documents_update,
       has_column_privilege(role_name, 'public.documents', 'content', 'UPDATE') as content_update,
       has_column_privilege(role_name, 'public.documents', 'metadata', 'UPDATE') as metadata_update,
       has_column_privilege(role_name, 'public.documents', 'embedding', 'UPDATE') as embedding_update,
       has_column_privilege(role_name, 'public.documents', 'id', 'UPDATE') as id_update,
       has_table_privilege(role_name, 'public.documents', 'DELETE') as documents_delete,
       has_table_privilege(role_name, 'public.document_registry', 'SELECT') as registry_select,
       has_table_privilege(role_name, 'public.document_registry', 'UPDATE') as registry_update,
       has_sequence_privilege(role_name, 'public.documents_id_seq', 'USAGE') as documents_sequence_usage,
       has_function_privilege(role_name, 'public.match_documents(vector,integer,jsonb)', 'EXECUTE') as can_match,
       has_function_privilege(role_name, 'rag_private.activate_document(text,text,uuid,integer)', 'EXECUTE') as can_activate,
       has_function_privilege(role_name, 'public.purge_abandoned_chunks(timestamptz)', 'EXECUTE') as can_cleanup,
       has_schema_privilege(role_name, 'rag_private', 'USAGE') as private_schema_usage,
       has_schema_privilege(role_name, 'rag_private', 'CREATE') as private_schema_create,
       has_schema_privilege(role_name, 'rag_chat', 'USAGE') as chat_schema_usage,
       has_schema_privilege(role_name, 'rag_chat', 'CREATE') as chat_schema_create
from (values ('anon'), ('authenticated'), ('service_role'), ('rag_workflow')) as roles(role_name);
-- Expected: anon/authenticated all false; service_role document SELECT/INSERT,
-- UPDATE on content/metadata/embedding only (no id UPDATE),
-- registry SELECT and can_match true, can_activate false; rag_workflow only
-- registry SELECT, can_activate, private_schema_usage, and chat schema
-- USAGE/CREATE true. private_schema_create must be false for every listed role.
-- can_cleanup is false for every role listed here.

-- Empty result expected before ingestion and after all live tests.
select r.source_key, r.active_version, r.chunk_count,
       count(d.id) as actual_chunks
from public.document_registry r
left join public.documents d
  on d.metadata->>'source_key' = r.source_key
 and d.metadata->>'version_id' = r.active_version::text
group by r.source_key, r.active_version, r.chunk_count
having count(d.id) <> r.chunk_count;

-- A staged version must never appear through match_documents. Empty result
-- expected; after a failed insert, this tests one remaining staged chunk.
with staged as (
  select d.id, d.embedding, d.metadata->>'version_id' as version_id
  from public.documents d
  where not exists (
    select 1 from public.document_registry r
    where r.source_key = d.metadata->>'source_key'
      and r.active_version::text = d.metadata->>'version_id'
  )
  limit 1
)
select s.id as leaked_staged_id
from staged s
join lateral public.match_documents(
  s.embedding, 20, jsonb_build_object('version_id', s.version_id)
) m on m.id = s.id;
