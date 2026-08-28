import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planExport } from '../release/export-plan.mjs';

const ok = (path, mode) => ({ path, mode });
const rule = (source, target) => ({ source, target });

function invalid(entries, rules) {
  assert.throws(() => planExport(entries, rules), (e) => e instanceof Error && e.code === 'export_plan_invalid' && e.message === 'export plan invalid');
}

test('deterministic order, copy/mode, and unselected private file exclusion', () => {
  const entries = [
    ok('public/b.js', '100644'),
    ok('public/a.js', '100755'),
    ok('.env', '100644'),
    ok('.secret/file', '100644')
  ];
  const rules = [rule('public/b.js', 'dist/b.js'), rule('public/a.js', 'dist/a.js')];
  const res = planExport(entries, rules);
  assert.deepEqual(res, [
    { source: 'public/a.js', target: 'dist/a.js', mode: '100755'},
    { source: 'public/b.js', target: 'dist/b.js', mode: '100644'}
  ]);
});

test('no mutation including frozen inputs', () => {
  const entries = Object.freeze([Object.freeze(ok('a.txt', '100644'))]);
  const rules = Object.freeze([Object.freeze(rule('a.txt', 'b.txt'))]);
  const res = planExport(entries, rules);
  assert.deepEqual(res, [{ source: 'a.txt', target: 'b.txt', mode: '100644' }]);
  assert.notEqual(res, rules);
  assert.notEqual(res[0], rules[0]);
});

test('missing selected source is an error', () => {
  invalid([ok('a.txt', '100644')], [rule('b.txt', 'c.txt')]);
});

test('reject selected symlink/submodule but ignore unselected ones', () => {
  invalid([ok('a', '120000')], [rule('a', 'b')]);
  invalid([ok('a', '160000')], [rule('a', 'b')]);
  invalid([ok('a', '999')], [rule('a', 'b')]);
  const res = planExport([ok('a', '100644'), ok('b', '120000')], [rule('a', 'c')]);
  assert.equal(res.length, 1);
});

test('duplicate and case-insensitive entry paths fail', () => {
  invalid([ok('a', '100644'), ok('a', '100644')], [rule('a', 'b')]);
  invalid([ok('a', '100644'), ok('A', '100644')], [rule('a', 'b')]);
});

test('duplicate and case-insensitive rule sources fail', () => {
  invalid([ok('a', '100644')], [rule('a', 'b'), rule('a', 'c')]);
  invalid([ok('a', '100644')], [rule('a', 'b'), rule('A', 'c')]);
});

test('duplicate and case-insensitive rule targets fail', () => {
  invalid([ok('a', '100644'), ok('b', '100644')], [rule('a', 'c'), rule('b', 'c')]);
  invalid([ok('a', '100644'), ok('b', '100644')], [rule('a', 'c'), rule('b', 'C')]);
});

test('file versus directory prefix collisions fail', () => {
  invalid([ok('a', '100644'), ok('a/b', '100644')], [rule('a', 'x'), rule('a/b', 'x/y')]);
  invalid([ok('a', '100644'), ok('a/b', '100644')], [rule('a', 'x/y'), rule('a/b', 'x')]);
  invalid([ok('a', '100644'), ok('A/b', '100644')], [rule('a', 'x'), rule('A/b', 'x/y')]);
});

test('source-prefix and target-prefix collisions are independent', () => {
  invalid([ok('a', '100644'), ok('a/b', '100644')], [rule('a', 'x'), rule('a/b', 'y/z')]);
  invalid([ok('a', '100644'), ok('b', '100644')], [rule('a', 'x/y'), rule('b', 'x')]);
  const res1 = planExport([ok('a', '100644'), ok('ab/c', '100644')], [rule('a', 'x'), rule('ab/c', 'w/y')]);
  assert.equal(res1.length, 2);
  const res2 = planExport([ok('a', '100644'), ok('ab/c', '100644')], [rule('a', 'x/y'), rule('ab/c', 'xy/z')]);
  assert.equal(res2.length, 2);
});

test('case-mismatched selection fails without input leakage', () => {
  invalid([ok('a', '100644')], [rule('A', 'b')]);
  assert.throws(() => planExport([ok('source_marker', '100644')], [rule('SOURCE_MARKER', 'b')]), (e) =>
    e instanceof Error && e.code === 'export_plan_invalid' && !e.message.toLowerCase().includes('source_marker'));
});

test('canonical path rejection', () => {
  const e = [ok('a', '100644')];
  invalid(e, [rule('a', '/b')]);
  invalid(e, [rule('a', 'b/')]);
  invalid(e, [rule('a', 'b/../c')]);
  invalid(e, [rule('a', 'b/./c')]);
  invalid(e, [rule('a', 'b//c')]);
  invalid(e, [rule('a', 'b\\c')]);
  invalid(e, [rule('a', 'b:c')]);
  invalid(e, [rule('a', 'b%c')]);
  invalid(e, [rule('a', 'b c')]);
  invalid(e, [rule('a', 'b\\u0001c')]);
  invalid(e, [rule('a', 'b/c\\u00e9d')]);
  invalid(e, [rule('a', 'b\u0001c')]);
  invalid(e, [rule('a', 'b/c\u00e9d')]);
  invalid(e, [rule('a', '')]);
  invalid(e, [rule('a', 'a'.repeat(241))]);
});

test('hidden path rejection in rules and .gitignore exception', () => {
  const e = [ok('.gitignore', '100644'), ok('.env', '100644'), ok('a/.b', '100644'), ok('a', '100644')];
  invalid(e, [rule('.env', 'b')]);
  invalid(e, [rule('a/.b', 'c')]);
  invalid(e, [rule('.git', 'b')]);
  invalid(e, [rule('a/.git', 'b')]);
  invalid(e, [rule('a/.GIT', 'b')]);
  invalid(e, [rule('.gitignore', 'b/.gitignore')]);
  invalid(e, [rule('.gitignore', '.gitignore/child')]);
  invalid(e, [rule('a', '.gitignore/child')]);
  invalid(e, [rule('a', 'dir/.gitignore')]);
  const res = planExport(e, [rule('.gitignore', '.gitignore')]);
  assert.equal(res.length, 1);
});

test('malformed types and capacity bounds', () => {
  invalid();
  invalid([]);
  invalid([ok('a', '100644')]);
  invalid(null, [rule('a', 'b')]);
  invalid([ok('a', '100644')], []);
  invalid([null], [rule('a', 'b')]);
  invalid([{}], [rule('a', 'b')]);
  invalid([{ path: 1, mode: '100644' }], [rule('a', 'b')]);
  invalid([{ path: 'a', mode: 1 }], [rule('a', 'b')]);
  invalid([ok('a', '100644')], [null]);
  invalid([ok('a', '100644')], [{}]);
  invalid([ok('a', '100644')], [{ source: 1, target: 'b' }]);
  invalid([ok('a', '100644')], [{ source: 'a', target: 1 }]);
  invalid(new Array(4097).fill(0).map(() => ok('a', '100644')), [rule('a', 'b')]);
  invalid([ok('a', '100644')], new Array(4097).fill(0).map(() => rule('a', 'b')));
});
