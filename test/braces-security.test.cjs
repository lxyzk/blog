'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const braces = require('braces');
const micromatch = require('micromatch');

test('normal brace patterns retain compile, expand and literal behavior', () => {
  assert.equal(braces.compile('posts/{draft,published}/*.md'), 'posts/(draft|published)/*.md');
  assert.deepEqual(braces.expand('file-{1..3}.md'), ['file-1.md', 'file-2.md', 'file-3.md']);
  assert.deepEqual(braces.expand('x/{a,{b,c}}'), ['x/a', 'x/b', 'x/c']);
  assert.equal(braces.stringify(braces.parse('x/{a,b}')), 'x/{a,b}');
  assert.equal(braces.compile('\\{literal\\}'), '{literal}');
  assert.equal(braces.compile('"{{quoted}}"'), '{{quoted}}');
  assert.deepEqual(micromatch(['x/a.md', 'x/b.txt'], 'x/*.{md,txt}'), ['x/a.md', 'x/b.txt']);
});

test('deep braces, parentheses, mixed and unclosed patterns are rejected before stack exhaustion', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const braces = require('braces');
    const patterns = [
      '{'.repeat(4000) + 'x' + '}'.repeat(4000),
      '('.repeat(4000) + 'x' + ')'.repeat(4000),
      '{('.repeat(2000) + 'x' + ')}'.repeat(2000),
      '{'.repeat(4000) + 'x'
    ];
    for (const pattern of patterns) {
      for (const operation of [braces, braces.parse, braces.compile, braces.expand, braces.stringify]) {
        assert.throws(() => operation(pattern), e => e instanceof SyntaxError && /nesting depth/.test(e.message));
      }
    }
  `], { cwd: require('node:path').resolve(__dirname, '..'), timeout: 5000, encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('AST inputs cannot bypass the recursive walker guards', () => {
  const makeAst = () => {
    let node = { type: 'text', value: 'x' };
    for (let i = 0; i < 4000; i++) node = { type: 'root', nodes: [node] };
    return node;
  };
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(() => operation(makeAst()), e => e instanceof SyntaxError && /nesting depth/.test(e.message));
  }
});

test('Chokidar still watches ordinary brace glob paths', { timeout: 8000 }, async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'blog-braces-watch-'));
  // Polling keeps the regression test independent of native OS watcher support.
  const watcher = require('chokidar').watch(path.join(dir, '*.{md,txt}'), {
    ignoreInitial: true, usePolling: true, interval: 50
  });
  try {
    await new Promise((resolve, reject) => {
      watcher.once('ready', resolve);
      watcher.once('error', reject);
    });
    const added = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Watcher did not detect the Markdown file')), 4000);
      watcher.once('add', file => { clearTimeout(timer); resolve(file); });
    });
    const file = path.join(dir, 'post.md');
    await fs.writeFile(file, '# Security check\n');
    assert.equal(await added, file);
  } finally {
    await watcher.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
