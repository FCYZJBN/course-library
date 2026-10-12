// 导出到文件夹：把整个资料库按「学期 / 课程 / 分类」写进用户自己选的真实文件夹。
//
// 为什么单独一个模块，而不是并进 exporter.js：
// 磁盘那半截在这儿测不了——showDirectoryPicker 要真实用户手势，无头浏览器里调不动。
// 所以职责切成两片：
//   buildExportPlan(data)  纯函数，只吃数据、只吐清单，Node 里能直接单测；
//   writeExportPlan(...)   照着清单往句柄里写，冒烟测试里拿 OPFS 当替身跑。
// 路径规则（非法字符、保留名、超长截断、同名加序号）全挤在纯函数那片，
// 那才是真正会出错、也真正值得反复单测的地方。
//
// 和 zip 备份的区别：zip 是「一份可以搬走的快照」，这里是「一棵看得见的目录树」。
// 这一级是一次性的导出：不记住句柄、不监听文件夹变化、不删除任何文件、
// 也不接管整理操作——那些是后面几级台阶的事。

import { naturalCompare } from './util.js';

const APP_TAG = 'course-library';

export const LIB_META = '_library.json';
export const SEM_META = '_semester.json';
export const COURSE_META = '_courselib.json';
export const UNFILED_DIR = '_待整理';
export const UNASSIGNED_SEM = '未分学期';

