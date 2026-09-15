import type { ReviewSubmission, SubmissionFlag } from './types.js';
import { extractUrls, isWellFormedUrl } from './urls.js';

/**
 * Deterministic, conservative checks only -- flags observations, never accusations.
 * Explicitly does not attempt semantic duplicate detection or subjective quality judgment.
 */
export function runPreChecks(submission: ReviewSubmission, allSubmissions: ReviewSubmission[]): SubmissionFlag[] {
  const flags: SubmissionFlag[] = [];
  const content = submission.content?.trim() ?? '';

  if (content.length === 0) {
    flags.push({ code: 'empty-submission', severity: 'warning', message: 'Submission content is empty.' });
    return flags;
  }

  if (content.length < 20) {
    flags.push({
      code: 'low-effort-content',
      severity: 'warning',
      message: 'Submission content is very short and may not describe meaningful work.',
    });
  }

  const contentUrls = extractUrls(content);
  const allUrls = [...new Set([...contentUrls, ...(submission.links ?? [])])];

  for (const url of allUrls) {
    if (!isWellFormedUrl(url)) {
      flags.push({ code: 'malformed-url', severity: 'warning', message: `URL does not look well-formed: "${url}"` });
    }
  }

  const urlCounts = new Map<string, number>();
  for (const url of allUrls) urlCounts.set(url, (urlCounts.get(url) ?? 0) + 1);
  for (const [url, count] of urlCounts) {
    if (count > 1) {
      flags.push({
        code: 'duplicate-url-in-submission',
        severity: 'info',
        message: `URL appears more than once in this submission: "${url}"`,
      });
    }
  }

  for (const other of allSubmissions) {
    if (other.id === submission.id) continue;

    const otherContent = other.content?.trim() ?? '';
    if (otherContent.length > 0 && otherContent === content) {
      flags.push({
        code: 'duplicate-submission-content',
        severity: 'warning',
        message: `Content is identical to submission "${other.id}". Potential duplicate.`,
      });
    }

    const otherUrls = new Set([...extractUrls(other.content ?? ''), ...(other.links ?? [])]);
    for (const url of allUrls) {
      if (otherUrls.has(url)) {
        flags.push({
          code: 'duplicate-url-across-submissions',
          severity: 'warning',
          message: `URL also appears in submission "${other.id}": "${url}". Potential duplicate.`,
        });
      }
    }
  }

  return flags;
}
