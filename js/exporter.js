// 导出与备份：打包成 zip 下载，以及从备份 zip 还原
//
// 依赖全局 JSZip（由 index.html 以 <script> 引入，和记账本的 ECharts 同一模式）。
//
// 备份包结构：<学期>/<课程>/<分类>/<文件名> + 根目录 metadata.json
// 刻意不把提取出的正文放进备份——那会让备份体积翻倍，而正文是可以重新提取的。

import { get, deleteTx, putTx, clear } from './db.js';
import { uid, extOf, naturalCompare } from './util.js';

const META_NAME = 'metadata.json';
const APP_TAG = 'course-library';

// 把一批文件（含 blob）按 <学期>/<课程>/<分类>/ 分组塞进 zip
async function addFilesToZip(zip, fileRecords, ctx) {
  const used = new Set();
  const entries = [];

  const sorted = [...fileRecords].sort((a, b) => naturalCompare(a.name, b.name));
  for (const f of sorted) {
    const row = await get('blobs', f.id);
    if (!row || !row.blob) continue; // 文件本体丢了就跳过，不让整包导出失败

    const course = ctx.courses.get(f.courseId);
    const sem = course?.semesterName || '未分学期';
    const courseName = course?.name || '未归类';
    const cat = ctx.categories.get(f.categoryId) || '其他';

    let path = `${sem}/${courseName}/${cat}/${f.name}`;
    path = path.replace(/[\\:*?"<>|]/g, '_'); // Windows 不允许的字符

    // 同名文件加序号，避免互相覆盖
    let finalPath = path;
    let n = 2;
    while (used.has(finalPath)) {
      const dot = path.lastIndexOf('.');
      finalPath = dot > 0 ? `${path.slice(0, dot)}(${n})${path.slice(dot)}` : `${path}(${n})`;
      n++;
    }
    used.add(finalPath);

    zip.file(finalPath, row.blob);
    entries.push({ ...f, path: finalPath });
  }
  return entries;
}

// 课程要带上所属学期名，因为文件记录里只存 courseId，拼路径时需要反查学期
function buildContext(semesters, courses, categories) {
  const semName = new Map(semesters.map((s) => [s.id, s.name]));
  return {
    semesters: semName,
    courses: new Map(
      courses.map((c) => [c.id, { ...c, semesterName: semName.get(c.semesterId) || '未分学期' }])
    ),
    categories: new Map(categories.map((c) => [c.id, c.name])),
  };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function onProgress(cb, msg) {
  if (typeof cb === 'function') cb(msg);
}

/**
 * 导出选定的课程为 zip。
 * @param {object} data 全量数据 {semesters, courses, categories, files}
 * @param {string[]} courseIds 要导出的课程；传 null 表示全部
 */
export async function exportCourses(data, courseIds, progress) {
  const zip = new JSZip();
  const ctx = buildContext(data.semesters, data.courses, data.categories);

  const courses = courseIds
    ? data.courses.filter((c) => courseIds.includes(c.id))
    : data.courses;

  const courseIdSet = new Set(courses.map((c) => c.id));
  // courseIds 传 null 表示「全部」——此时连待整理（无课程）的文件也要带上，
  // 否则用户点「导出全部」会静悄悄丢掉一批文件
  const targets = courseIds ? data.files.filter((f) => courseIdSet.has(f.courseId)) : data.files;

  onProgress(progress, `正在打包 ${targets.length} 个文件…`);
  await addFilesToZip(zip, targets, ctx);

  onProgress(progress, '正在压缩…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return blob;
}

/** 全量备份：文件 + metadata.json，用于换设备或清浏览器数据前存档 */
export async function exportBackup(data, progress) {
  const zip = new JSZip();
  const ctx = buildContext(data.semesters, data.courses, data.categories);

  onProgress(progress, `正在打包 ${data.files.length} 个文件…`);
  const entries = await addFilesToZip(zip, data.files, ctx);

  const meta = {
    app: APP_TAG,
    version: 1,
    exportedAt: Date.now(),
    semesters: data.semesters,
    courses: data.courses,
    categories: data.categories,
    // 正文不进备份包，恢复后重新提取
    files: entries.map(({ blob, ...rest }) => rest),
  };
  zip.file(META_NAME, JSON.stringify(meta, null, 2));

  onProgress(progress, '正在压缩…');
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/**
 * 从备份 zip 还原。会先清空现有数据（调用方需先征得用户确认）。
 * @returns {Promise<{semesters:number, courses:number, files:number, missing:number}>}
 */
export async function importBackup(file, progress) {
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('这个文件不是 zip，或者下载时损坏了。请重新导出备份再试。');
  }

  const metaFile = zip.file(META_NAME);
  if (!metaFile) throw new Error('这不是本工具导出的备份文件（缺少 metadata.json）');

  let meta;
  try {
    meta = JSON.parse(await metaFile.async('string'));
  } catch {
    throw new Error('备份包里的 metadata.json 读不出来，文件可能已损坏。');
  }
  if (meta.app !== APP_TAG) throw new Error('备份文件来自其它应用，无法还原');

  const rawFiles = Array.isArray(meta.files) ? meta.files : [];

  // —— 动手清空之前的最后一道检查 ——
  // 清空是不可逆的，而「选错文件」是最常见的失败：
  // 把「导出全部资料」的包当成备份导进来（它没有 metadata.json，上面已经拦了），
  // 或者下载没下完、zip 被截断。所以先拿 zip 的目录索引核对一遍文件名，
  // 这一步不需要解压任何文件，几乎不花时间，但能在毁掉数据之前喊停。
  if (rawFiles.length) {
    const absent = rawFiles.filter((fm) => !fm.path || !zip.file(fm.path)).length;
    if (absent > rawFiles.length * 0.2) {
      throw new Error(
        `备份包不完整：${rawFiles.length} 个文件里有 ${absent} 个在包里找不到。` +
        `为安全起见没有清空现有数据，请换一个备份文件重试。`
      );
    }
  }

  // —— 重新发一套 id ——
  // 库里所有 id 本该是 uid() 生成的，所以拼 HTML 时到处直接把 ${x.id} 写进属性，
  // 谁也没想过它会是别的样子。但备份包是别人给的：metadata.json 里的 id 想写什么写什么，
  // 一个带引号加事件属性的 id 就能从 data-* 里逃出来执行脚本。
  // 与其在十几个拼 HTML 的地方各补一次转义（那种事总有一处会漏），
  // 不如在这儿掐掉：进来的 id 一律不用，统一重发，并把互相之间的引用一起改过来。
  // 顺带也修掉了重复 id、缺失 id 这类脏数据。
  const idMap = new Map();
  const remap = (old) => {
    if (old == null || old === '') return uid();
    const key = String(old);
    if (!idMap.has(key)) idMap.set(key, uid());
    return idMap.get(key);
  };

  // 顺序不能乱：定义方先处理，后面引用它的才拿得到同一个新 id
  const semesters = (meta.semesters || []).map((s) => ({ ...s, id: remap(s.id) }));
  const courses = (meta.courses || []).map((c) => ({
    ...c,
    id: remap(c.id),
    semesterId: remap(c.semesterId),
  }));
  const categories = (meta.categories || []).map((c) => ({
    ...c,
    id: remap(c.id),
    courseId: remap(c.courseId),
  }));
  const fileMetas = rawFiles.map((f) => ({
    ...f,
    id: remap(f.id),
    courseId: remap(f.courseId),
    categoryId: remap(f.categoryId),
  }));

  onProgress(progress, '正在清空现有数据…');
  await clear('files');
  await clear('blobs');
  await clear('texts');
  await clear('courses');
  await clear('semesters');
  await clear('categories');

  // 先把元数据一次写进去
  await putTx({
    semesters,
    courses,
    categories,
    files: fileMetas.map(({ path, ...rest }) => ({
      ...rest,
      // 正文丢了，标记为待重新提取
      textContent: undefined,
      extractStatus: 'pending',
    })),
  });

  onProgress(progress, '正在还原文件…');
  let missing = 0;
  let done = 0;
  for (const fm of fileMetas) {
    if (!fm.path) { missing++; continue; }
    const entry = zip.file(fm.path);
    if (!entry) { missing++; continue; }

    const blob = await entry.async('blob');
    await putTx({ blobs: { id: fm.id, blob } });
    done++;
    if (done % 20 === 0) onProgress(progress, `正在还原文件… ${done}/${fileMetas.length}`);
  }

  return { semesters: semesters.length, courses: courses.length, files: done, missing };
}

export { downloadBlob };
