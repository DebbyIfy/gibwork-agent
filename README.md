# gibwork-agent

A non-web, CLI-first tool for reviewing Gibwork bounty submissions. Given a
bounty with many submissions, it answers "what needs a human's attention
first, and why?" -- fetching the task and its submissions directly through the
real [`@gibwork/sdk`](https://www.npmjs.com/package/@gibwork/sdk) (read-only:
`tasks.get()` / `submissions.list()`), evaluating each submission against the
task's requirements with a deterministic engine, optionally adding a
narrowly-scoped LLM reasoning layer as an advisory second opinion, and
printing one prioritized report. It never approves, rejects, pays, refunds,
or creates anything on Gibwork -- see
[Security and safety boundaries](#security-and-safety-boundaries) below.

```
Gibwork task + submissions
        ↓
Deterministic pre-checks
        ↓
Requirement extraction
        ↓
Deterministic evaluation  (score, classification, confidence -- source of truth)
        ↓
Reasoning router          (deterministic; decides IF an LLM call adds value)
        ↓
LLM reasoning             (advisory only; optional; mock or real)
        ↓
Human review
```

## Installation

**Prerequisites:** Node.js 20.12 or later (needed for `process.loadEnvFile()`,
used to load `.env` automatically; developed and tested on Node 22) and npm.

```
git clone https://github.com/DebbyIfy/gibwork-agent.git
cd gibwork-agent
npm install
npm run build
npm link          # exposes the `gibwork-agent` command on your PATH
```

`npm link` reads this package's `bin` entry (`gibwork-agent` -> `dist/index.js`) and
symlinks it onto your PATH, so `npm run build` must run first -- there's nothing to
link to before `dist/index.js` exists. Once linked, `gibwork-agent` is available as
a plain CLI command from any directory, and every example in this README
(`gibwork-agent review ...`) works as shown. Remove it later with
`npm unlink -g gibwork-agent`.

Prefer not to install it globally? Every command below also works unlinked:

```
node dist/index.js review --fixture fixtures/task.json   # after npm run build
npx tsx src/index.ts review --fixture fixtures/task.json # no build step
```

Live review (`gibwork-agent review <task-id>`, without `--fixture`) additionally
requires the [Gibwork CLI](https://gibwork.com) to be installed and configured with a
wallet keypair. This tool does not manage its own wallet config -- it reads the
path the Gibwork CLI already has on file for you (`gibwork config get
keypair-path`), so that has to be set up first:

```
gibwork config set keypair-path <path-to-your-keypair-file>
```

Fixture mode needs none of this -- no wallet, no network, no Gibwork CLI.

## Security and safety boundaries

- **Review is strictly read-only against Gibwork.** Live mode only ever calls
  `tasks.get()` and `submissions.list()` (see `src/gibwork.ts`) -- there is no
  approve, reject, pay, refund, or bounty-creation path anywhere in this tool.
- **A human always makes the final call.** The report recommends one of four
  next steps (see [Report format](#report-format) below) -- never "approve" or
  "reject" -- because this tool is human-in-the-loop by design.
- **AI reasoning is advisory only.** When enabled (`--reasoning`), its output
  is rendered in a separate report section and never changes the
  deterministic `score`, `classification`, or `confidence` computed above it
  -- see [What the reasoning layer does -- and does not do](#what-the-reasoning-layer-does----and-does-not-do)
  for the full detail.

## Scope and decision boundary

`gibwork-agent` is a **read-only review and prioritization layer** -- not a
decision-maker. It fetches and evaluates Gibwork bounty submissions, checks
them against the task's requirements and available evidence, flags potential
issues, and prioritizes which submissions most need a human's attention. It
does **not** approve, reject, refund, or pay a submission.

```
Gibwork bounty → submissions → gibwork-agent → evidence + prioritization → human review → Gibwork approval/rejection
```

The final approval/rejection decision always stays with the bounty owner,
made through Gibwork's own existing workflow -- this tool only informs that
decision, it never makes or executes it. This separation is intentional:
`gibwork-agent` is designed to provide evidence-backed decision support
without ever taking a financial or irreversible action.

A future version could optionally support explicit, user-confirmed approval
actions through the Gibwork SDK, but write operations are out of scope for
the current MVP.

## Usage

### Fixture / offline demo mode

Runs the exact same evaluation engine against local JSON fixtures in this
repo -- no Gibwork wallet, no Gibwork network call, and no LLM call unless you
opt into `--reasoning`. This is the fastest way to try the tool or demo it.

```
gibwork-agent review --fixture fixtures/task.json                # offline, deterministic only
gibwork-agent review --fixture fixtures/task.json --inspect 3     # focused drill-down into submission #3 (skips the summary)
gibwork-agent review --fixture fixtures/challenging-task.json --reasoning                       # + mock reasoning
gibwork-agent review --fixture fixtures/challenging-task.json --reasoning --reasoning-provider api  # + real reasoning
```

### Live Gibwork mode

Reads a real bounty and its submissions directly from Gibwork through the
`@gibwork/sdk` -- strictly read-only (see
[Security and safety boundaries](#security-and-safety-boundaries) above).
Requires the Gibwork CLI wallet setup described in
[Installation](#installation).

Don't have a task ID handy? List publicly available bounties first
(`tasks.listAvailable()`, also read-only):

```
gibwork-agent tasks --available
```

Then review one directly by id:

```
gibwork-agent review <task-id>                                  # live, read-only Gibwork review
gibwork-agent review <task-id> --inspect 3                       # focused drill-down into submission #3 (skips the summary)
gibwork-agent review <task-id> --reasoning                       # + mock reasoning
```

### Interactive mode

Running `gibwork-agent review <task-id>` (or `--fixture <path>`) with **both stdin and
stdout attached to a real terminal** automatically follows the summary with a menu --
no need to already know `--inspect` or `--reasoning`:

```
What would you like to do?

  1. Inspect a submission
  2. Exit
```

Picking "Inspect a submission" shows a numbered list built from the same submissions
already in the report's `NEEDS ATTENTION` section (score descending) -- pick one by
number to see its full existing focused-inspection report, then optionally choose
"Run AI reasoning" to get the existing advisory reasoning output for **only** that one
submission (never the whole bounty). `--reasoning`/`--reasoning-provider` still choose
*which* provider that on-demand run uses; interactive mode never eagerly reasons about
every routed submission the way non-interactive `--reasoning` does.

This is a convenience layer, not a replacement -- `--inspect`/`--submission` still work
exactly as documented above and never trigger a prompt (they already say precisely what
you want). Piped/redirected/CI usage is never interactive either, with no flag required.
Force it either way with `--interactive` / `--no-interactive`.

## Report format

`gibwork-agent review <task-id>` (or `--fixture`) prints a summary-first,
compact report designed to answer "what do I need to look at first?" for a
bounty with many submissions:

1. An executive summary: bounty title, a requirement-status rollup (how many
   requirements are typically satisfied/partial/missing across the
   submissions received), submission count, and counts per classification
   (`Strong` / `Review` / `Incomplete` / `Suspicious`).
2. A **Priority Review** section highlighting the `Review`, `Incomplete`, and
   `Suspicious` submissions most worth a human's time first (score descending).
3. Compact ~3-4 line blocks per submission in `TOP SUBMISSIONS` (a sample of
   `Strong` submissions) and `NEEDS ATTENTION` (every `Review`/`Incomplete`/
   `Suspicious` submission) -- never a full requirement/evidence dump.

Score, classification, and confidence are always kept as separate, clearly
labeled concepts -- a high score never implies `Strong` on its own, since
classification also checks for missing/contradicted required requirements
and duplicate/empty-content flags first.

The report only ever recommends one of four things -- never "approve" or
"reject" this submission, since the tool is human-in-the-loop by design:

| Classification | Recommended next step |
|---|---|
| Strong | No immediate concerns |
| Review | Human review recommended |
| Incomplete | Required evidence is missing |
| Suspicious | Requires manual verification |

`--inspect <ref>` is a focused drill-down into one submission, not an
addition to the summary -- it skips the compact report entirely and prints
only that submission's full evidence-backed breakdown: every requirement,
its status, its evidence (type/source), the reason behind that status, and
any quality/duplicate flags. `<ref>` is either the submission's report `#N`
display number or its literal submission ID. Run without `--inspect` first
to see the summary and find which `#N` is worth a closer look:

```
gibwork-agent review abc123 --inspect 12
gibwork-agent review abc123 --inspect <submission-id>
gibwork-agent review --fixture fixtures/task.json --inspect 3
```

Combined with `--reasoning` (`--inspect 12 --reasoning`), the reasoning
layer is asked about -- and only renders reasoning for -- the inspected
submission, never every submission in the bounty; see
[Cost and safety guidance](#cost-and-safety-guidance).

## What the reasoning layer does -- and does not do

The deterministic evaluator (`src/evaluation/evaluator.ts` and friends) is the
**source of truth**. It computes `score`, `classification`, and `confidence`
for every submission from objective checks: empty/duplicate detection,
malformed URLs, keyword/negation matching, evidence-type matching, and a
transparent scoring formula. This never changes, regardless of whether
reasoning is used.

A deterministic **router** (`src/evaluation/routing.ts`) then decides, per
submission, whether anything is genuinely unresolved -- e.g. evidence of the
wrong type, an attachment whose relevance can't be judged mechanically, the
same artifact used as evidence for two different requirements, or a
submission that looks fully resolved and is therefore worth a cheap
contradiction check. A submission already conclusively resolved (empty,
duplicate, explicit contradiction) is never routed -- there's nothing an LLM
would add.

Only routed submissions get an LLM call, and each gets **at most one batched
call** (never one call per requirement, never one per trigger).

**The reasoning layer is advisory only.** Its output is rendered in a
separate report section and never changes the deterministic `score`,
`classification`, or `confidence` shown above it. It cannot approve, reject,
refund, submit, or otherwise touch Gibwork state -- there is no such method on
the `LLMProvider` interface (`src/evaluation/llm.ts`) at all.

## Deterministic vs. AI reasoning

| | Deterministic evaluator | Reasoning layer |
|---|---|---|
| Handles | empty submissions, duplicates, malformed URLs, keyword/negation matches, evidence-type matching, scoring | evidence relevance judgment, cross-sentence contradiction detection, "is there enough info to tell" |
| Authority | source of truth for score/classification/confidence | advisory notes only, shown separately |
| Runs | always | only when the router flags a submission, and only if `--reasoning` is passed |
| Network | never | mock provider: never. real provider: yes, one call per routed submission |

## Configuring the real provider

Fixture mode with the **mock** provider (the default whenever `--reasoning` is
passed) needs no API key and makes no network call -- it returns canned
responses for a few known fixture IDs and a conservative "uncertain" fallback
for everything else, purely to demonstrate the routing plumbing.

To use the **real OpenRouter provider** instead:

1. Copy `.env.example` to `.env` (at the project root) and set
   `OPENROUTER_API_KEY` (get one at
   [openrouter.ai/keys](https://openrouter.ai/keys)).

   The current real provider is **OpenRouter**. `OPENROUTER_MODEL` is
   optional and defaults to `openrouter/free`, OpenRouter's free multi-model
   router. You can also set it to a specific OpenRouter model slug (for example,
   `anthropic/claude-haiku-4-5` or `openai/gpt-4o-mini`) when you want to use a
   fixed model.

   Direct API integrations with individual model providers are not currently
   included; model selection is handled through OpenRouter.
2. Build once: `npm run build`.
3. Run normally -- the project's own `.env` is loaded automatically (see
   below), no flag required:

   ```
   gibwork-agent review <task-id> --reasoning --reasoning-provider api
   node dist/index.js review --fixture fixtures/challenging-task.json --reasoning --reasoning-provider api
   ```

   or use the bundled script: `npm run review:fixture:reasoning:api`.

`.env` is git-ignored (see `.gitignore`) -- never commit real credentials.
`--reasoning-provider api` is never enabled by default; you have to pass it
explicitly, and `OPENROUTER_API_KEY` has to be set, or the reasoning layer
reports itself unavailable per-submission (see below) rather than crashing.

`.env` is loaded once at startup via Node's built-in `process.loadEnvFile()`
(no extra dependency), anchored to the project's own directory rather than
wherever you happen to run `gibwork-agent` from -- so the linked `gibwork-agent`
command picks it up the same way `node dist/index.js` does. A missing `.env`
is fine (fixture mode and non-reasoning runs need no environment variables at
all); an already-exported shell variable still takes precedence over `.env`,
same as Node's `--env-file` flag.

## Provider architecture

Everything depends on the `LLMProvider` interface (`src/evaluation/llm.ts`):

```ts
interface LLMProvider {
  reason(request: ReasoningRequest): Promise<ReasoningResult>;
}
```

- `src/evaluation/mock-llm-provider.ts` -- deterministic, offline, used by
  default and by all fixture tests.
- `src/evaluation/real-llm-provider.ts` -- the only file in this codebase that
  knows about a specific vendor (OpenRouter). Talks to OpenRouter's
  OpenAI-compatible chat completions endpoint with plain `fetch` rather than
  an SDK -- one HTTP endpoint with a JSON body doesn't need a client library.
  Swapping to a different vendor later means adding a sibling file, not
  touching the evaluator, router, or orchestrator.
- `src/evaluation/reasoning.ts`'s `applyReasoning()` is the **single**
  orchestration point that ever calls a provider. It decides whether to call
  (via the router), builds the compact request, and catches any provider
  failure so the deterministic assessment is never lost.

### Structured output and validation

The real provider requests `response_format: { type: 'json_object' }` from
OpenRouter's chat completions endpoint and includes the exact expected JSON
schema (relevance verdicts, an optional contradiction result, an ambiguity
signal) in the system prompt, since `openrouter/free` can route to any of
several underlying free models and not all of them support strict
`json_schema`-constrained output. The parsed JSON is then **independently
validated** in `real-llm-provider.ts` before being trusted -- every required
field, enum value (verdict, confidence), array, and string is checked
explicitly. A response is not assumed to be well-formed just because the API
accepted the request; if validation fails for any reason, a
`ProviderReasoningError` is thrown rather than silently coercing a partial or
malformed object into a confident-looking result.

### Fallback behavior

If the provider throws for any reason -- missing API key, network failure,
HTTP error, rate limit, invalid JSON, or a validation failure -- `applyReasoning()`
catches it and returns a `SubmissionReasoning` with `error` set instead of
`result`. The report renderer shows this as:

```
Reasoning: UNAVAILABLE -- <safe, human-readable message>
Deterministic assessment above is unaffected and remains the result of record.
```

The deterministic score/classification/confidence for that submission are
untouched and still fully printed above this line -- a provider failure never
removes the deterministic review.

## Cost and safety guidance

- Reasoning is opt-in (`--reasoning`) and the real provider is opt-in on top
  of that (`--reasoning-provider api`) -- nothing spends money by default.
- The router only sends submissions with a genuinely unresolved question;
  most submissions in the bundled fixtures are never routed at all.
- Each routed submission gets exactly one batched API call, covering every
  trigger for that submission together -- never one call per trigger.
- Combined with `--inspect`, this narrows further still: the provider is
  called for (at most) the one inspected submission, never for every routed
  submission in the bounty.
- The client is constructed with a small, explicit retry cap (1) and a 30s
  timeout -- no unbounded automatic retries.
- Never logged: the API key, request/response headers, or raw provider error
  bodies. Only sanitized `.message` strings are ever surfaced to the CLI.
- The reasoning layer has no method that can approve, reject, refund, submit,
  or sign anything -- those capabilities don't exist on `LLMProvider` at all.
- Live Gibwork review (`gibwork-agent review <task-id>`) remains strictly
  read-only, unrelated to and unaffected by this reasoning layer.

## Development

```
npm install
npx tsc --noEmit
npm run build
npm test                          # offline unit tests, no API key needed
npm run review:fixture            # deterministic only
npm run review:fixture:challenging
npm run review:fixture:reasoning  # + mock reasoning layer
```
