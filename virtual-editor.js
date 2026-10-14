// iPad/Safari용 대용량 편집기. 전체 데이터는 바깥의 단일 문자열에 두고,
// 네이티브 textarea에는 눈에 보이는 위치 근처의 몇 백 줄만 삽입한다.
// 화면 밖은 높이만 가진 spacer로 유지하므로 수백만 자를 textarea에 전달하지 않는다.
export class VirtualEditor {
  constructor(root, textarea, reader, getText, onChange) {
    this.host = root;
    this.input = textarea;
    this.reader = reader;
    this.getText = getText;
    this.onChange = onChange;
    this.home = textarea.parentNode;
    this.next = textarea.nextSibling;
    this.top = document.createElement('div');
    this.bottom = document.createElement('div');
    this.top.className = this.bottom.className = 'virtual-edit-spacer';
    this.active = false;
    this.allSelected = false;
    this.startPos = this.endPos = 0;
    this.startLine = this.endLine = 0;
    this.windowText = '';
    this.renderQueued = false;
    root.append(this.top, this.bottom);
    root.addEventListener('scroll', () => {
      if (!this.active || this.renderQueued || this.composing) return;
      this.renderQueued = true;
      requestAnimationFrame(() => {
        this.renderQueued = false;
        if (this.active && !this.composing) this.rewindow();
      });
    }, { passive: true });
  }

  get scrollTop() { return this.host.scrollTop; }
  set scrollTop(v) { this.host.scrollTop = v; }
  get clientHeight() { return this.host.clientHeight; }
  get scrollHeight() { return this.host.scrollHeight; }

  activate(position = 0, targetTop = null) {
    if (this.active) return;
    this.active = true;
    this.host.hidden = false;
    this.host.insertBefore(this.input, this.bottom);
    this.host.classList.add('active');
    const indexY = this.reader.offsets[this.reader.lineAt(position)] || 0;
    this.host.scrollTop = targetTop === null ? indexY : targetTop;
    this.draw(this.host.scrollTop, position);
    this.host.scrollTop = targetTop === null ? indexY : targetTop;
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.allSelected = false;
    if (document.activeElement === this.input) this.input.blur();
    // 반드시 호스트를 숨기기 전에 원래 위치로 되돌린다.
    this.home.insertBefore(this.input, this.next);
    this.input.value = '';
    this.windowText = '';
    this.host.hidden = true;
    this.host.classList.remove('active');
  }

  draw(y, preferredPosition = null) {
    if (!this.active) return;
    const n = this.reader.lines.length;
    const base = preferredPosition === null
      ? this.reader.atHeight(Math.max(0, y - 24))
      : this.reader.lineAt(preferredPosition);
    // textarea 길이를 1만 자 안팎으로 제한. 한국어 조합/키보드 지연 최소화.
    let first = Math.max(0, base - 95);
    let last = Math.min(n, Math.max(base + 125, first + 220));
    while (last > base + 1 && this.reader.starts[Math.min(last, n - 1)] - this.reader.starts[first] > 14500) last -= 8;
    while (first < base && this.reader.starts[Math.min(last, n - 1)] - this.reader.starts[first] > 14500) first += 8;
    this.startLine = first;
    this.endLine = last;
    this.startPos = this.reader.starts[first] || 0;
    this.endPos = last === n ? this.getText().length : this.reader.starts[last];
    this.windowText = this.getText().slice(this.startPos, this.endPos);
    this.input.value = this.windowText;
    this.measure();
  }

  measure() {
    if (!this.active) return;
    const full = this.reader.offsets[this.reader.lines.length];
    const startY = this.reader.offsets[this.startLine] || 0;
    const endY = this.reader.offsets[this.endLine] || full;
    this.top.style.height = `${Math.max(0, startY + 24)}px`;
    this.bottom.style.height = `${Math.max(0, full - endY + 25)}px`;
    // scrollHeight는 실측치. 편집된 줄바꿈과 폰트 크기를 그대로 반영한다.
    this.input.style.height = '1px';
    this.input.style.height = `${Math.max(28, this.input.scrollHeight)}px`;
  }

