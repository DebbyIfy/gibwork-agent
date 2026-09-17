import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterLLMProvider, ProviderReasoningError, OPENROUTER_BASE_URL, DEFAULT_MODEL } from './real-llm-provider.js';
import { applyReasoning } from './reasoning.js';
import { LocalDeterministicEvaluator } from './evaluator.js';
import { extractRequirements } from './requirements.js';
import type { LLMProvider, ReasoningRequest } from './llm.js';
import type { ReviewSubmission, ReviewTask } from './types.js';

/**
 * All tests here run entirely offline: a fake `fetch` is injected into the provider,
 * so no real network call is ever made and no real OpenRouter API key is required.
 */

function openRouterChatBody(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: 'gen-test',
    model: 'meta-llama/some-free-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
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
    const call: RecordedCall = { url, init, body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : undefined };
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
  const { fetch: fakeFetch, calls } = makeFakeFetch(() => jsonResponse(openRouterChatBody(JSON.stringify(validResult))));
  const provider = new OpenRouterLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  const result = await provider.reason(sampleRequest);

  assert.equal(result.submissionId, 'sub-test');
  assert.equal(result.relevance.length, 1);
  assert.equal(result.relevance[0]?.verdict, 'relevant');
  assert.equal(result.contradiction, undefined);
  assert.equal(calls.length, 1);
});

// 2. a JSON response wrapped in a markdown code fence still parses
test('a response wrapped in a ```json code fence is still parsed correctly', async () => {
  const fenced = '```json\n' + JSON.stringify(validResult) + '\n```';
  const { fetch: fakeFetch } = makeFakeFetch(() => jsonResponse(openRouterChatBody(fenced)));
  const provider = new OpenRouterLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  const result = await provider.reason(sampleRequest);
  assert.equal(result.relevance[0]?.verdict, 'relevant');
});

// 3. invalid JSON response
test('invalid JSON response is rejected as a safe ProviderReasoningError, not a crash', async () => {
  const { fetch: fakeFetch } = makeFakeFetch(() => jsonResponse(openRouterChatBody('this is not json {{{')));
  const provider = new OpenRouterLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  await assert.rejects(() => provider.reason(sampleRequest), ProviderReasoningError);
});

// 4. malformed structured response (valid JSON, wrong shape)
test('malformed structured response (missing/invalid fields) is rejected by validation', async () => {
  const malformed = {
    relevance: [{ requirementId: 'req-1' }], // missing verdict/reasoning/confidence
    contradiction: null,
    ambiguity: { needsReasoning: false, reason: 'x', confidence: 'medium' },
  };
  const { fetch: fakeFetch } = makeFakeFetch(() => jsonResponse(openRouterChatBody(JSON.stringify(malformed))));
  const provider = new OpenRouterLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  await assert.rejects(() => provider.reason(sampleRequest), ProviderReasoningError);
});

// 5. API error
test('an HTTP API error is mapped to a safe ProviderReasoningError', async () => {
  const { fetch: fakeFetch } = makeFakeFetch(() =>
    jsonResponse({ error: { message: 'internal failure', code: 'server_error' } }, 500),
  );
  const provider = new OpenRouterLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  await assert.rejects(() => provider.reason(sampleRequest), ProviderReasoningError);
});

// 6. authentication failure surfaces a message naming the correct env var
test('a 401 response is mapped to an authentication-specific error mentioning OPENROUTER_API_KEY', async () => {
  const { fetch: fakeFetch } = makeFakeFetch(() => jsonResponse({ error: { message: 'invalid key' } }, 401));
  const provider = new OpenRouterLLMProvider({ apiKey: 'bad-key', fetch: fakeFetch });

  await assert.rejects(() => provider.reason(sampleRequest), (error: unknown) => {
    assert.ok(error instanceof ProviderReasoningError);
    assert.match(error.message, /OPENROUTER_API_KEY/);
    return true;
  });
});

