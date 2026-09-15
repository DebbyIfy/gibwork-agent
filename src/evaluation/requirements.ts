import type { ReviewTask, Requirement } from './types.js';

/**
 * Replaceable extraction boundary. The deterministic implementation below reads
 * structured requirements straight off the task; an LLM-backed extractor could
 * implement this same interface later without touching any downstream code.
 */
export interface RequirementExtractor {
  extract(task: ReviewTask): Requirement[];
}

/** Deterministic: trusts structured requirements already attached to the task. */
export class StructuredRequirementExtractor implements RequirementExtractor {
  extract(task: ReviewTask): Requirement[] {
    if (task.requirements && task.requirements.length > 0) {
      return task.requirements;
    }
    // No structured requirements and no NLP extraction implemented yet -- fall back
    // to a single general requirement rather than guessing at task intent.
    return [
      {
        id: 'general-completion',
        description: task.description || task.title,
        required: true,
      },
    ];
  }
}

export function extractRequirements(
  task: ReviewTask,
  extractor: RequirementExtractor = new StructuredRequirementExtractor(),
): Requirement[] {
  return extractor.extract(task);
}
