import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ReviewSubmission, ReviewTask } from './evaluation/types.js';

export interface FixtureBundle {
  task: ReviewTask;
  submissions: ReviewSubmission[];
}

/**
 * Loads a fixture task and reads its matching submissions file from alongside it, e.g.
 * ".../task.json" -> ".../submissions.json" and ".../challenging-task.json" ->
 * ".../challenging-submissions.json". Purely local file reads.
 */
export function loadFixture(taskJsonPath: string): FixtureBundle {
  const taskPath = resolve(taskJsonPath);
  const taskFileName = basename(taskPath);
  if (!taskFileName.endsWith('task.json')) {
    throw new Error(`--fixture must point at a file named "*task.json" (got "${taskFileName}").`);
  }
  const submissionsFileName = taskFileName.replace(/task\.json$/, 'submissions.json');
  const submissionsPath = join(dirname(taskPath), submissionsFileName);

  let task: ReviewTask;
  try {
    task = JSON.parse(readFileSync(taskPath, 'utf8')) as ReviewTask;
  } catch (error) {
    throw new Error(`Could not read fixture task file at "${taskPath}".`, { cause: error });
  }

  let submissions: ReviewSubmission[];
  try {
    submissions = JSON.parse(readFileSync(submissionsPath, 'utf8')) as ReviewSubmission[];
  } catch (error) {
    throw new Error(
      `Could not read fixture submissions file at "${submissionsPath}" (expected alongside the task file).`,
      { cause: error },
    );
  }

  return { task, submissions };
}
