import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProgram } from '../src/cli/program.ts';
import { commandDocs, formatCommandDoc } from '../src/cli/help/commandDoc.ts';
import { generateManPage } from '../src/cli/man/generate.ts';
import { EXIT } from '../src/cli/exit.ts';

test('man page is derived from every visible command', () => {
  const program = buildProgram('test');
  const docs = commandDocs(program);
  const man = generateManPage(program);
  for (const doc of docs) {
    assert.match(man, new RegExp(`\\.SS ${doc.name}`));
    for (const option of doc.options) assert.ok(man.includes(option.flags.replaceAll('-', '\\-')));
    const command = program.commands.find((item) => item.name() === doc.name);
    assert.ok(command);
    const help = formatCommandDoc(command);
    assert.ok(help.includes(doc.prose));
    assert.ok(help.includes(doc.synopsis));
    for (const argument of doc.arguments) assert.ok(help.includes(argument.term));
    for (const option of doc.options) assert.ok(help.includes(option.flags));
  }
  for (const variable of ['RELAY_HOME', 'RELAY_ASCII', 'NO_COLOR']) assert.ok(man.includes(variable));
  for (const code of Object.values(EXIT)) assert.ok(man.includes(`.B ${code}`));
});
