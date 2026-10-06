import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurationChanges } from '../../engine/src/configuration.ts';
import type { Project } from '../../engine/src/types.ts';

const empty: Project = { name: '项目', devices: [], groups: [], timelines: [], triggers: [] };
test('应用预览包含新增/删除/修改的对象，指令变化提示关联日程', () => {
  const before: Project = { ...empty, devices: [{ id: 'd', name: '灯', ip: '127.0.0.1' }], commands: [{ id: 'c', name: '开灯', targets: ['d'], format: 'ascii', payload: 'ON' }] };
  const after = structuredClone(before); after.devices[0]!.ip = '127.0.0.2'; after.commands![0]!.payload = 'OFF'; after.timelines.push({ id: 't', name: '工作日', cues: [] });
  const rows = configurationChanges(before, after);
  assert(rows.some((r) => r.includes('修改设备「灯」')));
  assert(rows.some((r) => r.includes('修改指令「开灯」')));
  assert(rows.some((r) => r.includes('新增模式「工作日」')));
  assert.deepEqual(configurationChanges(before, structuredClone(before)), []);
});
