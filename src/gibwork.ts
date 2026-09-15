import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createGibworkClient } from '@gibwork/sdk/node';
import {
  GibworkApiError,
  GibworkValidationError,
  type AvailableTask,
  type AvailableTasksQuery,
  type GibworkClient,
  type Paginated,
  type SubmissionPaginationQuery,
  type TaskDetails,
  type TaskSubmission,
  type WalletTaskSubmissionDetails,
} from '@gibwork/sdk';

/**
 * Resolves the keypair path from the already-configured Gibwork CLI (`gibwork config get
 * keypair-path`) instead of introducing a second, parallel wallet configuration. Only the
 * file *path* is read here -- never its contents -- so nothing secret is ever logged.
 */
function resolveKeypairPath(profile?: string): string {
  const args = profile
    ? ['--profile', profile, 'config', 'get', 'keypair-path']
    : ['config', 'get', 'keypair-path'];

  let output: string;
  try {
    output = execFileSync('gibwork', args, { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(
      'Could not read the configured Gibwork keypair path. Run `gibwork wallet doctor` to check your CLI setup.',
      { cause: error },
    );
  }
  if (!output) {
    throw new Error('No keypair path is configured for the Gibwork CLI. Run `gibwork config set keypair-path <path>` first.');
  }
  return output;
}

/** Reads the key file into memory only to hand it to the SDK signer; never printed or logged. */
function loadPrivateKey(keypairPath: string): string {
  try {
    return readFileSync(keypairPath, 'utf8').trim();
  } catch (error) {
    throw new Error(`Could not read the Gibwork keypair file at "${keypairPath}".`, { cause: error });
  }
}

export interface GibworkContext {
  client: GibworkClient;
}

/** Builds a stage-environment client from the existing Gibwork CLI wallet configuration. */
export function buildGibworkClient(profile?: string): GibworkContext {
  const keypairPath = resolveKeypairPath(profile);
  const privateKey = loadPrivateKey(keypairPath);
  const client = createGibworkClient({ privateKey, production: false });
  return { client };
}

/**
 * Read-only submission review. This module intentionally has no approve, reject,
 * prepareApproval, submitApproval, create, or refund path -- only the two Gibwork
 * calls below exist, and neither mutates anything or moves funds.
 */
export async function listSubmissions(
  client: GibworkClient,
  taskId: string,
  query: SubmissionPaginationQuery = {},
): Promise<Paginated<TaskSubmission>> {
  return client.submissions.list(taskId, query);
}

export async function getSubmissionDetail(
  client: GibworkClient,
  taskId: string,
  submissionId: string,
): Promise<WalletTaskSubmissionDetails> {
  return client.submissions.get(taskId, submissionId);
}

/** Read-only: lists publicly available bounties via tasks.listAvailable(). No write path exists here. */
export async function listAvailableTasks(
  client: GibworkClient,
  query: AvailableTasksQuery = {},
): Promise<Paginated<AvailableTask>> {
  return client.tasks.listAvailable(query);
}

/**
 * Resolves a single task directly by id via tasks.get() -- read-only, no write/financial
 * endpoint is involved. Returns undefined for a missing or malformed id (mistyped, wrong
 * environment, or never existed) so callers can treat that as a normal, expected outcome,
 * not a crash.
 */
export async function getTask(client: GibworkClient, taskId: string): Promise<TaskDetails | undefined> {
  try {
    return await client.tasks.get(taskId);
  } catch (error) {
    if (error instanceof GibworkApiError && error.status === 404) return undefined;
    if (error instanceof GibworkValidationError) return undefined;
    throw error;
  }
}
