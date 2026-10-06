/** 有界草稿历史。只保存编辑内容，不保存引擎状态或日志。 */
export class EditHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  private limit: number;
  constructor(limit = 50) { this.limit = Math.max(1, limit); }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  record(before: T): void {
    this.past.push(structuredClone(before));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: T): T | null {
    if (!this.canUndo) return null;
    this.future.push(structuredClone(current));
    return this.past.pop()!;
  }
  redo(current: T): T | null {
    if (!this.canRedo) return null;
    this.past.push(structuredClone(current));
    return this.future.pop()!;
  }
  clear(): void { this.past = []; this.future = []; }
}
