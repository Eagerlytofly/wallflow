/* 流光壁纸 · dashboard */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  data: null,
  photos: [],
  photoTotal: 0,
  photoOffset: 0,
  pageSize: 60,
  filter: 'selected',
  category: '',
  q: '',
  tab: 'gallery',
  renders: [],
  activeIndex: null,
  styleDrafts: {},
  customDrafts: {},
  libraryDirty: true,
  queueDirty: true,
  settingsBuilt: false,
  heroLayer: 0,
  heroUrl: '',
  esOpen: false,
  busy: new Set(),
};

const CATS = { person: '人物', animal: '动物', landscape: '风景', urban: '城市', other: '其他' };

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmtMoney = (cents) => `¥${((cents ?? 0) / 100).toFixed(2)}`;
const fmtInt = (n) => (n ?? 0).toLocaleString('zh-CN');

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return '刚刚';
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟前`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时前`;
  return `${Math.floor(ms / 86400000)} 天前`;
}

function fmtDur(ms) {
  if (!ms || ms < 0) return '0s';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

function fmtInterval(seconds) {
  const s = Number(seconds);
  if (s === 0) return '手动';
  if (!Number.isFinite(s) || s <= 0) return '30 分钟';
  if (s < 60) return `${Math.round(s)} 秒`;
  if (s < 3600) {
    const m = s / 60;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} 分钟`;
  }
  return `${(s / 3600).toFixed(1)} 小时`;
}

function lockModeLabel(mode) {
  if (mode === 'off') return '仅桌面';
  if (mode === 'each') return '桌面 + 锁屏';
  return '桌面 + 锁屏 + 屏保';
}

function fmtCountdown(ms) {
  if (ms == null) return '--:--';
  if (ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `HTTP ${res.status}`);
    err.hint = json?.error?.hint;
    throw err;
  }
  return json;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

async function act(fn, label) {
  try {
    await fn();
  } catch (err) {
    toast(`${label}：${err.message}${err.hint ? ` · ${err.hint}` : ''}`, 'err');
  }
}

function setBusy(key, busy) {
  if (busy) state.busy.add(key);
  else state.busy.delete(key);
  $$(`[data-busy="${key}"]`).forEach((el) => {
    el.disabled = busy;
  });
}

/* ---------------- boot / events ---------------- */

async function refreshState() {
  const data = await api('/api/state');
  state.data = data;
  renderStatus();
  renderHero();
  renderStats();
  renderTabs();
  if (state.tab === 'queue') renderQueueContent();
  if (state.tab === 'gallery' && state.libraryDirty) {
    state.libraryDirty = false;
  }
  if (state.scanning !== data.scan.scanning) {
    state.scanning = data.scan.scanning;
    if (!data.scan.scanning && state.tab === 'gallery') loadPhotos(true);
  }
  if (data.scan.scanning) {
    $('#scanline').hidden = false;
  } else {
    $('#scanline').hidden = true;
  }
}

function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    try {
      await refreshState();
    } catch {
      // ignore transient errors
    }
  }, 220);
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => {
    state.esOpen = true;
  });
  es.addEventListener('invalidate', (event) => {
    let data = {};
    try {
      data = JSON.parse(event.data);
    } catch {
      data = {};
    }
    if (data.type === 'render' || data.type === 'scan-done' || data.type === 'styles' || data.type === 'settings') {
      state.libraryDirty = true;
      state.queueDirty = true;
    }
    if (data.type === 'render') {
      state.queueDirty = true;
      if (state.tab === 'gallery') loadPhotos(true).catch(() => {});
      if (state.tab === 'queue') loadRenders().catch(() => {});
      const render = data.key && state.data?.current?.key === data.key;
      if (render) refreshState().catch(() => {});
    }
    scheduleRefresh();
  });
  es.addEventListener('log', (event) => {
    try {
      appendLog(JSON.parse(event.data));
    } catch {
      // ignore
    }
  });
  es.onerror = () => {
    state.esOpen = false;
  };
  es.onopen = () => {
    state.esOpen = true;
  };
}

setInterval(() => {
  if (!state.esOpen) scheduleRefresh();
}, 6000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh();
});

/* ---------------- status / hero ---------------- */

function renderStatus() {
  const d = state.data;
  if (!d) return;
  const pills = [];
  if (d.scan.scanning) {
    const total = d.scan.total || 0;
    const done = d.scan.done || 0;
    pills.push(`<span class="pill on important"><i class="dot"></i>扫描中 <b>${done}/${total || '…'}</b></span>`);
  }
  if (!d.ark.hasKey) {
    pills.push(`<span class="pill err important"><i class="dot"></i>未配置 API Key</span>`);
  }
  const p = d.pipeline;
  if (p.running) {
    pills.push(`<span class="pill on important"><i class="dot"></i>生成中 <b>${p.active.length}</b> · 排队 ${p.queued}</span>`);
  }
  if (d.rotation.intervalSeconds === 0) {
    pills.push('<span class="pill"><i class="dot"></i>手动切换 · 不自动轮播</span>');
  } else {
    pills.push(`<span class="pill ${d.rotation.enabled ? 'on' : ''}"><i class="dot"></i>${d.rotation.enabled ? '轮播中' : '轮播暂停'} · ${fmtInterval(d.rotation.intervalSeconds)}一张</span>`);
  }
  pills.push(`<span class="pill"><i class="dot"></i>成片 <b>${d.summary.ready}</b></span>`);
  pills.push(`<span class="pill"><i class="dot"></i>今日 ${fmtMoney(d.summary.dayCostCents)}</span>`);
  $('#statusPills').innerHTML = pills.join('');

  const scanBtn = $('[data-action="scan"]');
  if (scanBtn) scanBtn.disabled = Boolean(d.scan.scanning);

  const pipelineBtn = $('#pipelineBtn');
  if (pipelineBtn) {
    pipelineBtn.innerHTML = p.running
      ? `<svg><use href="#i-pause"/></svg><span>暂停生成</span>`
      : `<svg><use href="#i-play"/></svg><span>开始生成</span>`;
  }
  const rotationBtn = $('#rotationBtn');
  if (rotationBtn) {
    if (d.rotation.intervalSeconds === 0) {
      rotationBtn.innerHTML = `<svg><use href="#i-play"/></svg><span>开启轮播</span>`;
      rotationBtn.disabled = false;
      rotationBtn.title = '开启 30 秒自动轮播';
    } else {
      rotationBtn.innerHTML = d.rotation.enabled
        ? `<svg><use href="#i-pause"/></svg><span>暂停轮播</span>`
        : `<svg><use href="#i-play"/></svg><span>继续轮播</span>`;
      rotationBtn.disabled = false;
    }
  }
  const rl = $('#rotationState');
  if (rl) rl.textContent = d.rotation.intervalSeconds === 0 ? '手动切换' : d.rotation.enabled ? '轮播中' : '已暂停';
  const il = $('#intervalLabel');
  if (il) il.textContent = d.rotation.intervalSeconds === 0 ? '手动切换' : `每 ${fmtInterval(d.rotation.intervalSeconds)}`;
}

function setHeroImage(url) {
  if (!url || url === state.heroUrl) return;
  state.heroUrl = url;
  const a = $('#heroImgA');
  const b = $('#heroImgB');
  const next = state.heroLayer === 0 ? a : b;
  const prev = state.heroLayer === 0 ? b : a;
  next.onload = () => {
    next.classList.add('show');
    prev.classList.remove('show');
  };
  next.src = url;
  if (next.complete) next.onload?.();
  state.heroLayer = state.heroLayer === 0 ? 1 : 0;
}

function renderHero() {
  const d = state.data;
  if (!d) return;
  const current = d.current;
  const empty = !current;
  $('#heroEmpty').hidden = !empty;
  $('.hero-copy').style.visibility = empty ? 'hidden' : 'visible';
  $('#hero').classList.toggle('is-empty', empty);
  if (empty) renderHeroEmpty();

  if (!empty) {
    const url = current.render
      ? `/media/render/${encodeURIComponent(current.key)}.jpg`
      : current.photo
        ? `/media/preview/${current.photo.id}.jpg`
        : '';
    setHeroImage(url);
    const style = d.styles.find((s) => s.id === current.styleId);
    const cat = CATS[current.photo?.category] || '';
    $('#heroTitle').textContent = current.title || '此刻';
    $('#heroSub').textContent = [style?.name, cat, current.appliedAt ? `${fmtAgo(current.appliedAt)}切换` : ''].filter(Boolean).join(' · ');
    const chips = [];
    if (style) chips.push(`<span class="chip accent">${style.emoji} ${esc(style.name)}</span>`);
    if (cat) chips.push(`<span class="chip">${cat}</span>`);
    chips.push(`<span class="chip">${lockModeLabel(d.config.wallpaper.lockScreenMode)}</span>`);
    if (current.photo) chips.push(`<span class="chip">${esc(current.photo.name)}</span>`);
    $('#heroChips').innerHTML = chips.join('');
  } else {
    $('#heroChips').innerHTML = '';
    $('#heroTitle').textContent = '此刻';
    $('#heroSub').textContent = '还没有正在播放的壁纸';
  }

  const next = d.rotation.nextUp;
  const nextThumb = $('#nextThumb');
  if (next) {
    nextThumb.style.backgroundImage = `url("/media/render-thumb/${encodeURIComponent(next.key)}.jpg")`;
    nextThumb.innerHTML = '<span></span>';
    $('#nextStyle').textContent = (d.styles.find((s) => s.id === next.styleId)?.name) || 'NEXT';
  } else {
    nextThumb.style.backgroundImage = '';
    nextThumb.innerHTML = `<span>${d.summary.ready ? '等待下一轮' : '等待第一张成片'}</span>`;
    $('#nextStyle').textContent = 'NEXT';
  }

  const p = d.pipeline;
  const queueLine = $('#queueLine');
  if (p.running) {
    queueLine.textContent = `${p.active.length} 张生成中 · ${p.queued} 张排队 · ${p.effectiveModel.split('-').slice(0, 2).join('-')}`;
  } else if (d.summary.pending > 0) {
    queueLine.textContent = `还有 ${d.summary.pending} 张待生成 · 点右侧「开始生成」`;
  } else {
    queueLine.textContent = '生成队列空闲';
  }
  $('#rotationBtn').disabled = !d.summary.ready && !d.rotation.enabled;
}

function renderHeroEmpty() {
  const d = state.data;
  const empty = $('#heroEmpty');
  const hasPhotos = d.summary.photos > 0;
  const hasRenders = d.summary.ready > 0;
  const generating = d.pipeline.running;
  const mode = !hasPhotos ? 'scan' : generating ? 'generating' : hasRenders ? 'paused' : 'generate';
  const key = `${mode}:${d.summary.photos}:${d.summary.ready}:${d.pipeline.queued}`;
  if (empty.dataset.key === key) return;
  empty.dataset.key = key;

  const views = {
    scan: `
      <div class="orb"></div>
      <p class="eyebrow">YOUR PHOTOS, REIMAGINED</p>
      <h2>让你的照片<br/>成为此刻的风景</h2>
      <p class="muted">本地选片 · 火山方舟风格化 · 桌面与锁屏轮播</p>
      <button class="btn primary" data-action="scan"><svg><use href="#i-scan"/></svg><span>开始扫描照片</span></button>
      <div class="hero-steps"><span><b>01</b> 本地 Vision 选片</span><span><b>02</b> Seedream 风格化</span><span><b>03</b> 边播边生成</span></div>`,
    generate: `
      <div class="orb"></div>
      <p class="eyebrow">CURATED · ${d.summary.selected} PHOTOS</p>
      <h2>照片已经选好<br/>等一阵风把它们吹成画</h2>
      <p class="muted">${d.summary.selected} 张入选 · 每张约 ${state.data.config.ark.priceCents / 100} 元 · 生成期间可以正常使用电脑</p>
      <button class="btn primary" data-action="pipeline-toggle"><svg><use href="#i-spark"/></svg><span>开始生成第一张</span></button>
      <div class="hero-steps"><span><b>01</b> 智能裁切到 16:9</span><span><b>02</b> 模型重绘</span><span><b>03</b> 自动轮播</span></div>`,
    generating: `
      <div class="orb"></div>
      <p class="eyebrow">RENDERING · ${d.pipeline.active.length} IN FLIGHT</p>
      <h2>第一张壁纸<br/>正在生成中</h2>
      <p class="muted">已排队 ${d.pipeline.queued} 张 · 完成一张就会立刻加入轮播，不用等全部结束</p>
      <button class="btn ghost" data-action="rotation-toggle"><svg><use href="#${d.rotation.enabled ? 'i-pause' : 'i-play'}"/></svg><span>${d.rotation.enabled ? '暂停轮播' : '继续轮播'}</span></button>
      <div class="hero-steps"><span><b>队列</b> ${d.pipeline.queued} 张</span><span><b>并发</b> ${d.pipeline.concurrency}</span><span><b>模型</b> ${d.pipeline.effectiveModel.replace('doubao-', '')}</span></div>`,
    paused: `
      <div class="orb"></div>
      <p class="eyebrow">${d.rotation.enabled ? 'READY TO SHUFFLE' : 'ROTATION PAUSED'}</p>
      <h2>${d.summary.ready} 张成片<br/>正在等你</h2>
      <p class="muted">${d.rotation.intervalSeconds === 0 ? '自动轮播已关闭，点「下一张」手动切换。' : d.rotation.enabled ? '轮播已就绪，点一下立刻把它们放上桌面和锁屏。' : `轮播已暂停。继续后每 ${fmtInterval(d.rotation.intervalSeconds)}换一张。`}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${d.rotation.enabled
          ? `<button class="btn primary" data-action="next"><svg><use href="#i-shuffle"/></svg><span>下一张</span></button>`
          : `<button class="btn primary" data-action="rotation-toggle"><svg><use href="#i-play"/></svg><span>继续轮播</span></button>`}
        <button class="btn ghost" data-action="scan"><svg><use href="#i-scan"/></svg><span>重新扫描</span></button>
      </div>
      <div class="hero-steps"><span><b>桌面</b> 已接管</span><span><b>锁屏</b> ${lockModeLabel(state.data.config.wallpaper.lockScreenMode)}</span></div>`,
  };
  empty.innerHTML = views[mode];
}

function renderStats() {
  const d = state.data;
  if (!d) return;
  const s = d.summary;
  const dist = ['person', 'animal', 'landscape', 'urban']
    .map((c) => [CATS[c], s.byCategory?.[c] ?? 0])
    .filter(([, n]) => n)
    .map(([label, n]) => `${label} ${n}`)
    .join(' · ');
  $('#stats').innerHTML = `
    <div class="stat"><div class="k">Photo Library</div><div class="v">${fmtInt(s.photos)}<small>张</small></div><div class="sub">已分析 ${fmtInt(s.analyzed)} 张</div></div>
    <div class="stat"><div class="k">Curated</div><div class="v">${fmtInt(s.selected)}<small>张</small></div><div class="sub">${dist || '等待扫描'}</div></div>
    <div class="stat"><div class="k">Ready Wallpapers</div><div class="v">${fmtInt(s.ready)}<small>张</small></div><div class="sub">${d.pipeline.running ? `${d.pipeline.active.length} 张正在生成` : '生成队列空闲'}</div></div>
    <div class="stat"><div class="k">Today</div><div class="v">${fmtMoney(s.dayCostCents)}</div><div class="sub">今日 ${s.dayCount} 张 · 累计 ${fmtMoney(s.costCents)}</div></div>
  `;
}

function renderTabs() {
  const d = state.data;
  if (!d) return;
  $('#tabGalleryCount').textContent = d.summary.selected;
  $('#tabQueueCount').textContent = d.pipeline.queued + d.pipeline.active.length;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
}

/* ---------------- gallery ---------------- */

function galleryShell() {
  const view = $('#view');
  view.innerHTML = `
    <div class="toolbar">
      <div class="seg" id="filterSeg">
        ${[['selected', '已选中'], ['all', '全部照片'], ['styled', '已成片'], ['rejected', '未选中']]
          .map(([id, label]) => `<button data-filter="${id}" class="${state.filter === id ? 'active' : ''}">${label}</button>`)
          .join('')}
      </div>
      <div class="seg" id="catSeg">
        ${[['', '全部'], ['person', '人物'], ['animal', '动物'], ['landscape', '风景'], ['urban', '城市']]
          .map(([id, label]) => `<button data-category="${id}" class="${state.category === id ? 'active' : ''}">${label}</button>`)
          .join('')}
      </div>
      <div class="spacer"></div>
      <div class="search"><input id="gallerySearch" placeholder="搜索文件名或标签…" value="${esc(state.q)}" /></div>
    </div>
    <div class="gallery-grid" id="galleryGrid"></div>
    <div class="load-more" id="loadMore"></div>
  `;
  $('#filterSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    $$('#filterSeg button').forEach((b) => b.classList.toggle('active', b === btn));
    loadPhotos(true);
  });
  $('#catSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-category]');
    if (!btn) return;
    state.category = btn.dataset.category;
    $$('#catSeg button').forEach((b) => b.classList.toggle('active', b === btn));
    loadPhotos(true);
  });
  let timer = null;
  $('#gallerySearch').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = e.target.value.trim();
      loadPhotos(true);
    }, 280);
  });
}

async function loadPhotos(reset = true) {
  if (reset) {
    state.photoOffset = 0;
    state.photos = [];
  }
  const params = new URLSearchParams({
    limit: String(state.pageSize),
    offset: String(state.photoOffset),
    filter: state.filter,
    category: state.category,
    q: state.q,
  });
  const res = await api(`/api/photos?${params}`);
  state.photoTotal = res.total;
  state.photos = reset ? res.items : state.photos.concat(res.items);
  state.photoOffset = state.photos.length;
  renderGalleryGrid();
}

function photoCard(photo, index) {
  const img = photo.render?.thumb || photo.thumb;
  const ai = Boolean(photo.render);
  const tags = photo.tags?.slice(0, 1).join('');
  return `
    <button class="card ${photo.selected ? 'selected' : ''}" data-photo-index="${index}" title="${esc(photo.name)}">
      <img loading="lazy" src="${img}" alt="${esc(photo.name)}" onload="this.classList.add('loaded')" onerror="this.style.opacity=.15" />
      <div class="badges">
        ${ai ? `<span class="badge ai">AI · ${esc(styleName(photo.render.styleId))}</span>` : `<span class="badge">${CATS[photo.category] || '其他'}</span>`}
        <span class="badge score">${(photo.score ?? 0).toFixed(2)}</span>
      </div>
      <div class="meta">
        <span class="name">${esc(photo.name)}</span>
        <span class="cat">${photo.renderStatus === 'running' ? '生成中…' : photo.renderStatus === 'failed' ? '失败' : state.filter === 'styled' && photo.render ? fmtAgo(photo.render.createdAt) : (photo.selected ? `#${photo.rank}` : (tags || ''))}</span>
      </div>
    </button>
  `;
}

function styleName(id) {
  return state.data?.styles?.find((s) => s.id === id)?.name || id;
}

function renderGalleryGrid() {
  const grid = $('#galleryGrid');
  if (!grid) return;
  if (!state.data?.summary.photos) {
    grid.innerHTML = '';
    $('#loadMore').innerHTML = `
      <div class="empty" style="grid-column:1/-1;width:100%">
        <h3>还没有照片索引</h3>
        <p>扫描目录后会先在本地用 Apple Vision 分析构图、清晰度和美感，再把最合适的照片交给火山方舟做风格化。</p>
        <button class="btn primary" data-action="scan"><svg><use href="#i-scan"/></svg><span>扫描照片</span></button>
        <div class="steps">
          <div class="step"><b>01</b>本地选片</div>
          <div class="step"><b>02</b>AI 风格化</div>
          <div class="step"><b>03</b>桌面与锁屏轮播</div>
        </div>
      </div>`;
    return;
  }
  if (!state.photos.length) {
    grid.innerHTML = '';
    $('#loadMore').innerHTML = `<div class="empty" style="grid-column:1/-1;width:100%"><h3>这个筛选下还没有照片</h3><p>换一个筛选条件，或者重新扫描照片目录。</p></div>`;
    return;
  }
  grid.innerHTML = state.photos.map(photoCard).join('');
  const remaining = state.photoTotal - state.photos.length;
  $('#loadMore').innerHTML = remaining > 0
    ? `<button class="btn ghost" data-action="load-more">加载更多（还有 ${remaining} 张）</button>`
    : `<span class="dim" style="font-size:11px">共 ${state.photoTotal} 张</span>`;
}

/* ---------------- queue ---------------- */

function queueShell() {
  const view = $('#view');
  view.innerHTML = `
    <div class="queue-top" id="queueStats"></div>
    <div class="panel">
      <div class="panel-head">
        <h3>正在生成</h3>
        <div style="display:flex;gap:8px">
          <button class="btn ghost sm" data-action="retry"><svg><use href="#i-refresh"/></svg><span>重试失败</span></button>
          <button class="btn ghost sm" data-action="pipeline-toggle" id="queuePipelineBtn"></button>
        </div>
      </div>
      <div class="job-list" id="jobList"></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>最近成片</h3><span class="hint" id="renderHint"></span></div>
      <div class="render-grid" id="renderGrid"></div>
    </div>
  `;
  renderQueueContent();
  loadRenders().catch((err) => toast(err.message, 'err'));
  $('#renderGrid').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-retry-key]');
    if (!btn) return;
    event.stopPropagation();
    btn.disabled = true;
    try {
      const res = await api('/api/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: btn.dataset.retryKey }),
      });
      toast(`已重新排队 ${res.count} 张`, 'ok');
      await refreshState();
      await loadRenders();
    } catch (err) {
      toast(`${err.message}${err.hint ? ` · ${err.hint}` : ''}`, 'err');
      btn.disabled = false;
    }
  });
}

async function loadRenders() {
  const res = await api('/api/renders?limit=120');
  state.renders = res.items;
  renderRenderGrid();
}

function renderQueueContent() {
  const d = state.data;
  if (!d || state.tab !== 'queue') return;
  const p = d.pipeline;
  $('#queueStats').innerHTML = `
    <div class="qstat"><div class="k">今日生成</div><div class="v">${d.summary.dayCount} <small class="dim">张</small></div></div>
    <div class="qstat"><div class="k">今日花费</div><div class="v">${fmtMoney(d.summary.dayCostCents)}</div></div>
    <div class="qstat"><div class="k">排队中</div><div class="v">${p.queued}</div></div>
    <div class="qstat"><div class="k">失败</div><div class="v">${d.summary.failedRenders}</div></div>
  `;
  const btn = $('#queuePipelineBtn');
  if (btn) {
    btn.innerHTML = p.running
      ? `<svg><use href="#i-pause"/></svg><span>暂停生成</span>`
      : `<svg><use href="#i-play"/></svg><span>开始生成</span>`;
  }

  const list = $('#jobList');
  if (!list) return;
  if (!p.active.length) {
    list.innerHTML = `<div class="empty" style="padding:26px"><p style="margin:0">${p.running ? '等待下一张进入模型…' : '生成队列空闲'}</p></div>`;
  } else {
    list.innerHTML = p.active.map((job) => {
      const photo = d.current?.photo?.id === job.photoId ? d.current.photo : null;
      const thumb = photo ? `/media/thumb/${job.photoId}.jpg` : `/media/thumb/${job.photoId}.jpg`;
      const stepLabel = { preparing: '准备画面', generating: '模型生成中', finalizing: '输出 4K' }[job.step] || job.step;
      return `
        <div class="job">
          <img class="thumb" src="${thumb}" alt="" loading="lazy" />
          <div class="info">
            <div class="t"><span class="style">${esc(styleName(job.styleId))}</span><span class="key">${esc(job.key)}</span></div>
            <div class="bar"><i></i></div>
            <div class="state"><span class="spin"></span>${stepLabel} · 第 ${job.attempts} 次</div>
          </div>
          <div class="time">${fmtDur(job.elapsedMs)}</div>
        </div>`;
    }).join('');
  }
}

function renderRenderGrid() {
  const grid = $('#renderGrid');
  if (!grid) return;
  if (!state.renders.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><p style="margin:0">还没有成片。点「开始生成」，模型会一张张产出，播放不会等待它们全部完成。</p></div>`;
    return;
  }
  if ($('#renderHint')) $('#renderHint').textContent = `共 ${state.renders.length} 张 · 点击预览`;
  grid.innerHTML = state.renders.map((r) => `
    <div class="render ${r.status === 'failed' ? 'failed' : ''}" data-render-key="${esc(r.key)}">
      ${r.status === 'done'
        ? `<img loading="lazy" src="${r.thumb}" alt="" onload="this.classList.add('loaded')" onerror="this.style.opacity=.15" />`
        : `<div class="skeleton" style="position:absolute;inset:0"></div>`}
      <div class="rtop">
        <span class="badge ${r.status === 'done' ? 'ai' : ''}">${esc(r.styleName)}</span>
        ${r.status === 'failed' ? '<span class="badge" style="color:#ee9494">失败</span>' : ''}
      </div>
      <div class="rinfo">
        <div>${esc(r.title || r.key)}</div>
        ${r.status === 'failed' ? `<div style="color:#ee9494;font-size:9.5px;margin-top:2px">${esc((r.error || '').slice(0, 60))}</div><button class="btn ghost sm" data-retry-key="${esc(r.key)}" style="margin-top:6px;padding:4px 9px;font-size:10px">重试这张</button>` : `<div class="dim" style="font-size:9.5px">${r.durationMs ? `${fmtDur(r.durationMs)} · ` : ''}${fmtAgo(r.createdAt)}</div>`}
      </div>
    </div>
  `).join('');
}

