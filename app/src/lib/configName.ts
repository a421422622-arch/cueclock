/** 配置文件的显示名：只取文件名，去掉 .cueclock.json / .json 后缀，不把 JSON 暴露给用户。 */
export function configName(file: string | null | undefined): string {
  if (!file) return '（未知）';
  const base = file.split(/[\\/]/).pop() || file;
  return base.replace(/\.cueclock\.json$/i, '').replace(/\.json$/i, '') || base;
}
