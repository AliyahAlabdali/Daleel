import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = process.cwd();
const read = path => readFileSync(join(root, path), 'utf8');
const json = path => JSON.parse(read(path));
const ingest = json('workflows/01-document-ingestion.review.json');
const chat = json('workflows/02-conversational-assistant.review.json');
const schema = read('supabase/schema.sql');
const verify = read('supabase/verify.sql');
const upsertMigration = read('supabase/migrations/20261016_vector_upsert_grant.sql');
const nodes = flow => Object.fromEntries(flow.nodes.map(n => [n.name, n]));
const i = nodes(ingest);
const c = nodes(chat);

test('local source exports retain their audited SHA-256 hashes', t => {
  const expected = json('tests/original-hashes.json');
  const present = Object.keys(expected).filter(file => existsSync(join(root, file)));
  if (present.length === 0) {
    t.skip('source exports are intentionally excluded from the public repository');
    return;
  }
  assert.equal(present.length, Object.keys(expected).length, 'source exports must be present together');
  for (const [file, hash] of Object.entries(expected)) {
    assert.equal(createHash('sha256').update(readFileSync(join(root, file))).digest('hex'), hash);
  }
});

test('review exports are inactive, import as new workflows, and contain no credential references', () => {
  for (const flow of [ingest, chat]) {
    assert.equal(flow.active, false);
    assert.equal(flow.id, undefined);
    assert.equal(flow.versionId, undefined);
    assert.equal(flow.meta, undefined);
    assert.equal(flow.nodes.some(n => n.credentials), false);
    assert.equal(flow.nodes.some(n => n.webhookId), false);
    assert.equal(new Set(flow.nodes.map(n => n.name)).size, flow.nodes.length);
    const names = new Set(flow.nodes.map(n => n.name));
    for (const [from, channels] of Object.entries(flow.connections)) {
      assert.ok(names.has(from), `missing source ${from}`);
      for (const groups of Object.values(channels)) {
        for (const group of groups) for (const target of group) {
          assert.ok(names.has(target.node), `missing target ${target.node}`);
        }
      }
    }
  }
});