/* ---------------- styles ---------------- */

function stylesShell() {
  const view = $('#view');
  const styles = state.data.styles;
  state.customDrafts = Object.fromEntries(styles.map((s) => [s.id, s.custom || '']));
  view.innerHTML = `
    <div class="notice">
      <svg><use href="#i-spark"/></svg>
      <div>启用的风格会轮流分配给选中的照片。每次生成都会花费方舟额度（约 ${fmtMoney(state.data.config.ark.priceCents)}/张），可在设置里设置每日预算。修改风格后，已生成的成片不会消失。</div>
    </div>
    <div class="style-grid">
      ${styles.map(styleCard).join('')}
    </div>
  `;
  $('#view').addEventListener('change', onStyleToggle);
  $('#view').addEventListener('click', onStyleAction);
}

function styleCard(s) {
  return `
    <div class="style-card ${s.enabled ? '' : 'off'}" style="--accent:${s.accent}" data-style="${s.id}">
      <div class="style-head">
        <div class="style-emoji">${s.emoji}</div>
        <div><div class="style-name">${esc(s.name)}</div><div class="style-en">${esc(s.en)}</div></div>
        <label class="switch"><input type="checkbox" data-style-toggle="${s.id}" ${s.enabled ? 'checked' : ''} /><i></i></label>
      </div>
      <p class="style-hint">${esc(s.hint)}</p>
      <details class="style-prompt">
        <summary>自定义提示词</summary>
        <textarea data-style-prompt="${s.id}" placeholder="${esc(s.hint)}">${esc(s.custom)}</textarea>
        <div class="save-row"><button class="btn ghost sm" data-style-save="${s.id}">保存提示词</button></div>
      </details>
    </div>`;
}

