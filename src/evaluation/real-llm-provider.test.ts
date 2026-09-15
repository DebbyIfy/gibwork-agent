import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicLLMProvider, ProviderReasoningError } from './real-llm-provider.js';
import { applyReasoning } from './reasoning.js';
import { LocalDeterministicEvaluator } from './evaluator.js';
import { extractRequirements } from './requirements.js';
import type { LLMProvider, ReasoningRequest } from './llm.js';
import type { ReviewSubmission, ReviewTask } from './types.js';

/**
 * All tests here run entirely offline: a fake `fetch` is injected into the SDK
 * client, so no real network call is ever made and no real API key is required.
 */

function anthropicMessageBody(text: string, stopReason = 'end_turn'): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface RecordedCall {
  url: string;
  body: Record<string, unknown> | undefined;
}

function makeFakeFetch(handler: (call: RecordedCall, callIndex: number) => Response): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    const call: RecordedCall = { url, body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : undefined };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const sampleRequest: ReasoningRequest = {
  submissionId: 'sub-test',
  relevance: [
    {
      requirementId: 'req-1',
      requirementDescription: 'Some requirement',
      claimText: 'I did the thing: https://example.com',
      evidence: [{ type: 'url', value: 'https://example.com' }],
    },
  ],
};

const validResult = {
  relevance: [{ requirementId: 'req-1', verdict: 'relevant', reasoning: 'Evidence matches.', confidence: 'high' }],
  contradiction: null,
  ambiguity: { needsReasoning: false, reason: 'Nothing further to check.', confidence: 'medium' },
};

// 1. valid structured LLM response
test('valid structured response is parsed and returned', async () => {
  const { fetch: fakeFetch, calls } = makeFakeFetch(() => jsonResponse(anthropicMessageBody(JSON.stringify(validResult))));
  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  const result = await provider.reason(sampleRequest);

  assert.equal(result.submissionId, 'sub-test');
  assert.equal(result.relevance.length, 1);
  assert.equal(result.relevance[0]?.verdict, 'relevant');
  assert.equal(result.contradiction, undefined);
  assert.equal(calls.length, 1);
});

// 2. invalid JSON response
test('invalid JSON response is rejected as a safe ProviderReasoningError, not a crash', async () => {
  const { fetch: fakeFetch } = makeFakeFetch(() => jsonResponse(anthropicMessageBody('this is not json {{{')));
  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  await assert.rejects(() => provider.reason(sampleRequest), ProviderReasoningError);
});

// 3. malformed structured response (valid JSON, wrong shape)
test('malformed structured response (missing/invalid fields) is rejected by validation', async () => {
  const malformed = {
    relevance: [{ requirementId: 'req-1' }], // missing verdict/reasoning/confidence
    contradiction: null,
    ambiguity: { needsReasoning: false, reason: 'x', confidence: 'medium' },
  };
  const { fetch: fakeFetch } = makeFakeFetch(() => jsonResponse(anthropicMessageBody(JSON.stringify(malformed))));
  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  await assert.rejects(() => provider.reason(sampleRequest), ProviderReasoningError);
});

// 4. API error
test('an HTTP API error is mapped to a safe ProviderReasoningError', async () => {
  const { fetch: fakeFetch } = makeFakeFetch(() =>
    jsonResponse({ type: 'error', error: { type: 'api_error', message: 'internal failure' } }, 500),
  );
  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', fetch: fakeFetch, maxRetries: 0 });

  await assert.rejects(() => provider.reason(sampleRequest), ProviderReasoningError);
});

// 5. missing API key
test('a missing API key fails immediately, with no network call attempted', async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return jsonResponse(anthropicMessageBody(JSON.stringify(validResult)));
  }) as typeof fetch;
  const provider = new AnthropicLLMProvider({ apiKey: '', fetch: fakeFetch });

  await assert.rejects(() => provider.reason(sampleRequest), ProviderReasoningError);
  assert.equal(called, false, 'fetch must never be called when the API key is missing');
});