// 7. missing API key
test('a missing API key fails immediately, with no network call attempted', async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return jsonResponse(openRouterChatBody(JSON.stringify(validResult)));
  }) as typeof fetch;
  const provider = new OpenRouterLLMProvider({ apiKey: '', fetch: fakeFetch });

  await assert.rejects(() => provider.reason(sampleRequest), ProviderReasoningError);
  assert.equal(called, false, 'fetch must never be called when the API key is missing');
});

// 8. request configuration: URL, auth header, default model
test('the request targets the OpenRouter chat completions endpoint with a bearer auth header and the default model', async () => {
  const { fetch: fakeFetch, calls } = makeFakeFetch(() => jsonResponse(openRouterChatBody(JSON.stringify(validResult))));
  const provider = new OpenRouterLLMProvider({ apiKey: 'secret-key', fetch: fakeFetch });

  await provider.reason(sampleRequest);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${OPENROUTER_BASE_URL}/chat/completions`);
  assert.equal(calls[0]?.init?.method, 'POST');
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer secret-key');
  assert.equal(calls[0]?.body?.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'openrouter/free');
});

// 9. model selection: an explicit model overrides the default
test('an explicit model option overrides the default openrouter/free model', async () => {
  const { fetch: fakeFetch, calls } = makeFakeFetch(() => jsonResponse(openRouterChatBody(JSON.stringify(validResult))));
  const provider = new OpenRouterLLMProvider({ apiKey: 'test-key', model: 'openai/gpt-4o-mini', fetch: fakeFetch });

  await provider.reason(sampleRequest);

  assert.equal(calls[0]?.body?.model, 'openai/gpt-4o-mini');
});

// 10. structured output request shape: json_object response_format and schema-carrying system prompt
test('the request asks for json_object output and carries the expected schema in the system prompt', async () => {
  const { fetch: fakeFetch, calls } = makeFakeFetch(() => jsonResponse(openRouterChatBody(JSON.stringify(validResult))));
  const provider = new OpenRouterLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  await provider.reason(sampleRequest);

  const body = calls[0]?.body as { response_format?: { type: string }; messages?: { role: string; content: string }[] };
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const systemMessage = body.messages?.find((message) => message.role === 'system');
  assert.ok(systemMessage?.content.includes('"requirementId"'), 'system prompt must describe the expected JSON schema');
});

// 11. provider failure preserves the deterministic assessment
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

// 12. batched reasoning request
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
  const { fetch: fakeFetch, calls } = makeFakeFetch(() => jsonResponse(openRouterChatBody(JSON.stringify(batchedResult))));
  const provider = new OpenRouterLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  const result = await provider.reason(request);

  assert.equal(calls.length, 1, 'both triggers must be served by a single call, not one per trigger');
  assert.equal(result.relevance.length, 2);
  assert.ok(result.contradiction);
  const sentMessages = calls[0]?.body?.messages as { content: string }[] | undefined;
  const userPrompt = sentMessages?.find((message) => message.content.includes('Requirement ['))?.content ?? '';
  assert.ok(userPrompt.includes('req-a') && userPrompt.includes('req-b'), 'prompt must cover both requirements');
  assert.ok(userPrompt.includes('Contradiction check'), 'prompt must include the contradiction section');
});

// 13. no change to deterministic score/classification/confidence
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

// 14. an OpenRouterLLMProvider result never mutates the deterministic assessment either,
// even when it returns a confident-looking "relevant" verdict end-to-end through the fake fetch.
test('an OpenRouterLLMProvider result flowing through applyReasoning never mutates the deterministic assessment', async () => {
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
  const snapshotBefore = JSON.stringify(assessment);

  const { fetch: fakeFetch } = makeFakeFetch(() => jsonResponse(openRouterChatBody(JSON.stringify(validResult))));
  const provider = new OpenRouterLLMProvider({ apiKey: 'test-key', fetch: fakeFetch });

  const reasoning = await applyReasoning(submission, requirements, assessment, provider);

  assert.equal(reasoning.routed, true);
  assert.equal(reasoning.result?.relevance[0]?.verdict, 'relevant');
  assert.equal(JSON.stringify(assessment), snapshotBefore, 'assessment object must be byte-identical after reasoning runs');
});
