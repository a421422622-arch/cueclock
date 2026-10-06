import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeKind, duplicateTile, groupNames, moveTile, newTile, padColumns, textOn } from '../src/lib/pad.ts';
import type { Pad, PadTile } from '../../engine/src/types.ts';

const t = (id: string, extra: Partial<PadTile> = {}): PadTile => ({ id, label: id, kind: 'button', actions: [], ...extra });

test('列数：默认 4，限制在 1~8', () => {
  assert.deepEqual([{}, { columns: 2 }, { columns: 0 }, { columns: 99 }, { columns: 3.6 }].map((x) => padColumns({ id: 'p', name: 'p', tiles: [], ...x } as Pad)), [4, 2, 1, 8, 4]);
});

test('新按钮：名字按同类数量编号，颜色轮换，开关带 offActions', () => {
  const a = newTile('button', [], 'x');
  assert.deepEqual([a.label, a.kind, a.offActions], ['按钮 1', 'button', undefined]);
  const b = newTile('toggle', [a], 'y');
  assert.deepEqual([b.label, b.offActions], ['开关 1', []]);
  assert.notEqual(a.color, b.color);
});

test('移动：左右移动、越界停在两端、不修改入参', () => {
  const tiles = [t('a'), t('b'), t('c')];
  assert.deepEqual(moveTile(tiles, 'a', 1).map((x) => x.id), ['b', 'a', 'c']);
  assert.deepEqual(moveTile(tiles, 'c', -1).map((x) => x.id), ['a', 'c', 'b']);
  assert.deepEqual(moveTile(tiles, 'a', -1).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(moveTile(tiles, 'c', 5).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(moveTile(tiles, 'zzz', 1), tiles);
  assert.deepEqual(tiles.map((x) => x.id), ['a', 'b', 'c']);
});

test('切换类型：开关→按钮丢掉 offActions；按钮→开关去掉单选组并补 offActions', () => {
  const toggle = t('x', { kind: 'toggle', offActions: [{ id: 'o', type: 'delay', ms: 1 }] });
  assert.equal('offActions' in changeKind(toggle, 'button'), false);
  const btn = t('y', { group: 'g' });
  const asToggle = changeKind(btn, 'toggle');
  assert.deepEqual([asToggle.kind, asToggle.offActions, 'group' in asToggle], ['toggle', [], false]);
  assert.equal(changeKind(btn, 'button'), btn);
  assert.equal(changeKind({ ...btn, group: 'g' }, 'button').group, 'g');
});

test('复制：新 id、动作 id 全部重新生成、名字加副本；原件不变', () => {
  let n = 0;
  const src = t('a', { kind: 'toggle', actions: [{ id: 'a1', type: 'delay', ms: 1 }], offActions: [{ id: 'o1', type: 'delay', ms: 2 }] });
  const c = duplicateTile(src, 'b', () => `n${++n}`);
  assert.deepEqual([c.id, c.label, c.actions[0]!.id, c.offActions![0]!.id], ['b', 'a 副本', 'n1', 'n2']);
  assert.deepEqual([src.id, src.label, src.actions[0]!.id], ['a', 'a', 'a1']);
});

test('单选组名建议、按钮字色', () => {
  assert.deepEqual(groupNames({ id: 'p', name: 'p', tiles: [t('a', { group: 'm' }), t('b', { group: 'm' }), t('c', { group: 'n' }), t('d')] }), ['m', 'n']);
  assert.equal(textOn('#ffb84d'), '#0a0a0c');
  assert.equal(textOn('#0a84ff'), '#f5f5f7');
  assert.equal(textOn(undefined), '#f5f5f7');
  assert.equal(textOn('red'), '#f5f5f7');
});