test('one file per loader call and version activation only follows vector insertion', () => {
  assert.equal(i['Loop Over Files'].parameters.batchSize, 1);
  assert.equal(ingest.connections['Loop Over Files'].main[1][0].node, 'Route by File Type');
  assert.equal(ingest.connections['Already Indexed?'].main[0][0].node, 'Confirm Duplicate');
  assert.equal(ingest.connections['Already Indexed?'].main[1][0].node, 'Index Chunks in Supabase');
  assert.equal(ingest.connections['Index Chunks in Supabase'].main[0][0].node, 'Count Indexed Chunks');
  assert.equal(ingest.connections['Count Indexed Chunks'].main[0][0].node, 'Activate Document Version');
  assert.match(i['Check Document Version'].parameters.query, /sha256\(convert_to/);
  assert.match(i['Activate Document Version'].parameters.query, /rag_private\.activate_document\(\$3::text, \$4::text, \$5::uuid, \$6::integer\)/);
  assert.match(i['Confirm Duplicate'].parameters.query, /conflict_retry/);
  assert.equal(ingest.connections['Confirm Duplicate'].main[0][0].node, 'Loop Over Files');
  assert.match(i['Summarize Upload'].parameters.jsCode, /conflict_retry: files\.filter/);
});

test('embedding, retrieval, authentication, and schema contract agree', () => {
  for (const n of [i['OpenAI Embeddings'], c['OpenAI Query Embeddings']]) {
    assert.equal(n.parameters.model, 'text-embedding-3-small');
    assert.equal(n.parameters.options.dimensions, 1536);
  }
  assert.equal(i['Index Chunks in Supabase'].parameters.tableName.value, 'documents');
  assert.equal(c['knowledge_base_search'].parameters.tableName.value, 'documents');
  assert.equal(c['knowledge_base_search'].parameters.options.queryName, 'match_documents');
  assert.equal(i['Upload Documents Form'].parameters.authentication, 'n8nUserAuth');
  assert.equal(i['Upload Documents Form'].parameters.requireExecuteAccess, true);
  assert.equal(c['Chat Message Received'].parameters.public, false);
  assert.equal(c['Chat Message Received'].parameters.authentication, 'n8nUserAuth');
  assert.equal(c['Chat Message Received'].parameters.requireExecuteAccess, true);
  assert.equal(chat.connections['Chat Message Received'].main[0][0].node, 'Validate Chat Session');
  assert.equal(chat.connections['Validate Chat Session'].main[0][0].node, 'RAG Assistant Agent');
  assert.equal(c['Postgres Chat Memory'].parameters.tableName, 'rag_chat.chat_histories');
  assert.equal(c['Postgres Chat Memory'].parameters.sessionIdType, 'customKey');
  assert.equal(c['Postgres Chat Memory'].parameters.sessionKey, "={{ $('Validate Chat Session').first().json.memorySessionKey }}");
  for (const metadata of ['source', 'category', 'source_key', 'content_hash', 'version_id']) {
    assert.ok(i['Document Loader + Metadata'].parameters.options.metadata.metadataValues.some(m => m.name === metadata));
  }
  assert.match(schema, /embedding vector\(1536\) not null/i);
  assert.match(schema, /function public\.match_documents\(/i);
  assert.match(schema, /function rag_private\.activate_document\(/i);
  assert.match(schema, /p_expected_chunks integer/);
  assert.match(schema, /v_count <> p_expected_chunks or v_valid <> p_expected_chunks/);
  assert.match(schema, /grant execute on function rag_private\.activate_document\(text, text, uuid, integer\)\s+to rag_workflow/i);
  assert.match(schema, /revoke all on function rag_private\.activate_document\(text, text, uuid, integer\)\s+from public, anon, authenticated, service_role/i);
  assert.match(schema, /alter function rag_private\.activate_document\(text, text, uuid, integer\)\s+owner to postgres/i);
  assert.match(schema, /revoke all on schema rag_private from rag_workflow;\s+grant usage on schema rag_private to rag_workflow;/i);
  assert.match(schema, /grant usage, create on schema rag_chat to rag_workflow;/i);
  assert.match(schema, /revoke all on function public\.match_documents\(vector, integer, jsonb\)\s+from public, anon, authenticated;/i);
  assert.match(schema, /revoke all on function public\.purge_abandoned_chunks\(timestamptz\)\s+from public, anon, authenticated, service_role, rag_workflow;/i);
  assert.match(schema, /language plpgsql security definer\s+set search_path = pg_catalog, public, extensions, pg_temp/i);
  assert.match(schema, /r\.active_version::text = d\.metadata->>'version_id'/);
  assert.match(schema, /create or replace function public\.purge_abandoned_chunks/);
  assert.match(verify, /has_table_privilege/);
  assert.match(verify, /has_function_privilege/);
  assert.match(verify, /has_sequence_privilege/);
  assert.match(verify, /relrowsecurity/);
  assert.match(verify, /vector\(1536\)/);
  assert.match(verify, /acl\.grantee = 0 and acl\.privilege_type = 'EXECUTE'/);
  assert.match(verify, /private_schema_create/);
  assert.match(verify, /chat_schema_create/);
  assert.match(schema, /enable row level security/ig);
  assert.match(schema, /rag_private/);
  assert.ok(schema.indexOf('insert into public.document_registry') < schema.indexOf('delete from public.documents d\n    where d.metadata->>\'source_key\' = p_source_key\n      and d.metadata->>\'version_id\' = v_old.active_version::text'));
});

test('schema and migration declare the upsert UPDATE grant and row-update guard', () => {
  for (const sql of [schema, upsertMigration]) {
    assert.match(sql, /grant update \(content, metadata, embedding\) on public\.documents to service_role;/i);
    assert.match(sql, /create or replace function rag_private\.reject_document_api_update\(\)/i);
    assert.match(sql, /if current_user <> 'postgres' then\s+raise exception 'Direct document updates are forbidden'/i);
    assert.match(sql, /before update on public\.documents\s+for each row execute function rag_private\.reject_document_api_update\(\)/i);
    assert.match(sql, /revoke all on function rag_private\.reject_document_api_update\(\)\s+from public, anon, authenticated, service_role, rag_workflow;/i);
    assert.doesNotMatch(sql, /grant (?:all|update).*public\.documents to (?:anon|authenticated)/i);
  }
  assert.match(verify, /has_column_privilege\(role_name, 'public\.documents', 'embedding', 'UPDATE'\)/);
  assert.match(verify, /documents_reject_api_update' and tgenabled = 'O'/);
  assert.match(schema, /alter function rag_private\.activate_document\(text, text, uuid, integer\)\s+owner to postgres/i);
});

test('chunk counter accepts the flat metadata returned by n8n vector-store insert', () => {
  const run = new Function('$input', i['Count Indexed Chunks'].parameters.jsCode);
  const metadata = { source: 'rag-test.txt', category: 'general', source_key: '["general","rag-test.txt"]', content_hash: 'a'.repeat(64), version_id: 'version-1' };
  const result = run({ all: () => [{ json: { metadata, pageContent: 'Blue Lantern project text' } }] });
  assert.deepEqual(result[0].json, { source: metadata.source, category: metadata.category,
    source_key: metadata.source_key, content_hash: metadata.content_hash,
    version_id: metadata.version_id, expected_chunks: 1 });
});

test('chunk counter rejects empty or mixed output and passes exact expected count', () => {
  const run = new Function('$input', i['Count Indexed Chunks'].parameters.jsCode);
  const metadata = { source: 'a.txt', category: 'policy', source_key: '["policy","a.txt"]', content_hash: 'a'.repeat(64), version_id: 'version-1' };
  // n8n's insert operation returns serialized chunks with flat json fields.
  const make = (text, meta = metadata) => ({ json: { pageContent: text, metadata: meta } });
  const counted = run({ all: () => [make('first'), make('second')] })[0].json;
  assert.equal(counted.expected_chunks, 2);
  assert.equal(counted.source_key, metadata.source_key);
  assert.equal(counted.content_hash, metadata.content_hash);
  assert.equal(counted.version_id, metadata.version_id);
  assert.throws(() => run({ all: () => [] }), /no chunks/);
  assert.throws(() => run({ all: () => [{ json: { pageContent: 'first' } }] }), /missing version metadata/);
  assert.throws(() => run({ all: () => [make('first'), make('second', { ...metadata, version_id: 'version-2' })] }), /Inconsistent/);
  assert.throws(() => run({ all: () => [make('first'), make('  ')] }), /Inconsistent/);
});

test('upload validation separates files and rejects unsupported or oversized input', async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('$input', i['Split Uploaded Files'].parameters.jsCode);
  const pdf = Buffer.from('%PDF-1.7\nA small but valid header');
  const txt = Buffer.from('Some plain text for a test document.');
  const makeFile = (name, bytes) => ({ fileName: name, data: bytes });
  const input = [{ json: { category: 'policy' }, binary: {
    documents_0: makeFile('one.pdf', pdf),
    documents_1: makeFile('two.txt', txt),
  } }];
  const ctx = { helpers: { getBinaryDataBuffer: async (idx, key) => input[idx].binary[key].data } };
  const result = await run.call(ctx, { all: () => input });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(x => x.json.fileName), ['one.pdf', 'two.txt']);
  assert.notEqual(result[0].json.sourceKey, result[1].json.sourceKey);
  assert.equal(result[0].binary.data, input[0].binary.documents_0);
  await assert.rejects(run.call(ctx, { all: () => [{ json: {}, binary: { data: makeFile('bad.exe', txt) } }] }), /Unsupported file/);
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  const oversize = [{ json: {}, binary: { data: makeFile('big.txt', big) } }];
  await assert.rejects(run.call({ helpers: { getBinaryDataBuffer: async () => big } }, { all: () => oversize }), /5 MiB/);
});

test('cleaner preserves the current file metadata', () => {
  const run = new Function('$', '$json', i['Clean & Normalize Text'].parameters.jsCode);
  const a = run(() => ({ item: { json: { fileName: 'one.txt', sourceKey: '["policy","one.txt"]', category: 'policy', fileType: 'text', ingestedAt: '2026-10-16' } } }), { text: 'A policy paragraph with enough text.\n\nMore text.' });
  const b = run(() => ({ item: { json: { fileName: 'two.txt', sourceKey: '["policy","two.txt"]', category: 'policy', fileType: 'text', ingestedAt: '2026-10-16' } } }), { text: 'A separate document with enough text to index.' });
  assert.equal(a.json.source, 'one.txt');
  assert.equal(b.json.source, 'two.txt');
  assert.notEqual(a.json.sourceKey, b.json.sourceKey);
});

test('built-in chat accepts a session without a user and ignores a claimed user ID', () => {
  const run = new Function('$json', '$execution', '$workflow', '$', c['Validate Chat Session'].parameters.jsCode);
  const trigger = () => ({ params: c['Chat Message Received'].parameters });
  const context = [{ mode: 'test' }, { id: 'workflow-1' }, trigger];
  const result = run({ sessionId: 'session-1', chatInput: '  hello  ', action: 'sendMessage' }, ...context).json;
  assert.equal(result.chatInput, 'hello');
  assert.equal(result.action, 'sendMessage');
  assert.equal(result.memorySessionKey, '["editor-test","workflow-1","session-1"]');
  assert.notEqual(run({ sessionId: 'session-2', chatInput: 'hello' }, ...context).json.memorySessionKey, result.memorySessionKey);
  const forged = run({ sessionId: 'session-1', chatInput: 'hello', user: { id: 'forged' } }, ...context).json;
  assert.equal(forged.memorySessionKey, result.memorySessionKey);
  assert.equal(forged.user, undefined);
});

test('chat rejects missing or invalid sessions and unsafe public settings', () => {
  const run = new Function('$json', '$execution', '$workflow', '$', c['Validate Chat Session'].parameters.jsCode);
  const testContext = [{ mode: 'test' }, { id: 'workflow-1' }, () => ({ params: c['Chat Message Received'].parameters })];
  const message = { sessionId: 'session-1', chatInput: 'hello' };
  assert.throws(() => run({ chatInput: 'hello' }, ...testContext), /valid chat session ID/);
  assert.throws(() => run({ ...message, sessionId: '  ' }, ...testContext), /valid chat session ID/);
  assert.throws(() => run({ ...message, sessionId: { id: 'x' } }, ...testContext), /valid chat session ID/);
  assert.throws(() => run({ ...message, sessionId: 'x\nwrong' }, ...testContext), /valid chat session ID/);
  assert.throws(() => run({ ...message, chatInput: 'x'.repeat(4001) }, ...testContext), /4000/);
  assert.throws(() => run(message, { mode: 'production' }, testContext[1], testContext[2]), /private editor test/);
  const unsafeTrigger = () => ({ params: { public: true, authentication: 'none', requireExecuteAccess: false, includeUserInOutput: true } });
  assert.throws(() => run({ ...message, user: { id: 'forged' } }, { mode: 'production' }, testContext[1], unsafeTrigger), /authenticated n8n User Auth/);
  const secureTrigger = () => ({ params: { public: true, mode: 'hostedChat', authentication: 'n8nUserAuth', requireExecuteAccess: true, includeUserInOutput: true } });
  const embeddedTrigger = () => ({ params: { ...secureTrigger().params, mode: 'webhook' } });
  assert.throws(() => run({ ...message, user: { id: 'forged' } }, { mode: 'production' }, testContext[1], embeddedTrigger), /authenticated n8n User Auth/);
  assert.throws(() => run(message, { mode: 'production' }, testContext[1], secureTrigger), /authenticated n8n user/);
  const authenticated = run({ ...message, user: { id: 'server-user-1' } }, { mode: 'production' }, testContext[1], secureTrigger).json;
  assert.equal(authenticated.memorySessionKey, '["n8n-user","server-user-1","session-1"]');
  assert.equal(authenticated.user, undefined);
  const otherUser = run({ ...message, user: { id: 'server-user-2' } }, { mode: 'production' }, testContext[1], secureTrigger).json;
  assert.notEqual(otherUser.memorySessionKey, authenticated.memorySessionKey);
});
