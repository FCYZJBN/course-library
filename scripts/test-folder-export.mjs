// 导出到文件夹的路径规划单元测试：node scripts/test-folder-export.mjs
//
// 磁盘那半截（showDirectoryPicker / createWritable）在 Node 里跑不了，
// 但真正会出错的本来就是路径规则这一片：非法字符、保留名、超长截断、同名加序号。
// 这些全在 buildExportPlan 这个纯函数里，所以把它钉死就够了。

import {
  buildExportPlan, LIB_META, SEM_META, COURSE_META, UNFILED_DIR, UNASSIGNED_SEM,
} from '../js/folder-export.js';

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

const NOW = Date.UTC(2026, 8, 17, 4, 0, 0); // 固定时刻，_library.json 才可比对

// 一份小小的样本库：1 个学期、1 门课、1 个分类、1 个文件
function library(over = {}) {
  return {
    semesters: [{ id: 's1', name: '2025 秋', sortOrder: 1 }],
    courses: [{ id: 'c1', name: '高等数学', semesterId: 's1', sortOrder: 1, aliases: ['高数'], teacher: '张老师' }],
    categories: [{ id: 'k1', name: '课件', courseId: 'c1', sortOrder: 1 }],
    files: [{ id: 'f1', name: '第3章.pptx', courseId: 'c1', categoryId: 'k1', size: 100 }],
    ...over,
  };
}
const file = (id, name, over = {}) => ({ id, name, courseId: 'c1', categoryId: 'k1', size: 1, ...over });
const paths = (plan) => plan.entries.map((e) => e.path);

console.log('\n【目录结构】');
{
  const plan = buildExportPlan(library(), NOW);
  check('学期/课程/分类/文件名 四层路径', paths(plan), ['2025 秋/高等数学/课件/第3章.pptx']);
  check('学期、课程、分类三个目录都建', plan.dirs, ['2025 秋', '2025 秋/高等数学', '2025 秋/高等数学/课件']);
  check('根上的 _library.json 排在最前', plan.sidecars[0].path, LIB_META);
  check('_library.json 带 tag 和时间戳',
    plan.sidecars[0].data, { app: 'course-library', version: 1, exportedAt: '2026-09-17T04:00:00.000Z' });
  check('课程 sidecar 只留推不出来的字段',
    plan.sidecars.find((s) => s.path.endsWith(COURSE_META)).data,
    { app: 'course-library', version: 1, name: '高等数学', aliases: ['高数'], teacher: '张老师', color: '', icon: '', sortOrder: 1 });
  check('学期 sidecar 记着真名和排序',
    plan.sidecars.find((s) => s.path === `2025 秋/${SEM_META}`).data,
    { app: 'course-library', version: 1, name: '2025 秋', sortOrder: 1 });
  check('统计数字对得上', plan.counts, { semesters: 1, courses: 1, files: 1 });
  check('干净的一次导出没有任何改动记录', plan.notes, []);
}

{
  // 空学期、空课程照样建目录：空目录本身就是「这里还空着」的信息
  const plan = buildExportPlan(library({ files: [] }), NOW);
  check('一门课都没有文件的学期，目录照建', plan.dirs.includes('2025 秋'), true);
  check('没有文件的课程，目录照建', plan.dirs.includes('2025 秋/高等数学'), true);
  check('没有文件的课程还是要写 sidecar',
    plan.sidecars.some((s) => s.path === `2025 秋/高等数学/${COURSE_META}`), true);
  check('没有文件的分类不建目录', plan.dirs.includes('2025 秋/高等数学/课件'), false);
  check('空库导出不报错，文件数为 0', plan.entries.length, 0);
}

{
  // 待整理摊平：那里的分类是导入时猜的，不该刻到磁盘上
  const plan = buildExportPlan(library({
    files: [file('f1', '新建文件夹(3).docx', { courseId: null, categoryId: 'k1' })],
  }), NOW);
  check('未归类文件落在 _待整理 下，不套分类', paths(plan), [`${UNFILED_DIR}/新建文件夹(3).docx`]);
  check('_待整理 目录会被建出来', plan.dirs.includes(UNFILED_DIR), true);
  check('没人归类时不建课程下的分类目录', plan.dirs.includes('2025 秋/高等数学/课件'), false);
}

{
  // 课程的学期没了（理论上不该发生），也别让它们凭空消失
  const plan = buildExportPlan(library({
    courses: [{ id: 'c9', name: '离散数学', semesterId: '查无此学期', sortOrder: 1 }],
    files: [file('f9', 'a.pdf', { courseId: 'c9' })],
  }), NOW);
  check('孤儿课程收进「未分学期」', paths(plan), [`${UNASSIGNED_SEM}/离散数学/课件/a.pdf`]);
  check('「未分学期」目录会被建出来', plan.dirs.includes(UNASSIGNED_SEM), true);
}