// Windows 文件名里不允许出现的字符。斜杠也在内——它在这儿是路径分隔符，
// 一个叫「第3章/习题.docx」的文件会凭空多出一层目录，还原时结构就对不上了。
const ILLEGAL_RE = /[\\/:*?"<>|]/g;
// 控制字符，含换行。从网页另存下来的文件名里偶尔混着。
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
// Windows 的设备名。只比主干，所以 `CON.docx` 一样非法，且不分大小写。
const RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
// 结尾的点和空格：Windows 会静默吃掉，于是磁盘上的名字和清单对不上。
const TRAILING_RE = /[. ]+$/;

// 路径长度预算。Windows 的硬上限是 260 个字符，但这里拿不到用户在磁盘上的绝对路径
// （File System Access API 刻意不暴露它），所以算不出总数，只能给自己的相对路径
// 留一份保守预算：假设根目录不超过 80 字符（`D:\课程资料\` 11 个，OneDrive 深层目录
// 约 45 个），相对路径就卡在 180。真撞上 260 的时候，报错会发生在写入那一刻，
// 而不是导到一半才发现。
const MAX_REL_PATH = 180;
const MIN_STEM = 8; // 截断后至少留这么多字符的主干，否则全变成「第3章…」

/**
 * 把一个名字净化成 Windows 上合法的单个路径段。
 * notes 收集所有改动，最后原样汇报给用户——静默改名比不改名更糟。
 */
function sanitizeSegment(raw, notes, kind) {
  const from = String(raw ?? '');
  let out = from.replace(ILLEGAL_RE, '_').replace(CONTROL_RE, '');
  out = out.replace(TRAILING_RE, '');
  if (!out) out = '未命名';
  const dot = out.lastIndexOf('.');
  const stem = dot > 0 ? out.slice(0, dot) : out;
  if (RESERVED_RE.test(stem)) out = `_${out}`;
  if (out !== from) notes.push({ kind: 'renamed', what: kind, from, to: out });
  return out;
}

/** 超长就把主干截短，保留扩展名——扩展名一丢，文件双击就打不开了。 */
function truncateName(dirPath, name, notes) {
  const prefix = dirPath ? dirPath.length + 1 : 0;
  const budget = MAX_REL_PATH - prefix;
  if (name.length <= budget) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const stem = dot > 0 ? name.slice(0, dot) : name;
  // 至少留 MIN_STEM，且一定比原来短——保证循环会收敛
  const keep = Math.min(stem.length, Math.max(MIN_STEM, budget - ext.length));
  const out = stem.slice(0, keep) + ext;
  notes.push({ kind: 'truncated', what: '文件名', from: name, to: out });
  return out;
}

/**
 * 把资料库算成一份「要建哪些目录、要写哪些文件」的清单。
 *
 * 纯函数：不碰 DOM、不碰 IndexedDB、不碰磁盘。同一个 data 进去，清单永远一样。
 * 文件名和目录名是这里唯一会「变」的东西——凡是变了都记在 notes 里。
 *
 * @param {{semesters,courses,categories,files}} data
 * @param {number} now 导出时刻，只用于 _library.json 的时间戳
 */
export function buildExportPlan(data, now = Date.now()) {
  const notes = [];
  const dirs = [];     // 要建的目录，父目录在前
  const sidecars = []; // 目录里的说明文件
  const entries = [];  // 要写的资料文件（正文只在库里，不写盘）
  const usedNames = new Map(); // 目录 → 已占用的名字（小写）

  // Windows 的文件系统大小写不敏感：`ABC.docx` 和 `abc.docx` 是同一个文件。
  // 按小写去重，否则第二个会静默盖掉第一个，而报告里还说「写了两个」。
  // 目录和文件共用一个命名空间——同一个位置上不能既叫这个名字又是那个名字。
  function alloc(dirKey, name) {
    const key = dirKey.toLowerCase();
    let set = usedNames.get(key);
    if (!set) { set = new Set(); usedNames.set(key, set); }
    let out = name;
    let n = 2;
    while (set.has(out.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      out = dot > 0 ? `${name.slice(0, dot)}(${n})${name.slice(dot)}` : `${name}(${n})`;
      n++;
    }
    set.add(out.toLowerCase());
    return out;
  }

  const bySort = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  const semesters = [...(data.semesters || [])].sort(bySort);
  const courses = [...(data.courses || [])].sort(bySort);
  // 文件按名字排：加序号去重时「谁拿原名」就有了确定的答案，而不是看数据库的返回顺序
  const files = [...(data.files || [])].sort((a, b) => naturalCompare(a.name || '', b.name || ''));
  const catNames = new Map((data.categories || []).map((c) => [c.id, c.name]));

  sidecars.push({
    path: LIB_META,
    data: { app: APP_TAG, version: 1, exportedAt: new Date(now).toISOString() },
  });

  // —— 学期：目录总是建，哪怕一门课都没有 ——
  // 空目录在这一级是货真价实的信息：「这个学期我还没开始往里放东西」。
  // 分类目录的做法正相反，见下面文件那段。
  const semSegs = new Map();
  for (const s of semesters) {
    const seg = alloc('', sanitizeSegment(s.name, notes, '学期名'));
    semSegs.set(s.id, [seg]);
    dirs.push(seg);
    sidecars.push({
      path: `${seg}/${SEM_META}`,
      // 带上 name：目录名是净化过的，万一原名里有非法字符，只有这里还留着真名
      data: { app: APP_TAG, version: 1, name: s.name, sortOrder: s.sortOrder ?? 0 },
    });
  }

  // —— 课程：目录总是建 + 一份 _courselib.json ——
  // sidecar 只有这么几个字段，因为其余全是可推导的：版本标签由文件名分组算出来、
  // 分类来自内置的默认表、文件列表就是目录里躺着的东西。凡是能推出来的都不抄第二份，
  // 抄了就有两个真相，迟早对不上。
  const courseSegs = new Map();
  let orphanDir = null;
  const orphanSegs = () => {
    // 课程的学期没了（理论上不该发生，删除学期会连带删课程）。
    // 单独开一个目录，别让它们凭空消失
    if (!orphanDir) {
      orphanDir = alloc('', UNASSIGNED_SEM);
      dirs.push(orphanDir);
    }
    return [orphanDir];
  };
  for (const c of courses) {
    const parent = semSegs.get(c.semesterId) || orphanSegs();
    const seg = alloc(parent.join('/'), sanitizeSegment(c.name, notes, '课程名'));
    const segs = [...parent, seg];
    courseSegs.set(c.id, segs);
    dirs.push(segs.join('/'));
    sidecars.push({
      path: [...segs, COURSE_META].join('/'),
      data: {
        app: APP_TAG,
        version: 1,
        name: c.name,
        aliases: [...(c.aliases || [])],
        teacher: c.teacher || '',
        color: c.color || '',
        icon: c.icon || '',
        sortOrder: c.sortOrder ?? 0,
      },
    });
  }

  // —— 文件 ——
  let unfiledSegs = null;
  const unfiledDir = () => {
    if (!unfiledSegs) {
      unfiledSegs = [alloc('', UNFILED_DIR)];
      dirs.push(unfiledSegs[0]);
    }
    return unfiledSegs;
  };
  const catSegs = new Map(); // `${courseId}\0${categoryId}` → segs

  for (const f of files) {
    const base = courseSegs.get(f.courseId);
    let segs;

    if (!base) {
      // 待整理：这里的分类是导入时猜的、用户从没确认过。把它当结构写到磁盘上
      // 等于给一个猜测盖章。索性摊平，让用户自己决定怎么分。
      segs = unfiledDir();
    } else {
      // 分类目录懒创建：只在真有文件要放进去时才建。一门课 5 个分类、3 个是空的，
      // 建出来只会让用户以为「这几个分类我该去填」，而它其实只是默认表。
      // 还要先去重再建，否则同一个「课件」会被 alloc 分配成「课件」「课件(2)」……
      const dirPath = base.join('/');
      const key = `${f.courseId}\u0000${f.categoryId ?? ''}`;
      segs = catSegs.get(key);
      if (!segs) {
        const seg = alloc(dirPath, sanitizeSegment(catNames.get(f.categoryId) || '其他', notes, '分类名'));
        segs = [...base, seg];
        catSegs.set(key, segs);
        dirs.push(segs.join('/'));
      }
    }

    const dirPath = segs.join('/');
    const cleaned = sanitizeSegment(f.name, notes, '文件名');
    // 先截断再 alloc：反过来的话，被截掉的可能是刚加上的「(2)」
    const name = alloc(dirPath, truncateName(dirPath, cleaned, notes));
    entries.push({
      path: `${dirPath}/${name}`,
      fileId: f.id,
      name: f.name || '',
      size: f.size || 0,
    });
  }

  return {
    dirs,
    sidecars,
    entries,
    notes,
    counts: {
      semesters: semesters.length,
      courses: courses.length,
      files: entries.length,
    },
  };
}

// ============================ 磁盘那半截 ============================

async function collectFiles(dir, prefix, out) {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') await collectFiles(handle, path, out);
    else out.push(path);
  }
}

async function hasOurLibTag(dirHandle) {
  try {
    const fh = await dirHandle.getFileHandle(LIB_META);
    const meta = JSON.parse(await (await fh.getFile()).text());
    return meta?.app === APP_TAG;
  } catch {
    // 读不出来、不是 JSON、或者根本不是我们写的——一律当外人
    return false;
  }
}

/**
 * 看看用户挑的文件夹能不能往里写。
 *   fresh     空的，随便写
 *   overwrite 里面有我们自己的 _library.json，认作上次的导出，往上叠
 *   blocked   有别人的东西，不碰
 *
 * 「有别人的东西」是真的不碰：往一个装满照片的文件夹里倒 520 个课程文件，
 * 用户要收拾就得一个个删。这个风险不该由一次误点来承担，
 * 所以挡住，并说清楚该换个空文件夹。
 */
export async function inspectTargetFolder(dirHandle) {
  let count = 0;
  let tagged = false;
  for await (const [name, handle] of dirHandle.entries()) {
    count++;
    // 同名不等于同源，所以还要把 tag 读出来认一下
    if (handle.kind === 'file' && name === LIB_META) tagged = await hasOurLibTag(dirHandle);
  }
  if (!count) return { mode: 'fresh', existing: [] };
  if (tagged) {
    const existing = [];
    await collectFiles(dirHandle, '', existing);
    return { mode: 'overwrite', existing };
  }
  return { mode: 'blocked', existing: [] };
}

/**
 * 照着清单往文件夹里写。
 *
 * 单个文件写不进去不该让整批停摆（名字太长、磁盘满、文件被占用都只影响它自己），
 * 收集起来最后一起报告。整个操作级别的失败（权限被拒、句柄失效）则直接抛，
 * 因为那意味着后面每一个都会失败，硬撑着只是白等。
 *
 * @param {FileSystemDirectoryHandle} root
 * @param {ReturnType<typeof buildExportPlan>} plan
 * @param {{getBlob:(id)=>Promise<{blob:Blob}|undefined>, existing?:string[], onProgress?:(msg:string)=>void}} opts
 */
export async function writeExportPlan(root, plan, opts = {}) {
  const { getBlob, existing = [], onProgress } = opts;
  const notes = [...plan.notes];
  const failures = [];
  const dirCache = new Map();

  async function dirFor(segs) {
    const key = segs.join('/');
    const hit = dirCache.get(key);
    if (hit) return hit;
    let d = root;
    for (const s of segs) d = await d.getDirectoryHandle(s, { create: true });
    dirCache.set(key, d);
    return d;
  }

  // createWritable 写的是临时文件，close 的时候才替换正式文件。
  // 所以写坏了要 abort 丢掉——否则会把一个本来好好的旧文件换成半截的。
  async function writeBlob(dir, name, blob) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(blob);
    } catch (err) {
      try { await w.abort(); } catch {}
      throw err;
    }
    await w.close();
  }

  // 目录先建齐，空学期空课程才算数
  for (const p of plan.dirs) await dirFor(p.split('/'));

  const metaPaths = new Set();
  for (const sc of plan.sidecars) {
    const segs = sc.path.split('/');
    const name = segs.pop();
    const json = `${JSON.stringify(sc.data, null, 2)}\n`;
    await writeBlob(await dirFor(segs), name, new Blob([json], { type: 'application/json' }));
    metaPaths.add(sc.path);
  }

  const total = plan.entries.length;
  let written = 0;
  let bytes = 0;
  let missing = 0;
  let failed = 0;

  for (let i = 0; i < plan.entries.length; i++) {
    const e = plan.entries[i];
    const segs = e.path.split('/');
    const name = segs.pop();
    try {
      const row = await getBlob(e.fileId);
      if (!row || !row.blob) {
        // 文件本体丢了（导入中断、配额回收）。跳过并报告，让这一批剩下的照常写
        missing++;
        notes.push({ kind: 'missing', what: '文件', from: e.name, to: '', path: e.path });
      } else {
        await writeBlob(await dirFor(segs), name, row.blob);
        written++;
        bytes += row.blob.size || 0;
      }
    } catch (err) {
      failed++;
      failures.push({ path: e.path, reason: err?.name || 'Error', message: err?.message || String(err) });
    }
    if (onProgress) onProgress(`正在写入 ${i + 1}/${total}…`);
  }

  // 上次导出留下、这次库里已经没有的：只报告，不删。
  // 「导出」这个动作不该攥着删除权——那份东西还有没有用，只有用户知道。
  const current = new Set([...plan.entries.map((e) => e.path), ...metaPaths]);
  const leftovers = existing.filter((p) => !current.has(p));

  return { written, bytes, missing, failed, failures, leftovers, notes, total, counts: plan.counts };
}
