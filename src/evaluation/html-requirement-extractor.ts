import type { RequirementExtractor } from './requirements.js';
import type { EvidenceType, Requirement, ReviewTask } from './types.js';

/**
 * Deterministic RequirementExtractor for live Gibwork tasks. A live task's
 * AvailableTask.requirements field is free text and was confirmed null on both real
 * stage bounties inspected -- the actual checklist content lives inside `content`'s
 * HTML as headed <ul>/<ol> lists (e.g. a "Submit"/"Rules" section), not a separate
 * structured field. This module never invents a requirement that isn't literally
 * present as a list item in the source HTML, and falls back to the exact same
 * general-completion requirement StructuredRequirementExtractor already uses when no
 * recognizable section is found -- fixtures never use this extractor, so their
 * behavior is completely unaffected.
 *
 * This is a small, hand-rolled parser, not a full HTML parser: it assumes the flat,
 * non-nested <h2-6>/<ul|ol>/<li> shape actually observed in real Gibwork task content.
 * Nested lists of the same tag type inside a list item are not handled correctly (a
 * known, accepted limitation given the real shape has none).
 */

export const MAX_EXTRACTED_REQUIREMENTS = 20;

const CRITERIA_HEADING_PATTERNS: RegExp[] = [
  /\bsubmit\b/i,
  /\bwhat to submit\b/i,
  /\bdeliverables?\b/i,
  /\brequirements?\b/i,
  /\bacceptance criteria\b/i,
  /\bcriteria\b/i,
  /\brules?\b/i,
  /\bmust\b/i,
];

const WORKFLOW_HEADING_PATTERNS: RegExp[] = [
  /\bwhat to do\b/i,
  /\bhow to\b/i,
  /\bsteps?\b/i,
  /\binstructions?\b/i,
  /\bgetting started\b/i,
];

/** Checked before the criteria list -- e.g. "How to submit" must not match "submit". */
function isWorkflowHeading(heading: string): boolean {
  return WORKFLOW_HEADING_PATTERNS.some((pattern) => pattern.test(heading));
}

function isCriteriaHeading(heading: string): boolean {
  return CRITERIA_HEADING_PATTERNS.some((pattern) => pattern.test(heading));
}

const OPTIONAL_CUE_PATTERN = /\b(optional|bonus|nice to have)\b/i;

const GITHUB_EVIDENCE_CUE = /\b(github|pull request|pr|commit)\b/i;
const URL_EVIDENCE_CUE = /\b(url|link|tweet|twitter)\b|x\.com/i;
const IMAGE_EVIDENCE_CUE = /\b(image|screenshot|photo)\b/i;

// A platform/payout policy statement (e.g. "One payout per unique meme/tweet.") can
// incidentally contain an evidence-shaped word ("tweet") while actually describing how
// the bounty is paid out, not what the submission must provide. Checked first so such
// statements never become falsely "verified" merely because a URL/image happens to
// exist elsewhere in the submission -- they stay evidence-type-less (claimed at most).
const POLICY_CUE_PATTERN = /\bpayout\b|\bper (submission|meme|tweet|entry|person|wallet|unique)\b|\bone per\b/i;

