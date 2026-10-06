import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCalendarText, parseCalendarText } from '../src/calendarText.ts';

test('解析：单日、区间、调休、注释、默认名称', () => {
  const r = parseCalendarText(`
    # 示例数据
    2026-10-01~2026-10-03 国庆节   // 行尾注释
    2026-10-05
    班 2026-09-27
    调休 2026-10-10
    work 2026-10-11
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.holidays, {
    '2026-10-01': '国庆节', '2026-10-02': '国庆节', '2026-10-03': '国庆节', '2026-10-05': '节假日',
  });
  assert.deepEqual(r.makeupWorkdays, ['2026-09-27', '2026-10-10', '2026-10-11']);
});

test('错误按行报告，其余行仍然生效', () => {
  const r = parseCalendarText(['2026-02-30 不存在', '乱写一通', '2026-10-07~2026-10-01 倒序', '2026-01-01~2026-12-31 太长', '2026-10-01 好的'].join('\n'));
  assert.deepEqual(r.errors.map((e) => e.line), [1, 2, 3, 4]);
  assert.match(r.errors[0]!.message, /日期不存在/);
  assert.match(r.errors[2]!.message, /早于/);
  assert.match(r.errors[3]!.message, /超过/);
  assert.deepEqual(r.holidays, { '2026-10-01': '好的' });
});

test('同一天不能既放假又调休上班（先到先得，后者报错）', () => {
  const a = parseCalendarText('2026-10-01 国庆\n班 2026-10-01');
  assert.equal(a.errors.length, 1);
  assert.deepEqual(a.makeupWorkdays, []);
  const b = parseCalendarText('班 2026-10-01\n2026-10-01 国庆');
  assert.equal(b.errors.length, 1);
  assert.deepEqual(b.holidays, {});
});

test('格式化：连续同名合并为区间；往返一致', () => {
  const cal = {
    holidays: { '2026-10-01': '国庆', '2026-10-02': '国庆', '2026-10-03': '国庆', '2026-10-04': '中秋', '2026-10-09': '国庆' },
    makeupWorkdays: ['2026-10-10', '2026-09-27'],
  };
  const text = formatCalendarText(cal);
  assert.equal(text, ['2026-10-01~2026-10-03 国庆', '2026-10-04 中秋', '2026-10-09 国庆', '班 2026-09-27', '班 2026-10-10'].join('\n'));
  const back = parseCalendarText(text);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.holidays, cal.holidays);
  assert.deepEqual(back.makeupWorkdays, ['2026-09-27', '2026-10-10']);
  assert.equal(formatCalendarText(undefined), '');
});