async function onStyleToggle(event) {
  const input = event.target.closest('[data-style-toggle]');
  if (!input) return;
  const enabled = $$('[data-style-toggle]').filter((el) => el.checked).map((el) => el.dataset.styleToggle);
  await act(async () => {
    await api('/api/styles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, custom: state.customDrafts, perPhoto: state.data.config.styles.perPhoto }),
    });
    toast(`已启用 ${enabled.length} 种风格`, 'ok');
    state.libraryDirty = true;
    await refreshState();
    if (state.tab === 'styles') stylesShell();
  }, '更新风格');
}

async function onStyleAction(event) {
  const save = event.target.closest('[data-style-save]');
  if (save) {
    const id = save.dataset.styleSave;
    const textarea = $(`[data-style-prompt="${id}"]`);
    state.customDrafts[id] = textarea.value;
    const enabled = $$('[data-style-toggle]').filter((el) => el.checked).map((el) => el.dataset.styleToggle);
    await act(async () => {
      await api('/api/styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, custom: state.customDrafts, perPhoto: state.data.config.styles.perPhoto }),
      });
      toast('提示词已保存', 'ok');
      state.libraryDirty = true;
      await refreshState();
    }, '保存提示词');
  }
}

/* ---------------- settings ---------------- */

function settingsShell() {
  const c = state.data.config;
  const s = state.data.summary;
  const screens = state.data.screens ?? [];
  const view = $('#view');
  view.innerHTML = `
    ${!state.data.ark.hasKey ? `<div class="notice"><svg><use href="#i-warning"/></svg><div>还没有配置火山方舟 API Key。把密钥写进 <span class="mono">${esc(state.data.app.root)}/.secrets/volcengine.env</span>（变量名 <span class="mono">ARK_API_KEY</span>），或设置同名环境变量后重启。</div></div>` : ''}
    <form id="settingsForm" class="settings-grid">
      ${c.rotation.intervalSeconds === 0 ? `<div class="notice" style="grid-column:1/-1"><svg><use href="#i-warning"/></svg><div>自动轮播已关闭（间隔 0）。<button type="button" class="btn ghost sm" data-action="enable-rotation" style="margin-left:10px">开启 30 秒轮播</button></div></div>` : ''}
      <div class="panel">
        <div class="panel-head"><h3>照片与选片</h3><span class="hint">本地 Vision 分析，不上传</span></div>
        <div class="field">
          <label>照片目录 <small>每行一个，递归扫描</small></label>
          <textarea name="roots" class="code" rows="4">${esc((c.roots || []).join('\n'))}</textarea>
        </div>
        <div class="field two">
          <div><label>最多扫描张数</label><input type="number" name="maxFiles" min="1" value="${c.scan.maxFiles}" /></div>
          <div><label>选片数量</label><input type="number" name="selCount" min="1" max="300" value="${c.selection.count}" /></div>
        </div>
        <div class="field two">
          <div><label>最低分数 <small>0-1</small></label><input type="number" step="0.01" name="minScore" min="0" max="1" value="${c.selection.minScore}" /></div>
          <div><label>最小像素 <small>百万</small></label><input type="number" step="0.1" name="minMp" min="0.1" value="${c.scan.minMegapixels}" /></div>
        </div>
        <div class="field row">
          <div><b>跳过截屏 / 文字图</b><span>依赖 Vision 的 isUtility 与文字识别</span></div>
          <label class="switch"><input type="checkbox" name="skipScreenshots" ${c.scan.skipScreenshots ? 'checked' : ''} /><i></i></label>
        </div>
        <div class="form-actions">
          <button type="button" class="btn ghost" data-action="scan"><svg><use href="#i-scan"/></svg><span>重新扫描</span></button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>风格化与花费</h3><span class="hint">火山方舟 Seedream</span></div>
        <div class="field">
          <label>模型 <small>可用性可在体检里探测</small></label>
          <input name="model" list="modelList" value="${esc(c.ark.model)}" />
          <datalist id="modelList">
            <option value="doubao-seedream-4-0-20260415">Seedream 4.0（快，约 8s）</option>
            <option value="doubao-seedream-5-0-pro-260628">Seedream 5.0 Pro（慢，质量更高）</option>
            <option value="doubao-seedream-5-0-flash-260915">Seedream 5.0 Flash</option>
          </datalist>
        </div>
        <div class="field two">
          <div><label>输出尺寸</label><input name="size" value="${esc(c.ark.size)}" placeholder="2560x1440" /></div>
          <div><label>并发数 <small>1-4</small></label><input type="number" name="concurrency" min="1" max="4" value="${c.ark.concurrency}" /></div>
        </div>
        <div class="field two">
          <div><label>每日预算 <small>元，0 为不限</small></label><input type="number" step="0.1" name="budget" min="0" value="${(c.ark.dailyBudgetCents / 100).toFixed(1)}" /></div>
          <div><label>单张价格 <small>元，用于估算</small></label><input type="number" step="0.01" name="price" min="0" value="${(c.ark.priceCents / 100).toFixed(2)}" /></div>
        </div>
        <div class="field two">
          <div><label>壁纸宽度</label><input type="number" name="outW" value="${c.output.width}" /></div>
          <div><label>壁纸高度</label><input type="number" name="outH" value="${c.output.height}" /></div>
        </div>
        <div class="field">
          <label>锁屏同步 <small>锁屏只能靠重启 WallpaperAgent 生效，会闪一下</small></label>
          <select name="lockMode">
            ${[['on-lock', '锁屏时同步（推荐，不闪烁）'], ['each', '每次换壁纸都同步（短间隔会闪）'], ['off', '只换桌面']]
              .map(([v, label]) => `<option value="${v}" ${c.wallpaper.lockScreenMode === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
        <div class="field row">
          <div><b>切换时通知</b><span>用系统通知提醒</span></div>
          <label class="switch"><input type="checkbox" name="notify" ${c.rotation.notify ? 'checked' : ''} /><i></i></label>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>轮播</h3><span class="hint">播放与生成并行</span></div>
        <div class="field two">
          <div><label>间隔 <small>秒，0 = 关闭；开启至少 30 秒</small></label><input type="number" step="1" name="interval" min="0" value="${c.rotation.intervalSeconds}" /></div>
          <div><label>缩放方式</label>
            <select name="placement">
              ${[[1, '填充屏幕'], [2, '适应屏幕'], [3, '拉伸'], [4, '居中'], [5, '平铺']].map(([v, label]) => `<option value="${v}" ${c.wallpaper.placement === v ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="quick-row" id="quickIntervals">
          ${[[0, '关闭轮播'], [30, '30 秒'], [60, '1 分钟'], [300, '5 分钟'], [1800, '30 分钟']]
            .map(([v, label]) => `<button type="button" class="btn ghost sm" data-quick="${v}">${label}</button>`).join('')}
        </div>
        <div class="field row">
          <div><b>启动时自动应用</b><span>服务启动后如果已有成片，立即换一次</span></div>
          <label class="switch"><input type="checkbox" name="applyOnStart" ${c.rotation.applyOnStart ? 'checked' : ''} /><i></i></label>
        </div>
        <div class="field">
          <label>屏幕 <small>WallpaperAgent 实际分辨率</small></label>
          <div class="prompt-mono">${screens.map((d) => `${esc(d.name)} · ${d.width}×${d.height}`).join('<br/>') || '未读取到屏幕信息'}</div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn ghost" data-action="next"><svg><use href="#i-shuffle"/></svg><span>立即下一张</span></button>
          <button type="button" class="btn ghost" data-action="refresh-screens">刷新屏幕信息</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>体检与恢复</h3><span class="hint">出问题时先跑这里</span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn ghost sm" data-action="doctor"><svg><use href="#i-refresh"/></svg><span>运行体检</span></button>
          <button type="button" class="btn ghost sm" data-action="unify"><svg><use href="#i-lock"/></svg><span>修复锁屏联动</span></button>
          <button type="button" class="btn ghost sm" data-action="open-data">数据目录</button>
          <button type="button" class="btn danger sm" data-action="restore-wallpaper"><svg><use href="#i-lock"/></svg><span>恢复原始壁纸</span></button>
        </div>
        <div class="doctor" id="doctorResults"></div>
        <p class="dim" style="font-size:11px;margin:14px 0 0;line-height:1.8">
          成片目录：<span class="mono">${esc(state.data.app.dataDir)}/wallpapers</span><br/>
          原始壁纸备份：<span class="mono">data/wallpaper/original.plist</span>
        </p>
      </div>

      <div style="grid-column:1/-1;display:flex;justify-content:flex-end;gap:9px">
        <button type="button" class="btn ghost" data-action="reload-settings">放弃修改</button>
        <button type="submit" class="btn primary"><svg><use href="#i-check"/></svg><span>保存设置</span></button>
      </div>
    </form>
  `;
  $('#settingsForm').addEventListener('submit', onSettingsSubmit);
  $('#quickIntervals')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-quick]');
    if (!btn) return;
    const input = $('#settingsForm input[name="interval"]');
    if (input) input.value = btn.dataset.quick;
  });
  state.settingsBuilt = true;
}

