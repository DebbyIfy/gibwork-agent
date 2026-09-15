import type { Requirement, RequirementAssessment, ReviewResult, ReviewTask, SubmissionClassification, SubmissionFlag } from './types.js';
import type { SubmissionReasoning } from './reasoning.js';
import { isRequirementFullySatisfied } from './classification.js';
import { buildReviewSummary, type SubmissionSummaryEntry } from './review-summary.js';

export interface RenderReviewReportOptions {
  /** Set for a live Gibwork review -- drops the (otherwise true) "fixture mode" footer note. */
  live?: boolean;
  /** Shown directly under the requirements line -- e.g. when a live task has no structured
   *  per-requirement criteria and is being scored against a single general fallback requirement. */
  generalRequirementsNotice?: string;
}

const DIVIDER = '─'.repeat(40);

/** The only four allowed calls-to-action -- one per classification. Never "approve"/"reject":
 *  the agent prioritizes and evidences, the bounty owner always makes the final call. */
const ACTION_LINE: Record<SubmissionClassification, string> = {
  strong: 'No immediate concerns',
  review: 'Human review recommended',
  incomplete: 'Required evidence is missing',
  suspicious: 'Requires manual verification',
};

/** Exported for reuse by the interactive layer's submission-selection labels --
 *  never redefined elsewhere. */
export function classificationLabel(classification: SubmissionClassification): string {
  return classification.charAt(0).toUpperCase() + classification.slice(1);
}

function buildRequirementIndex(requirements: Requirement[]): Map<string, number> {
  return new Map(requirements.map((requirement, index) => [requirement.id, index + 1]));
}

/** Same "fully satisfied" ceiling the classifier itself uses -- never redefined here. */
function isConcerning(requirement: Requirement | undefined, assessment: RequirementAssessment): boolean {
  if (!requirement) return assessment.status !== 'verified';
  return !isRequirementFullySatisfied(requirement, assessment);
}

/** Short, decision-oriented, conservative phrasing -- never "this is fraud/plagiarism". */
function describeConcern(requirement: Requirement | undefined, assessment: RequirementAssessment, index: number): string {
  switch (assessment.status) {
    case 'not_found':
      return `Requirement ${index} not sufficiently evidenced`;
    case 'partially_verified':
      return `Evidence only partially supports requirement ${index}`;
    case 'contradicted':
      return `Requirement ${index} appears contradicted by the submission`;
    case 'claimed':
      return requirement?.evidenceType
        ? `Requirement ${index} claimed but not evidenced`
        : `Requirement ${index} claimed`;
    default:
      return `Requirement ${index} needs review`;
  }
}

/** Deliberately conservative: "potential duplicate", never an accusation of fraud/plagiarism. */
function describeFlag(flag: SubmissionFlag): string {
  switch (flag.code) {
    case 'duplicate-submission-content':
      return 'Potential duplicate: content identical to another submission';
    case 'duplicate-url-across-submissions':
      return 'Potential duplicate: evidence URL also appears in another submission';
    case 'duplicate-url-in-submission':
      return 'Evidence URL repeated within this submission';
    case 'malformed-url':
      return 'Evidence not provided: a submitted URL does not look well-formed';
    case 'low-effort-content':
      return 'Submission content is very short';
    case 'empty-submission':
      return 'Submission content is empty';
    default:
      return flag.message;
  }
}

const HEADER_LABEL_WIDTH = 5;

function renderHeaderLine(entry: SubmissionSummaryEntry): string {
  const label = `#${entry.displayNumber}`.padEnd(HEADER_LABEL_WIDTH);
  const classification = classificationLabel(entry.assessment.classification).padEnd(13);
  return `${label}${classification}${entry.assessment.score.total}/100`;
}

/** Indents every line after the header so ⚠/✓/→ bullets line up under the
 *  classification column instead of under the "#N" label. */
function withBodyIndent(lines: string[]): string[] {
  const bodyIndent = ' '.repeat(HEADER_LABEL_WIDTH);
  return lines.map((line, index) => (index === 0 ? line : `${bodyIndent}${line}`));
}

/** Ultra-compact single-highlight form used only in the executive summary's Priority
 *  Review section, to keep the summary itself glanceable at a large submission count. */