/** Only assigned on an unambiguous textual cue -- never guessed from vague wording. */
function inferEvidenceType(text: string): EvidenceType | undefined {
  if (POLICY_CUE_PATTERN.test(text)) return undefined;
  if (GITHUB_EVIDENCE_CUE.test(text)) return 'github';
  if (URL_EVIDENCE_CUE.test(text)) return 'url';
  if (IMAGE_EVIDENCE_CUE.test(text)) return 'image';
  return undefined;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = isHex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strips tags (replacing with a space, so adjacent inline tags never glue words together), decodes entities, collapses whitespace. */
function cleanText(fragment: string): string {
  const withoutTags = fragment.replace(/<[^>]*>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

function slugify(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

// A term recurs across almost any bounty ("image", "link", "submission", "payout", ...)
// and would create false OR-matched "claimed" positives if used alone as a keyword.
// Deliberately conservative and small -- not an attempt at a stopword-completeness list.
const GENERIC_KEYWORD_TERMS = new Set([
  'image',
  'work',
  'submit',
  'link',
  'project',
  'code',
  'file',
  'files',
  'url',
  'urls',
  'photo',
  'photos',
  'screenshot',
  'screenshots',
  'submission',
  'submissions',
  'task',
  'tasks',
  'payout',
  'payment',
  'deliverable',
  'deliverables',
  'requirement',
  'requirements',
  'rule',
  'rules',
  'criteria',
  'item',
  'items',
  'content',
  'post',
  'posts',
]);

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'be',
  'been',
  'being',
  'this',
  'that',
  'these',
  'those',
  'your',
  'you',
  'it',
  'its',
  'at',
  'by',
  'as',
  'not',
  'no',
  'must',
  'will',
  'shall',
  'should',
  'would',
  'can',
  'could',
  'may',
  'might',
  'from',
  'into',
  'onto',
  'than',
  'then',
  'so',
  'if',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  'was',
  'were',
  'also',
  'but',
  'per',
  'one',
  'any',
  'all',
  'each',
  'other',
  'such',
  'only',
  'via',
  'including',
  'include',
  'includes',
]);

function isEligibleKeywordWord(word: string): boolean {
  const lower = word.toLowerCase();
  if (lower.length < 4) return false;
  if (STOPWORDS.has(lower)) return false;
  if (GENERIC_KEYWORD_TERMS.has(lower)) return false;
  return true;
}

const DISTINCTIVE_TOKEN_PATTERN = /(@[A-Za-z0-9_]{2,})|\b([A-Za-z0-9-]+\.(?:com|io|dev|org|net|xyz|app))\b/g;

/**
 * Prefers, in order: (1) a handle/domain-shaped token (highly distinctive, safe),
 * (2) two ADJACENT eligible words as they actually appear in the source text (a real
 * short phrase, more specific than a lone word), (3) a single eligible word. Returns
 * undefined -- never a guess -- when nothing safely distinctive can be found, since an
 * always-not_found requirement is preferable to a keyword that creates false "claimed"
 * matches across unrelated submissions.
 */
function deriveKeywords(text: string): string[] | undefined {
  const distinctive = [...text.matchAll(DISTINCTIVE_TOKEN_PATTERN)]
    .map((match) => (match[1] ?? match[2] ?? '').toLowerCase())
    .filter(Boolean);
  if (distinctive.length > 0) {
    return [...new Set(distinctive)].slice(0, 2);
  }

  const words = text.split(/[^A-Za-z0-9']+/).filter(Boolean);
  const eligible = words.map(isEligibleKeywordWord);

  for (let i = 0; i < words.length - 1; i++) {
    if (eligible[i] && eligible[i + 1]) {
      return [`${words[i]!.toLowerCase()} ${words[i + 1]!.toLowerCase()}`];
    }
  }

  const firstEligibleIndex = eligible.findIndex(Boolean);
  return firstEligibleIndex === -1 ? undefined : [words[firstEligibleIndex]!.toLowerCase()];
}

function buildRequirement(slug: string, positionInSection: number, text: string): Requirement {
  const keywords = deriveKeywords(text);
  const evidenceType = inferEvidenceType(text);
  return {
    id: `${slug}-${positionInSection}`,
    description: text,
    required: !OPTIONAL_CUE_PATTERN.test(text),
    ...(keywords ? { keywords } : {}),
    ...(evidenceType ? { evidenceType } : {}),
  };
}

export interface HtmlRequirementExtractionResult {
  requirements: Requirement[];
  /** True when qualifying items beyond MAX_EXTRACTED_REQUIREMENTS were found and dropped -- never silent. */
  truncated: boolean;
}

/**
 * Pure function: walks the HTML once, in document order, tracking the most recent
 * heading. A <ul>/<ol> list is only harvested when the current heading matches a
 * criteria/deliverable pattern and does not match a workflow/instruction pattern
 * (checked first, so "How to submit" is correctly excluded despite containing "submit").
 * A list with no preceding heading, or a heading that matches neither list, is ignored
 * entirely -- this is an allow-list, not a fallback-to-everything scan.
 */
export function extractRequirementsFromHtml(html: string): HtmlRequirementExtractionResult {
  const blockPattern = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>|<(ul|ol)[^>]*>([\s\S]*?)<\/\2>/gi;
  const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;

  const collected: Requirement[] = [];
  const idCounters = new Map<string, number>();
  let currentHeading = '';

  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(html)) !== null) {
    const [, headingInner, , listInner] = match;

    if (headingInner !== undefined) {
      currentHeading = cleanText(headingInner);
      continue;
    }

    if (isWorkflowHeading(currentHeading)) continue;
    if (!isCriteriaHeading(currentHeading)) continue;

    const slug = slugify(currentHeading);
    for (const liMatch of (listInner ?? '').matchAll(liPattern)) {
      const itemText = cleanText(liMatch[1] ?? '');
      if (!itemText) continue;
      const position = (idCounters.get(slug) ?? 0) + 1;
      idCounters.set(slug, position);
      collected.push(buildRequirement(slug, position, itemText));
    }
  }

  const truncated = collected.length > MAX_EXTRACTED_REQUIREMENTS;
  return { requirements: collected.slice(0, MAX_EXTRACTED_REQUIREMENTS), truncated };
}

export class HtmlListRequirementExtractor implements RequirementExtractor {
  private truncatedLastRun = false;
  private usedFallbackLastRun = false;

  extract(task: ReviewTask): Requirement[] {
    const { requirements, truncated } = extractRequirementsFromHtml(task.description ?? '');
    this.truncatedLastRun = truncated;
    this.usedFallbackLastRun = requirements.length === 0;

    if (requirements.length > 0) return requirements;

    // Mirrors StructuredRequirementExtractor's fallback exactly -- no recognizable
    // criteria/deliverable list structure means we degrade safely, not guess.
    return [
      {
        id: 'general-completion',
        description: task.description || task.title,
        required: true,
      },
    ];
  }

  /** Reflects the most recent extract() call -- read this right after calling extract(). */
  get wasTruncated(): boolean {
    return this.truncatedLastRun;
  }

  /** Reflects the most recent extract() call -- true when no criteria section was found. */
  get usedGeneralFallback(): boolean {
    return this.usedFallbackLastRun;
  }
}
