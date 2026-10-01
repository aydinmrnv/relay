import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProgram } from '../src/cli/program.ts';
import { commandDocs, describeDefault, formatCommandDoc } from '../src/cli/help/commandDoc.ts';
import { generateManPage } from '../src/cli/man/generate.ts';
import { EXIT, EXIT_MEANINGS } from '../src/cli/exit.ts';

/** Wide enough that nothing wraps, so a sentence can be looked for whole. */
const UNWRAPPED = 1_000;

test('man page is derived from every visible command', () => {
  const program = buildProgram('test');
  const docs = commandDocs(program);
  const man = generateManPage(program);
  for (const doc of docs) {
    assert.match(man, new RegExp(`\\.SS ${doc.name}`));
    for (const option of doc.options) assert.ok(man.includes(option.flags.replaceAll('-', '\\-')));
    const command = program.commands.find((item) => item.name() === doc.name);
    assert.ok(command);
    const help = formatCommandDoc(command, UNWRAPPED);
    assert.ok(help.includes(doc.prose));
    assert.ok(help.includes(doc.synopsis));
    for (const argument of doc.arguments) assert.ok(help.includes(argument.term));
    for (const option of doc.options) assert.ok(help.includes(option.flags));
  }
  for (const variable of ['RELAY_HOME', 'RELAY_ASCII', 'RELAY_NO_OS_SANDBOX', 'NO_COLOR']) assert.ok(man.includes(variable));
  for (const code of Object.values(EXIT)) assert.ok(man.includes(`.B ${code}`));
});

// A date somebody typed describes the release it was typed for. The title
// line carries the build's own month and the version being packed instead.
test('man page is dated and versioned by the build that made it', () => {
  const program = buildProgram('1.2.3');
  const man = generateManPage(program, { version: '1.2.3', date: new Date('2027-03-09T12:00:00Z') });
  assert.match(man, /^\.TH RELAY 1 "March 2027" "Relay 1\.2\.3" "User Commands"$/m);
  // A copy whose manifest could not be read still gets a well-formed page.
  assert.match(generateManPage(program, { version: 'unknown', date: new Date('2027-03-09T12:00:00Z') }), /^\.TH RELAY 1 "March 2027" "Relay" /m);
});

test('man page says what each exit status means, not what the code calls it', () => {
  const man = generateManPage(buildProgram('test'));
  for (const name of Object.keys(EXIT) as Array<keyof typeof EXIT>) {
    assert.ok(man.includes(`.B ${EXIT[name]}\n${EXIT_MEANINGS[name].replaceAll('-', '\\-')}`), name);
  }
  assert.doesNotMatch(man, /checksFailed|preconditions\n/);
});

// A repeatable flag collects into an array that starts empty. Printing that
// array is how the help came to say `(default: )` and the manual `Default: .`
test('an empty default is not printed as a default', () => {
  assert.equal(describeDefault([]), undefined);
  assert.equal(describeDefault(undefined), undefined);
  assert.equal(describeDefault(''), undefined);
  assert.equal(describeDefault(['a', 'b']), 'a, b');
  assert.equal(describeDefault('latest'), 'latest');
  assert.equal(describeDefault(80), '80');

  const program = buildProgram('test');
  const man = generateManPage(program);
  assert.doesNotMatch(man, /Default: \./);
  for (const command of program.commands) {
    const help = formatCommandDoc(command, UNWRAPPED);
    assert.doesNotMatch(help, /\(default: \)/, command.name());
  }
  // A default that says something is still shown.
  const watch = program.commands.find((item) => item.name() === 'watch');
  assert.ok(watch);
  assert.match(formatCommandDoc(watch, UNWRAPPED), /poll interval in milliseconds \(default: 1000\)/);
});

test('a variadic argument is shown as one', () => {
  const run = buildProgram('test').commands.find((item) => item.name() === 'run');
  assert.ok(run);
  assert.match(formatCommandDoc(run, UNWRAPPED), /^Usage: relay run \[issue\.\.\.\]$/m);
});

test('help wraps to the terminal instead of running off its edge', () => {
  const program = buildProgram('test');
  for (const command of program.commands) {
    for (const line of formatCommandDoc(command, 80).split('\n')) {
      assert.ok(line.length <= 80, `${command.name()}: ${line.length} columns: ${line}`);
    }
  }
  const root = program.helpInformation();
  for (const line of root.split('\n')) assert.ok(line.length <= 80, `${line.length} columns: ${line}`);
});

// Whoever hosts Relay Cloud runs `relay hub`; nobody else ever does. `--tuff`
// is kept working for the people who know it is there. Neither is advertised:
// not in the help, not in the manual.
test('hidden commands and flags are left out of the help and the manual', () => {
  const program = buildProgram('test');
  const root = program.helpInformation();
  assert.doesNotMatch(root, /^\s+hub\b/m);
  assert.doesNotMatch(root, /^Cloud:/m, 'a group with nothing in it has no heading');
  assert.ok(!commandDocs(program).some((doc) => doc.name === 'hub' || doc.name.startsWith('__')));

  const man = generateManPage(program);
  assert.doesNotMatch(man, /\.SS hub/);
  assert.doesNotMatch(man, /tuff/);

  const run = program.commands.find((item) => item.name() === 'run');
  assert.ok(run);
  assert.doesNotMatch(formatCommandDoc(run, UNWRAPPED), /--tuff/);
  // Hidden is not removed: both still parse.
  assert.ok(run.options.some((option) => option.long === '--tuff'));
  assert.ok(program.commands.some((item) => item.name() === 'hub'));
});
