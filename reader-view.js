// 큰 문서용 가상 읽기 화면. 전체 줄은 데이터로 보관하되 화면 근처의 DOM만 만든다.
// 줄바꿈에 따른 실제 높이는 표시된 줄에서 측정하고, 나머지는 보수적으로 추정한다.
export class VirtualReader {
  constructor(element) {
    this.root = element;
    this.lines = [''];
    this.starts = [0];
    this.heights = [24];
    this.offsets = [0, 24];
    this.totalLength = 0;
    this.nodes = new Map();
    this.matches = new Map();
    this.current = null;
    this.selected = null;
    this.from = -1;
    this.to = -1;
    this.frame = 0;
    this.rendering = false;
    this.top = document.createElement('div');
    this.bottom = document.createElement('div');
    this.top.className = this.bottom.className = 'reader-spacer';
    element.replaceChildren(this.top, this.bottom);
  }

  get lineHeight() {
    const cs = getComputedStyle(this.root);
    const px = parseFloat(cs.lineHeight);
    return Number.isFinite(px) ? px : 24;
  }

  get approximateWidth() {
    const style = getComputedStyle(this.root);
    const fs = parseFloat(style.fontSize) || 16;
    const usable = Math.max(100, (this.root.clientWidth || this.root.parentElement.clientWidth) - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0) - 12);
    return usable / fs;
  }

  estimate(line) {
    const base = this.lineHeight;
    if (!line || line.length < 35) return base;
    const width = this.approximateWidth;
    // CJK/전각은 1글자 너비, 영숫자는 평균 0.55글자 너비로 계산한다.
    const sample = line.length > 4000 ? line.slice(0, 4000) : line;
    let units = 0;
    for (let i = 0; i < sample.length; i++) {
      const code = sample.charCodeAt(i);
      units += code >= 0x2e80 || code >= 0x1100 && code <= 0x11ff ? 1 : code === 9 ? 2.2 : 0.56;
    }
    units *= line.length / sample.length;
    return Math.max(base, Math.ceil(units / Math.max(8, width - 1)) * base);
  }

  rebuildOffsets(from = 0) {
    if (from <= 0) {
      this.offsets = [0];
      from = 0;
    }
    for (let i = from; i < this.lines.length; i++) this.offsets[i + 1] = this.offsets[i] + this.heights[i];
    this.offsets.length = this.lines.length + 1;
  }

  reset(text = '') {
    this.lines = [''];
    this.starts = [0];
    this.heights = [this.lineHeight];
    this.offsets = [0, this.lineHeight];
    this.totalLength = 0;
    this.matches = new Map();
    this.current = null;
    this.selected = null;
    this.nodes.clear();
    this.from = this.to = -1;
    this.root.replaceChildren(this.top, this.bottom);
    this.root.scrollTop = 0;
    if (text) this.append(text);
    else this.schedule(true);
  }

  append(chunk) {
    if (!chunk) return;
    const pieces = chunk.split('\n');
    const i = this.lines.length - 1;
    this.lines[i] += pieces[0];
    this.heights[i] = this.estimate(this.lines[i]);
    let offset = this.totalLength + pieces[0].length;
    for (let j = 1; j < pieces.length; j++) {
      this.lines.push(pieces[j]);
      this.starts.push(offset + 1);
      this.heights.push(this.estimate(pieces[j]));
      offset += pieces[j].length + 1;
    }
    this.totalLength += chunk.length;
    this.rebuildOffsets(i);
    const visibleTail = this.nodes.get(i);
    if (visibleTail) this.fill(visibleTail, i);
    this.schedule();
  }

  resetMeasurements() {
    const scrollRatio = this.root.scrollHeight > this.root.clientHeight ? this.root.scrollTop / (this.root.scrollHeight - this.root.clientHeight) : 0;
    this.heights = this.lines.map((line) => this.estimate(line));
    this.rebuildOffsets();
    this.from = this.to = -1;
    this.schedule(true);
    requestAnimationFrame(() => {
      const max = this.root.scrollHeight - this.root.clientHeight;
      this.root.scrollTop = max > 0 ? scrollRatio * max : 0;
      this.schedule();
    });
  }

  lineAt(index) {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  atHeight(y) {
    let lo = 0, hi = this.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  firstVisibleLine() {
    return this.atHeight(Math.max(0, this.root.scrollTop));
  }

  getNode(i) {
    return this.nodes.get(i) || null;
  }

  setSelected(i) {
    const old = this.getNode(this.selected);
    if (old) old.classList.remove('sel');
    this.selected = i;
    const node = this.getNode(i);
    if (node) node.classList.add('sel');
  }

  setMatches(matches, current) {
    const grouped = new Map();
    for (const m of matches) {
      const i = this.lineAt(m.start);
      if (!grouped.has(i)) grouped.set(i, []);
      grouped.get(i).push(m);
    }
    this.matches = grouped;
    this.current = current;
    // 화면에 떠 있는 줄만 다시 그린다.
    for (const [i, node] of this.nodes) this.fill(node, i);
  }

  fill(node, i) {
    const line = this.lines[i] || '';
    const ms = this.matches.get(i);
    if (!ms || !ms.length) {
      node.textContent = line;
      return;
    }
    const frag = document.createDocumentFragment();
    const base = this.starts[i];
    let cursor = 0;
    for (const m of ms) {
      const s = Math.max(0, m.start - base);
      const e = Math.min(line.length, m.end - base);
      if (e <= s || s < cursor) continue;
      if (s > cursor) frag.appendChild(document.createTextNode(line.slice(cursor, s)));
      const mark = document.createElement('mark');
      if (this.current && this.current.start === m.start && this.current.end === m.end) mark.className = 'cur';
      mark.textContent = line.slice(s, e);
      frag.appendChild(mark);
      cursor = e;
    }
    if (cursor < line.length) frag.appendChild(document.createTextNode(line.slice(cursor)));
    node.replaceChildren(frag);
  }

  schedule(force = false) {
    if (force) this.from = this.to = -1;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render() {
    if (this.rendering || this.root.hidden || this.root.clientHeight === 0) return;
    this.rendering = true;
    try {
      const y = this.root.scrollTop;
      const top = Math.max(0, y - 650);
      const bottom = y + this.root.clientHeight + 900;
      let from = this.atHeight(top);
      let to = Math.min(this.lines.length, this.atHeight(bottom) + 2);
      if (to <= from) to = Math.min(this.lines.length, from + 1);
      if (from !== this.from || to !== this.to) {
        const frag = document.createDocumentFragment();
        const nodes = new Map();
        for (let i = from; i < to; i++) {
          let node = this.nodes.get(i);
          if (!node) {
            node = document.createElement('div');
            node.className = 'p';
            node.dataset.i = String(i);
            this.fill(node, i);
          }
          node.classList.toggle('sel', i === this.selected);
          nodes.set(i, node);
          frag.appendChild(node);
        }
        this.nodes = nodes;
        this.top.style.height = `${this.offsets[from]}px`;
        this.bottom.style.height = `${this.offsets[this.lines.length] - this.offsets[to]}px`;
        this.root.replaceChildren(this.top, frag, this.bottom);
        this.from = from;
        this.to = to;
      } else {
        // 진행 중인 첫 로딩에서 맨 마지막 줄이 자라는 경우도 화면을 갱신한다.
        this.bottom.style.height = `${this.offsets[this.lines.length] - this.offsets[to]}px`;
      }
      let firstChanged = -1;
      for (const [i, node] of this.nodes) {
        const h = node.getBoundingClientRect().height;
        if (h > 0 && Math.abs(h - this.heights[i]) > 1) {
          this.heights[i] = h;
          if (firstChanged < 0) firstChanged = i;
        }
      }
      if (firstChanged >= 0) {
        this.rebuildOffsets(firstChanged);
        this.top.style.height = `${this.offsets[from]}px`;
        this.bottom.style.height = `${Math.max(0, this.offsets[this.lines.length] - this.offsets[to])}px`;
        // 줄바꿈 높이를 보정한 뒤 필요한 경우에만 렌더링 범위를 다시 판단한다.
        this.schedule();
      }
    } finally {
      this.rendering = false;
    }
  }

  scrollToLine(i, fraction = 0.15) {
    i = Math.max(0, Math.min(this.lines.length - 1, i));
    const desired = Math.max(0, this.offsets[i] - this.root.clientHeight * fraction);
    this.root.scrollTop = desired;
    this.render();
    return this.getNode(i);
  }
}
