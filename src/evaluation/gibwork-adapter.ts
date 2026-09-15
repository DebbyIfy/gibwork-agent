import type { MediaItem, TaskDetails, TaskSubmission, WalletTaskSubmissionDetails } from '@gibwork/sdk';
import type { EvidenceType, ReviewSubmission, ReviewTask } from './types.js';

/**
 * Pure, source-specific mappers from live Gibwork SDK shapes into this project's own
 * source-agnostic domain types (ReviewTask/ReviewSubmission). Nothing here calls the
 * network or the SDK -- these functions only reshape already-fetched data, so the
 * evaluator/scoring/classification/routing layers never need to know Gibwork exists.
 */

function classifyMediaUrl(url: string): EvidenceType | undefined {
  try {
    return /(^|\.)github\.com$/i.test(new URL(url).hostname) ? 'github' : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort classification of a Gibwork media attachment. Unknown/malformed shapes fall back to 'other'. */
export function mapMediaType(item: Pick<MediaItem, 'type' | 'mimeType' | 'url'>): EvidenceType {
  const byUrl = classifyMediaUrl(item.url ?? '');
  if (byUrl) return byUrl;

  const mimeType = (item.mimeType ?? '').toLowerCase();
  const type = (item.type ?? '').toLowerCase();

  if (mimeType.startsWith('image/') || type.includes('image')) return 'image';
  if (
    mimeType === 'application/pdf' ||
    mimeType.includes('officedocument') ||
    mimeType.startsWith('application/msword') ||
    type.includes('document') ||
    type.includes('pdf')
  ) {
    return 'document';
  }
  if (mimeType.startsWith('text/')) return 'text';
  return 'other';
}

function toAttachment(item: MediaItem | null | undefined): { type: EvidenceType; value: string } | undefined {
  if (!item || typeof item.url !== 'string' || item.url.length === 0) return undefined;
  return { type: mapMediaType(item), value: item.url };
}

/**
 * Maps a live Gibwork submission (list or detail shape) into this project's
 * ReviewSubmission. `links` is deliberately left unset -- collectEvidence() already
 * regex-extracts URLs (including GitHub PR links) directly out of `content`, exactly
 * as it does for fixture submissions, so nothing is lost by not populating it.
 * Malformed/missing media (not an array, null entries, no url) is dropped rather than
 * thrown on -- a live API quirk in one attachment must never fail the whole mapping.
 */
export function toReviewSubmission(raw: TaskSubmission | WalletTaskSubmissionDetails): ReviewSubmission {
  const media = Array.isArray(raw.media) ? raw.media : [];
  const attachments = media.map(toAttachment).filter((item): item is { type: EvidenceType; value: string } => Boolean(item));

  return {
    id: raw.id,
    content: raw.content ?? '',
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * Maps a live Gibwork TaskDetails (from tasks.get()) into this project's ReviewTask.
 * `requirements` is deliberately left unset: TaskDetails has no structured Requirement[]
 * field, only free-form HTML content, and this MVP does not attempt to parse free text
 * into structured requirements. Leaving it unset lets the existing
 * StructuredRequirementExtractor fallback (a single general-completion requirement) run
 * exactly as it already does for any task with no structured requirements -- no new
 * logic needed here or in requirements.ts.
 */
export function toReviewTask(raw: TaskDetails): ReviewTask {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.content ?? '',
  };
}
