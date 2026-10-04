// 실행 취소 / 다시 실행 기록.
// textarea 기본 실행 취소는 코드로 글자를 바꾸면(바꾸기·모두 바꾸기) 기록이 끊어져서, 직접 관리한다.
// 전체 글을 통째로 저장하지 않고 "어디서 무엇이 무엇으로 바뀌었는지"만 저장해 큰 파일에서도 가볍다.

/** 두 문자열의 바뀐 부분: {start, removed, inserted} (같으면 null) */
export function diff(before, after) {
  if (before === after) return null;
  const minLen = Math.min(before.length, after.length);
  let start = 0;
  while (start < minLen && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
    endB--;
    endA--;
  }
  return { start, removed: before.slice(start, endB), inserted: after.slice(start, endA) };
}

export class UndoHistory {
  constructor(limit = 1000) {
    this.limit = limit;
    this.clear();
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.lastTime = 0;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  /**
   * 글자 변경을 기록한다.
   * merge=true 이면 바로 앞 기록과 이어진 타이핑일 때 한 번에 되돌릴 수 있게 합친다.
   */
  record(before, after, selBefore, selAfter, { merge = false, now = Date.now() } = {}) {
    const d = diff(before, after);
    if (!d) return;
    const entry = { ...d, selBefore, selAfter };
    const prev = this.undoStack[this.undoStack.length - 1];
    const canMerge =
      merge &&
      prev &&
      prev.mergeable &&
      now - this.lastTime < 1200 &&
      !d.removed &&
      !prev.removed &&
      d.inserted.indexOf('\n') === -1 &&
      prev.inserted.indexOf('\n') === -1 &&
      prev.start + prev.inserted.length === d.start &&
      !/\s$/.test(prev.inserted);
    if (canMerge) {
      prev.inserted += d.inserted;
      prev.selAfter = selAfter;
    } else {
      entry.mergeable = merge;
      this.undoStack.push(entry);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastTime = now;
  }

  /** 되돌린 결과 {text, selection} 또는 null */
  undo(current) {
    const e = this.undoStack.pop();
    if (!e) return null;
    const text = current.slice(0, e.start) + e.removed + current.slice(e.start + e.inserted.length);
    this.redoStack.push(e);
    this.lastTime = 0;
    return { text, selection: e.selBefore || { start: e.start, end: e.start + e.removed.length } };
  }

  redo(current) {
    const e = this.redoStack.pop();
    if (!e) return null;
    const text = current.slice(0, e.start) + e.inserted + current.slice(e.start + e.removed.length);
    this.undoStack.push(e);
    this.lastTime = 0;
    return { text, selection: e.selAfter || { start: e.start + e.inserted.length, end: e.start + e.inserted.length } };
  }
}