console.log('\n【名字净化】');
{
  const plan = buildExportPlan(library({
    files: [file('f1', '第3章:习题*答案?.docx', {})],
  }), NOW);
  check('Windows 非法字符换成下划线', paths(plan), ['2025 秋/高等数学/课件/第3章_习题_答案_.docx']);
  check('改名记进了报告', plan.notes, [
    { kind: 'renamed', what: '文件名', from: '第3章:习题*答案?.docx', to: '第3章_习题_答案_.docx' },
  ]);
}

{
  // 全角冒号在 Windows 上是合法字符，和半角冒号不是一回事，别一起换掉
  const plan = buildExportPlan(library({
    files: [file('f1', '第3章：习题.docx', {})],
  }), NOW);
  check('全角冒号不动它', paths(plan), ['2025 秋/高等数学/课件/第3章：习题.docx']);
  check('没改就不该出现在报告里', plan.notes, []);
}

{
  const plan = buildExportPlan(library({
    files: [file('f1', 'a/b.docx', {})],
  }), NOW);
  check('文件名里的斜杠也换掉——否则会凭空多出一层目录', paths(plan), ['2025 秋/高等数学/课件/a_b.docx']);
}

{
  const plan = buildExportPlan(library({
    files: [file('f1', 'CON.docx', {}), file('f2', 'lpt1.pdf', {}), file('f3', 'console.log.txt', {})],
  }), NOW);
  const out = paths(plan).map((p) => p.slice(p.lastIndexOf('/') + 1));
  check('保留名加下划线前缀',
    out.filter((n) => n.startsWith('_')).sort(), ['_CON.docx', '_lpt1.pdf']);
  check('只是以保留名开头的名字不受影响', out.includes('console.log.txt'), true);
}

{
  const plan = buildExportPlan(library({
    files: [file('f1', '第三章.docx ', {}), file('f2', '第四章.', {})],
  }), NOW);
  const out = paths(plan).map((p) => p.slice(p.lastIndexOf('/') + 1));
  check('结尾的空格去掉（Windows 会静默吃掉）', out.includes('第三章.docx'), true);
  check('结尾的点也一样', out.includes('第四章'), true);
}

{
  const plan = buildExportPlan(library({
    files: [file('f1', '   ', {})],
  }), NOW);
  check('名字全是空格就补一个「未命名」', paths(plan), ['2025 秋/高等数学/课件/未命名']);
}

{
  // `..` 是路径段里唯一真正危险的东西：留着它就能写到上级目录去。
  // 幸好净化规则里「去掉结尾的点」正好把它变成空串，再兜成「未命名」。
  const plan = buildExportPlan(library({
    files: [file('f1', '..', {}), file('f2', '...', {})],
  }), NOW);
  check('「..」不会变成向上一级',
    paths(plan), ['2025 秋/高等数学/课件/未命名', '2025 秋/高等数学/课件/未命名(2)']);
  check('没有一条路径跑出根目录', paths(plan).every((p) => !p.split('/').includes('..')), true);
}

console.log('\n【重名】');
{
  const plan = buildExportPlan(library({
    files: [file('f1', '第3章.pptx', {}), file('f2', '第3章.pptx', {})],
  }), NOW);
  check('同一目录下同名文件加序号', paths(plan), [
    '2025 秋/高等数学/课件/第3章.pptx',
    '2025 秋/高等数学/课件/第3章(2).pptx',
  ]);
}

{
  const plan = buildExportPlan(library({
    files: [file('f1', 'ABC.docx', {}), file('f2', 'abc.docx', {})],
  }), NOW);
  const out = paths(plan);
  check('大小写不同的同名文件也算撞车（Windows 不区分大小写）',
    out.length === 2 && new Set(out).size === 2 && out.some((p) => p.includes('(2)')), true);
}

{
  // 同名文件落在分类目录里面，和分类目录自己叫什么无关，不该被加序号
  const plan = buildExportPlan(library({ files: [file('f1', '课件', {})] }), NOW);
  check('文件和它所在的分类目录同名，互不干扰',
    paths(plan), ['2025 秋/高等数学/课件/课件']);
}

{
  const plan = buildExportPlan(library({
    courses: [
      { id: 'c1', name: '高等数学', semesterId: 's1', sortOrder: 1 },
      { id: 'c2', name: '高等数学', semesterId: 's1', sortOrder: 2 },
    ],
  }), NOW);
  check('同一学期下两门同名课各自建得出来',
    plan.dirs.filter((d) => d.split('/').length === 2).sort(),
    ['2025 秋/高等数学', '2025 秋/高等数学(2)']);
}