async function onSettingsSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fd = new FormData(form);
  const patch = {
    roots: String(fd.get('roots') || '').split('\n').map((s) => s.trim()).filter(Boolean),
    scan: {
      maxFiles: Number(fd.get('maxFiles')),
      minMegapixels: Number(fd.get('minMp')),
      skipScreenshots: fd.get('skipScreenshots') === 'on',
    },
    selection: { count: Number(fd.get('selCount')), minScore: Number(fd.get('minScore')) },
    ark: {
      model: String(fd.get('model') || '').trim() || state.data.config.ark.model,
      size: String(fd.get('size') || '').trim() || '2560x1440',
      concurrency: Number(fd.get('concurrency')),
      dailyBudgetCents: Math.round(Number(fd.get('budget') || 0) * 100),
      priceCents: Math.round(Number(fd.get('price') || 0) * 100),
    },
    output: { width: Number(fd.get('outW')), height: Number(fd.get('outH')) },
    wallpaper: { lockScreenMode: String(fd.get('lockMode') || 'on-lock'), placement: Number(fd.get('placement')) },
    rotation: {
      notify: fd.get('notify') === 'on',
      intervalSeconds: fd.get('interval') === '' ? state.data.rotation.intervalSeconds : Number(fd.get('interval')),
      applyOnStart: fd.get('applyOnStart') === 'on',
    },
  };
  await act(async () => {
    await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    toast('设置已保存', 'ok');
    state.libraryDirty = true;
    state.queueDirty = true;
    await refreshState();
    settingsShell();
  }, '保存设置');
}

