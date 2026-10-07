/** 备份包文件名：项目名 + 日期，去掉文件名里不能用的字符。 */
export function bundleFileName(projectName: string, now = new Date()): string {
  const safe = projectName.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'cueclock';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${safe}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.cueclock-bundle.json`;
}

/** 读用户选的备份包文件：必须是 JSON 对象，大小有上限（包里有日志，但不应该上百 MB）。 */
export function parseBundleText(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('文件不是有效的 JSON，可能不是备份包或已损坏'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('文件内容不是备份包');
  return value;
}
export const BUNDLE_MAX_BYTES = 50 * 1024 * 1024;