  rewindow(force = false) {
    if (!this.active || this.composing) return;
    const y = this.host.scrollTop;
    const h = this.host.clientHeight || 600;
    const startY = this.top.offsetHeight;
    const endY = startY + this.input.offsetHeight;
    if (!force && y >= startY + h * 0.45 && y + h <= endY - h * 0.45) return;
    const previouslyFocused = document.activeElement === this.input;
    const selectionStart = this.startPos + this.input.selectionStart;
    const selectionEnd = this.startPos + this.input.selectionEnd;
    // 재렌더링 중에도 선택 범위를 유지해야 검색 결과를 교체할 수 있다.
    this.draw(y);
    this.host.scrollTop = y;
    if (selectionStart >= this.startPos && selectionEnd <= this.endPos) {
      this.input.setSelectionRange(selectionStart - this.startPos, selectionEnd - this.startPos);
    } else if (previouslyFocused) {
      this.input.blur();
    }
  }

  selectAll() {
    if (!this.active) return;
    this.allSelected = true;
    this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(0, this.input.value.length);
  }

  // textarea의 짧은 구간 편집값을 전체 원본의 동일 부분에 반영한다.
  commit() {
    if (!this.active) return null;
    if (this.allSelected) {
      // ⌘A/CTRL+A 뒤 입력하면 화면 조각이 아니라 문서 전체를 교체한다.
      const before = this.getText();
      const after = this.input.value;
      const cursor = this.input.selectionStart;
      this.allSelected = false;
      if (before === after) return null;
      this.onChange(after);
      this.reader.reset(after);
      this.draw(0, cursor);
      this.locate(Math.min(cursor, after.length));
      return { before, after, start: 0, removed: before, inserted: after };
    }
    const after = this.input.value;
    const before = this.windowText;
    if (before === after) return null;
    const min = Math.min(before.length, after.length);
    let i = 0;
    while (i < min && before.charCodeAt(i) === after.charCodeAt(i)) i++;
    let j = before.length, k = after.length;
    while (j > i && k > i && before.charCodeAt(j - 1) === after.charCodeAt(k - 1)) { j--; k--; }
    const start = this.startPos + i;
    const end = this.startPos + j;
    const removed = before.slice(i, j);
    const inserted = after.slice(i, k);
    const fullBefore = this.getText();
    const fullAfter = fullBefore.slice(0, start) + inserted + fullBefore.slice(end);
    const delta = inserted.length - removed.length;
    this.endPos += delta;
    this.windowText = after;
    this.onChange(fullAfter);
    this.reader.applyEdit(start, end, inserted);
    this.endLine = this.endPos === fullAfter.length ? this.reader.lines.length : this.reader.lineAt(this.endPos);
    this.startLine = this.reader.lineAt(this.startPos);
    if (after.length > 18000) {
      // 붙여넣기가 커도 다음 프레임에서 네이티브 입력창이 다시 거대해지지 않게 한다.
      const caret = Math.min(fullAfter.length, this.startPos + this.input.selectionStart);
      const y = this.reader.offsets[this.reader.lineAt(caret)] || 0;
      this.draw(y, caret);
      this.locate(caret);
    } else this.measure();
    return { before: fullBefore, after: fullAfter, start, removed, inserted };
  }

  locate(start, end = start, focus = false) {
    if (!this.active) return;
    this.allSelected = false;
    start = Math.max(0, Math.min(this.getText().length, start));
    end = Math.max(start, Math.min(this.getText().length, end));
    const outside = start < this.startPos || end > this.endPos;
    if (outside) {
      const line = this.reader.lineAt(start);
      const y = this.reader.offsets[line];
      this.draw(y, start);
    }
    this.input.setSelectionRange(Math.max(0, start - this.startPos), Math.min(this.windowText.length, end - this.startPos));
    if (outside) {
      const line = this.reader.lineAt(start);
      this.host.scrollTop = Math.max(0, this.reader.offsets[line] - this.clientHeight * 0.24 + 24);
      this.rewindow();
    }
    if (focus) this.input.focus({ preventScroll: true });
  }

  replaceDocument(position = 0) {
    if (!this.active) return;
    const line = this.reader.lineAt(position);
    const y = this.reader.offsets[line] || 0;
    this.draw(y, position);
    this.host.scrollTop = Math.max(0, y - this.clientHeight * 0.3);
    this.locate(position);
  }
}