async function runDoctor() {
  const box = $('#doctorResults');
  box.innerHTML = '<div class="doc-item"><span class="tick">…</span><div class="d"><b>正在体检</b><span>检查 Vision / 壁纸权限 / 方舟模型…</span></div></div>';
  const report = await api('/api/doctor?probe=1');
  box.innerHTML = report.checks.map((c) => `
    <div class="doc-item ${c.ok ? 'ok' : 'bad'}">
      <span class="tick">${c.ok ? '✓' : '✕'}</span>
      <div class="d"><b>${esc(c.id)}</b><span>${esc(c.detail)}${c.hint ? ` · ${esc(c.hint)}` : ''}</span></div>
    </div>
  `).join('');
}

/* ---------------- lightbox ---------------- */

function openLightbox(index) {
  const photo = state.photos[index];
  if (!photo) return;
  state.activeIndex = index;
  const render = photo.render;
  const lb = $('#lightbox');
  lb.hidden = false;
  $('#lbOriginal').src = photo.preview;
  if (render) {
    $('#lbStyled').src = render.full;
    $('#lbStyled').style.display = '';
    $('#compareRange').style.display = '';
    $('.compare-labels').style.display = '';
    $('#compare').style.setProperty('--p', '55%');
    $('#compareRange').value = 55;
  } else {
    $('#lbStyled').src = photo.preview;
    $('#lbStyled').style.display = 'none';
    $('#compareRange').style.display = 'none';
    $('.compare-labels').style.display = 'none';
  }
  $('#lbTitle').textContent = render?.title || photo.name;
  const meta = [
    CATS[photo.category] || '其他',
    `评分 ${(photo.score ?? 0).toFixed(2)}`,
    `美感 ${photo.aesthetic != null ? photo.aesthetic.toFixed(2) : '—'}`,
    `${photo.width}×${photo.height}`,
    photo.date ? fmtTime(photo.date) : '',
  ].filter(Boolean);
  $('#lbMeta').textContent = meta.join(' · ');
  $('#lbTags').innerHTML = [
    photo.selected ? '<span class="chip accent">已选中</span>' : '<span class="chip">未选中</span>',
    ...(photo.tags || []).slice(0, 6).map((t) => `<span class="chip">${esc(t)}</span>`),
  ].join('');
  $('#lbPrompt').textContent = render?.prompt || '这张照片还没有风格化提示词。';
  $$('#lightbox [data-action="apply-current"]').forEach((b) => {
    b.disabled = !render;
  });
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  document.body.style.overflow = '';
  state.activeIndex = null;
}

