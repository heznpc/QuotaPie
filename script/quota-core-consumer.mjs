// Synthetic consumer executed from an isolated npm install under both runtimes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  routeCompaction, DEFAULT_COMPACTION_ROUTE, TaskSavingsRouter, DEFAULT_TASK_SAVINGS,
  ResponseCompletionObserver, parseCompactionRequestEvent, summarizeRequestEvents,
  parseCodexRateLimits, parseClaudeStatusLine, mapClaudeUsage, QUOTA_CORE_EVENT_SCHEMA_VERSION,
  selectTaskModel,
} from '@heznpc/quota-core';

const installedPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@heznpc/quota-core')), 'utf8')).version;
const selectionInput = { phase: 'verification',
  phasePreferences: { verification: { provider: 'fixture', model: 'review', effort: 'high' } },
  defaultSelection: { provider: 'fixture', model: 'work' },
  capabilities: [{ provider: 'fixture', model: 'review', efforts: ['high'] }, { provider: 'fixture', model: 'work', efforts: [] }],
};
assert.deepEqual(selectTaskModel(selectionInput), { status: 'selected', phase: 'verification',
  source: 'phase', selection: { provider: 'fixture', model: 'review', effort: 'high' }, reason: 'phase_preference' });
assert.deepEqual(selectTaskModel({ ...selectionInput, manualSelection: { provider: 'fixture', model: 'missing' } }), {
  status: 'unavailable', phase: 'verification', source: 'manual', selection: null,
  requested: { provider: 'fixture', model: 'missing' }, reason: 'unsupported_model',
});

const original = { model: 'gpt-6-astra', reasoning: { effort: 'high' }, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Fix the button typo "Svae".' }] }] };
const before = JSON.stringify(original);
const thread = '10000000-0000-4000-8000-000000000001';
const router = new TaskSavingsRouter(() => true);
assert.equal(router.route(original, DEFAULT_TASK_SAVINGS, thread).body.model, 'gpt-5.6-luna');
assert.equal(JSON.stringify(original), before);
router.failed(thread);
assert.equal(router.route(original, DEFAULT_TASK_SAVINGS, thread).reason, 'failure_fallback');
assert.equal(new TaskSavingsRouter().route(original, DEFAULT_TASK_SAVINGS, thread).reason, 'unsupported_model');
assert.equal(routeCompaction('/responses', original, DEFAULT_COMPACTION_ROUTE).routed, false);
const routed = routeCompaction('/responses/compact', original, DEFAULT_COMPACTION_ROUTE);
assert.equal(routed.body.model, 'gpt-5.6-sol');
assert.equal(routed.body.reasoning.effort, 'low');
assert.equal(JSON.stringify(original), before);

// Real loopback transport; the upstream is synthetic, not model capability proof.
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: body.model, usage: { input_tokens: 12, output_tokens: 3 } } })}\n\n`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/responses/compact`, { method: 'POST', body: JSON.stringify(routed.body) });
  assert.equal(response.status, 200);
  const observer = new ResponseCompletionObserver(response.headers.get('content-type'), true);
  for await (const bytes of response.body) observer.push(bytes);
  assert.equal(observer.finish().phase, 'completed');
  assert.equal(observer.responseModel, 'gpt-5.6-sol');
  assert.deepEqual(observer.usage, { input: 12, cachedInput: 0, output: 3 });
  const unproven = new ResponseCompletionObserver('text/event-stream', false);
  unproven.push(new TextEncoder().encode('data: [DONE]\n\n'));
  assert.equal(unproven.finish().phase, 'failed');
  assert.equal(unproven.responseModel, null);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

const base = { requestId: '20000000-0000-4000-8000-000000000001', threadId: thread, turnId: null, kind: 'compaction', from: 'gpt-6-astra', to: 'gpt-5.6-sol', routed: true, phase: 'completed', status: 200, requestedEffort: 'high', reasoningEffort: 'low', at: '2026-01-01T00:00:01Z', durationMs: 1000 };
const event = parseCompactionRequestEvent({ ...base, authorization: 'fixture-secret', prompt: 'fixture-private', url: 'https://invalid.local/private' });
assert.deepEqual(Object.keys(event).sort(), [...Object.keys(base), 'responseModel', 'usage'].sort());
assert.equal(JSON.stringify(event).includes('fixture-'), false);
assert.equal(parseCompactionRequestEvent({ ...base, requestId: 'invalid' }), null);
assert.equal(QUOTA_CORE_EVENT_SCHEMA_VERSION, 1);
const followup = { ...base, requestId: '30000000-0000-4000-8000-000000000001', kind: 'response', to: 'gpt-6-astra', at: '2026-01-01T00:00:03Z' };
assert.equal(summarizeRequestEvents([event, followup], new Set()).records[0].followup.model, 'gpt-6-astra');
assert.equal(summarizeRequestEvents([event, { ...followup, threadId: '40000000-0000-4000-8000-000000000001' }], new Set()).records[0].followup, null);
assert.equal(summarizeRequestEvents([{ ...event, phase: 'started' }], new Set()).records[0].phase, 'unverified');
const quota = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: null, windowDurationMins: 300, resetsAt: 1900000000 } }, email: 'private@example.invalid' }, 1000, 'local');
assert.equal(quota[0].usedPercent, null);
assert.equal(quota[0].resetsAtMs, 1900000000000);
assert.equal(quota[0].account, 'local');
assert.equal(JSON.stringify(quota).includes('private@'), false);
assert.equal(mapClaudeUsage({ five_hour: { utilization: 125 } }, 'local', 1000)[0].usedPercent, 100);
const claude = parseClaudeStatusLine({ session_id: 'fixture-session-secret', rate_limits: { five_hour: { used_percentage: 20 } } }, 1000, 'local');
assert.equal(claude[0].usedPercent, 20);
assert.equal(claude[0].metadata.sessionHash.length, 16);
assert.equal(JSON.stringify(claude).includes('fixture-session-secret'), false);
console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', installedPackage, taskModelSelection: 'pass', loopbackRouting: 'pass', completionEvidence: 'pass', metadataProjection: 'pass', quotaNormalization: 'pass', liveProvider: 'not-tested', quality: 'not-tested' }));
