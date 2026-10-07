import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeConfig, snapshotCurrent, appliedSnapshotMatches } from '../src/lib/runtimeConfig.ts';
import type { RuntimeConfigSnapshot } from '../src/lib/runtimeConfig.ts';
import type { Project } from '../../engine/src/types.ts';

const project: Project = { name: '运行中的配置', devices: [], groups: [], timelines: [], triggers: [] };
const reply = (rev = 2, instanceId = 'engine-a', file = '/project.json') => ({ project, rev, instanceId, file });
const status = (rev = 2, instanceId = 'engine-a', projectFile = '/project.json') => ({ daemon: { rev, instanceId, projectFile } });
const request = (queue: unknown[]) => async <T,>(_method: string): Promise<T> => queue.shift() as T;

test('运行配置来自引擎回读，版本与实例一致才标记核对，记录实际读取时间', async () => {
  const result = await readRuntimeConfig(request([reply(), status()]), () => 100);
  assert.equal(result.snapshot.project.name, '运行中的配置');
  assert.equal(result.snapshot.rev, 2); assert.equal(result.snapshot.readAt, 100);
  assert(snapshotCurrent(result.snapshot, status(), true));
  assert(!snapshotCurrent(result.snapshot, status(3), true));
  assert(!snapshotCurrent(result.snapshot, status(), false));
  assert(!snapshotCurrent(result.snapshot, status(2, 'engine-b'), true));
});

test('读取时其他客户端应用或切项目，重读匹配配置；持续变化明确失败而非冒充已核对', async () => {
  const result = await readRuntimeConfig(request([reply(), status(3), reply(3), status(3)]));
  assert.equal(result.snapshot.rev, 3);
  await assert.rejects(readRuntimeConfig(request([reply(), status(2, 'engine-b'), reply(), status(2, 'engine-b'), reply(), status(2, 'engine-b')])), /变化|核对/);
});

test('引擎回读失败直接报告失败，不能凭预览或旧缓存构造核对结果', async () => {
  await assert.rejects(readRuntimeConfig(async () => { throw new Error('连接断开'); }), /连接断开/);
  assert(!snapshotCurrent(null, status(), true));
  assert(!snapshotCurrent({ ...reply(), readAt: 100 }, status(2, 'engine-a', '/another.json'), true));
});

test('应用后核对配置内容，不把仅前端镜像或不同版本当成成功；JSON键顺序不影响比较', () => {
  const snapshot: RuntimeConfigSnapshot = { ...reply(), readAt: 100 };
  assert(appliedSnapshotMatches(snapshot, project, 2, 'engine-a'));
  assert(!appliedSnapshotMatches(snapshot, { ...project, name: '未应用草稿' }, 2, 'engine-a'));
  assert(!appliedSnapshotMatches(snapshot, project, 1, 'engine-a'));
  const reordered = { ...snapshot, project: { triggers: [], timelines: [], groups: [], devices: [], name: '运行中的配置' } };
  assert(appliedSnapshotMatches(reordered, project, 2, 'engine-a'));
});