function stepLightbox(delta) {
  if (state.activeIndex == null) return;
  const next = state.activeIndex + delta;
  if (next < 0 || next >= state.photos.length) return;
  openLightbox(next);
}

/* ---------------- logs ---------------- */

function appendLog(entry) {
  const body = $('#logsBody');
  if (!body) return;
  if (body.dataset.initialized !== '1') {
    body.innerHTML = '';
    body.dataset.initialized = '1';
  }
  const row = document.createElement('div');
  row.className = `log-row ${entry.level}`;
  const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
  row.innerHTML = `<span class="t">${time}</span><span class="l">${esc(entry.level)}</span><span class="m">${esc(entry.message)}</span>`;
  body.appendChild(row);
  while (body.children.length > 300) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
}

function renderLogs(entries) {
  const body = $('#logsBody');
  body.innerHTML = '';
  body.dataset.initialized = '1';
  entries.forEach(appendLog);
}

/* ---------------- actions ---------------- */

async function enableRotation() {
  await api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rotation: { intervalSeconds: 30 } }),
  });
  toast('已开启自动轮播（30 秒一张）', 'ok');
  await refreshState();
  if (state.tab === 'settings') settingsShell();
}

const actions = {
  async scan() {
    await api('/api/scan', { method: 'POST' });
    toast('扫描已开始：本地分析会持续几分钟', 'ok');
    scheduleRefresh();
  },
  async next() {
    const result = await api('/api/next', { method: 'POST' });
    if (!result?.key) {
      toast('还没有可用的成片，先开始生成', 'err');
      return;
    }
    toast(state.data?.config.wallpaper.lockScreenMode === 'on-lock'
      ? '已切换壁纸；锁屏会在下次锁定时同步'
      : '已切换壁纸', 'ok');
    refreshState();
  },
  async 'rotation-toggle'() {
    if (state.data?.rotation.intervalSeconds === 0) {
      await enableRotation();
      return;
    }
    const enabled = state.data?.rotation.enabled;
    await api(enabled ? '/api/rotation/pause' : '/api/rotation/start', { method: 'POST' });
    toast(enabled ? '轮播已暂停' : '轮播已继续', 'ok');
    refreshState();
  },
  async 'enable-rotation'() {
    await enableRotation();
  },
  async 'pipeline-toggle'() {
    const running = state.data?.pipeline.running;
    await api(running ? '/api/pipeline/pause' : '/api/pipeline/start', { method: 'POST' });
    toast(running ? '生成已暂停（进行中的会完成）' : '生成队列已启动', 'ok');
    refreshState();
  },
  async retry() {
    const res = await api('/api/retry', { method: 'POST' });
    toast(`已重置 ${res.count} 个失败任务`, 'ok');
    refreshState();
  },
  async 'load-more'() {
    await loadPhotos(false);
  },
  async 'apply-current'() {
    const photo = state.photos[state.activeIndex];
    const key = photo?.render?.key;
    if (!key) return toast('这张还没有成片', 'err');
    await api('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    toast('已设为壁纸（桌面 + 锁屏）', 'ok');
    await refreshState();
  },
  async reveal() {
    const photo = state.photos[state.activeIndex];
    if (!photo?.render?.key) return toast('还没有成片文件', 'err');
    await api('/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: photo.render.key }) });
  },
  async 'refresh-screens'() {
    await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    await refreshState();
    settingsShell();
    toast('屏幕信息已刷新', 'ok');
  },
  async doctor() {
    await runDoctor();
  },
  async 'restore-wallpaper'() {
    if (!confirm('恢复使用前备份的桌面与锁屏壁纸？')) return;
    await api('/api/restore', { method: 'POST' });
    toast('已恢复原始壁纸，轮播已暂停', 'ok');
    await refreshState();
  },
  async unify() {
    await api('/api/lockscreen/unify', { method: 'POST' });
    toast('已重新联动桌面与锁屏，请锁屏确认', 'ok');
    await refreshState();
  },
  async 'open-data'() {
    await api('/api/open-data', { method: 'POST' });
    toast(`已在 Finder 打开：${state.data.app.dataDir}`);
  },
  'reload-settings'() {
    settingsShell();
  },
  'toggle-logs'() {
    const logs = $('#logs');
    logs.hidden = !logs.hidden;
    if (!logs.hidden) renderLogs(state.data?.logs ?? []);
  },
  'close-lightbox'() {
    closeLightbox();
  },
  'lb-prev'() {
    stepLightbox(-1);
  },
  'lb-next'() {
    stepLightbox(1);
  },
};

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('#tabs [data-tab]');
  if (tab) {
    switchTab(tab.dataset.tab);
    return;
  }
  const photoEl = event.target.closest('[data-photo-index]');
  if (photoEl) {
    openLightbox(Number(photoEl.dataset.photoIndex));
    return;
  }
  const renderEl = event.target.closest('[data-render-key]');
  if (renderEl) {
    const key = renderEl.dataset.renderKey;
    const render = state.renders.find((r) => r.key === key);
    if (render && render.status === 'done') {
      const photoIndex = state.photos.findIndex((p) => p.render?.key === key);
      if (photoIndex >= 0) openLightbox(photoIndex);
      else {
        // Not in the current gallery page; jump to the gallery and leave a toast.
        toast(`成片 ${render.styleName} · ${render.title}`, 'ok');
      }
    }
    return;
  }
  const actionEl = event.target.closest('[data-action]');
  if (actionEl) {
    const name = actionEl.dataset.action;
    const handler = actions[name];
    if (!handler) return;
    actionEl.disabled = true;
    try {
      await handler();
    } catch (err) {
      toast(`${err.message}${err.hint ? ` · ${err.hint}` : ''}`, 'err');
    } finally {
      actionEl.disabled = false;
    }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!$('#lightbox').hidden) closeLightbox();
    else if (!$('#logs').hidden) $('#logs').hidden = true;
  }
  if (!$('#lightbox').hidden) {
    if (event.key === 'ArrowLeft') stepLightbox(-1);
    if (event.key === 'ArrowRight') stepLightbox(1);
  } else if ((event.key === 'n' || event.key === 'N') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    actions.next().catch((err) => toast(err.message, 'err'));
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'compareRange') {
    $('#compare').style.setProperty('--p', `${event.target.value}%`);
  }
  if (event.target.dataset.stylePrompt) {
    state.customDrafts[event.target.dataset.stylePrompt] = event.target.value;
  }
});

