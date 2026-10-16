# Testing and evaluation

## Observed in n8n Cloud

The live workflows completed these functional checks:

| Area | Observation |
| --- | --- |
| Ingestion | Upload, extraction, chunking, embedding, and Supabase indexing succeeded. Two files uploaded in one execution were processed separately. |
| Retrieval | The assistant cited the correct source file and combined information from two documents. |
| Conversation | Follow-up questions in one session worked. The assistant remembered a user-provided test code in a later message. |
| Missing information | The assistant handled a question whose answer was absent from the indexed documents. |
| Duplicate handling | Re-uploading unchanged content did not create another document version. |
| Replacement | After `project-alpha.txt` changed its manager from Sarah to Layla, the assistant answered Layla and cited `project-alpha.txt`. |

These results are observations from functional tests, not a measured accuracy or reliability benchmark. They do not establish cross-session isolation, PostgreSQL persistence across restarts, security, scalability, or production readiness.

## Offline checks

`npm test` runs local checks for workflow JSON, graph wiring, embedding configuration, authentication flags, file validation, per-file metadata, chunk count handling, schema and migration contracts, and synthetic retrieval metric calculations. It makes no external requests. When the local-only root exports are present, it also checks their original SHA-256 hashes. A public clone skips that hash check because those exports are excluded from Git.

## Evaluation still to run

| Area | Suggested check |
| --- | --- |
| Retrieval quality | Label source files for a fixed query set, record top-five retrieval results, then calculate Hit@5 and MRR@5. |
| Groundedness | Compare each cited answer with the source text, including questions with no answer in the corpus. |
| Failure paths | Exercise partial indexing, failed replacement, unsupported files, scanned PDFs, unavailable tools, and `conflict_retry`. |
| Isolation and persistence | Test separate sessions and users, then restart or reconnect the chat workflow and check memory behavior. |
| Security | Review access controls, prompt injection handling, credential scope, request limits, and service-role exposure before public access. |
| Performance | Record ingestion and chat latency across a fixed sample; report sample size and p50/p95. |
| Tools | Verify Brave search and calculator calls with controlled prompts and inspect the actual tool outputs. |

To calculate retrieval metrics, save private labels in `results.json` and run `node scripts/evaluate_retrieval.mjs results.json 5`. The file is ignored by Git. Each entry needs `id`, `relevant_sources`, and `retrieved_sources`; `latency_ms` is optional. For example:

```json
[
  {
    "id": "question-1",
    "relevant_sources": ["policy.txt"],
    "retrieved_sources": ["policy.txt", "manual.pdf"],
    "latency_ms": 1200
  }
]
```

The example is input format only. It is not a project result. Do not place document text, session IDs, or credential values in a public test record.
