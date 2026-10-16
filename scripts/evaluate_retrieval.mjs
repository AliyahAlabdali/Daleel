import { readFileSync } from 'node:fs';

export function evaluate(rows, k = 5) {
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer');
  if (!Array.isArray(rows) || !rows.length) throw new Error('Provide at least one labeled query');
  let hits = 0;
  let reciprocalRank = 0;
  const latencies = [];
  for (const row of rows) {
    if (!row.id || !Array.isArray(row.relevant_sources) || !row.relevant_sources.length || !Array.isArray(row.retrieved_sources)) {
      throw new Error('Each row needs id, relevant_sources, and retrieved_sources');
    }
    const relevant = new Set(row.relevant_sources);
    const rank = row.retrieved_sources.slice(0, k).findIndex(source => relevant.has(source));
    if (rank >= 0) {
      hits++;
      reciprocalRank += 1 / (rank + 1);
    }
    if (Number.isFinite(row.latency_ms) && row.latency_ms >= 0) latencies.push(row.latency_ms);
  }
  latencies.sort((a, b) => a - b);
  const percentile = p => latencies.length ? latencies[Math.ceil(p * latencies.length) - 1] : null;
  return {
    queries: rows.length,
    k,
    hit_at_k: hits / rows.length,
    mrr_at_k: reciprocalRank / rows.length,
    latency_samples: latencies.length,
    latency_p50_ms: percentile(0.5),
    latency_p95_ms: percentile(0.95),
  };
}

if (process.argv[1]?.endsWith('evaluate_retrieval.mjs')) {
  const path = process.argv[2];
  const k = process.argv[3] ? Number(process.argv[3]) : 5;
  if (!path) {
    console.error('Usage: node scripts/evaluate_retrieval.mjs results.json [k]');
    process.exitCode = 1;
  } else {
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    console.log(JSON.stringify(evaluate(rows, k), null, 2));
  }
}
