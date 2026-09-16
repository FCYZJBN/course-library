// 分类引擎单元测试：node scripts/test-classifier.mjs
// 分类准确率是这个产品的命根子，规则改动必须跑一遍这个。

import { guessCourse, guessCategory, parseVersion, recomputeVersions } from '../js/classifier.js';
import { DEFAULT_CATEGORIES, suggestAliases } from '../js/seed.js';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✔ ${label}`);
  } else {
    fail++;
    console.log(`  ✘ ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
  }
}

// —— 测试用课程表 ——
const courses = [
  { id: 'c1', name: '高等数学', aliases: suggestAliases('高等数学') },
  { id: 'c2', name: '工程力学', aliases: suggestAliases('工程力学') },
  { id: 'c3', name: '大学物理', aliases: suggestAliases('大学物理') },
  { id: 'c4', name: '数据结构', aliases: suggestAliases('数据结构') },
];

// 模拟建课后的分类（默认 5 类，挂到课程上）
const categories = DEFAULT_CATEGORIES.map((c, i) => ({
  id: 'cat-' + c.key,
  courseId: null,
  name: c.name,
  key: c.key,
  icon: c.icon,
  sortOrder: i + 1,
}));

console.log('\n【课程识别】');
check('全称直接命中', guessCourse('工程力学-第6章.pptx', courses)?.courseId, 'c2');
check('别名「高数」命中高等数学', guessCourse('高数期末复习笔记.pdf', courses)?.courseId, 'c1');
check('别名「大物」命中大学物理', guessCourse('大物实验报告.docx', courses)?.courseId, 'c3');
check('别名「DS」命中数据结构', guessCourse('DS-lec03.pdf', courses)?.courseId, 'c4');
check('认不出的文件返回 null', guessCourse('新建文件夹(3).docx', courses), null);
check('无意义文件名返回 null', guessCourse('最终版(1).pdf', courses), null);
check('最长匹配优先：大学物理实验', guessCourse('大学物理实验报告.pdf', courses)?.courseId, 'c3');

console.log('\n【分类推断】');
check('「第6章」→ 课件', guessCategory('工程力学-第6章.pptx', categories).categoryId, 'cat-courseware');
check('「期末试卷」→ 真题', guessCategory('高数期末试卷.pdf', categories).categoryId, 'cat-exam');
check('「期末复习笔记」→ 笔记(权重压过期末)', guessCategory('高数期末复习笔记.pdf', categories).categoryId, 'cat-note');
check('「作业」→ 作业', guessCategory('高数作业3.docx', categories).categoryId, 'cat-homework');
check('「实验报告」→ 作业', guessCategory('大物实验报告.docx', categories).categoryId, 'cat-homework');
check('「历年真题」→ 真题', guessCategory('历年真题合集.pdf', categories).categoryId, 'cat-exam');
check('「讲义」→ 课件', guessCategory('第3讲 讲义.pdf', categories).categoryId, 'cat-courseware');
check('都不命中 → 其他', guessCategory('IMG_20250901.jpg', categories).categoryId, 'cat-other');

console.log('\n【版本识别】');
check('识别「最新版」', parseVersion('高数课件最新版.pdf').explicitLatest, true);
check('识别 v3 版本号', parseVersion('高数课件v3.pdf').versionNum, 3);
check('识别「(2)」版本号', parseVersion('高数课件(2).pdf').versionNum, 2);
check('识别「第2版」', parseVersion('高数课件第2版.pdf').versionNum, 2);
check('版本词被剥除后 baseKey 一致',
  parseVersion('高数课件v2.pdf').baseKey === parseVersion('高数课件最新版.pdf').baseKey, true);
check('不带版本词的文件 baseKey 仍是自己',
  parseVersion('高数课件.pdf').baseKey, '高数课件');

console.log('\n【版本分组】');
{
  const now = Date.now();
  const list = [
    { id: 'f1', name: '工程力学课件v1.pdf', courseId: 'c2', categoryId: 'cat-courseware', importedAt: now - 3000, versionLabel: null },
    { id: 'f2', name: '工程力学课件v2.pdf', courseId: 'c2', categoryId: 'cat-courseware', importedAt: now - 2000, versionLabel: null },
    { id: 'f3', name: '工程力学课件最新版.pdf', courseId: 'c2', categoryId: 'cat-courseware', importedAt: now - 1000, versionLabel: null },
    { id: 'f4', name: '工程力学作业1.docx', courseId: 'c2', categoryId: 'cat-homework', importedAt: now, versionLabel: null },
  ];
  const changed = recomputeVersions(list);
  const byId = Object.fromEntries(changed.map((f) => [f.id, f.versionLabel]));
  check('显式「最新版」胜出版本号', byId.f3, 'latest');
  check('旧版本标 old', byId.f1, 'old');
  check('次新版本标 old', byId.f2, 'old');
  check('独一份的文件标 none（不误报版本）', byId.f4, 'none');
}

{
  // 同一 baseName 但分属不同课程时，不该被当成彼此的版本
  const now = Date.now();
  const list = [
    { id: 'g1', name: '课件.pdf', courseId: 'c1', categoryId: 'cat-courseware', importedAt: now, versionLabel: null },
    { id: 'g2', name: '课件.pdf', courseId: 'c2', categoryId: 'cat-courseware', importedAt: now, versionLabel: null },
  ];
  const changed = recomputeVersions(list);
  check('跨课程同名文件互不干扰', changed.every((f) => f.versionLabel === 'none'), true);
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail > 0 ? 1 : 0);
