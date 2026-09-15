import test from 'node:test';
import assert from 'node:assert/strict';
import type { MediaItem, TaskDetails, TaskSubmission, UserSummary } from '@gibwork/sdk';
import { mapMediaType, toReviewSubmission, toReviewTask } from './gibwork-adapter.js';

/**
 * All tests here are pure/offline: no network call, no SDK client, no fixture files.
 * Only literal SDK-shaped objects are used as inputs to the mapper functions.
 */

function baseTaskDetails(overrides: Partial<TaskDetails> = {}): TaskDetails {
  return {
    id: 'task-1',
    slug: 'task-1',
    title: 'Add pagination to the API',
    content: 'Implement pagination on GET /tasks.',
    tags: ['backend'],
    primarySkill: null,
    createdAt: '2026-01-01T00:00:00Z',
    deadline: null,
    status: 'CREATED',
    isOpen: true,
    isFeatured: false,
    asset: { id: 'asset-1', mintAddress: 'mint', symbol: 'USDC', imageUrl: null, amount: 0, price: 0, decimals: 6 },
    user: {
      id: 'user-1',
      externalId: 'ext-1',
      username: 'creator',
      profilePicture: '',
      isPremium: false,
      membership: { tier: 'free', entitlementLevel: 0, isPro: false },
      approvedTaskSubmissions: 0,
      rejectedTaskSubmissions: 0,
      rating: 0,
      publicProfile: null,
    },
    media: [],
    allowOnlyVerifiedSubmissions: false,
    allowOnlyDiscordGuildSubmissions: false,
    requiredDiscordGuildId: null,
    requiredDiscordGuildName: null,
    discordGuildInvitationUrl: null,
    requiredDiscordRoleIds: [],
    taskSubmissionsPendingCount: 0,
    taskSubmissionsRejectedCount: 0,
    taskSubmissionsApprovedCount: 0,
    ...overrides,
  } as TaskDetails;
}

const BASE_USER: UserSummary = {
  id: 'user-1',
  externalId: 'ext-1',
  username: 'alice',
  profilePicture: '',
  isPremium: false,
  membership: { tier: 'free', entitlementLevel: 0, isPro: false },
  approvedTaskSubmissions: 0,
  rejectedTaskSubmissions: 0,
  rating: 0,
};

function baseMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media-1',
    provider: 'gibwork',
    type: 'image',
    mimeType: 'image/png',
    url: 'https://cdn.example.dev/screenshot.png',
    order: 0,
    status: 'ready',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function baseTaskSubmission(overrides: Partial<TaskSubmission> = {}): TaskSubmission {
  return {
    id: 'sub-1',
    taskId: 'task-1',
    content: 'Implemented pagination: https://github.com/example-org/tasks-api/pull/112',
    status: 'OPEN',
    assetId: null,
    transactionId: null,
    rejectReason: null,
    blinks: false,
    isHidden: false,
    referralId: null,
    createdBy: 'user-1',
    createdAt: '2026-01-02T00:00:00Z',
    rating: null,
    user: BASE_USER,
    comments: [],
    media: [],
    asset: null,
    ...overrides,
  };
}

// --- toReviewTask ---

test('toReviewTask maps id/title/content into ReviewTask, description from content', () => {
  const task = toReviewTask(baseTaskDetails());
  assert.deepEqual(task, {
    id: 'task-1',
    title: 'Add pagination to the API',
    description: 'Implement pagination on GET /tasks.',
  });
});

test('toReviewTask deliberately leaves requirements unset so the general-completion fallback runs', () => {
  const task = toReviewTask(baseTaskDetails());
  assert.equal(task.requirements, undefined);
});

test('toReviewTask handles an empty content string', () => {
  const task = toReviewTask(baseTaskDetails({ content: '' }));
  assert.equal(task.description, '');
});

// --- mapMediaType ---

test('mapMediaType classifies an image by mimeType', () => {
  assert.equal(mapMediaType({ type: 'image', mimeType: 'image/png', url: 'https://cdn.example.dev/a.png' }), 'image');
});