{
  const plan = buildExportPlan(library({
    semesters: [
      { id: 's1', name: '2025 秋', sortOrder: 1 },
      { id: 's2', name: '2025 秋', sortOrder: 2 },
    ],
  }), NOW);
  check('两个学期重名也各自建得出来',
    plan.dirs.filter((d) => !d.includes('/')).sort(), ['2025 秋', '2025 秋(2)']);
}

{
  // 学期和 _待整理 抢同一个名字：学期先占，工具目录让位
  const plan = buildExportPlan(library({
    semesters: [{ id: 's1', name: UNFILED_DIR, sortOrder: 1 }],
    courses: [],
    files: [file('f1', 'a.pdf', { courseId: null })],
  }), NOW);
  check('学期先占住名字，_待整理 让位',
    plan.dirs.filter((d) => !d.includes('/')).sort(), [`${UNFILED_DIR}`, `${UNFILED_DIR}(2)`]);
  check('未归类文件落进让位后的那个目录',
    paths(plan), [`${UNFILED_DIR}(2)/a.pdf`]);
}

console.log('\n【超长截断】');
{
  const long = 'A'.repeat(245) + '.docx'; // 250 字符
  const plan = buildExportPlan(library({ files: [file('f1', long, {})] }), NOW);
  const out = paths(plan)[0];
  const base = out.slice(out.lastIndexOf('/') + 1);
  // 目录前缀「2025 秋/高等数学/课件/」14+1 = 15 字符，相对路径预算 180，余 165
  check('截到 165 个字符（180 减去 15 字符的目录前缀）', base.length, 165);
  check('扩展名留住——丢了扩展名文件就双击不开了', base.endsWith('.docx'), true);
  check('确实短了', base.length < long.length, true);
  check('截断记进了报告', plan.notes[0].kind, 'truncated');
  check('报告里留下原名，用户才知道是哪个',
    plan.notes[0].from, long);
}

{
  const plan = buildExportPlan(library({
    files: [file('f1', '短名字.docx', {})],
  }), NOW);
  check('不长的名字一个字都不动', paths(plan), ['2025 秋/高等数学/课件/短名字.docx']);
  check('不动就不该出现在报告里', plan.notes, []);
}

{
  // 分类目录自己也要净化
  const plan = buildExportPlan(library({
    categories: [{ id: 'k1', name: '课后:习题', courseId: 'c1', sortOrder: 1 }],
    files: [file('f1', 'a.pdf', {})],
  }), NOW);
  check('分类名里的非法字符同样处理',
    paths(plan), ['2025 秋/高等数学/课后_习题/a.pdf']);
  check('分类改名也算条记录', plan.notes, [
    { kind: 'renamed', what: '分类名', from: '课后:习题', to: '课后_习题' },
  ]);
}

console.log('\n【排序】');
{
  const plan = buildExportPlan(library({
    files: [file('f2', '第10章.pptx', {}), file('f1', '第2章.pptx', {})],
  }), NOW);
  check('文件按自然序排，第2章在第10章前面',
    paths(plan), ['2025 秋/高等数学/课件/第2章.pptx', '2025 秋/高等数学/课件/第10章.pptx']);
}

{
  const plan = buildExportPlan(library({
    files: [
      file('f1', 'a.pdf', { courseId: 'c2' }),
      file('f2', 'b.pdf', { courseId: 'c1' }),
    ],
    courses: [
      { id: 'c2', name: '大学物理', semesterId: 's1', sortOrder: 2 },
      { id: 'c1', name: '高等数学', semesterId: 's1', sortOrder: 1 },
    ],
    categories: [
      { id: 'k1', name: '课件', courseId: 'c1', sortOrder: 1 },
      { id: 'k2', name: '课件', courseId: 'c2', sortOrder: 1 },
    ],
  }), NOW);
  check('课程按 sortOrder 建目录',
    plan.dirs.filter((d) => d.split('/').length === 2),
    ['2025 秋/高等数学', '2025 秋/大学物理']);
  check('两门课各自有「课件」目录，不会互相加序号',
    plan.dirs.filter((d) => d.endsWith('课件')).sort(),
    ['2025 秋/大学物理/课件', '2025 秋/高等数学/课件']);
}

console.log('\n【不改输入】');
{
  const data = library({ files: [file('f1', '<非法>.docx', {})] });
  const before = JSON.stringify(data);
  buildExportPlan(data, NOW);
  check('buildExportPlan 不动传进来的数据', JSON.stringify(data), before);
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail > 0 ? 1 : 0);
