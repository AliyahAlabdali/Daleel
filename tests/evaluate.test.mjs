import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../scripts/evaluate_retrieval.mjs';

test('Hit@k, MRR@k, and latency math on synthetic labels', () => {
  const rows = [
    { id: 'a', relevant_sources: ['a.txt'], retrieved_sources: ['a.txt', 'b.txt'], latency_ms: 100 },
    { id: 'b', relevant_sources: ['b.txt'], retrieved_sources: ['a.txt', 'b.txt'], latency_ms: 300 },
    { id: 'c', relevant_sources: ['c.txt'], retrieved_sources: ['a.txt', 'b.txt'], latency_ms: 200 },
  ];
  assert.deepEqual(evaluate(rows, 2), {
    queries: 3, k: 2, hit_at_k: 2 / 3, mrr_at_k: 0.5,
    latency_samples: 3, latency_p50_ms: 200, latency_p95_ms: 300,
  });
});
