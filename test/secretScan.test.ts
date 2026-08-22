import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ENTROPY_RULE,
  matchesIgnorePattern,
  neverCommitRule,
  readSecretsIgnore,
  scanContent,
  scanForSecrets,
  shannonEntropy,
} from '../src/git/secretScan.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

// Every planted credential is assembled at runtime so no token-shaped string
// sits in this repository's own diff — the scanner under test would flag it.
const GITHUB_TOKEN = ['ghp', `Zz9${'Aa1Bb2Cc3Dd4Ee5Ff6Gg7'}`].join('_');
const AWS_KEY_ID = `${'AK'}${'IA'}JQ7W9XZ2K4M6P8R0`;
const PRIVATE_KEY_BLOCK = [
  ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  'MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQ',
  ['-----END', 'PRIVATE KEY-----'].join(' '),
].join('\n');
// 40 characters, alternating case and digits: entropy above the strong tier.
const HIGH_ENTROPY = 'aB3dE5gH7jK9mN1pQ4sU6wX8zY0cF2iL5oR7tV9x';

describe('content detectors', () => {
  it('reports the rule and the line for a recognizable token, never the token', () => {
    const content = `line one\nline two\nconst t = "${GITHUB_TOKEN}";\n`;
    const hits = scanContent(content);

    assert.deepEqual(hits, [{ line: 3, rule: 'github-token' }]);
    assert.ok(!JSON.stringify(hits).includes(GITHUB_TOKEN));
  });

  it('recognizes the other high-signal shapes redact.ts knows', () => {
    assert.deepEqual(scanContent(`key=${AWS_KEY_ID}\n`), [{ line: 1, rule: 'aws-key-id' }]);
    assert.equal(scanContent(`prefix\n${PRIVATE_KEY_BLOCK}\n`)[0]?.rule, 'private-key');
    assert.equal(scanContent(`prefix\n${PRIVATE_KEY_BLOCK}\n`)[0]?.line, 2);
  });

  it('flags a long high-entropy string with no recognizable prefix', () => {
    // The precondition the tier depends on, asserted so the fixture cannot rot.
    assert.ok(HIGH_ENTROPY.length >= 32 && shannonEntropy(HIGH_ENTROPY) >= 4.5);
    assert.deepEqual(scanContent(`data = "${HIGH_ENTROPY}"\n`), [{ line: 1, rule: ENTROPY_RULE }]);
  });

  it('lets a shorter high-entropy string through unless the line says it is a key', () => {
    const candidate = 'q1w2e3r4t5y6u7i8o9p0z3x4';
    assert.ok(candidate.length >= 24 && candidate.length < 32);
    assert.ok(shannonEntropy(candidate) >= 3.8 && shannonEntropy(candidate) < 4.5);

    assert.deepEqual(scanContent(`const blob = "${candidate}";\n`), []);
    assert.deepEqual(scanContent(`const api_key = "${candidate}";\n`), [{ line: 1, rule: ENTROPY_RULE }]);
  });

  it('does not mistake hashes, paths or prose for keys', () => {
    // A git SHA: pure hex, however long, is a hash in a diff far more often
    // than it is a credential.
    assert.deepEqual(scanContent(`${'0123456789abcdef'.repeat(4)}\n`), []);
    // An npm integrity line, explicitly exempted.
    assert.deepEqual(scanContent(`"integrity": "sha512-${HIGH_ENTROPY}"\n`), []);
    // A path shares the base64 alphabet but carries separators.
    assert.deepEqual(scanContent('import x from "src/workflow/phases/implementation.ts";\n'), []);
    assert.deepEqual(scanContent('The quick brown fox jumps over the lazy dog once more\n'), []);
  });
});

describe('never-commit filenames', () => {
  it('refuses env files, key material and credential JSON by name alone', () => {
    for (const path of ['.env', 'deploy/.env.production', 'id_rsa', 'certs/server.pem', 'gcp/credentials.json', 'client_secret.json']) {
      assert.ok(neverCommitRule(path) !== undefined, `${path} should be a finding`);
    }
  });

  it('lets templates and public halves through', () => {
    for (const path of ['.env.example', '.env.sample', 'id_rsa.pub', 'src/app.ts', 'docs/env.md']) {
      assert.equal(neverCommitRule(path), undefined, `${path} should not be a finding`);
    }
  });

  it('names the rule without reading the file', () => {
    assert.match(neverCommitRule('.env') ?? '', /never-commit filename \(\.env\)/);
    assert.match(neverCommitRule('a/b/key.pem') ?? '', /\*\.pem/);
  });
});