function renderPriorityLine(entry: SubmissionSummaryEntry, requirements: Requirement[], requirementIndex: Map<string, number>): string[] {
  const lines = [renderHeaderLine(entry)];
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const { assessment } = entry;

  const flag = assessment.flags.find((item) => item.severity === 'warning');
  if (flag) {
    lines.push(`⚠ ${describeFlag(flag)}`);
  } else {
    const concern = assessment.requirementAssessments.find((item) => isConcerning(byId.get(item.requirementId), item));
    if (concern) {
      const index = requirementIndex.get(concern.requirementId) ?? 0;
      lines.push(`⚠ ${describeConcern(byId.get(concern.requirementId), concern, index)}`);
    }
  }
  lines.push(`→ ${ACTION_LINE[assessment.classification]}`);
  return withBodyIndent(lines);
}

const COMPACT_CONCERN_CAP = 2;

/** The standard per-submission unit used in the Top Submissions / Needs Attention
 *  sections: header + up to a couple of concerns (or two canned lines for Strong) + one
 *  grouped "supported" line + the call-to-action. Never dumps every requirement/evidence
 *  detail -- that level of depth is what --inspect is for. */
function renderCompactBlock(entry: SubmissionSummaryEntry, requirements: Requirement[], requirementIndex: Map<string, number>): string[] {
  const { assessment } = entry;
  const lines = [renderHeaderLine(entry)];

  if (assessment.classification === 'strong') {
    lines.push('✓ Required criteria supported');
    lines.push('✓ Evidence provided');
    lines.push(`→ ${ACTION_LINE.strong}`);
    return withBodyIndent(lines);
  }

  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const concerning = assessment.requirementAssessments.filter((item) => isConcerning(byId.get(item.requirementId), item));
  const supported = assessment.requirementAssessments.filter((item) => !concerning.includes(item));

  const flagLines = assessment.flags
    .filter((flag) => flag.severity === 'warning')
    .slice(0, COMPACT_CONCERN_CAP)
    .map((flag) => `⚠ ${describeFlag(flag)}`);
  lines.push(...flagLines);

  const remainingCap = Math.max(0, COMPACT_CONCERN_CAP - flagLines.length);
  const shownConcerns = concerning.slice(0, remainingCap);
  for (const item of shownConcerns) {
    const index = requirementIndex.get(item.requirementId) ?? 0;
    lines.push(`⚠ ${describeConcern(byId.get(item.requirementId), item, index)}`);
  }

  const hiddenConcerns = concerning.length - shownConcerns.length;
  if (hiddenConcerns > 0) {
    lines.push(`⚠ +${hiddenConcerns} more requirement concern(s) -- see --inspect ${entry.displayNumber}`);
  }

  if (supported.length > 0 && flagLines.length === 0) {
    const indices = supported
      .map((item) => requirementIndex.get(item.requirementId))
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    if (indices.length > 0) {
      lines.push(`✓ Requirement${indices.length > 1 ? 's' : ''} ${indices.join(', ')} supported`);
    }
  }

  lines.push(`→ ${ACTION_LINE[assessment.classification]}`);
  return withBodyIndent(lines);
}

function pushIndented(lines: string[], block: string[], indent = '  '): void {
  for (const line of block) lines.push(`${indent}${line}`);
}

/**
 * Kept separate from the evaluator on purpose: the evaluator returns structured data
 * only, so this (and any future --format json/markdown renderer) can reuse it without
 * touching evaluation logic. Summary-first, compact by default: this never dumps every
 * requirement/evidence detail for every submission -- use --inspect for that.
 */
