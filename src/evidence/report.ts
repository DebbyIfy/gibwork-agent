import type { GithubPrEvidence } from './github.js';

export interface GithubEvidenceOutcome {
  url: string;
  evidence?: GithubPrEvidence;
  error?: string;
}

/**
 * Purely additive, like the reasoning report section: shows what was retrieved and
 * never implies verification. Deliberately does not render `body` in full (can be
 * long) -- just enough to tell a human what the PR is.
 */
export function renderGithubEvidenceSection(bySubmission: Map<string, GithubEvidenceOutcome[]>): string {
  const lines: string[] = [];
  lines.push('=== GITHUB EVIDENCE INSPECTION (read-only -- does not affect score/classification) ===');
  lines.push('');

  for (const [submissionId, outcomes] of bySubmission) {
    lines.push(`--- Submission ${submissionId} ---`);
    if (outcomes.length === 0) {
      lines.push('  No inspectable GitHub pull request evidence found.');
      lines.push('');
      continue;
    }

    for (const outcome of outcomes) {
      lines.push(`  ${outcome.url}`);
      if (outcome.error || !outcome.evidence) {
        lines.push(`    UNAVAILABLE -- ${outcome.error ?? 'no evidence was returned'}`);
        lines.push('');
        continue;
      }

      const evidence = outcome.evidence;
      const stateSuffix = `${evidence.isDraft ? ' (draft)' : ''}${evidence.merged ? ' (merged)' : ''}`;
      lines.push(`    Title:   ${evidence.title}`);
      lines.push(`    State:   ${evidence.state}${stateSuffix}`);
      lines.push(`    Changed: ${evidence.changedFilesCount} file(s), +${evidence.additions}/-${evidence.deletions}`);
      if (evidence.changedFiles.length > 0) {
        const fileList = evidence.changedFiles.map((file) => file.path).join(', ');
        lines.push(`    Files:   ${fileList}${evidence.changedFilesTruncated ? ', ...' : ''}`);
      }
      if (evidence.checks.length > 0) {
        lines.push(`    Checks:  ${evidence.checks.map((check) => `${check.name}=${check.state}`).join(', ')}`);
      }
      if (evidence.reviewDecision) {
        lines.push(`    Review:  ${evidence.reviewDecision}`);
      }
      lines.push('    (Retrieved evidence, not a verification -- the evaluator/reasoning layer decides what it means.)');
      lines.push('');
    }
  }

  return lines.join('\n');
}
