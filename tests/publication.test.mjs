import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const read = file => readFileSync(file, 'utf8');
const docs = ['README.md'];
const exports = [
  'workflows/01-document-ingestion.review.json',
  'workflows/02-conversational-assistant.review.json',
];

test('public documentation has local links and no stylistic long dashes', () => {
  for (const file of docs) {
    const markdown = read(file);
    assert.doesNotMatch(markdown, /[\u2013\u2014]/, `${file} contains a long dash`);
    // Links inside fenced code are examples, not rendered links.
    const prose = markdown.replace(/```[\s\S]*?```/g, '');
    for (const [, target] of prose.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(target)) continue;
      const path = decodeURIComponent(target.split('#')[0]);
      assert.ok(existsSync(resolve(dirname(file), path)), `${file} links to missing ${path}`);
    }
  }
});

test('architecture diagram uses a simple GitHub Mermaid flowchart', () => {
  const diagram = read('README.md').match(/```mermaid\n([\s\S]*?)\n```/);
  assert.ok(diagram, 'README architecture diagram is missing');
  const lines = diagram[1].trim().split('\n').map(line => line.trim());
  // An optional theme directive may precede the flowchart.
  if (lines[0].startsWith('%%{init:')) lines.shift();
  assert.equal(lines.shift(), 'flowchart LR');
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(line, /^\w+(?:\[[^\[\]]+\]|\[\([^()]+\)\])? --> \w+(?:\[[^\[\]]+\]|\[\([^()]+\)\])?$/, `invalid flowchart edge: ${line}`);
  }
});

test('public workflow exports omit instance identifiers and credentials', () => {
  for (const file of exports) {
    const workflow = JSON.parse(read(file));
    assert.equal(workflow.id, undefined);
    assert.equal(workflow.versionId, undefined);
    assert.equal(workflow.meta, undefined);
    assert.equal(workflow.active, false);
    for (const node of workflow.nodes) {
      assert.equal(node.credentials, undefined, `${file}: ${node.name} has a credential reference`);
      assert.equal(node.webhookId, undefined, `${file}: ${node.name} has a webhook ID`);
    }
    assert.doesNotMatch(read(file), /https?:\/\/[^\s"']*(?:n8n|supabase)\.[^\s"']+/i);
  }
  const gitignore = read('.gitignore');
  assert.match(gitignore, /^\/RAG _ 1\. Document Ingestion & Indexing\.json$/m);
  assert.match(gitignore, /^\/RAG _ 2\. Conversational AI Assistant\.json$/m);
});

test('example configuration contains placeholders only', () => {
  const lines = read('.env.example').split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  const safeLiterals = new Set(['postgres', 'true']);
  for (const line of lines) {
    const index = line.indexOf('=');
    assert.ok(index > 0, 'invalid example configuration line');
    const value = line.slice(index + 1);
    assert.ok(/<[A-Z_]+>/.test(value) || safeLiterals.has(value), 'example configuration has a concrete value');
  }
});
