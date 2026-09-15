import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRequirementsFromHtml,
  HtmlListRequirementExtractor,
  MAX_EXTRACTED_REQUIREMENTS,
} from './html-requirement-extractor.js';
import type { ReviewTask } from './types.js';

/**
 * All tests here are pure/offline -- no network, no SDK client. TOKEN_SHIT_HTML is the
 * real HTML captured (read-only) from the actual stage bounty during the audit for this
 * milestone -- both known available stage tasks returned this exact content.
 */

const TOKEN_SHIT_HTML = `<p>Make a meme in the official TOKEN$HIT studio, tweet it, and tag <a href="https://x.com/Tokenshit_">@Tokenshit_</a>.</p>
<p><strong>Pay:</strong> 1.00 USDC per approved meme. Pool is 10 USDC (about 10 memes).</p>
<h3>What to do</h3>
<ol>
<li>Go to <a href="https://tokenshit.com/memes">tokenshit.com/memes</a>. No login or wallet needed. Dismiss any Hour results / install-app popups.</li>
<li>Pick a blank (1000+ templates, face-pack filters, or Upload / Paste your own image).</li>
<li>Add TOP/BOTTOM captions, drag and resize, Light/Dark Monoton.</li>
<li>Download image or Copy image. Share opens X.</li>
<li>Tweet the meme and tag <strong>@Tokenshit_</strong>.</li>
</ol>
<h3>Submit</h3>
<ul>
<li>The tweet URL (must tag @Tokenshit_ and show the meme)</li>
<li>The meme image file</li>
</ul>
<h3>Rules</h3>
<ul>
<li>Must be made in the official studio, not a random generator.</li>
<li>Original work only. No spam, no copies of other submissions.</li>
<li>One payout per unique meme/tweet.</li>
</ul>`;

test('Submit items are extracted with exact source text preserved', () => {
  const { requirements } = extractRequirementsFromHtml(TOKEN_SHIT_HTML);
  const submitItems = requirements.filter((r) => r.id.startsWith('submit-'));
  assert.equal(submitItems.length, 2);
  assert.equal(submitItems[0]?.id, 'submit-1');
  assert.equal(submitItems[0]?.description, 'The tweet URL (must tag @Tokenshit_ and show the meme)');
  assert.equal(submitItems[1]?.id, 'submit-2');
  assert.equal(submitItems[1]?.description, 'The meme image file');
});

test('Rules items are extracted with exact source text preserved', () => {
  const { requirements } = extractRequirementsFromHtml(TOKEN_SHIT_HTML);
  const rulesItems = requirements.filter((r) => r.id.startsWith('rules-'));
  assert.equal(rulesItems.length, 3);
  assert.equal(rulesItems[0]?.description, 'Must be made in the official studio, not a random generator.');
  assert.equal(rulesItems[1]?.description, 'Original work only. No spam, no copies of other submissions.');
  assert.equal(rulesItems[2]?.description, 'One payout per unique meme/tweet.');
});

test('"What to do" workflow items are excluded entirely', () => {
  const { requirements } = extractRequirementsFromHtml(TOKEN_SHIT_HTML);
  assert.equal(requirements.length, 5, 'only Submit (2) + Rules (3) should be extracted, not the 5 "What to do" steps');
  for (const requirement of requirements) {
    assert.ok(!requirement.description.includes('tokenshit.com/memes'), 'a "What to do" step leaked through');
    assert.ok(!requirement.description.includes('Pick a blank'), 'a "What to do" step leaked through');
  }
});

test('HTML entities are decoded', () => {
  const html = '<h3>Requirements</h3><ul><li>Use &amp; verify &#39;done&#39; &mdash; confirm.</li></ul>';
  const { requirements } = extractRequirementsFromHtml(html);
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0]?.description, "Use & verify 'done' — confirm.");
});

test('nested inline markup is stripped without gluing words together', () => {
  const html = '<h3>Submit</h3><ul><li>Provide the <strong>PR</strong> <a href="x">link</a> here.</li></ul>';
  const { requirements } = extractRequirementsFromHtml(html);
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0]?.description, 'Provide the PR link here.');
});

test('evidenceType detection is conservative and correct on the real bounty items', () => {
  const { requirements } = extractRequirementsFromHtml(TOKEN_SHIT_HTML);
  const byId = new Map(requirements.map((r) => [r.id, r]));
  assert.equal(byId.get('submit-1')?.evidenceType, 'url');
  assert.equal(byId.get('submit-2')?.evidenceType, 'image');
  // "Must be made in the official studio..." and "Original work only..." have no
  // unambiguous evidence cue -- must stay evidence-type-less, not guessed.
  assert.equal(byId.get('rules-1')?.evidenceType, undefined);
  assert.equal(byId.get('rules-2')?.evidenceType, undefined);
  // The explicit milestone example: a payout/policy statement must never get an
  // evidenceType just because it happens to contain the word "tweet".
  assert.equal(byId.get('rules-3')?.evidenceType, undefined);
});

test('required defaults to true for all extracted items', () => {
  const { requirements } = extractRequirementsFromHtml(TOKEN_SHIT_HTML);
  assert.ok(requirements.length > 0);
  for (const requirement of requirements) {
    assert.equal(requirement.required, true);
  }
});