// 6. provider failure preserves the deterministic assessment
test('applyReasoning degrades gracefully: a provider failure never removes the deterministic assessment', async () => {
  const task: ReviewTask = {
    id: 't1',
    title: 'Task',
    description: 'desc',
    requirements: [{ id: 'req-1', description: 'Do X', required: true, keywords: ['thing'], evidenceType: 'url' }],
  };
  const submission: ReviewSubmission = { id: 'sub-1', content: 'I did the thing, see https://example.com/evidence' };
  const requirements = extractRequirements(task);
  const evaluator = new LocalDeterministicEvaluator([submission]);
  const assessment = await evaluator.evaluate(task, submission);

  const throwingProvider: LLMProvider = {
    reason: async () => {
      throw new Error('simulated provider crash');
    },
  };

  const reasoning = await applyReasoning(submission, requirements, assessment, throwingProvider);

  assert.equal(reasoning.routed, true);
  assert.equal(reasoning.result, undefined);
  assert.ok(reasoning.error?.includes('simulated provider crash'));
  // The deterministic assessment itself must still be exactly what it was.
  assert.equal(assessment.classification, 'strong');
});

// 7. batched reasoning request
test('multiple triggers for one submission produce exactly one batched fetch call', async () => {
  const request: ReasoningRequest = {
    submissionId: 'sub-batch',
    relevance: [
      { requirementId: 'req-a', requirementDescription: 'A', claimText: 'text', evidence: [] },
      { requirementId: 'req-b', requirementDescription: 'B', claimText: 'text', evidence: [] },
    ],
    contradiction: {
      submissionText: 'text',
      requirementClaims: [
        { requirementId: 'req-a', description: 'A' },
        { requirementId: 'req-b', description: 'B' },
      ],
    },
  };
  const batchedResult = {
    relevance: [
      { requirementId: 'req-a', verdict: 'relevant', reasoning: 'ok', confidence: 'high' },
      { requirementId: 'req-b', verdict: 'uncertain', reasoning: 'unclear', confidence: 'low' },
    ],
    contradiction: { contradictionFound: false, explanation: 'none found', confidence: 'medium' },
    ambiguity: { needsReasoning: false, reason: 'fine', confidence: 'medium' },
  };
  const { fetch: fakeFetch, calls } = makeFakeFetch(() => jsonResponse(anthropicMessageBody(JSON.stringify(batchedResult))));
  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  const result = await provider.reason(request);

  assert.equal(calls.length, 1, 'both triggers must be served by a single call, not one per trigger');
  assert.equal(result.relevance.length, 2);
  assert.ok(result.contradiction);
  const sentMessages = calls[0]?.body?.messages as { content: string }[] | undefined;
  const userPrompt = sentMessages?.[0]?.content ?? '';
  assert.ok(userPrompt.includes('req-a') && userPrompt.includes('req-b'), 'prompt must cover both requirements');
  assert.ok(userPrompt.includes('Contradiction check'), 'prompt must include the contradiction section');
});

// 8. no change to deterministic score/classification/confidence
test('running reasoning never mutates the deterministic assessment', async () => {
  const task: ReviewTask = {
    id: 't1',
    title: 'Task',
    description: 'desc',
    requirements: [{ id: 'req-1', description: 'Do X', required: true, keywords: ['thing'] }],
  };
  const submission: ReviewSubmission = { id: 'sub-1', content: 'I did the thing.' };
  const requirements = extractRequirements(task);
  const evaluator = new LocalDeterministicEvaluator([submission]);
  const assessment = await evaluator.evaluate(task, submission);
  const snapshotBefore = JSON.stringify(assessment);

  const okProvider: LLMProvider = {
    reason: async (req) => ({
      submissionId: req.submissionId,
      relevance: [],
      ambiguity: { needsReasoning: true, reason: 'advisory only', confidence: 'medium' },
    }),
  };
  await applyReasoning(submission, requirements, assessment, okProvider);

  assert.equal(JSON.stringify(assessment), snapshotBefore, 'score/classification/confidence must be byte-identical after reasoning');
});
