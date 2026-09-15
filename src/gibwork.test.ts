import test from 'node:test';
import assert from 'node:assert/strict';
import { GibworkApiError, GibworkValidationError } from '@gibwork/sdk';
import type { AvailableTask, AvailableTasksQuery, GibworkClient, Paginated, TaskDetails } from '@gibwork/sdk';
import { listAvailableTasks, getTask } from './gibwork.js';

/**
 * All tests here use a fake GibworkClient (only the `tasks.listAvailable`/`tasks.get`
 * shape each function actually touches) -- no real network call, no wallet, no keypair.
 */

function baseAvailableTask(overrides: Partial<AvailableTask> = {}): AvailableTask {
  return {
    id: 'task-1',
    slug: 'task-1',
    title: 'A bounty',
    content: 'Do the thing.',
    requirements: null,
    tags: [],
    primarySkillId: null,
    createdAt: '2026-01-01T00:00:00Z',
    deadline: null,
    status: 'CREATED',
    isOpen: true,
    asset: null,
    minSubmissionAmount: null,
    totalSubmissions: 0,
    maxSubmissions: null,
    standardSubmissionSlotsRemaining: null,
    requiresPremium: false,
    participationRequirements: {
      allowOnlyVerifiedSubmissions: false,
      allowOnlyVerifiedTwitterAccountSubmissions: false,
      minTwitterFollowers: 0,
      minTweetLikes: 0,
      minTweetViews: 0,
      isTwitterTask: false,
      allowOnlyDiscordGuildSubmissions: false,
      requiredDiscordGuildId: null,
      requiredDiscordGuildName: null,
      discordGuildInvitationUrl: null,
      requiredDiscordRoleIds: [],
    },
    ...overrides,
  };
}

function paginated(results: AvailableTask[], page: number, lastPage: number): Paginated<AvailableTask> {
  return { results, page, limit: results.length, total: results.length * lastPage, lastPage };
}

function fakeClient(pages: AvailableTask[][]): { client: GibworkClient; calls: AvailableTasksQuery[] } {
  const calls: AvailableTasksQuery[] = [];
  const client = {
    tasks: {
      listAvailable: async (query: AvailableTasksQuery = {}) => {
        calls.push(query);
        const pageNumber = query.page ?? 1;
        const results = pages[pageNumber - 1] ?? [];
        return paginated(results, pageNumber, pages.length);
      },
    },
  } as unknown as GibworkClient;
  return { client, calls };
}

function baseTaskDetails(overrides: Partial<TaskDetails> = {}): TaskDetails {
  return {
    id: 'task-1',
    slug: 'task-1',
    title: 'A bounty',
    content: 'Do the thing.',
    tags: [],
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

function fakeGetClient(handler: (taskId: string) => Promise<TaskDetails>): { client: GibworkClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    tasks: {
      get: async (taskId: string) => {
        calls.push(taskId);
        return handler(taskId);
      },
    },
  } as unknown as GibworkClient;
  return { client, calls };
}

test('listAvailableTasks delegates directly to client.tasks.listAvailable', async () => {
  const { client } = fakeClient([[baseAvailableTask({ id: 't1' })]]);
  const page = await listAvailableTasks(client, { limit: 10 });
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0]?.id, 't1');
});

test('getTask delegates directly to client.tasks.get and returns the task', async () => {
  const { client, calls } = fakeGetClient(async (taskId) => baseTaskDetails({ id: taskId }));
  const found = await getTask(client, 'target');
  assert.equal(found?.id, 'target');
  assert.deepEqual(calls, ['target']);
});

test('getTask returns undefined (not a crash) on a 404 GibworkApiError', async () => {
  const { client } = fakeGetClient(async () => {
    throw new GibworkApiError(404, { message: 'not found' }, 'GET', '/v2/int/tasks/missing');
  });
  const found = await getTask(client, 'missing');
  assert.equal(found, undefined);
});

test('getTask returns undefined (not a crash) on a malformed/non-UUID id', async () => {
  const { client } = fakeGetClient(async () => {
    throw new GibworkValidationError('taskId must be a UUID');
  });
  const found = await getTask(client, 'not-a-uuid');
  assert.equal(found, undefined);
});

test('getTask rethrows other API errors (e.g. 500) instead of silently swallowing them', async () => {
  const { client } = fakeGetClient(async () => {
    throw new GibworkApiError(500, { message: 'server error' }, 'GET', '/v2/int/tasks/target');
  });
  await assert.rejects(() => getTask(client, 'target'), GibworkApiError);
});
