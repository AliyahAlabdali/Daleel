<div align="center">

# Daleel

**A RAG assistant that answers from your documents and shows its sources**

![n8n](https://img.shields.io/badge/n8n-workflows-EA4B71?style=flat-square&logo=n8n&logoColor=white&labelColor=1F2937)
![Supabase](https://img.shields.io/badge/Supabase-pgvector-EA4B71?style=flat-square&logo=supabase&logoColor=white&labelColor=1F2937)
![OpenAI](https://img.shields.io/badge/OpenAI-embeddings-EA4B71?style=flat-square&logo=openai&logoColor=white&labelColor=1F2937)

![Demo of the assistant answering questions and replacing a document](assets/demo.gif)

</div>

## About

Daleel (دليل) is an AI RAG assistant for your documents. You upload your files, ask questions in plain language, and each answer comes with the file it was taken from. When a document changes, you upload the new version and Daleel replaces the old one, so answers don't mix outdated and current information.

It runs on two n8n workflows: one indexes documents into Supabase pgvector, and the other is a chat agent that searches them.

## Features

- Upload PDF, TXT or MD files, up to 3 per batch and 5 MiB each
- Every answer names the files it came from
- Unchanged re-uploads are detected by SHA-256 hash and skipped
- A changed file replaces the old version only after its new chunks are indexed and counted, in a single transaction
- Follow-up questions use chat history stored in Postgres
- Web search and a calculator for questions the documents can't answer
- Text inside documents is treated as data, so hidden instructions are ignored

## Demo

Recorded on n8n Cloud with the sample files in [`demo/documents`](demo/documents). The travel policy and vendor notes were indexed before the recording.

| # | Action | Result | |
| :-: | --- | --- | :-: |
| 1 | Upload `project-nakheel.txt` | `inserted: 1` | Pass |
| 2 | Who manages Project Nakheel and when does it launch? | Noura Alqahtani, 14 Dec 2026 | Pass |
| 3 | What percentage of its budget has been spent? | 38%, SAR 171,000 of 450,000 | Pass |
| 4 | Daily allowance for the team on a 3-day trip to Jeddah, and does it need director approval? | SAR 6,000, no. Cites both files | Pass |
| 5 | How many days of annual leave do employees get? | Not in the documents, no answer invented | Partial |
| 6 | Upload the updated `project-nakheel.txt` | `replaced: 1` | Pass |
| 7 | Upload the same file again | `duplicate: 1` | Pass |
| 8 | Who manages Project Nakheel now, and how much budget is left? | Faisal Alharbi, SAR 203,500 | Pass |
| 9 | What did the vendor say? (file with a hidden instruction) | Real points only, instruction ignored | Pass |

Step 5 didn't offer a web search, which the system prompt asks for.

**Step 4.** One answer drawing on two documents

![Answer citing travel-policy.md and project-nakheel.txt](assets/chat-answer.png)

**Step 6.** The updated file replaces the old version

![Upload summary showing replaced: 1](assets/upload-result.png)

**Step 9.** The hidden instruction in `vendor-notes.txt` is ignored

![Answer to the vendor question that ignores the hidden instruction](assets/injection-check.png)

## How it works

```mermaid
%%{init: {"theme": "base", "themeVariables": {"primaryColor": "#1F2937", "primaryTextColor": "#F9FAFB", "primaryBorderColor": "#EA4B71", "lineColor": "#EA4B71"}}}%%
flowchart LR
  Upload[Upload form] --> Validate[Validate and extract]
  Validate --> Hash[Hash check]
  Hash --> Registry[(document_registry)]
  Hash --> Skip[Unchanged: skip]
  Hash --> Embed[New or changed: chunk and embed]
  Embed --> Docs[(documents)]
  Docs --> Activate[Count chunks and activate version]
  Activate --> Registry
  Chat[Chat message] --> Session[Validate session]
  Session --> Agent[AI agent]
  Agent --> Tools[Web search and calculator]
  Agent --> Memory[(Chat memory)]
  Agent --> Search[Vector search, active versions only]
  Search --> Docs
  Search --> Registry
```

### Ingestion

Each file is validated, extracted and hashed. A known hash stops at `Confirm Duplicate`. New or changed text is split into 1,000-character chunks with 200 overlap, embedded with `text-embedding-3-small`, and written to `documents`. `activate_document` then checks the chunk count and switches the active version in `document_registry`.

![Ingestion workflow in n8n](assets/ingestion-workflow.png)

### Chat

`Validate Chat Session` checks the session and builds the memory key. The agent searches the top 5 chunks from active versions only, keeps the last 10 messages in Postgres, and calls web search or the calculator when needed.

![Chat workflow in n8n](assets/chat-workflow.png)

## Stack

| Layer | Tool |
| --- | --- |
| Orchestration | n8n Cloud |
| Vector store | Supabase Postgres with pgvector (HNSW, cosine) |
| Embeddings | OpenAI `text-embedding-3-small`, 1536 dimensions |
| Chat model | OpenAI through the n8n AI Gateway |
| Memory | n8n Postgres Chat Memory |
| Tools | Brave Search, calculator |
| Tests | Node.js test runner |

## Run it yourself

**1. Database.** Run [`supabase/schema.sql`](supabase/schema.sql) once in the SQL Editor of a new Supabase project. Then create the login the workflows use:

```sql
create role rag_n8n_login with login inherit password 'choose-a-password';
grant rag_workflow to rag_n8n_login;
```

[`supabase/verify.sql`](supabase/verify.sql) checks tables, grants and RLS.

**2. Workflows.** Import both files from [`workflows/`](workflows) into n8n.

**3. Credentials.**

| Credential | Values | Nodes |
| --- | --- | --- |
| Supabase | Project URL without `/rest/v1/`, `service_role` key | `Index Chunks in Supabase`, `knowledge_base_search` |
| Postgres | Session pooler host, port 5432, database `postgres`, user `rag_n8n_login.<project-ref>`, SSL | `Check Document Version`, `Confirm Duplicate`, `Activate Document Version`, `Postgres Chat Memory` |
| OpenAI, Brave | n8n AI Gateway | Chat model, embeddings, `web_search` |

**4. Use it.** The upload form requires an n8n login, which doesn't work from the editor's test mode. Publish the ingestion workflow and open its form. Chat works from the editor's chat panel.

## Tests

```sh
npm test
```

16 offline checks covering workflow wiring, upload validation, the SQL schema, and that no credentials or instance IDs are committed.

To score retrieval, label a set of questions and run `node scripts/evaluate_retrieval.mjs results.json 5` for Hit@5 and MRR.

## Project structure

```
├── workflows/          n8n exports, credentials removed
├── supabase/           schema, verification queries, migration
├── demo/documents/     sample files used in the demo
├── assets/             GIF and screenshots
├── scripts/            workflow builder, retrieval scoring
└── tests/              offline checks
```

## Limitations

- The demo results come from one run, not an accuracy benchmark.
- PDFs that are scanned images of pages can't be read yet. Only PDFs with selectable text work.

---

<div align="center">

<sub>Made with 🤍 by <b>Aliyah Alabdali</b></sub>

</div>
