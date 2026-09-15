import type { Evidence, Requirement, RequirementAssessment, ReviewSubmission } from './types.js';
import { extractUrls } from './urls.js';

function classifyUrl(url: string): 'github' | 'url' {
  try {
    return /(^|\.)github\.com$/i.test(new URL(url).hostname) ? 'github' : 'url';
  } catch {
    return 'url';
  }
}

/** Only ever reports evidence that is actually present in the submission -- never invented. */
export function collectEvidence(submission: ReviewSubmission): Evidence[] {
  const evidence: Evidence[] = [];
  const urls = new Set([...extractUrls(submission.content ?? ''), ...(submission.links ?? [])]);

  for (const url of urls) {
    evidence.push({ type: classifyUrl(url), value: url, sourceNote: 'submission content/links' });
  }
  for (const attachment of submission.attachments ?? []) {
    evidence.push({ type: attachment.type, value: attachment.value, sourceNote: 'attachment' });
  }
  return evidence;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Narrow, structural check: a "GitHub PR or commit link" cannot be satisfied by a bare
 * github.com root URL -- that references the whole site, not a specific change. This is
 * a syntactic distinction (does the path point at something), not a semantic judgment
 * about whether the linked content is actually correct.
 */
function looksLikeSpecificGithubReference(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    if (/\/(pull|commit|compare|tree|blob)\//i.test(pathname)) return true;
    return pathname.split('/').filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

/** Simple, deliberately non-semantic cue: a negation word near the keyword. */
function isNegated(text: string, keyword: string): boolean {
  const pattern = new RegExp(
    `\\b(not|never|no|didn't|did not|doesn't|does not)\\b[^.]{0,20}${escapeRegExp(keyword)}`,
    'i',
  );
  return pattern.test(text);
}

/**
 * Core "claimed != verified" rule:
 * - a negation near the keyword -> contradicted
 * - a requirement with no defined evidence type can never be marked verified --
 *   deterministically we have no way to confirm it, only to see it mentioned (claimed).
 * - evidence alone, with no matching textual claim, is NOT enough to verify --
 *   evidence must correspond to an actual mention of the requirement it is meant to
 *   satisfy, otherwise we would be inferring completion of X merely because some
 *   unrelated evidence of the right type exists in the submission somewhere.
 * - matching evidence of the expected type, specific enough to be meaningful (e.g. a
 *   GitHub link that actually points at a PR/commit, not just the homepage), plus a
 *   claim -> verified
 * - evidence of the expected type/domain but not specific enough, or evidence of a
 *   different type, plus a claim -> partially_verified
 * - a claim with no evidence at all -> claimed
 * - nothing found -> not_found
 */
export function assessRequirement(
  requirement: Requirement,
  submissionText: string,
  evidence: Evidence[],
): RequirementAssessment {
  const text = (submissionText ?? '').toLowerCase();
  const keywords = (requirement.keywords ?? []).map((keyword) => keyword.toLowerCase());
  const claimed = keywords.some((keyword) => text.includes(keyword));
  const negated = keywords.some((keyword) => isNegated(text, keyword));

  if (negated) {
    return {
      requirementId: requirement.id,
      status: 'contradicted',
      evidence: [],
      reason: 'Submission text appears to explicitly deny this requirement.',
    };
  }

  if (!requirement.evidenceType) {
    // Free-form: no keywords were authored to match against (e.g. the general-completion
    // fallback for a bounty with no structured criteria list), so a substring check can
    // never confirm or deny this requirement -- it would otherwise always fall through to
    // "not found", which is frequently false. Treat any non-empty response as an
    // unverified claim instead; semantic fulfillment is the reasoning layer's job.
    if (keywords.length === 0) {
      if (text.trim().length > 0) {
        return {
          requirementId: requirement.id,
          status: 'claimed',
          evidence: [],
          reason:
            'Non-empty response provided to a free-form instruction; not deterministically verifiable beyond this -- see --reasoning for a semantic opinion.',
        };
      }
      return {
        requirementId: requirement.id,
        status: 'not_found',
        evidence: [],
        reason: 'No mention of this requirement was found in the submission.',
      };
    }

    if (claimed) {
      return {
        requirementId: requirement.id,
        status: 'claimed',
        evidence: [],
        reason: 'Submission claims this requirement was addressed. This requirement has no defined evidence type, so it cannot be deterministically verified further.',
      };
    }
    return {
      requirementId: requirement.id,
      status: 'not_found',
      evidence: [],
      reason: 'No mention of this requirement was found in the submission.',
    };
  }

  if (!claimed) {
    // Evidence of the right type may exist elsewhere in the submission for an
    // unrelated requirement -- without a claim tying it to *this* requirement, that
    // is not evidence of this requirement, so this must not be marked verified.
    return {
      requirementId: requirement.id,
      status: 'not_found',
      evidence: [],
      reason: 'No claim or evidence found for this requirement.',
    };
  }

  const matchingTypeEvidence = evidence.filter((item) => item.type === requirement.evidenceType);
  const specificEvidence =
    requirement.evidenceType === 'github'
      ? matchingTypeEvidence.filter((item) => looksLikeSpecificGithubReference(item.value))
      : matchingTypeEvidence;

  if (specificEvidence.length > 0) {
    return {
      requirementId: requirement.id,
      status: 'verified',
      evidence: specificEvidence,
      reason: 'Matching evidence of the expected type was found and corresponds to a claim in the submission.',
    };
  }

  if (matchingTypeEvidence.length > 0) {
    return {
      requirementId: requirement.id,
      status: 'partially_verified',
      evidence: matchingTypeEvidence,
      reason: 'Evidence of the expected type is present, but it does not look specific enough (e.g. a bare homepage link rather than a PR/commit) to confirm this exact requirement.',
    };
  }

  if (evidence.length > 0) {
    return {
      requirementId: requirement.id,
      status: 'partially_verified',
      evidence,
      reason: 'Submission provides some evidence and claims this requirement, but not evidence of the specific type expected.',
    };
  }

  return {
    requirementId: requirement.id,
    status: 'claimed',
    evidence: [],
    reason: 'Submission claims this requirement was addressed, but no supporting evidence was found.',
  };
}