test('mapMediaType classifies a PDF/document by mimeType', () => {
  assert.equal(mapMediaType({ type: 'file', mimeType: 'application/pdf', url: 'https://cdn.example.dev/a.pdf' }), 'document');
  assert.equal(
    mapMediaType({
      type: 'file',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      url: 'https://cdn.example.dev/a.docx',
    }),
    'document',
  );
});

test('mapMediaType classifies a GitHub URL as github regardless of mimeType', () => {
  assert.equal(
    mapMediaType({ type: 'link', mimeType: 'text/html', url: 'https://github.com/example-org/tasks-api/pull/112' }),
    'github',
  );
});

test('mapMediaType falls back to other for an unrecognized/malformed type', () => {
  assert.equal(mapMediaType({ type: '', mimeType: '', url: 'https://cdn.example.dev/mystery.bin' }), 'other');
  assert.equal(mapMediaType({ type: 'weird-thing', mimeType: 'application/x-custom', url: '' }), 'other');
});

// --- toReviewSubmission ---

test('toReviewSubmission maps id/content and omits attachments when there is no media', () => {
  const submission = toReviewSubmission(baseTaskSubmission({ media: [] }));
  assert.deepEqual(submission, {
    id: 'sub-1',
    content: 'Implemented pagination: https://github.com/example-org/tasks-api/pull/112',
  });
});

test('toReviewSubmission maps media into attachments with the correct evidence type', () => {
  const submission = toReviewSubmission(
    baseTaskSubmission({
      media: [
        baseMediaItem({ id: 'm1', type: 'image', mimeType: 'image/png', url: 'https://cdn.example.dev/screenshot.png' }),
        baseMediaItem({ id: 'm2', type: 'file', mimeType: 'application/pdf', url: 'https://cdn.example.dev/writeup.pdf' }),
      ],
    }),
  );
  assert.deepEqual(submission.attachments, [
    { type: 'image', value: 'https://cdn.example.dev/screenshot.png' },
    { type: 'document', value: 'https://cdn.example.dev/writeup.pdf' },
  ]);
});

test('toReviewSubmission drops a media entry with a missing/empty url instead of throwing', () => {
  const submission = toReviewSubmission(
    baseTaskSubmission({
      media: [
        baseMediaItem({ url: '' }),
        baseMediaItem({ id: 'm-good', url: 'https://cdn.example.dev/ok.png' }),
      ],
    }),
  );
  assert.deepEqual(submission.attachments, [{ type: 'image', value: 'https://cdn.example.dev/ok.png' }]);
});

test('toReviewSubmission tolerates a null entry inside media (malformed API response)', () => {
  const media = [null, baseMediaItem({ url: 'https://cdn.example.dev/ok.png' })] as unknown as MediaItem[];
  const submission = toReviewSubmission(baseTaskSubmission({ media }));
  assert.deepEqual(submission.attachments, [{ type: 'image', value: 'https://cdn.example.dev/ok.png' }]);
});

test('toReviewSubmission tolerates media not being an array at all (malformed API response)', () => {
  const raw = { ...baseTaskSubmission(), media: null } as unknown as TaskSubmission;
  const submission = toReviewSubmission(raw);
  assert.equal(submission.attachments, undefined);
  assert.equal(submission.id, 'sub-1');
});

test('toReviewSubmission handles a missing content string', () => {
  const raw = { ...baseTaskSubmission(), content: undefined } as unknown as TaskSubmission;
  const submission = toReviewSubmission(raw);
  assert.equal(submission.content, '');
});

test('toReviewSubmission also accepts the WalletTaskSubmissionDetails (detail) shape', () => {
  const detail = {
    id: 'sub-2',
    taskId: 'task-1',
    content: 'See PR: https://github.com/example-org/tasks-api/pull/9',
    status: 'OPEN' as const,
    createdAt: '2026-01-02T00:00:00Z',
    rating: null,
    user: { ...BASE_USER, publicProfile: null },
    comments: [],
    media: [],
  };
  const submission = toReviewSubmission(detail);
  assert.deepEqual(submission, { id: 'sub-2', content: 'See PR: https://github.com/example-org/tasks-api/pull/9' });
});
