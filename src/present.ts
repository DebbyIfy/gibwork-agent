import type { AvailableTask, Paginated, TaskSubmission, WalletTaskSubmissionDetails } from '@gibwork/sdk';

const LIST_PREVIEW_LIMIT = 200;
const DETAIL_CONTENT_LIMIT = 2000;
const COMMENT_PREVIEW_LIMIT = 300;

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}... (${trimmed.length - limit} more characters)`;
}

/** Read-only view of a page of submissions. Renders only -- never approves/rejects. */
export function renderSubmissionList(taskId: string, page: Paginated<TaskSubmission>): string {
  const lines: string[] = [];
  lines.push('=== GIBWORK SUBMISSION REVIEW -- read-only, nothing approved/rejected/paid ===');
  lines.push('');
  lines.push(`Task: ${taskId}`);
  lines.push(`Page: ${page.page}/${page.lastPage} (${page.total} total submission${page.total === 1 ? '' : 's'})`);
  lines.push('');

  if (page.results.length === 0) {
    lines.push('No submissions match this query.');
    return lines.join('\n');
  }

  for (const submission of page.results) {
    lines.push(`- ${submission.id}`);
    lines.push(`    status:    ${submission.status}`);
    lines.push(`    user:      ${submission.user.username}`);
    lines.push(`    rating:    ${submission.rating ?? '(not rated)'}`);
    lines.push(`    createdAt: ${submission.createdAt}`);
    lines.push(`    content:   ${truncate(submission.content, LIST_PREVIEW_LIMIT)}`);
    lines.push('');
  }

  lines.push(`View one in full: gibwork-agent review ${taskId} --submission <id>`);
  return lines.join('\n');
}

/**
 * Read-only view of publicly available bounties (tasks.listAvailable()). Renders only
 * -- never approves/rejects/creates/refunds. `totalSubmissions` here is the task
 * metadata's own count, which may not match what submissions.list() actually returns
 * (see review's live output for the authoritative count) -- labeled as such.
 */
export function renderAvailableTasksList(page: Paginated<AvailableTask>): string {
  const lines: string[] = [];
  lines.push('=== GIBWORK AVAILABLE BOUNTIES -- read-only, nothing approved/rejected/paid/created ===');
  lines.push('');
  lines.push(`Page: ${page.page}/${page.lastPage} (${page.total} total available bount${page.total === 1 ? 'y' : 'ies'})`);
  lines.push('');

  if (page.results.length === 0) {
    lines.push('No available bounties match this query.');
    return lines.join('\n');
  }

  for (const task of page.results) {
    lines.push(`- ${task.title}`);
    lines.push(`    id:                  ${task.id}`);
    lines.push(`    status:              ${task.status}${task.isOpen ? '' : ' (closed)'}`);
    lines.push(`    submissions (task metadata, not authoritative -- \`review\` confirms the real count): ${task.totalSubmissions}`);
    lines.push(`    deadline:            ${task.deadline ?? '(none)'}`);
    lines.push(`    createdAt:           ${task.createdAt}`);
    lines.push('');
  }

  lines.push('Review one: gibwork-agent review <task-id>');
  return lines.join('\n');
}

/** Read-only view of a single submission's full detail. Renders only -- never mutates. */
export function renderSubmissionDetail(taskId: string, submission: WalletTaskSubmissionDetails): string {
  const lines: string[] = [];
  lines.push('=== GIBWORK SUBMISSION DETAIL -- read-only, nothing approved/rejected/paid ===');
  lines.push('');
  lines.push(`Task:       ${taskId}`);
  lines.push(`Submission: ${submission.id}`);
  lines.push(`Status:     ${submission.status}`);
  lines.push(`User:       ${submission.user.username}`);
  lines.push(`Rating:     ${submission.rating ?? '(not rated)'}`);
  lines.push(`Created:    ${submission.createdAt}`);
  if (submission.rejectReason) lines.push(`Reject reason: ${submission.rejectReason}`);
  lines.push('');

  lines.push('Content:');
  for (const line of truncate(submission.content, DETAIL_CONTENT_LIMIT).split('\n')) {
    lines.push(`  ${line}`);
  }
  lines.push('');

  if (submission.media.length > 0) {
    lines.push(`Media (${submission.media.length}):`);
    for (const item of submission.media) {
      lines.push(`  - ${item.type}: ${item.url}`);
    }
    lines.push('');
  }

  if (submission.comments.length > 0) {
    lines.push(`Comments (${submission.comments.length}):`);
    for (const comment of submission.comments) {
      lines.push(`  [${comment.createdAt}] ${comment.user.username}: ${truncate(comment.content, COMMENT_PREVIEW_LIMIT)}`);
    }
  } else {
    lines.push('Comments: (none)');
  }

  return lines.join('\n');
}
