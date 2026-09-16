// 课程资料库 —— 主逻辑（视图渲染 / 导入 / 检索 / 设置）
//
// 数据全部存在本机 IndexedDB，无账号、无服务器、不上传任何文件。

import {
  escapeHtml, uid, extOf, splitExt, formatBytes, formatDateTime,
  relativeTime, naturalCompare, debounce, snippetAround,
} from './util.js';
import * as db from './db.js';
import { classifyBatch, classifyOne, recomputeVersions } from './classifier.js';
import { extractText, isExtractable } from './extractor.js';
import { exportCourses, exportBackup, importBackup, downloadBlob } from './exporter.js';
import { searchTexts } from './search.js';
import { DEFAULT_CATEGORIES, suggestAliases } from './seed.js';

// 课程色卡：建课时按顺序分配，让侧栏一眼能区分
const COURSE_COLORS = ['#2f6fed', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

const state = {
  semesters: [],
  courses: [],
  categories: [],
  files: [],

  view: 'course',        // course | unfiled | search | settings
  semesterId: null,
  courseId: null,
  categoryId: null,      // 空表示「全部」
  query: '',
  searchHits: null,      // Map<fileId, {count, snippet}> | null 表示还没搜正文

  selection: new Set(),
  extracting: { running: false, total: 0, done: 0 },
};

const $ = (sel) => document.querySelector(sel);

// ============================ 启动 ============================

boot();

async function boot() {
  bindGlobal();
  await loadAll();
  render();
  runExtractionQueue();
  registerServiceWorker();
}

// 注册 Service Worker，让应用离线可用。
// 用相对路径注册：这个站点可能被放在 GitHub Pages 的子目录下（/course-library/），
// 写死 '/sw.js' 在那种情况下会 404。
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// 下注册必然失败，不必白报一个错
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  const register = () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service Worker 注册失败（不影响使用）：', err);
    });
  };

  // boot() 是异步的，等它 await 完 IndexedDB，load 事件多半已经过去了，
  // 那时候再加监听器就永远不会触发——必须先问一句现在到哪一步了。
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

async function loadAll() {
  const [semesters, courses, categories, files] = await Promise.all([
    db.getAll('semesters'),
    db.getAll('courses'),
    db.getAll('categories'),
    db.getAll('files'),
  ]);
  state.semesters = semesters.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  state.courses = courses.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  state.categories = categories;
  state.files = files;

  if (!state.semesterId && state.semesters.length) state.semesterId = state.semesters[0].id;
  if (!state.courseId && state.courses.length) state.courseId = state.courses[0].id;
}

// ============================ 渲染 ============================

function render() {
  renderSidebar();
  renderView();
  renderExtractStatus();
}

function coursesOf(semesterId) {
  return state.courses.filter((c) => c.semesterId === semesterId);
}