export function renderReviewReport(result: ReviewResult, options: RenderReviewReportOptions = {}): string {
  const lines: string[] = [];
  const summary = buildReviewSummary(result);
  const requirementIndex = buildRequirementIndex(result.requirements);

  lines.push('GIBWORK SUBMISSION REVIEW');
  lines.push(DIVIDER);
  lines.push('');
  lines.push('Bounty');
  lines.push(`  ${result.task.title}`);
  lines.push(`  Task ID: ${result.task.id}`);
  lines.push('');

  lines.push('Requirements');
  if (summary.assessedSubmissionCount === 0) {
    lines.push(`  ${summary.requirementStatus.total} total (no submissions received yet -- status not yet assessed)`);
  } else {
    lines.push(
      `  ${summary.requirementStatus.total} total · ${summary.requirementStatus.satisfied} satisfied · ` +
        `${summary.requirementStatus.partial} partial · ${summary.requirementStatus.missing} missing`,
    );
  }
  if (options.generalRequirementsNotice) {
    lines.push(`  NOTE: ${options.generalRequirementsNotice}`);
  }
  lines.push('');

  lines.push('Submissions');
  lines.push(`  ${summary.assessedSubmissionCount} total`);
  lines.push('');
  lines.push(`  ${'STRONG'.padEnd(13)}${summary.classificationCounts.strong}`);
  lines.push(`  ${'REVIEW'.padEnd(13)}${summary.classificationCounts.review}`);
  lines.push(`  ${'INCOMPLETE'.padEnd(13)}${summary.classificationCounts.incomplete}`);
  lines.push(`  ${'SUSPICIOUS'.padEnd(13)}${summary.classificationCounts.suspicious}`);
  lines.push('');

  lines.push('Priority Review');
  if (summary.assessedSubmissionCount === 0) {
    lines.push('  No submissions have been received for this bounty yet.');
  } else if (summary.priorityReview.length === 0) {
    lines.push('  No submissions currently need priority review.');
  } else {
    for (const entry of summary.priorityReview) {
      lines.push('');
      pushIndented(lines, renderPriorityLine(entry, result.requirements, requirementIndex));
    }
    if (summary.priorityReviewOverflow > 0) {
      lines.push('');
      lines.push(`  ...and ${summary.priorityReviewOverflow} more in Suspicious/Review/Incomplete -- see "Needs Attention" below.`);
    }
  }
  lines.push('');
  lines.push(DIVIDER);

  if (summary.topSubmissions.length > 0) {
    lines.push('');
    lines.push('TOP SUBMISSIONS');
    for (const entry of summary.topSubmissions) {
      lines.push('');
      pushIndented(lines, renderCompactBlock(entry, result.requirements, requirementIndex));
    }
    if (summary.topSubmissionsOverflow > 0) {
      lines.push('');
      lines.push(`  ...and ${summary.topSubmissionsOverflow} more Strong submission(s).`);
    }
    lines.push('');
    lines.push(DIVIDER);
  }

  if (summary.needsAttention.length > 0) {
    lines.push('');
    lines.push('NEEDS ATTENTION');
    for (const entry of summary.needsAttention) {
      lines.push('');
      pushIndented(lines, renderCompactBlock(entry, result.requirements, requirementIndex));
    }
    lines.push('');
    lines.push(DIVIDER);
  }

  lines.push('');
  lines.push('No submissions were approved or rejected.');
  lines.push('Human review required.');
  lines.push(
    `(deterministic, evidence-based evaluation${options.live ? '' : ' -- fixture mode, no live Gibwork calls'}; ` +
      'this tool never approves, rejects, refunds, or pays anything)',
  );
  lines.push('');
  lines.push(`Run with --inspect <#N or submission id> for the full evidence-backed breakdown of one submission.`);

  return lines.join('\n');
}

/**
 * The detailed view behind --inspect: every requirement, its status, its evidence
 * (type/source), the deterministic reason behind that status, and any suspicious/quality
 * flags -- all of it already-computed, decision-oriented data, never internal
 * chain-of-thought (there is none to expose; every string here already exists on
 * SubmissionAssessment/RequirementAssessment).
 */
