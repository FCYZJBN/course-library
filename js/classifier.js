// 分类引擎：从文件名推断「属于哪门课」「属于哪个分类」「是不是最新版」
//
// 三条规则按可靠性排序，本模块负责前两条，第三条另见 recomputeVersions：
//   1. 文件名里的课程名 / 课程别名   —— 最可靠
//   2. 文件名里的分类关键词           —— 加权打分
//   3. 不猜。认不出就留空，交给「待整理」区让用户手动分配

import { splitExt, naturalCompare } from './util.js';
import { CATEGORY_KEYWORDS, LATEST_WORDS, VERSION_PATTERNS } from './seed.js';

// 课程名归一：小写、去掉空格与常见分隔符，便于在文件名里做子串匹配
function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-—–·．.、,，]/g, '');
}

/**
 * 从文件名猜课程。
 * 命中多门课时取「匹配串最长」的那门——越长越具体，
 * 例如「大学物理实验」应当胜过「大学物理」。
 * @returns {{courseId: string, via: string, len: number} | null}
 */
export function guessCourse(filename, courses) {
  const hay = norm(splitExt(filename).base);
  if (!hay) return null;

  let best = null;
  for (const c of courses || []) {
    const candidates = [c.name, ...(c.aliases || [])];
    for (const cand of candidates) {
      const needle = norm(cand);
      if (needle.length < 2) continue; // 单字别名太容易误伤，忽略
      if (hay.includes(needle)) {
        if (!best || needle.length > best.len) {
          best = { courseId: c.id, via: cand, len: needle.length };
        }
      }
    }
  }
  return best;
}

/**
 * 从文件名推断分类。加权打分，取总分最高者；全部不命中则落到「其他」。
 * @returns {{categoryId: string, score: number}}
 */
export function guessCategory(filename, categories) {
  const hay = norm(splitExt(filename).base);

  let bestId = null;
  let bestScore = 0;

  for (const cat of categories || []) {
    // 全局默认分类按 key 查词表；用户自建分类没有词表，不参与推断
    const table = CATEGORY_KEYWORDS[cat.key];
    if (!table) continue;

    let score = 0;
    for (const [word, weight] of table) {
      if (hay.includes(norm(word))) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = cat.id;
    }
  }

  if (bestId) return { categoryId: bestId, score: bestScore };

  // 都没命中：退回「其他」（全局默认分类里 key === 'other' 的那个）
  const fallback = (categories || []).find((c) => c.key === 'other');
  return { categoryId: fallback ? fallback.id : null, score: 0 };
}

/**
 * 拆出版本信息：baseKey 用于判「同一文件的不同版本」，versionNum 用于比新旧。
 */
export function parseVersion(filename) {
  const { base } = splitExt(filename);
  let stripped = base;
  let explicitLatest = false;
  let versionNum = 0;

  const lower = base.toLowerCase();
  if (LATEST_WORDS.some((w) => lower.includes(w.toLowerCase()))) {
    explicitLatest = true;
  }

  // 数值版本号：v2 / 第2版 / (3) / 修订2
  const numPatterns = [
    /v(\d+(?:\.\d+)*)/i,
    /第(\d+)版/,
    /[（(](\d+)[)）]/,
    /修订版?(\d+)/,
    /副本(\d+)/,
  ];
  for (const p of numPatterns) {
    const m = base.match(p);
    if (m) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n > versionNum) versionNum = n;
    }
  }

  for (const p of VERSION_PATTERNS) {
    stripped = stripped.replace(p, '');
  }

  return {
    baseKey: norm(stripped),
    baseName: base.replace(/\s+$/, ''),
    explicitLatest,
    versionNum,
  };
}

/**
 * 对一组文件重算版本标记。
 * 同一课程 + 同一分类下、baseKey 相同的文件视为「同一份文件的不同版本」，
 * 其中最优的那个标 latest，其余标 old；独一份的标 none。
 *
 * 必须在每次导入后整组重算——新导入一份文件可能让原来的「最新版」变成旧版。
 * @returns {Array} 需要写回数据库的文件记录（已带新 versionLabel）
 */
export function recomputeVersions(fileList) {
  const groups = new Map();
  for (const f of fileList) {
    const { baseKey } = parseVersion(f.name);
    const gk = `${f.courseId || ''}::${f.categoryId || ''}::${baseKey}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(f);
  }

  const changed = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      if (members[0].versionLabel !== 'none') {
        members[0].versionLabel = 'none';
        changed.push(members[0]);
      }
      continue;
    }

    // 排序：显式写了「最新/最终/定稿」的优先；其次版本号大的；再次导入时间晚的
    const sorted = [...members].sort((a, b) => {
      const pa = parseVersion(a.name);
      const pb = parseVersion(b.name);
      if (pa.explicitLatest !== pb.explicitLatest) return pa.explicitLatest ? -1 : 1;
      if (pa.versionNum !== pb.versionNum) return pb.versionNum - pa.versionNum;
      return (b.importedAt || 0) - (a.importedAt || 0);
    });

    sorted.forEach((f, i) => {
      const label = i === 0 ? 'latest' : 'old';
      if (f.versionLabel !== label) {
        f.versionLabel = label;
        changed.push(f);
      }
    });
  }

  return changed;
}

/**
 * 分类一条待导入的文件记录（尚未入库）。
 * @returns {{courseId: string|null, categoryId: string|null, matchedBy: string|null, score: number}}
 */
export function classifyOne(fileRecord, courses, categories) {
  // matchText 可选：导入整个文件夹时把目录名也算作线索。
  // 「高等数学/作业/第3次.docx」里的目录名能直接定出课程和分类，比文件名可靠得多。
  const hit = guessCourse(fileRecord.matchText || fileRecord.name, courses);
  const cat = guessCategory(fileRecord.matchText || fileRecord.name, categories);
  return {
    courseId: hit ? hit.courseId : null,
    matchedBy: hit ? hit.via : null,
    categoryId: cat.categoryId,
    score: cat.score,
  };
}

/**
 * 批量分类 + 组内去重提示。
 * 返回的每一项都带 needsReview 标记：课程没认出来、或分类只拿 0 分，都该让用户看一眼。
 */
export function classifyBatch(records, courses, categories) {
  const out = records.map((r) => {
    const c = classifyOne(r, courses, categories);
    return {
      ...r,
      ...c,
      needsReview: !c.courseId,
    };
  });
  return out.sort((a, b) => naturalCompare(a.name, b.name));
}
