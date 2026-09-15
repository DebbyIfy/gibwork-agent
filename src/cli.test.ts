import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCli, resolveInteractiveMode } from './cli.js';
import type { FixtureReviewCliOptions, LiveReviewCliOptions } from './types.js';

test('parseCli: review --fixture with no interactive flags leaves interactive unset (auto-detect later)', () => {
  const options = parseCli(['review', '--fixture', 'fixtures/task.json']) as FixtureReviewCliOptions;
  assert.equal(options.mode, 'fixture');
  assert.equal(options.interactive, undefined);
});

test('parseCli: --interactive is parsed as interactive: true', () => {
  const options = parseCli(['review', '--fixture', 'fixtures/task.json', '--interactive']) as FixtureReviewCliOptions;
  assert.equal(options.interactive, true);
});

test('parseCli: --no-interactive is parsed as interactive: false', () => {
  const options = parseCli(['review', '--fixture', 'fixtures/task.json', '--no-interactive']) as FixtureReviewCliOptions;
  assert.equal(options.interactive, false);
});

test('parseCli: --interactive and --no-interactive together is a clear error', () => {
  assert.throws(
    () => parseCli(['review', '--fixture', 'fixtures/task.json', '--interactive', '--no-interactive']),
    /--interactive and --no-interactive cannot both be passed/,
  );
});

test('parseCli: --interactive combined with --submission (live mode) is rejected, like --reasoning/--inspect already are', () => {
  assert.throws(
    () => parseCli(['review', 'abc123', '--submission', 'sub1', '--interactive']),
    /--submission.*cannot be combined with.*--interactive/,
  );
});

test('parseCli: --no-interactive combined with --submission is allowed (both express "no interactive behavior")', () => {
  const options = parseCli(['review', 'abc123', '--submission', 'sub1', '--no-interactive']) as LiveReviewCliOptions;
  assert.equal(options.submissionId, 'sub1');
  assert.equal(options.interactive, false);
});

test('parseCli: live mode also carries --interactive through', () => {
  const options = parseCli(['review', 'abc123', '--interactive']) as LiveReviewCliOptions;
  assert.equal(options.mode, 'live');
  assert.equal(options.interactive, true);
});

test('resolveInteractiveMode: --inspect always wins, even over an explicit --interactive and a real TTY', () => {
  assert.equal(resolveInteractiveMode({ inspect: '3', interactive: true }, true, true), false);
  assert.equal(resolveInteractiveMode({ inspect: '3' }, true, true), false);
});

test('resolveInteractiveMode: explicit --interactive forces it on even when piped (not a TTY)', () => {
  assert.equal(resolveInteractiveMode({ interactive: true }, false, false), true);
});

test('resolveInteractiveMode: explicit --no-interactive forces it off even in a real TTY', () => {
  assert.equal(resolveInteractiveMode({ interactive: false }, true, true), false);
});

test('resolveInteractiveMode: auto-detects on only when both stdin and stdout are a TTY and nothing else overrides it', () => {
  assert.equal(resolveInteractiveMode({}, true, true), true);
  assert.equal(resolveInteractiveMode({}, true, false), false);
  assert.equal(resolveInteractiveMode({}, false, true), false);
  assert.equal(resolveInteractiveMode({}, false, false), false);
});