test('an explicit optional/bonus cue sets required=false', () => {
  const html = '<h3>Deliverables</h3><ul><li>Add a demo video (optional).</li><li>Provide a bonus writeup.</li><li>Provide the main link.</li></ul>';
  const { requirements } = extractRequirementsFromHtml(html);
  assert.equal(requirements[0]?.required, false);
  assert.equal(requirements[1]?.required, false);
  assert.equal(requirements[2]?.required, true);
});

test('unsafe/broad keyword candidates are never generated', () => {
  const { requirements } = extractRequirementsFromHtml(TOKEN_SHIT_HTML);
  const blocked = ['image', 'work', 'submit', 'link', 'project', 'code', 'file', 'url', 'submission', 'payout'];
  for (const requirement of requirements) {
    for (const keyword of requirement.keywords ?? []) {
      assert.ok(!blocked.includes(keyword), `keyword "${keyword}" on ${requirement.id} is an unsafe generic term`);
    }
  }
});

test('a bullet with no safely-distinctive words leaves keywords undefined rather than guessing', () => {
  const html = '<h3>Rules</h3><ul><li>Include the file link.</li></ul>';
  const { requirements } = extractRequirementsFromHtml(html);
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0]?.keywords, undefined);
});

test('a handle/domain in the text is preferred as a safe, highly distinctive keyword', () => {
  const { requirements } = extractRequirementsFromHtml(TOKEN_SHIT_HTML);
  const submit1 = requirements.find((r) => r.id === 'submit-1');
  assert.deepEqual(submit1?.keywords, ['@tokenshit_']);
});

test('repeated extraction of identical HTML produces identical Requirement[] (stable IDs, no regex-state leakage)', () => {
  const first = extractRequirementsFromHtml(TOKEN_SHIT_HTML);
  const second = extractRequirementsFromHtml(TOKEN_SHIT_HTML);
  const third = extractRequirementsFromHtml(TOKEN_SHIT_HTML);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test('malformed/empty HTML does not throw', () => {
  assert.doesNotThrow(() => extractRequirementsFromHtml(''));
  assert.doesNotThrow(() => extractRequirementsFromHtml('<h3>Submit<ul><li>Unclosed item'));
  assert.doesNotThrow(() => extractRequirementsFromHtml('just plain text, no tags at all'));
  assert.doesNotThrow(() => extractRequirementsFromHtml('<div><span>garbage</span></div>'));

  const emptyResult = extractRequirementsFromHtml('');
  assert.deepEqual(emptyResult, { requirements: [], truncated: false });
});

test('prose-only content (no recognizable list structure) yields zero extracted requirements', () => {
  const { requirements, truncated } = extractRequirementsFromHtml('<p>Just write a short essay about your favorite color.</p>');
  assert.equal(requirements.length, 0);
  assert.equal(truncated, false);
});

test('long lists are capped deterministically and expose truncation, without silently dropping items', () => {
  const items = Array.from({ length: 25 }, (_, i) => `<li>Requirement number ${i + 1} distinctivephrase${i + 1}.</li>`).join('');
  const html = `<h3>Requirements</h3><ul>${items}</ul>`;
  const { requirements, truncated } = extractRequirementsFromHtml(html);
  assert.equal(requirements.length, MAX_EXTRACTED_REQUIREMENTS);
  assert.equal(truncated, true);
  // Order-preserving: the first 20 in source order, not an arbitrary subset.
  assert.ok(requirements[0]?.description.includes('number 1 '));
  assert.ok(requirements[19]?.description.includes('number 20 '));
});

// --- HtmlListRequirementExtractor (the RequirementExtractor used by runLiveReview) ---

test('HtmlListRequirementExtractor.extract returns the extracted checklist for the real bounty', () => {
  const extractor = new HtmlListRequirementExtractor();
  const task: ReviewTask = { id: 't1', title: 'Create a TOKEN$HIT meme', description: TOKEN_SHIT_HTML };
  const requirements = extractor.extract(task);
  assert.equal(requirements.length, 5);
  assert.equal(extractor.usedGeneralFallback, false);
  assert.equal(extractor.wasTruncated, false);
});

test('HtmlListRequirementExtractor falls back to the exact general-completion requirement for prose-only tasks', () => {
  const extractor = new HtmlListRequirementExtractor();
  const task: ReviewTask = { id: 't2', title: 'Write an essay', description: 'Write 500 words about your favorite color.' };
  const requirements = extractor.extract(task);
  assert.deepEqual(requirements, [
    { id: 'general-completion', description: 'Write 500 words about your favorite color.', required: true },
  ]);
  assert.equal(extractor.usedGeneralFallback, true);
});

test('HtmlListRequirementExtractor falls back safely on malformed HTML instead of throwing', () => {
  const extractor = new HtmlListRequirementExtractor();
  const task: ReviewTask = { id: 't3', title: 'Broken task', description: '<h3>Submit<ul><li>Unclosed' };
  assert.doesNotThrow(() => extractor.extract(task));
  const requirements = extractor.extract(task);
  assert.equal(requirements[0]?.id, 'general-completion');
});
