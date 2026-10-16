# Portfolio summary

## Project description

Built a document-grounded assistant in n8n Cloud. It ingests PDF, TXT, and MD files, stores OpenAI embeddings in Supabase pgvector, and retrieves active document versions to support cited answers in chat.

## Engineering highlights

- Designed a per-file ingestion flow with validation, text extraction, chunking, and source metadata.
- Used SHA-256 hashes and a PostgreSQL document registry to detect duplicates and replace changed documents only after their new chunks were indexed and counted.
- Connected Supabase vector search to an n8n AI Agent with source attribution, PostgreSQL Chat Memory, Brave search, and a calculator tool.
- Added private upload and chat entry points, scoped chat session keys, SQL access controls, and offline workflow checks.
- Verified multi-file retrieval, multi-turn responses, duplicate detection, and version replacement in n8n Cloud.

## Technology

n8n Cloud, Supabase PostgreSQL, pgvector, OpenAI `text-embedding-3-small` via n8n Gateway, Brave Search, JavaScript, and SQL.

## Scope

The system has passed the functional checks listed in [testing](testing.md). Retrieval quality metrics, failure recovery under load, public endpoint security, and PostgreSQL memory persistence across restarts remain future evaluation work.
