import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProject } from '../src/validate.ts';
import { project } from './helpers.ts';

test('复制出来的禁用模式不参与互斥优先级冲突警告，启用后会提示', () => {
  const p = project([
    { id: 'a', name: '工作日', groupId: 'G', priority: 10, cues: [] },
    { id: 'b', name: '工作日副本', groupId: 'G', priority: 10, enabled: false, cues: [] },
  ]);
  assert.equal(validateProject(p).filter((i) => /优先级相同/.test(i.message)).length, 0);
  p.timelines[1]!.enabled = true;
  assert.equal(validateProject(p).filter((i) => /优先级相同/.test(i.message)).length, 1);
});