function categoriesOf(courseId) {
  return state.categories
    .filter((c) => c.courseId === courseId)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

function filesOfCourse(courseId) {
  return state.files.filter((f) => f.courseId === courseId);
}

function unfiledFiles() {
  return state.files.filter((f) => !f.courseId);
}

function courseName(id) {
  return state.courses.find((c) => c.id === id)?.name || '未归类';
}

function categoryName(id) {
  return state.categories.find((c) => c.id === id)?.name || '其他';
}

function currentCourse() {
  return state.courses.find((c) => c.id === state.courseId) || null;
}

// ---------- 侧栏 ----------

function renderSidebar() {
  const el = $('#sidebar');
  const unfiled = unfiledFiles().length;

  if (!state.courses.length) {
    el.innerHTML = `<div class="side-empty">还没有课程。<br>先点下方「新建学期」，再建课程。</div>
      <div class="side-actions"><button class="ghost-btn" id="side-new-sem" style="width:100%">＋ 新建学期</button></div>`;
    el.querySelector('#side-new-sem').onclick = () => openSemesterDialog();
    return;
  }

  const bySid = new Map();
  for (const c of state.courses) {
    if (!bySid.has(c.semesterId)) bySid.set(c.semesterId, []);
    bySid.get(c.semesterId).push(c);
  }

  const blocks = state.semesters.map((s) => {
    const list = bySid.get(s.id) || [];
    const items = list.map((c) => {
      const n = filesOfCourse(c.id).length;
      const active = state.view === 'course' && state.courseId === c.id;
      return `<button class="course-item ${active ? 'is-active' : ''}" data-course="${c.id}">
        <span class="course-dot" style="background:${escapeHtml(c.color || '#8b93a3')}"></span>
        <span class="course-label">${escapeHtml(c.name)}</span>
        <span class="course-count">${n}</span>
      </button>`;
    }).join('');
    return `<div class="sem-block">
      <div class="sem-name">${escapeHtml(s.name)}<span class="count">${list.length} 门</span></div>
      ${items || '<div class="side-empty" style="padding:4px 10px 8px">暂无课程</div>'}
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="side-head">
      <span class="side-title">我的课程</span>
      <button class="link-btn" id="side-new-course">＋ 新建课程</button>
    </div>
    ${blocks}
    <div class="side-sep"></div>
    <button class="course-item unfiled-item ${state.view === 'unfiled' ? 'is-active' : ''}" data-view="unfiled">
      <span class="course-dot"></span>
      <span class="course-label">待整理</span>
      <span class="course-count">${unfiled}</span>
    </button>
    <div class="side-sep"></div>
    <div class="side-actions">
      <button class="ghost-btn" id="side-new-sem" style="width:100%">＋ 新建学期</button>
    </div>`;

  el.querySelectorAll('[data-course]').forEach((b) => {
    b.onclick = () => {
      state.view = 'course';
      state.courseId = b.dataset.course;
      state.categoryId = null;
      state.selection.clear();
      render();
    };
  });
  el.querySelector('[data-view="unfiled"]').onclick = () => {
    state.view = 'unfiled';
    state.selection.clear();
    render();
  };
  el.querySelector('#side-new-course').onclick = () => openCourseDialog();
  el.querySelector('#side-new-sem').onclick = () => openSemesterDialog();
}

// ---------- 主区 ----------

function renderView() {
  const main = $('#view');
  main.innerHTML = '';

  if (!state.courses.length) {
    main.innerHTML = renderEmptyGuide();
    main.querySelector('#guide-new-sem').onclick = () => openSemesterDialog();
    main.querySelector('#guide-import').onclick = () => $('#file-input').click();
    return;
  }

  if (state.view === 'settings') return renderSettings(main);
  if (state.view === 'search') return renderSearchResults(main);
  if (state.view === 'unfiled') return renderUnfiled(main);
  return renderCourse(main);
}

function renderEmptyGuide() {
  return `<div class="empty-state">
    <div class="empty-ico">📚</div>
    <div class="empty-title">开始建立你的课程资料库</div>
    <div class="empty-desc">
      把散落在各个群聊、下载文件夹里的课件、作业、笔记收进来，
      按课程自动归类，之后随时能搜到、一键打包带走。
    </div>
    <div class="steps">
      <div class="step"><span class="step-n">1</span><span class="step-text">
        <b>建一个学期</b>，比如「2025 秋」</span></div>
      <div class="step"><span class="step-n">2</span><span class="step-text">
        <b>建几门课程</b>，填上课程名就够了，常用简称（高数、大物…）会自动带上</span></div>
      <div class="step"><span class="step-n">3</span><span class="step-text">
        <b>把文件拖进来</b>，工具会按文件名自动归类，确认一下即可入库</span></div>
    </div>
    <div style="margin-top:20px;display:flex;gap:10px;justify-content:center">
      <button class="primary-btn" id="guide-new-sem">新建学期</button>
      <button class="ghost-btn" id="guide-import">直接导入文件</button>
    </div>
    <div class="empty-desc" style="margin-top:20px;font-size:12.5px">
      数据全部保存在这台设备的浏览器里，不会上传到任何服务器。
    </div>
  </div>`;
}

// ---------- 课程视图 ----------

function renderCourse(main) {
  // state.courseId 可能指向一门已被删掉的课，这里顺手修回第一门，别让主区开天窗
  const course = currentCourse() || state.courses[0];
  if (!course) { main.innerHTML = renderEmptyGuide(); return; }
  state.courseId = course.id;

  const cats = categoriesOf(course.id);
  const all = filesOfCourse(course.id);
  const shown = state.categoryId ? all.filter((f) => f.categoryId === state.categoryId) : all;
  const semester = state.semesters.find((s) => s.id === course.semesterId);

  const totalSize = all.reduce((s, f) => s + (f.size || 0), 0);

  main.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">
          <span class="course-dot" style="background:${escapeHtml(course.color || '#8b93a3')}"></span>
          ${escapeHtml(course.name)}
        </h1>
        <p class="view-sub">
          ${escapeHtml(semester?.name || '未分学期')}${course.teacher ? ' · ' + escapeHtml(course.teacher) : ''}
          · ${all.length} 个文件 · ${formatBytes(totalSize)}
        </p>
      </div>
      <div class="view-head-actions">
        <button class="ghost-btn" id="btn-manage-cats">管理分类</button>
        <button class="ghost-btn" id="btn-edit-course">编辑课程</button>
        <button class="ghost-btn" id="btn-export-course">导出本课程</button>
      </div>
    </div>

    <div class="chip-row">
      <button class="chip ${!state.categoryId ? 'is-active' : ''}" data-cat="">
        全部 <span class="n">${all.length}</span>
      </button>
      ${cats.map((c) => {
        const n = all.filter((f) => f.categoryId === c.id).length;
        return `<button class="chip ${state.categoryId === c.id ? 'is-active' : ''}" data-cat="${c.id}">
          ${escapeHtml(c.icon || '')} ${escapeHtml(c.name)} <span class="n">${n}</span>
        </button>`;
      }).join('')}
    </div>

    <div id="file-area">${renderFileArea(shown, cats)}</div>`;

  main.querySelectorAll('[data-cat]').forEach((b) => {
    b.onclick = () => { state.categoryId = b.dataset.cat || null; state.selection.clear(); render(); };
  });
  main.querySelector('#btn-manage-cats').onclick = () => openCategoryManager(course);
  main.querySelector('#btn-edit-course').onclick = () => openCourseDialog(course);
  main.querySelector('#btn-export-course').onclick = () => doExportCourses([course.id], course.name);

  bindFileArea(main);
}

// ---------- 待整理 ----------

function renderUnfiled(main) {
  const list = unfiledFiles();

  main.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">🟡 待整理</h1>
        <p class="view-sub">${list.length} 个文件没能自动认出属于哪门课</p>
      </div>
      <div class="view-head-actions">
        ${list.length ? '<button class="ghost-btn" id="btn-bulk-assign">批量分配课程</button>' : ''}
      </div>
    </div>
    ${list.length ? `<div class="preview-hint">
      这里不是垃圾桶——是「我还没想好放哪」的缓冲区。认出课程后，文件会自己走进对应的课程里。
    </div>` : ''}
    <div id="file-area">${list.length ? renderFileArea(list, null, { showCourse: true }) : `
      <div class="empty-state">
        <div class="empty-ico">✅</div>
        <div class="empty-title">没有待整理的文件</div>
        <div class="empty-desc">所有文件都已归到对应课程下。</div>
      </div>`}</div>`;

  const bulkBtn = main.querySelector('#btn-bulk-assign');
  if (bulkBtn) bulkBtn.onclick = () => openBulkAssign([...state.selection]);

  bindFileArea(main);
}

// ---------- 搜索结果 ----------

function renderSearchResults(main) {
  const q = state.query.trim();
  const ql = q.toLowerCase();

  const byName = state.files.filter((f) => f.name.toLowerCase().includes(ql));
  const hits = state.searchHits || new Map();
  const byContent = state.files.filter((f) => hits.has(f.id));
  const byContentOnly = byContent.filter((f) => !byName.includes(f));

  const total = byName.length + byContentOnly.length;

  main.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">搜索「${escapeHtml(q)}」</h1>
        <p class="view-sub">
          文件名命中 ${byName.length} · 正文命中 ${byContent.length}${state.searchHits === null ? '（正在搜正文…）' : ''}
        </p>
      </div>
      <div class="view-head-actions">
        <button class="ghost-btn" id="btn-export-search" ${total ? '' : 'disabled'}>导出结果</button>
      </div>
    </div>
    <div id="file-area">${
      total
        ? renderFileArea(byName.concat(byContentOnly), null, { searchHits: hits, showSnippet: true })
        : `<div class="empty-state">
             <div class="empty-ico">🔍</div>
             <div class="empty-title">没有找到匹配的文件</div>
             <div class="empty-desc">换个关键词试试，或者确认文件已经导入并且提取过正文。</div>
           </div>`
    }</div>`;

  const ex = main.querySelector('#btn-export-search');
  if (ex) ex.onclick = () => doExportSearchResults(byName.concat(byContentOnly));

  bindFileArea(main);
}

// ---------- 文件列表 ----------

function fileIcon(ext) {
  const map = {
    pdf: '📕', ppt: '📙', pptx: '📙', doc: '📘', docx: '📘',
    xls: '📗', xlsx: '📗', csv: '📗',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', bmp: '🖼️',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️',
    txt: '📄', md: '📄',
  };
  return map[ext] || '📎';
}

function renderFileArea(list, cats, opts = {}) {
  if (!list.length) {
    return `<div class="empty-state">
      <div class="empty-ico">📂</div>
      <div class="empty-title">这里还没有文件</div>
      <div class="empty-desc">把文件拖进窗口，或者点右上角「＋ 导入文件」。</div>
    </div>`;
  }

  const sorted = [...list].sort((a, b) => naturalCompare(a.name, b.name));

  // 没有分类筛选时按分类分组显示，更贴近「整理」的心智
  const groups = new Map();
  if (cats && !state.categoryId) {
    for (const c of cats) groups.set(c.id, []);
    groups.set('__none', []);
    for (const f of sorted) {
      if (groups.has(f.categoryId)) groups.get(f.categoryId).push(f);
      else groups.get('__none').push(f);
    }
  }

  const renderGroup = (title, files, icon) => {
    if (!files.length) return '';
    return `<div style="margin-bottom:20px">
      <div class="sem-name" style="padding-left:2px">${icon || ''} ${escapeHtml(title)}
        <span class="count">${files.length}</span></div>
      <div class="file-list">${files.map((f) => renderFileRow(f, opts)).join('')}</div>
    </div>`;
  };

  if (groups.size) {
    let html = '';
    for (const c of cats) html += renderGroup(c.name, groups.get(c.id) || [], c.icon);
    const none = groups.get('__none') || [];
    if (none.length) html += renderGroup('未分类', none, '📎');
    return html || '';
  }

  return `<div class="file-list">${sorted.map((f) => renderFileRow(f, opts)).join('')}</div>`;
}

function renderFileRow(f, opts = {}) {
  const ext = extOf(f.name);
  const selected = state.selection.has(f.id);

  let versionTag = '';
  if (f.versionLabel === 'latest') versionTag = '<span class="tag tag-latest">最新版</span>';
  else if (f.versionLabel === 'old') versionTag = '<span class="tag tag-old">旧版</span>';

  let noTextTag = '';
  if (f.extractStatus === 'empty') noTextTag = '<span class="tag tag-notext">无正文</span>';
  else if (f.extractStatus === 'failed') noTextTag = '<span class="tag tag-notext">提取失败</span>';

  // 搜索结果里显示正文命中片段
  let snippet = '';
  if (opts.searchHits && opts.searchHits.has(f.id)) {
    const h = opts.searchHits.get(f.id);
    const highlighted = escapeHtml(h.snippet).replace(
      new RegExp(escapeRegExp(escapeHtml(state.query.trim())), 'gi'),
      (m) => `<mark>${m}</mark>`
    );
    snippet = `<span class="snippet">…${highlighted}… (${h.count} 处)</span>`;
  }

  const courseTag = opts.showCourse || state.view === 'unfiled'
    ? `<span class="tag tag-course">${escapeHtml(courseName(f.courseId))}</span>` : '';

  return `<div class="file-row" data-id="${f.id}">
    <input type="checkbox" class="file-check" data-check="${f.id}" ${selected ? 'checked' : ''} />
    <div class="file-ico">${fileIcon(ext)}</div>
    <div class="file-main">
      <div class="file-name">
        ${escapeHtml(f.name)} ${versionTag}${noTextTag}
      </div>
      <div class="file-sub">
        ${courseTag}
        <span>${escapeHtml(categoryName(f.categoryId))}</span>
        <span>${formatBytes(f.size)}</span>
        <span>${relativeTime(f.importedAt)}</span>
        ${snippet}
      </div>
    </div>
    <div class="file-actions">
      <button class="link-btn" data-download="${f.id}">下载</button>
      <button class="link-btn" data-move="${f.id}">移动</button>
      <button class="link-btn danger" data-del="${f.id}">删除</button>
    </div>
  </div>`;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bindFileArea(main) {
  main.querySelectorAll('[data-check]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) state.selection.add(cb.dataset.check);
      else state.selection.delete(cb.dataset.check);
      renderSelectionBar();
    };
  });

  main.querySelectorAll('[data-download]').forEach((b) => {
    b.onclick = () => downloadFile(b.dataset.download);
  });

  main.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => openMoveDialog([b.dataset.move]);
  });

  main.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => confirmDelete([b.dataset.del]);
  });

  renderSelectionBar();
}

function renderSelectionBar() {
  let bar = $('#selection-bar');
  const n = state.selection.size;

  if (!n) { if (bar) bar.remove(); return; }

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selection-bar';
    bar.className = 'toast';
    bar.style.cssText = 'bottom:26px;display:flex;gap:14px;align-items:center;padding:9px 18px';
    document.body.appendChild(bar);
  }

  bar.innerHTML = `
    <span>已选 ${n} 个</span>
    <button class="link-btn" style="color:#8fd0ff" id="sel-move">移动</button>
    <button class="link-btn" style="color:#8fd0ff" id="sel-export">导出</button>
    <button class="link-btn" style="color:#ff9b9b" id="sel-del">删除</button>
    <button class="link-btn" style="color:#c9cfda" id="sel-clear">取消</button>`;

  bar.querySelector('#sel-move').onclick = () => openMoveDialog([...state.selection]);
  bar.querySelector('#sel-export').onclick = () => doExportSelection([...state.selection]);
  bar.querySelector('#sel-del').onclick = () => confirmDelete([...state.selection]);
  bar.querySelector('#sel-clear').onclick = () => { state.selection.clear(); render(); };
}

// ============================ 导入 ============================

function bindGlobal() {
  $('#btn-import').onclick = () => openImportChooser();
  $('#btn-settings').onclick = () => {
    state.view = 'settings';
    state.selection.clear();
    render();
  };

  const searchEl = $('#search');
  const doSearch = debounce(async (q) => {
    state.query = q;
    if (!q.trim()) {
      state.view = state.courseId ? 'course' : 'course';
      state.searchHits = null;
      render();
      return;
    }
    state.view = 'search';
    state.searchHits = null;
    render();

    // 正文搜索是全表扫描，慢一点；先渲染文件名结果，再补正文
    const hits = await searchTexts(q);
    if (state.query === q) {
      state.searchHits = hits;
      render();
    }
  }, 260);

  searchEl.addEventListener('input', () => {
    $('#search-clear').classList.toggle('hidden', !searchEl.value);
    doSearch(searchEl.value);
  });

  $('#search-clear').onclick = () => {
    searchEl.value = '';
    $('#search-clear').classList.add('hidden');
    state.query = '';
    state.view = 'course';
    state.searchHits = null;
    render();
  };

  $('#file-input').onchange = (e) => {
    handleIncoming([...e.target.files]);
    e.target.value = '';
  };
  $('#dir-input').onchange = (e) => {
    handleIncoming([...e.target.files]);
    e.target.value = '';
  };

  bindDragDrop();
}

function openImportChooser() {
  const m = openModal({
    title: '导入文件',
    body: `<div class="card-actions" style="flex-direction:column;gap:10px">
      <button class="primary-btn" id="pick-files" style="width:100%">选择文件</button>
      <button class="ghost-btn" id="pick-dir" style="width:100%">选择整个文件夹</button>
      <div class="field-hint" style="margin-top:2px">
        也可以直接把文件或文件夹拖进窗口。<br>
        选文件夹时，目录名也会参与识别（比如 <code>高等数学/作业/</code> 下的文件会被归到高等数学·作业）。
      </div>
    </div>`,
  });
  m.body.querySelector('#pick-files').onclick = () => { m.close(); $('#file-input').click(); };
  m.body.querySelector('#pick-dir').onclick = () => { m.close(); $('#dir-input').click(); };
}

// 拖拽导入
function bindDragDrop() {
  let overlay = null;
  let depth = 0;

  const show = () => {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    overlay.innerHTML = `<div class="drop-box">松手即可导入
      <small>文件会先经过自动识别，确认后才入库</small></div>`;
    document.body.appendChild(overlay);
  };
  const hide = () => {
    depth = 0;
    if (overlay) { overlay.remove(); overlay = null; }
  };

  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    depth++;
    show();
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth--;
    if (depth <= 0) hide();
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    hide();
    handleIncoming([...e.dataTransfer.files]);
  });
}

/**
 * 接收一批文件：先分类，再弹出预览让用户确认，确认后才真正入库。
 * 这个是整个产品里最关键的一步——分类不可能 100% 准，
 * 与其吹「越用越准」，不如把把关的机会直接交给用户。
 */
async function handleIncoming(fileList) {
  const files = fileList.filter((f) => f.size >= 0 && f.name && !f.name.startsWith('.'));
  if (!files.length) { toast('没有可导入的文件'); return; }

  if (!state.courses.length) {
    toast('请先新建一门课程，再来导入文件');
    return;
  }

  const pending = files.map((f) => {
    const rel = f.webkitRelativePath || '';
    const folders = rel ? rel.split('/').slice(0, -1).join(' ') : '';
    return {
      tmpId: uid(),
      file: f,
      name: f.name,
      size: f.size,
      mime: f.type || '',
      ext: extOf(f.name),
      relPath: rel,
      // 目录名也当线索，但只在识别时用，不参与展示
      matchText: folders ? `${f.name} ${folders}` : '',
      courseId: null,
      categoryId: null,
    };
  });

  // 分类：课程匹配全局，分类要在选定课程下才有意义
  const withCourse = pending.map((p) => {
    const c = classifyOne(p, state.courses, state.categories);
    return { ...p, courseId: c.courseId, matchedBy: c.matchedBy };
  });

  // 课程定下来后再按该课程的分类表推断分类
  for (const p of withCourse) {
    if (!p.courseId) continue;
    const cats = categoriesOf(p.courseId);
    const c = classifyOne(p, state.courses, cats);
    p.categoryId = c.categoryId;
  }

  openImportPreview(withCourse);
}

function openImportPreview(rows) {
  // 默认选中的课程：优先用当前正在看的课程
  const defaultCourseId = state.courseId || state.courses[0]?.id || null;

  const m = openModal({
    title: `确认归类（${rows.length} 个文件）`,
    wide: true,
    body: `
      <div class="preview-hint">
        下面是根据文件名（选文件夹导入时还包括目录名）自动识别的结果。
        <b>确认之前，所有文件都还没入库</b>——认错的现在改最省事。
      </div>
      <div class="bulk-row">
        <span style="font-size:13px;color:var(--muted)">批量设为：</span>
        <select id="bulk-course">
          <option value="">— 选课程 —</option>
          ${state.courses.map((c) => `<option value="${c.id}" ${c.id === defaultCourseId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <select id="bulk-cat"><option value="">— 选分类 —</option></select>
        <button class="ghost-btn" id="apply-bulk">应用到全部</button>
        <span class="spacer" style="flex:1"></span>
        <span id="review-count" style="font-size:12.5px;color:var(--muted)"></span>
      </div>
      <table class="preview-table">
        <thead><tr><th style="width:34%">文件</th><th style="width:28%">课程</th><th style="width:22%">分类</th><th style="width:16%">大小</th></tr></thead>
        <tbody id="preview-body"></tbody>
      </table>`,
    foot: `<span id="preview-summary" style="font-size:12.5px;color:var(--muted)"></span>
      <span class="spacer"></span>
      <button class="ghost-btn" id="preview-cancel">取消</button>
      <button class="primary-btn" id="preview-ok">确认导入</button>`,
  });

  const body = m.body.querySelector('#preview-body');
  const bulkCat = m.body.querySelector('#bulk-cat');
  const bulkCourse = m.body.querySelector('#bulk-course');

  const fillCatOptions = (sel, courseId) => {
    const cats = courseId ? categoriesOf(courseId) : [];
    sel.innerHTML = '<option value="">— 选分类 —</option>' +
      cats.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  };

  const refreshSummary = () => {
    const unset = rows.filter((r) => !r.courseId).length;
    m.body.querySelector('#review-count').textContent =
      unset ? `${unset} 个文件没认出课程，需要手动指定` : '全部识别完成';
    m.foot.querySelector('#preview-summary').textContent =
      unset ? `还有 ${unset} 个未指定课程` : `将导入 ${rows.length} 个文件`;
    m.foot.querySelector('#preview-ok').disabled = unset > 0;
  };

  const renderRows = () => {
    body.innerHTML = rows.map((r, i) => {
      const cats = r.courseId ? categoriesOf(r.courseId) : [];
      return `<tr class="${r.courseId ? '' : 'needs-review'}">
        <td class="fname" title="${escapeHtml(r.relPath || r.name)}">${escapeHtml(r.name)}</td>
        <td>
          <select data-row="${i}" data-kind="course" class="${r.courseId ? '' : 'unset'}">
            <option value="">— 未识别 —</option>
            ${state.courses.map((c) => `<option value="${c.id}" ${c.id === r.courseId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </td>
        <td>
          <select data-row="${i}" data-kind="cat">
            ${cats.length
              // 课程定下来了但分类一个词都没命中时，categoryId 还是 null；
              // 没有这个空选项的话下拉框会默认显示第一项，看着像已经选好了，
              // 实际存进去的仍是 null —— 必须让「未分类」这个状态可见
              ? '<option value=""' + (r.categoryId ? '' : ' selected') + '>— 未分类 —</option>'
                + cats.map((c) => `<option value="${c.id}" ${c.id === r.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')
              : '<option value="">—</option>'}
          </select>
        </td>
        <td style="color:var(--muted);font-size:12px">${formatBytes(r.size)}</td>
      </tr>`;
    }).join('');

    body.querySelectorAll('select[data-kind="course"]').forEach((sel) => {
      sel.onchange = () => {
        const r = rows[+sel.dataset.row];
        r.courseId = sel.value || null;
        // 换了课程，分类表也换，重新按文件名推一次
        if (r.courseId) {
          const c = classifyOne(r, state.courses, categoriesOf(r.courseId));
          r.categoryId = c.categoryId;
        } else r.categoryId = null;
        renderRows();
        refreshSummary();
      };
    });

    body.querySelectorAll('select[data-kind="cat"]').forEach((sel) => {
      sel.onchange = () => { rows[+sel.dataset.row].categoryId = sel.value || null; };
    });
  };

  bulkCourse.onchange = () => fillCatOptions(bulkCat, bulkCourse.value);
  fillCatOptions(bulkCat, bulkCourse.value);

  m.body.querySelector('#apply-bulk').onclick = () => {
    if (!bulkCourse.value) { toast('先选一门课程'); return; }
    for (const r of rows) {
      r.courseId = bulkCourse.value;
      if (bulkCat.value) r.categoryId = bulkCat.value;
      else r.categoryId = classifyOne(r, state.courses, categoriesOf(r.courseId)).categoryId;
    }
    renderRows();
    refreshSummary();
  };

  renderRows();
  refreshSummary();

  m.foot.querySelector('#preview-cancel').onclick = () => m.close();
  m.foot.querySelector('#preview-ok').onclick = async () => {
    m.close();
    await commitImport(rows);
  };
}

/** 真正写库：元数据 + 文件本体一起落，然后后台提取正文、重算版本 */
async function commitImport(rows) {
  const progress = openProgress('正在导入…');
  let done = 0;

  for (const r of rows) {
    const id = uid();
    const record = {
      id,
      courseId: r.courseId,
      categoryId: r.categoryId,
      name: r.name,
      size: r.size,
      mime: r.mime,
      ext: r.ext,
      relPath: r.relPath || '',
      importedAt: Date.now(),
      versionLabel: 'none',
      // 提取不阻塞导入：先把文件收进来，正文慢慢补
      extractStatus: isExtractable(r.name) ? 'pending' : 'unsupported',
    };

    await db.putTx({ files: record, blobs: { id, blob: r.file } });
    done++;
    if (done % 10 === 0) progress.set(`正在导入… ${done}/${rows.length}`);
  }

  // 顺序不能反：refreshVersions 是在 state.files 上分组的，
  // 必须先把刚写入的文件读回来，否则是在旧列表上算版本，等于没算。
  progress.set('正在整理版本…');
  await loadAll();
  await refreshVersions([...new Set(rows.map((r) => r.courseId).filter(Boolean))]);

  progress.close();

  const n = rows.length;
  toast(`已导入 ${n} 个文件，正在后台提取正文`);
  render();

  runExtractionQueue();
}

/** 对涉及的课程整组重算版本标记——新导入一份可能让原来的「最新版」变成旧版 */
async function refreshVersions(courseIds) {
  const changed = [];
  for (const cid of courseIds) {
    const list = state.files.filter((f) => f.courseId === cid);
    changed.push(...recomputeVersions(list));
  }
  if (changed.length) {
    await db.putTx({ files: changed });
    state.files = state.files.map((f) => changed.find((c) => c.id === f.id) || f);
  }
}

// ============================ 正文提取队列 ============================

async function runExtractionQueue() {
  if (state.extracting.running) return;

  const pending = state.files.filter((f) => f.extractStatus === 'pending');
  if (!pending.length) return;

  state.extracting = { running: true, total: pending.length, done: 0 };
  renderExtractStatus();

  for (const f of pending) {
    try {
      const row = await db.get('blobs', f.id);
      if (!row?.blob) {
        f.extractStatus = 'failed';
      } else {
        const { status, text } = await extractText(row.blob, f.name);
        f.extractStatus = status;
        f.textLength = text.length;
        await db.putTx({
          files: f,
          texts: status === 'done' ? { id: f.id, text } : null,
        });
        if (status !== 'done') await db.remove('texts', f.id);
      }
    } catch (err) {
      console.warn('[extract] 失败', f.name, err);
      f.extractStatus = 'failed';
      await db.put('files', f);
    }
    state.extracting.done++;
    renderExtractStatus();
  }

  state.extracting.running = false;
  renderExtractStatus();

  // 提取完正文后，如果用户正停在搜索页，把正文结果补上
  if (state.view === 'search' && state.query.trim()) {
    state.searchHits = await searchTexts(state.query);
    render();
  }
}

function renderExtractStatus() {
  const el = $('#extract-status');
  if (!el) return;
  const { running, total, done } = state.extracting;
  if (!running) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = `提取正文 ${done}/${total}`;
}

// ============================ 文件操作 ============================

async function downloadFile(id) {
  const f = state.files.find((x) => x.id === id);
  const row = await db.get('blobs', id);
  if (!row?.blob) { toast('文件内容丢失'); return; }
  downloadBlob(row.blob, f?.name || 'file');
}

function openMoveDialog(ids) {
  if (!ids.length) return;
  const m = openModal({
    title: `移动 ${ids.length} 个文件`,
    body: `
      <div class="field">
        <label class="field-label">目标课程</label>
        <select id="mv-course">${state.courses.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label class="field-label">目标分类</label>
        <select id="mv-cat"></select>
      </div>`,
    foot: `<span class="spacer"></span>
      <button class="ghost-btn" id="mv-cancel">取消</button>
      <button class="primary-btn" id="mv-ok">移动</button>`,
  });

  const courseSel = m.body.querySelector('#mv-course');
  const catSel = m.body.querySelector('#mv-cat');

  const fill = () => {
    catSel.innerHTML = categoriesOf(courseSel.value)
      .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  };
  courseSel.onchange = fill;
  fill();

  m.foot.querySelector('#mv-cancel').onclick = () => m.close();
  m.foot.querySelector('#mv-ok').onclick = async () => {
    const target = { courseId: courseSel.value, categoryId: catSel.value };
    const changed = [];
    // 旧的 courseId 要在改写之前收集——文件被移走之后，
    // 原来那门课的分组可能只剩一份，得回头把它从「最新版」降级
    const affected = new Set([target.courseId]);
    for (const id of ids) {
      const f = state.files.find((x) => x.id === id);
      if (!f) continue;
      if (f.courseId) affected.add(f.courseId);
      Object.assign(f, target);
      changed.push(f);
    }
    await db.putTx({ files: changed });
    await refreshVersions([...affected]);
    await loadAll();
    state.selection.clear();
    m.close();
    toast(`已移动 ${changed.length} 个文件`);
    render();
  };
}

function confirmDelete(ids) {
  if (!ids.length) return;
  const m = openModal({
    title: '删除文件',
    body: `<p style="margin:0;line-height:1.8">
      将从资料库中永久删除 <b>${ids.length}</b> 个文件。<br>
      <span style="color:var(--muted);font-size:13px">
        注意：这里删的是资料库里的副本，你磁盘上的原文件不受影响。
      </span>
    </p>`,
    foot: `<span class="spacer"></span>
      <button class="ghost-btn" id="del-cancel">取消</button>
      <button class="primary-btn" id="del-ok" style="background:var(--danger)">删除</button>`,
  });

  m.foot.querySelector('#del-cancel').onclick = () => m.close();
  m.foot.querySelector('#del-ok').onclick = async () => {
    await db.deleteTx({ files: ids, blobs: ids, texts: ids });
    // 删掉的可能正是「最新版」，剩下的版本要重新判定
    const affected = [...new Set(ids.map((id) => state.files.find((f) => f.id === id)?.courseId).filter(Boolean))];
    await loadAll();
    await refreshVersions(affected);
    state.selection.clear();
    m.close();
    toast(`已删除 ${ids.length} 个文件`);
    render();
  };
}

async function openBulkAssign(ids) {
  if (!ids.length) { toast('先勾选要分配的文件'); return; }
  openMoveDialog(ids);
}

// ============================ 导出 ============================

async function doExportCourses(courseIds, label) {
  const progress = openProgress('正在打包…');
  try {
    const data = await currentData();
    const blob = await exportCourses(data, courseIds, (msg) => progress.set(msg));
    downloadBlob(blob, `${label || '课程资料'}_${todayStamp()}.zip`);
    progress.close();
    toast('已开始下载');
  } catch (err) {
    progress.close();
    console.error(err);
    toast('导出失败：' + err.message);
  }
}

async function doExportSelection(ids) {
  const progress = openProgress('正在打包…');
  try {
    const data = await currentData();
    const subset = { ...data, files: data.files.filter((f) => ids.includes(f.id)) };
    const blob = await exportCourses(subset, null, (msg) => progress.set(msg));
    downloadBlob(blob, `选中文件_${todayStamp()}.zip`);
    progress.close();
    toast('已开始下载');
  } catch (err) {
    progress.close();
    toast('导出失败：' + err.message);
  }
}

async function doExportSearchResults(list) {
  if (!list.length) return;
  await doExportSelection(list.map((f) => f.id));
}

async function currentData() {
  return {
    semesters: await db.getAll('semesters'),
    courses: await db.getAll('courses'),
    categories: await db.getAll('categories'),
    files: await db.getAll('files'),
  };
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ============================ 设置页 ============================

async function renderSettings(main) {
  const data = await currentData();
  const totalSize = data.files.reduce((s, f) => s + (f.size || 0), 0);
  const withText = data.files.filter((f) => f.extractStatus === 'done').length;

  main.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">⚙️ 设置</h1>
        <p class="view-sub">数据全部保存在本机浏览器中</p>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="stat-n">${data.courses.length}</div><div class="stat-l">课程</div></div>
      <div class="stat"><div class="stat-n">${data.files.length}</div><div class="stat-l">文件</div></div>
      <div class="stat"><div class="stat-n">${formatBytes(totalSize)}</div><div class="stat-l">占用空间</div></div>
      <div class="stat"><div class="stat-n">${withText}</div><div class="stat-l">已提取正文</div></div>
    </div>

    <div class="card">
      <h3 class="card-title">导出资料</h3>
      <p class="card-desc">
        按「学期 / 课程 / 分类」的目录结构打包成 zip，解压就是一棵整理好的文件夹树，
        可以直接发给同学或备份到网盘。
      </p>
      <div class="card-actions">
        <button class="primary-btn" id="set-export-all" ${data.files.length ? '' : 'disabled'}>导出全部资料（zip）</button>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">备份与恢复</h3>
      <p class="card-desc">
        备份包比「导出全部」多一个 <code>metadata.json</code>，记录着课程、分类和版本标记，
        所以能一键还原成现在的样子。<br>
        <b style="color:var(--warn)">清理浏览器数据会清空资料库，请定期备份。</b>
      </p>
      <div class="card-actions">
        <button class="primary-btn" id="set-backup">导出备份</button>
        <button class="ghost-btn" id="set-restore">从备份还原</button>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">关于</h3>
      <p class="card-desc">
        课程资料库是一个纯本地的网页应用：没有账号，没有服务器，不会上传任何文件。<br>
        你把文件拖进来，它按课程归好类；换设备或清数据前，用上面的备份功能存档。
      </p>
      <p class="card-desc" style="font-size:12.5px;margin-bottom:0">
        分类识别基于文件名和目录名，认不出的会进「待整理」而不是硬猜——猜错比留白更伤信任。
      </p>
    </div>

    <div class="card" style="border-color:#f0c8c8">
      <h3 class="card-title" style="color:var(--danger)">危险操作</h3>
      <p class="card-desc">清空资料库里的全部数据，不可撤销。建议先导出备份。</p>
      <div class="card-actions">
        <button class="ghost-btn" id="set-wipe" style="color:var(--danger);border-color:#eeb4b4">清空全部数据</button>
      </div>
    </div>`;

  main.querySelector('#set-export-all').onclick = async () => {
    const progress = openProgress('正在打包…');
    try {
      const d = await currentData();
      const blob = await exportCourses(d, null, (msg) => progress.set(msg));
      downloadBlob(blob, `课程资料全部_${todayStamp()}.zip`);
      progress.close();
      toast('已开始下载');
    } catch (err) {
      progress.close();
      toast('导出失败：' + err.message);
    }
  };

  main.querySelector('#set-backup').onclick = async () => {
    const progress = openProgress('正在生成备份…');
    try {
      const d = await currentData();
      const blob = await exportBackup(d, (msg) => progress.set(msg));
      downloadBlob(blob, `课程资料库备份_${todayStamp()}.zip`);
      progress.close();
      toast('备份已开始下载，请妥善保存');
    } catch (err) {
      progress.close();
      toast('备份失败：' + err.message);
    }
  };

  main.querySelector('#set-restore').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      openConfirmRestore(file);
    };
    input.click();
  };

  main.querySelector('#set-wipe').onclick = () => {
    const m = openModal({
      title: '清空全部数据',
      body: `<p style="line-height:1.8;margin:0">
        这会删除资料库里的所有课程和文件，<b style="color:var(--danger)">不可撤销</b>。<br>
        请确认你已经导出过备份。</p>`,
      foot: `<span class="spacer"></span>
        <button class="ghost-btn" id="wipe-cancel">取消</button>
        <button class="primary-btn" id="wipe-ok" style="background:var(--danger)">确认清空</button>`,
    });
    m.foot.querySelector('#wipe-cancel').onclick = () => m.close();
    m.foot.querySelector('#wipe-ok').onclick = async () => {
      for (const s of ['files', 'blobs', 'texts', 'courses', 'semesters', 'categories']) {
        await db.clear(s);
      }
      state.courseId = null;
      state.semesterId = null;
      state.selection.clear();
      await loadAll();
      m.close();
      state.view = 'course';
      toast('已清空');
      render();
    };
  };
}

function openConfirmRestore(file) {
  const m = openModal({
    title: '从备份还原',
    body: `<p style="line-height:1.8;margin:0">
      将从 <b>${escapeHtml(file.name)}</b> 还原。<br>
      <b style="color:var(--danger)">现有的全部数据会被覆盖。</b><br>
      <span style="color:var(--muted);font-size:13px">
        还原后正文需要重新提取一次，稍等片刻即可恢复搜索能力。</span></p>`,
    foot: `<span class="spacer"></span>
      <button class="ghost-btn" id="rs-cancel">取消</button>
      <button class="primary-btn" id="rs-ok">开始还原</button>`,
  });

  m.foot.querySelector('#rs-cancel').onclick = () => m.close();
  m.foot.querySelector('#rs-ok').onclick = async () => {
    m.close();
    const progress = openProgress('正在还原…');
    try {
      const r = await importBackup(file, (msg) => progress.set(msg));
      await loadAll();
      progress.close();
      toast(`还原完成：${r.courses} 门课程、${r.files} 个文件${r.missing ? `（${r.missing} 个缺失）` : ''}`);
      state.view = 'course';
      render();
      runExtractionQueue();
    } catch (err) {
      progress.close();
      console.error(err);
      toast('还原失败：' + err.message);
    }
  };
}

// ============================ 弹层 ============================

function openModal({ title, body, foot, wide }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">
    <div class="modal-head">
      <span class="modal-title">${escapeHtml(title)}</span>
      <span class="spacer"></span>
      <button class="close-x" aria-label="关闭">×</button>
    </div>
    <div class="modal-body"></div>
    ${foot ? '<div class="modal-foot">' + foot + '</div>' : ''}
  </div>`;

  document.body.appendChild(backdrop);
  const bodyEl = backdrop.querySelector('.modal-body');
  bodyEl.innerHTML = body || '';
  const footEl = backdrop.querySelector('.modal-foot');

  const close = () => backdrop.remove();
  backdrop.querySelector('.close-x').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  return { el: backdrop, body: bodyEl, foot: footEl, close };
}

function openProgress(initial) {
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `<div class="modal" style="max-width:380px">
    <div class="modal-body progress-box">
      <div class="progress-text">${escapeHtml(initial)}</div>
      <div class="progress-bar"><i></i></div>
    </div>
  </div>`;
  document.body.appendChild(el);
  return {
    set: (msg) => { const t = el.querySelector('.progress-text'); if (t) t.textContent = msg; },
    close: () => el.remove(),
  };
}

// ============================ 课程 / 学期管理 ============================

function openSemesterDialog() {
  const m = openModal({
    title: '新建学期',
    body: `<div class="field">
      <label class="field-label">学期名称</label>
      <input type="text" id="sem-name" placeholder="例如：2025 秋" />
    </div>`,
    foot: `<span class="spacer"></span>
      <button class="ghost-btn" id="sem-cancel">取消</button>
      <button class="primary-btn" id="sem-ok">创建</button>`,
  });

  const input = m.body.querySelector('#sem-name');
  input.focus();

  const submit = async () => {
    const name = input.value.trim();
    if (!name) { toast('请填学期名称'); return; }
    const id = uid();
    await db.put('semesters', { id, name, sortOrder: state.semesters.length, createdAt: Date.now() });
    await loadAll();
    state.semesterId = id;
    m.close();
    toast('学期已创建，接着建课程吧');
    render();
    openCourseDialog();
  };

  m.foot.querySelector('#sem-cancel').onclick = () => m.close();
  m.foot.querySelector('#sem-ok').onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

function openCourseDialog(existing) {
  const isEdit = !!existing;

  // 课程必须挂在某个学期下，没有学期就先引导建学期，否则建出来的课在侧栏里不显示
  if (!state.semesters.length) {
    toast('先建一个学期，再建课程');
    openSemesterDialog();
    return;
  }

  const semester = existing
    ? state.semesters.find((s) => s.id === existing.semesterId)
    : (state.semesters.find((s) => s.id === state.semesterId) || state.semesters[0]);

  const m = openModal({
    title: isEdit ? '编辑课程' : '新建课程',
    body: `
      <div class="field">
        <label class="field-label">课程名称 *</label>
        <input type="text" id="c-name" placeholder="例如：高等数学" value="${escapeHtml(existing?.name || '')}" />
        <div class="field-hint">填全称就好，常用简称会自动带上，识别文件时两者都认。</div>
      </div>
      <div class="field">
        <label class="field-label">所属学期</label>
        <select id="c-sem">${state.semesters.map((s) =>
          `<option value="${s.id}" ${s.id === semester?.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label class="field-label">老师（选填）</label>
        <input type="text" id="c-teacher" placeholder="资料传承时能标清是谁的课" value="${escapeHtml(existing?.teacher || '')}" />
      </div>
      <div class="field">
        <label class="field-label">别名（选填）</label>
        <input type="text" id="c-aliases" placeholder="用逗号分隔" value="${escapeHtml((existing?.aliases || []).join('，'))}" />
        <div class="field-hint" id="alias-hint">文件名里几乎不会写课程全称，填上简称能大幅提高识别率。</div>
      </div>`,
    foot: `<span class="spacer"></span>
      ${isEdit ? '<button class="link-btn danger" id="c-del">删除课程</button>' : ''}
      <button class="ghost-btn" id="c-cancel">取消</button>
      <button class="primary-btn" id="c-ok">${isEdit ? '保存' : '创建'}</button>`,
  });

  const nameInput = m.body.querySelector('#c-name');
  const aliasInput = m.body.querySelector('#c-aliases');
  const semSel = m.body.querySelector('#c-sem');
  nameInput.focus();

  // 输入课程名时自动补上预置简称
  if (!isEdit) {
    nameInput.oninput = () => {
      const sug = suggestAliases(nameInput.value.trim());
      if (sug.length && !aliasInput.value.trim()) {
        aliasInput.value = sug.join('，');
        aliasInput.style.background = '#eaf1ff';
        setTimeout(() => { aliasInput.style.background = ''; }, 600);
      }
    };
  }

  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('请填课程名称'); return; }

    const aliases = aliasInput.value.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);

    if (isEdit) {
      Object.assign(existing, { name, teacher: m.body.querySelector('#c-teacher').value.trim(), aliases, semesterId: semSel.value });
      await db.put('courses', existing);
      await loadAll();
      m.close();
      toast('已保存');
      render();
      return;
    }

    const courseId = uid();
    const course = {
      id: courseId,
      name,
      teacher: m.body.querySelector('#c-teacher').value.trim(),
      aliases,
      semesterId: semSel.value,
      color: COURSE_COLORS[state.courses.length % COURSE_COLORS.length],
      sortOrder: state.courses.length,
      createdAt: Date.now(),
    };
    await db.put('courses', course);

    // 每门课建一套自己的分类（从默认模板复制），这样改一门课的分类不会影响别的课
    const cats = DEFAULT_CATEGORIES.map((c, i) => ({
      id: uid(),
      courseId,
      key: c.key,
      name: c.name,
      icon: c.icon,
      sortOrder: i + 1,
      builtin: true,
    }));
    await db.putTx({ categories: cats });

    await loadAll();
    state.courseId = courseId;
    state.view = 'course';
    m.close();
    toast(`课程「${name}」已创建`);
    render();
  };

  m.foot.querySelector('#c-cancel').onclick = () => m.close();
  m.foot.querySelector('#c-ok').onclick = submit;
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  aliasInput.onkeydown = (e) => { if (e.key === 'Enter') submit(); };

  const delBtn = m.foot.querySelector('#c-del');
  if (delBtn) delBtn.onclick = () => {
    const n = filesOfCourse(existing.id).length;
    const confirm = openModal({
      title: '删除课程',
      body: `<p style="line-height:1.8;margin:0">
        将删除课程「${escapeHtml(existing.name)}」${n ? `以及它下面的 <b>${n}</b> 个文件` : ''}，不可撤销。</p>`,
      foot: `<span class="spacer"></span>
        <button class="ghost-btn" id="cd-cancel">取消</button>
        <button class="primary-btn" id="cd-ok" style="background:var(--danger)">删除</button>`,
    });
    confirm.foot.querySelector('#cd-cancel').onclick = () => confirm.close();
    confirm.foot.querySelector('#cd-ok').onclick = async () => {
      const ids = filesOfCourse(existing.id).map((f) => f.id);
      const catIds = categoriesOf(existing.id).map((c) => c.id);
      if (ids.length) await db.deleteTx({ files: ids, blobs: ids, texts: ids });
      if (catIds.length) await db.deleteTx({ categories: catIds });
      await db.remove('courses', existing.id);
      state.courseId = state.courses.find((c) => c.id !== existing.id)?.id || null;
      await loadAll();
      confirm.close();
      m.close();
      toast('课程已删除');
      render();
    };
  };
}

function openCategoryManager(course) {
  const renderBody = () => {
    const cats = categoriesOf(course.id);
    const body = m.body;
    body.innerHTML = `
      <p class="card-desc" style="margin-top:0">
        这门课的分类。改这里不会影响其它课程。<br>
        带 <span class="tag tag-old">默认</span> 的分类参与自动识别，自建的只做手动归类用。
      </p>
      <div class="file-list">
        ${cats.map((c) => {
          const n = filesOfCourse(course.id).filter((f) => f.categoryId === c.id).length;
          return `<div class="file-row">
            <div class="file-ico">${escapeHtml(c.icon || '📎')}</div>
            <div class="file-main">
              <div class="file-name">${escapeHtml(c.name)}
                ${c.key ? '<span class="tag tag-old">默认</span>' : ''}</div>
              <div class="file-sub"><span>${n} 个文件</span></div>
            </div>
            <div class="file-actions" style="opacity:1">
              <button class="link-btn" data-rename="${c.id}">改名</button>
              ${cats.length > 1 ? `<button class="link-btn danger" data-delcat="${c.id}">删除</button>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:14px;display:flex;gap:8px">
        <input type="text" id="new-cat-name" placeholder="新分类名称" style="flex:1;height:36px;padding:0 11px;border:1px solid var(--border-strong);border-radius:8px" />
        <button class="ghost-btn" id="add-cat">添加</button>
      </div>`;

    body.querySelectorAll('[data-rename]').forEach((b) => {
      b.onclick = async () => {
        const c = state.categories.find((x) => x.id === b.dataset.rename);
        const name = prompt('新的分类名', c.name);
        if (!name || !name.trim()) return;
        c.name = name.trim();
        await db.put('categories', c);
        await loadAll();
        renderBody();
        renderView();
      };
    });

    body.querySelectorAll('[data-delcat]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.delcat;
        const n = filesOfCourse(course.id).filter((f) => f.categoryId === id).length;
        if (!confirm(n ? `该分类下有 ${n} 个文件，删除后这些文件会移到「其他」。继续？` : '删除这个分类？')) return;

        const fallback = categoriesOf(course.id).find((c) => c.id !== id);
        const moved = filesOfCourse(course.id).filter((f) => f.categoryId === id);
        moved.forEach((f) => { f.categoryId = fallback?.id || null; });
        if (moved.length) await db.putTx({ files: moved });
        await db.remove('categories', id);
        await loadAll();
        renderBody();
        renderView();
      };
    });

    body.querySelector('#add-cat').onclick = async () => {
      const input = body.querySelector('#new-cat-name');
      const name = input.value.trim();
      if (!name) return;
      await db.put('categories', {
        id: uid(),
        courseId: course.id,
        key: null,           // 自建分类没有词表，不参与自动识别
        name,
        icon: '📌',
        sortOrder: categoriesOf(course.id).length + 1,
      });
      await loadAll();
      renderBody();
      renderView();
    };
  };

  const m = openModal({ title: `管理分类 · ${course.name}`, body: '', foot: `<span class="spacer"></span><button class="ghost-btn" id="cm-close">关闭</button>` });
  m.foot.querySelector('#cm-close').onclick = () => m.close();
  renderBody();
}

// ============================ 杂项 ============================

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}