function switchTab(tab) {
  state.tab = tab;
  document.body.dataset.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'gallery') {
    galleryShell();
    loadPhotos(true).catch((err) => toast(err.message, 'err'));
  } else if (tab === 'queue') {
    queueShell();
  } else if (tab === 'styles') {
    stylesShell();
  } else if (tab === 'settings') {
    settingsShell();
  }
}

/* ---------------- countdown ---------------- */

function tickCountdown() {
  const d = state.data;
  if (!d) return;
  const nextAt = d.current?.nextAt ? new Date(d.current.nextAt).getTime() : null;
  const interval = (d.rotation.intervalSeconds || 0) * 1000;
  const now = Date.now();
  let remaining = nextAt ? nextAt - now : null;
  if (!d.rotation.enabled) remaining = null;
  $('#countdown').textContent = d.rotation.intervalSeconds === 0 ? '手动' : fmtCountdown(remaining);
  const pct = remaining == null || interval === 0 ? 0 : Math.max(0, Math.min(1, remaining / interval));
  $('#ring').style.setProperty('--p', `${(pct * 100).toFixed(1)}%`);
  const q = $('#queueLine');
  if (q && d.pipeline.running && d.pipeline.active.length) {
    q.textContent = `${d.pipeline.active.length} 张生成中 · ${d.pipeline.queued} 张排队 · ${d.pipeline.effectiveModel.split('-').slice(0, 2).join('-')}`;
  }
}

/* ---------------- boot ---------------- */

async function boot() {
  connectEvents();
  try {
    await refreshState();
    galleryShell();
    await loadPhotos(true);
    renderLogs(state.data?.logs ?? []);
  } catch (err) {
    toast(`加载失败：${err.message}`, 'err');
  }
  setInterval(tickCountdown, 1000);
  tickCountdown();
}

boot();