describe('ignore patterns', () => {
  it('matches like a small gitignore', () => {
    assert.ok(matchesIgnorePattern('*.pem', 'certs/server.pem'));
    assert.ok(matchesIgnorePattern('fixtures/**', 'fixtures/a/b.txt'));
    assert.ok(matchesIgnorePattern('fixtures/', 'fixtures/deep/file.txt'));
    assert.ok(matchesIgnorePattern('./leak.txt', 'leak.txt'));
    assert.ok(matchesIgnorePattern('**/token.txt', 'token.txt'));
    assert.ok(matchesIgnorePattern('file.?xt', 'file.txt'));

    assert.ok(!matchesIgnorePattern('*.pem', 'server.pemx'));
    assert.ok(!matchesIgnorePattern('fixtures/*', 'fixtures/a/b.txt'));
    assert.ok(!matchesIgnorePattern('other/', 'fixtures/file.txt'));
  });
});

describe('scanning a worktree', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function scan(options: { allow?: string[]; ignore?: string[] } = {}) {
    const baseSha = await repo.git('rev-parse', 'HEAD');
    return scanForSecrets({ worktree: repo.root, baseSha, ...options });
  }

  it('finds a planted key in an untracked file, with its file and line', async () => {
    await repo.writeFile('config/settings.txt', `alpha\nbeta\ntoken: ${GITHUB_TOKEN}\n`);

    const result = await scan();

    assert.deepEqual(result.findings, [{ file: 'config/settings.txt', line: 3, rule: 'github-token' }]);
    assert.ok(!JSON.stringify(result).includes(GITHUB_TOKEN));
    assert.ok(result.scanned >= 1);
  });

  it('reports a never-commit filename without a line number', async () => {
    await repo.writeFile('.env', 'HOME=/root\n');

    const result = await scan();
    assert.deepEqual(result.findings, [{ file: '.env', line: null, rule: 'never-commit filename (.env)' }]);
  });

  it('scans only what changed since the base', async () => {
    // The planted key is already part of the base commit: this run did not add
    // it, so this run's delivery is not the place it gets reported.
    await repo.writeFile('legacy.txt', `old ${GITHUB_TOKEN}\n`);
    await repo.commit('legacy');
    await repo.writeFile('clean.txt', 'nothing secret here\n');

    const result = await scan();
    assert.deepEqual(result.findings, []);
    assert.equal(result.scanned, 1);
  });

  it('lets --allow-secret suppress one path, and counts the suppression', async () => {
    await repo.writeFile('leak.txt', `${GITHUB_TOKEN}\n`);

    const blocked = await scan();
    assert.equal(blocked.findings.length, 1);

    const allowed = await scan({ allow: ['leak.txt'] });
    assert.deepEqual(allowed.findings, []);
    assert.equal(allowed.suppressed, 1);
  });

  it('lets .relay/secretsignore patterns suppress repeatably', async () => {
    await repo.writeFile('fixtures/sample.pem', 'not really a key\n');

    const blocked = await scan();
    assert.equal(blocked.findings.length, 1);

    const ignored = await scan({ ignore: ['fixtures/**'] });
    assert.deepEqual(ignored.findings, []);
    assert.equal(ignored.suppressed, 1);
  });

  it('exempts lockfiles from the entropy heuristic but not from real tokens', async () => {
    await repo.writeFile('package-lock.json', `{"blob": "${HIGH_ENTROPY}"}\n`);
    assert.deepEqual((await scan()).findings, []);

    await repo.writeFile('package-lock.json', `{"token": "${GITHUB_TOKEN}"}\n`);
    assert.deepEqual(
      (await scan()).findings.map((finding) => finding.rule),
      ['github-token'],
    );
  });

  it('checks a binary file by name but not by content', async () => {
    const binary = Buffer.concat([Buffer.from('junk'), Buffer.from([0]), Buffer.from(GITHUB_TOKEN)]);
    await mkdir(join(repo.root, 'bin'), { recursive: true });
    await writeFile(join(repo.root, 'bin', 'blob.pem'), binary);

    const result = await scan();
    assert.deepEqual(result.findings, [{ file: 'bin/blob.pem', line: null, rule: 'never-commit filename (*.pem)' }]);
  });
});

describe('.relay/secretsignore', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reads one pattern per line, skipping comments and blanks', async () => {
    await repo.writeFile('.relay/secretsignore', '# fixtures are fake\nfixtures/**\n\n  *.pem  \n');
    assert.deepEqual(await readSecretsIgnore(repo.root), ['fixtures/**', '*.pem']);
  });

  it('is empty when the file does not exist', async () => {
    assert.deepEqual(await readSecretsIgnore(repo.root), []);
  });
});