export function renderSubmissionInspection(entry: SubmissionSummaryEntry, task: ReviewTask, requirements: Requirement[]): string {
  const lines: string[] = [];
  const { assessment } = entry;
  const requirementIndex = buildRequirementIndex(requirements);

  lines.push(DIVIDER);
  lines.push(`SUBMISSION #${entry.displayNumber} -- INSPECTION`);
  lines.push(DIVIDER);
  lines.push('');
  lines.push(`Task:           ${task.title} (${task.id})`);
  lines.push(`Submission:     ${entry.submissionId}`);
  lines.push(`Classification: ${classificationLabel(assessment.classification)}`);
  lines.push(`Confidence:     ${assessment.confidence.toUpperCase()}`);
  lines.push(
    `Score:          ${assessment.score.total}/100  ` +
      `(requirements ${assessment.score.requirementCoverage}/40, ` +
      `evidence ${assessment.score.evidenceQuality}/25, ` +
      `completeness ${assessment.score.completeness}/15, ` +
      `relevance ${assessment.score.relevance}/10, ` +
      `quality ${assessment.score.qualitySignals}/10)`,
  );
  lines.push('');
  lines.push(`Recommended next step: ${ACTION_LINE[assessment.classification]}`);
  lines.push('(This is a prioritization signal, not a decision. Only a human may approve, reject, or refund.)');
  lines.push('');

  lines.push('Requirements:');
  for (const requirement of requirements) {
    const index = requirementIndex.get(requirement.id);
    const requirementAssessment = assessment.requirementAssessments.find((item) => item.requirementId === requirement.id);
    lines.push('');
    lines.push(`  [${index}] ${requirement.description}${requirement.required ? '' : ' (optional)'}`);
    if (!requirementAssessment) {
      lines.push('      status: not assessed');
      continue;
    }
    lines.push(`      status: ${requirementAssessment.status}`);
    if (requirement.evidenceType) lines.push(`      expected evidence type: ${requirement.evidenceType}`);
    if (requirementAssessment.evidence.length > 0) {
      lines.push('      evidence:');
      for (const evidence of requirementAssessment.evidence) {
        lines.push(`        - [${evidence.type}] ${evidence.value}${evidence.sourceNote ? ` (${evidence.sourceNote})` : ''}`);
      }
    } else {
      lines.push('      evidence: none found');
    }
    lines.push(`      reason: ${requirementAssessment.reason}`);
  }
  lines.push('');

  if (assessment.flags.length > 0) {
    lines.push('Signals (quality / suspicious / duplicate):');
    for (const flag of assessment.flags) {
      lines.push(`  - [${flag.severity}] ${flag.message}`);
    }
    lines.push('');
  }

  if (assessment.reasons.length > 0) {
    lines.push('Reasons:');
    for (const reason of assessment.reasons) {
      lines.push(`  - ${reason}`);
    }
    lines.push('');
  }

  lines.push(DIVIDER);
  lines.push('Evidence and prioritization only -- no approve/reject/refund/pay action was taken.');

  return lines.join('\n');
}

/**
 * Purely additive: renders what the deterministic routing layer decided and, where a
 * (mock) provider was actually consulted, its advisory output. This never changes the
 * classification/score/confidence shown above -- it is reported separately so the
 * distinction between deterministic fact and model judgment stays visible.
 */
export function renderReasoningSummary(reasoningById: Map<string, SubmissionReasoning>): string {
  const lines: string[] = [];
  lines.push('=== REASONING LAYER (advisory only -- does not change classification/score/confidence above) ===');
  lines.push('');

  for (const [submissionId, reasoning] of reasoningById) {
    lines.push(`--- Submission ${submissionId} ---`);
    if (!reasoning.routed) {
      lines.push('  Routed to reasoning: NO (deterministic result already conclusive or nothing unresolved)');
      lines.push('');
      continue;
    }

    lines.push('  Routed to reasoning: YES');
    lines.push(`  Triggers: ${reasoning.triggers.join(', ')}`);

    const result = reasoning.result;
    if (!result) {
      lines.push(`  Reasoning: UNAVAILABLE -- ${reasoning.error ?? 'no result was returned'}`);
      lines.push('  Deterministic assessment above is unaffected and remains the result of record.');
      lines.push('');
      continue;
    }

    if (result.relevance.length > 0) {
      lines.push('  Relevance judgments (model opinion, not a verified fact):');
      for (const item of result.relevance) {
        lines.push(`    - ${item.requirementId}: ${item.verdict} (confidence: ${item.confidence}) -- ${item.reasoning}`);
      }
    }

    if (result.contradiction) {
      lines.push(
        `  Contradiction check: ${result.contradiction.contradictionFound ? 'POSSIBLE CONTRADICTION FOUND' : 'none found'} ` +
          `(confidence: ${result.contradiction.confidence})`,
      );
      lines.push(`    ${result.contradiction.explanation}`);
    }

    lines.push(
      `  Needs human review: ${result.ambiguity.needsReasoning ? 'YES' : 'NO'} (confidence: ${result.ambiguity.confidence})`,
    );
    lines.push(`    ${result.ambiguity.reason}`);
    lines.push('');
  }

  return lines.join('\n');
}
