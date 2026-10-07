/** 在管道中完整写出自检报告后退出；stdout/stderr和成功/失败共用同一条路径。 */
export async function writeThenExit(line: string, code: number, stream: Pick<NodeJS.WritableStream, 'write'>, exit: (code: number) => void): Promise<void> {
  let result = code;
  try {
    await new Promise<void>((resolve, reject) => stream.write(line + '\n', (error) => error ? reject(error) : resolve()));
  } catch { result = 1; }
  exit(result);
}
