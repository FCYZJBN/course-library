// 端到端冒烟测试：node scripts/smoke.mjs
//
// 起一个本地服务器 + 无头 Chrome，用 CDP 驱动真实浏览器走完整个核心链路：
// 建学期 → 建课程 → 导入文件 → 确认归类 → 落库 → 后台提取正文 → 内容搜索 → 导出。
// 全程收集 Runtime.exceptionThrown，任何未捕获异常都算失败。
//
// 依赖 .fixtures/ 里的假文件，先跑 node scripts/make-fixtures.mjs 生成。

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Cdp, ROOT, sleep, startServer, startChrome } from './cdp.mjs';

const PORT = 8010;
const DEBUG_PORT = 9411;

// 默认打本地；传 BASE_URL=https://fcyzjbn.github.io/course-library/ 就能让同一套
// 断言直接跑线上站点——部署完最该确认的就是「线上真的能跑」，而不是「文件能下载」。
const BASE_URL = process.env.BASE_URL || null;
const ORIGIN = BASE_URL || `http://127.0.0.1:${PORT}/`;

// ============================ 断言 ============================

let pass = 0;
const failures = [];

function check(ok, label, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function checkEq(actual, expected, label) {
  check(
    actual === expected,
    label,
    actual === expected ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
  );
}

// ============================ 主流程 ============================

async function main() {
  const fixturesDir = join(ROOT, '.fixtures');
  if (!existsSync(fixturesDir)) {
    console.error('缺少 .fixtures/，先跑：node scripts/make-fixtures.mjs');
    process.exit(1);
  }
  const fixtures = readdirSync(fixturesDir).map((n) => join(fixturesDir, n));

  let chrome;
  try {
    chrome = startChrome({ debugPort: DEBUG_PORT });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // —— 本地服务器（打线上时不需要）——
  const server = BASE_URL ? null : startServer(PORT);
  await sleep(800);

  const cleanup = () => {
    chrome.dispose();
    try { server?.kill(); } catch {}
  };
  process.on('exit', cleanup);

  try {
    const cdp = await Cdp.connect(DEBUG_PORT);
    const pageErrors = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '未知异常');
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');

    const js = (expr) => cdp.eval(expr);
    const waitFor = (expr, label, timeout) => cdp.waitFor(expr, label, timeout);

    // ============ 1. 启动与空状态 ============
    console.log(`\n[1] 启动与空状态  （${ORIGIN}）`);
    await cdp.goto(ORIGIN);
    await waitFor(`document.querySelector('#view')?.innerHTML.length`, '应用启动');

    checkEq(await js(`!!document.querySelector('#guide-new-sem')`), true, '空库时展示三步引导');
    checkEq(await js(`document.querySelectorAll('#sidebar .sem-block').length`), 0, '侧栏初始没有学期');

    // ============ 2. 建学期 + 建课程 ============
    console.log('\n[2] 建立学期与课程');
    const makeCourse = async (name) => {
      await js(`(() => {
        const i = document.querySelector('#c-name');
        i.value = ${JSON.stringify(name)};
        i.dispatchEvent(new Event('input'));
      })()`);
      const aliases = await js(`document.querySelector('#c-aliases').value`);
      await js(`document.querySelector('#c-ok').click()`);
      await waitFor(`!document.querySelector('#c-name')`, `课程「${name}」创建完成`);
      return aliases;
    };

    await js(`document.querySelector('#guide-new-sem').click()`);
    await waitFor(`!!document.querySelector('#sem-name')`, '学期弹窗');
    await js(`(() => {
      document.querySelector('#sem-name').value = '2025-2026 第一学期';
      document.querySelector('#sem-ok').click();
    })()`);
    await waitFor(`!!document.querySelector('#c-name')`, '建完学期自动接建课程');

    const alias1 = await makeCourse('高等数学');
    check(alias1.includes('高数'), '课程别名自动填充（高等数学 → 包含「高数」）', `实际：${alias1}`);

    // 再建两门：点侧栏新建课程
    for (const name of ['大学物理', '工程力学']) {
      await js(`document.querySelector('#side-new-course').click()`);
      await waitFor(`!!document.querySelector('#c-name')`, `新建课程弹窗（${name}）`);
      await makeCourse(name);
    }

    const courseNames = await js(
      `[...document.querySelectorAll('#sidebar .course-label')].map(e => e.textContent).join(',')`
    );
    check(
      ['高等数学', '大学物理', '工程力学'].every((n) => courseNames.includes(n)),
      '三门课程都出现在侧栏',
      `侧栏课程：${courseNames}`
    );

    // ============ 3. 导入文件（预览阶段） ============
    console.log('\n[3] 导入与自动归类');
    await cdp.setFileInput('#file-input', fixtures);
    await waitFor(`!!document.querySelector('#preview-body')`, '导入预览弹窗');

    const rows = await js(`[...document.querySelectorAll('#preview-body tr')].map(tr => {
      const sels = tr.querySelectorAll('select');
      const opt = (s) => s.options[s.selectedIndex]?.textContent || '';
      return { name: tr.querySelector('.fname').textContent, course: opt(sels[0]), cat: opt(sels[1]), review: tr.classList.contains('needs-review') };
    })`);

    console.log('        识别结果：');
    for (const r of rows) {
      console.log(`          ${r.name} → ${r.course || '未识别'} / ${r.cat}`);
    }

    const find = (n) => rows.find((r) => r.name === n);
    checkEq(find('高数期末复习笔记.txt').course, '高等数学', '「高数期末复习笔记」认出课程');
    checkEq(find('高数期末复习笔记.txt').cat, '笔记', '「期末复习笔记」判为笔记（不是真题）');
    checkEq(find('大物实验报告.docx').course, '大学物理', '「大物实验报告」认出课程');
    checkEq(find('大物实验报告.docx').cat, '作业', '「实验报告」判为作业');
    checkEq(find('工程力学-第3章-课件.pptx').cat, '课件', '「课件」判为课件');
    checkEq(find('大物期末试卷.pdf').cat, '真题', '「试卷」判为真题');
    checkEq(find('新建文件夹(3).docx').review, true, '认不出的文件标为待人工指定');
    checkEq(
      await js(`document.querySelector('#preview-ok').disabled`),
      true,
      '存在未识别文件时禁止直接确认'
    );

    // 手动指定那个认不出的文件
    await js(`(() => {
      const sel = [...document.querySelectorAll('select[data-kind="course"]')].find(s => !s.value);
      sel.value = [...sel.options].find(o => o.textContent === '高等数学').value;
      sel.onchange();
    })()`);
    await waitFor(`!document.querySelector('#preview-ok').disabled`, '全部指定完毕后可以确认');

    // ============ 4. 落库 ============
    console.log('\n[4] 确认导入');
    await js(`document.querySelector('#preview-ok').click()`);
    await waitFor(`!!document.querySelector('.file-row')`, '文件列表出现');

    // 导入完停在最后创建的那门课上，切回高数才能看到三个版本的笔记
    await js(`(() => {
      const b = [...document.querySelectorAll('#sidebar .course-item')]
        .find(e => e.querySelector('.course-label')?.textContent === '高等数学');
      b.click();
    })()`);
    await sleep(400);

    const fileCount = await js(`document.querySelectorAll('.file-row').length`);
    check(fileCount >= 4, '高数课程下渲染出已导入的文件', `渲染了 ${fileCount} 个文件行`);

    // ============ 5. 版本标记 ============
    console.log('\n[5] 版本标记');
    await waitFor(
      `document.querySelectorAll('.tag-latest').length > 0`,
      '出现最新版标记',
      20000
    );
    const versionInfo = await js(`(() => {
      const out = [];
      for (const row of document.querySelectorAll('.file-row')) {
        const tag = row.querySelector('.tag-latest, .tag-old');
        if (tag) out.push(row.querySelector('.file-name').textContent.trim().replace(/\\s+/g,' ') + ' => ' + tag.textContent);
      }
      return out;
    })()`);
    console.log('        版本标记：' + (versionInfo.join(' | ') || '（无）'));
    check(
      versionInfo.some((s) => s.includes('最终版') && s.includes('最新')),
      '「最终版」被标为最新版',
      versionInfo.join(' | ')
    );
    check(
      versionInfo.filter((s) => s.includes('复习笔记')).length >= 3,
      '三个同名笔记被认成同一组版本',
      versionInfo.join(' | ')
    );

    // ============ 6. 后台提取正文 ============
    console.log('\n[6] 正文提取');
    const textCount = async () => js(`new Promise((res, rej) => {
      const r = indexedDB.open('course-library-db');
      r.onsuccess = () => {
        const q = r.result.transaction('texts','readonly').objectStore('texts').count();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      };
      r.onerror = () => rej(r.error);
    })`);

    // 提取状态记在 files 表上（texts 表只存正文），按文件看才有意义
    const readExtract = () => js(`new Promise((res, rej) => {
      const r = indexedDB.open('course-library-db');
      r.onsuccess = () => {
        const out = [];
        const c = r.result.transaction('files','readonly').objectStore('files').openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) return res(out);
          out.push({ name: cur.value.name, status: cur.value.extractStatus, len: cur.value.textLength || 0 });
          cur.continue();
        };
      };
      r.onerror = () => rej(r.error);
    })`);

    // 等到「没有 pending 了」为止，而不是等到某个数量就往下走。
    // 后者在本地够快所以侥幸能过，线上就露馅了：PDF 那条路要先从网上拉
    // 约 1.8MB 的 pdf.js，等凑够 6 份时另外两份还在 pending，紧接着的断言必然挂。
    // 上限给到 90 秒——线上第一次跑要把 pdf.js 下下来。
    let extractRows = [];
    for (let i = 0; i < 300; i++) {
      extractRows = await readExtract();
      if (extractRows.length >= 8 && !extractRows.some((r) => r.status === 'pending')) break;
      await sleep(300);
    }
    console.log('        提取状态：' + extractRows.map((r) => `${r.name}=${r.status}(${r.len}字)`).join(', '));

    const n = await textCount();
    check(n >= 6, '六种格式的正文都提取入库（txt/docx/pptx/xlsx/pdf）', `已提取 ${n} 份`);

    check(
      extractRows.length >= 8 && extractRows.every((r) => r.status === 'done'),
      '八个文件全部提取成功，无一失败',
      extractRows.filter((r) => r.status !== 'done').map((r) => `${r.name}:${r.status}`).join(', ')
    );
    check(
      extractRows.every((r) => r.len > 0),
      '每份正文都非空',
      extractRows.filter((r) => !r.len).map((r) => r.name).join(', ')
    );

    // ============ 7. 内容搜索 ============
    console.log('\n[7] 全文搜索');
    const searchFor = async (kw) => {
      await js(`(() => {
        const i = document.querySelector('#search');
        i.value = ${JSON.stringify(kw)};
        i.dispatchEvent(new Event('input'));
      })()`);
      await sleep(900);
      return js(`document.querySelectorAll('.file-row').length`);
    };

    check((await searchFor('洛必达法则')) >= 3, '搜到 txt 里的「洛必达法则」');
    checkEq(await searchFor('杨氏模量'), 1, '搜到 docx 里的「杨氏模量」');
    checkEq(await searchFor('应力状态'), 1, '搜到 pptx 里的「应力状态」');
    checkEq(await searchFor('期末成绩'), 1, '搜到 xlsx 里的「期末成绩」');
    checkEq(await searchFor('Youngs Modulus'), 1, '搜到 pdf 里的「Youngs Modulus」');

    await js(`(() => {
      const i = document.querySelector('#search');
      i.value = '';
      i.dispatchEvent(new Event('input'));
    })()`);
    await sleep(600);

    // ============ 8. 导出 ============
    console.log('\n[8] 导出');
    await js(`document.querySelector('#btn-settings').click()`);
    await waitFor(`!!document.querySelector('#set-backup')`, '设置页');

    // 拦下 <a download>，确认真的生成了 blob，而不是静默什么都没做
    await js(`(() => {
      window.__downloads = [];
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) { window.__downloads.push({ name: this.download, href: this.href }); return; }
        return orig.apply(this, arguments);
      };
    })()`);

    await js(`document.querySelector('#set-backup').click()`);
    await waitFor(`window.__downloads.length > 0`, '备份 zip 生成', 40000);

    const dl = await js(`window.__downloads[0]`);
    check(!!dl && /\.zip$/.test(dl.name), '备份文件已生成并触发下载', JSON.stringify(dl));
    check(
      await js(`fetch(window.__downloads[0].href).then(r => r.blob()).then(b => b.size > 1000)`),
      '备份 zip 有实际内容（大于 1KB）'
    );

    // 下面还原那节要复用这个包。blob URL 十秒后会被 revoke，
    // 等走到那里早过期了，所以趁现在把字节本身接住，别只留个会失效的地址。
    const backupSize = await js(
      `fetch(window.__downloads[0].href)
         .then(r => r.blob())
         .then(b => { window.__backupBlob = b; return b.size; })`
    );
    check(backupSize > 1000, '已抓住备份包的字节供还原测试使用', `读到 ${backupSize} 字节`);

    // ============ 9. 导出到文件夹 ============
    // 磁盘那一半在 Node 里测不了：showDirectoryPicker 必须要真实用户手势。
    // 但 OPFS 交出来的句柄是真的 FileSystemDirectoryHandle——把 showDirectoryPicker
    // 换成一个返回 OPFS 目录的函数，写入这条路就能在无头浏览器里真跑一遍，
    // 而且写出来的东西能用同一套 API 读回来逐条核对。
    //
    // 这里核对的是「磁盘上的树」和「库里的数据」对不对得上，不是把路径规则再算一遍——
    // 路径规则已经用纯函数在 scripts/test-folder-export.mjs 里钉死了，
    // 在这儿重算一遍等于把同一个 bug 抄两次。
    console.log('\n[9] 导出到文件夹');

    const idbAll = (store) => js(`new Promise((res, rej) => {
      const r = indexedDB.open('course-library-db');
      r.onsuccess = () => {
        const q = r.result.transaction(${JSON.stringify(store)},'readonly').objectStore(${JSON.stringify(store)}).getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      };
      r.onerror = () => rej(r.error);
    })`);

    // 认得出哪些是工具自己写的侧车，剩下的才是资料文件
    const isSidecar = (p) => p.endsWith('.json') && p.split('/').pop().startsWith('_');

    // —— 不支持这个 API 的浏览器（Firefox / Safari / 手机）该看到什么 ——
    await js(`window.showDirectoryPicker = undefined`);
    await js(`document.querySelector('#btn-settings').click()`);
    await waitFor(`document.querySelector('#set-export-folder').hidden`, '设置页换成不支持的样子');
    checkEq(await js(`document.querySelector('#set-export-folder').hidden`), true,
      '浏览器不给文件夹权限时，按钮不露出来');
    check(
      await js(`document.querySelector('#folder-hint').textContent.includes('zip')`),
      '按钮藏起来的同时说清替代方案是导出 zip，而不是让用户以为功能坏了'
    );

    // —— 装上 OPFS 替身 ——
    await js(`(async () => {
      const root = await navigator.storage.getDirectory();
      const walk = async (dir, prefix) => {
        let out = [];
        for await (const [n, h] of dir.entries()) {
          const p = prefix ? prefix + '/' + n : n;
          if (h.kind === 'directory') out = out.concat(await walk(h, p));
          else out.push({ path: p, name: n, size: (await h.getFile()).size });
        }
        return out;
      };
      const at = async (base, p, create) => {
        const parts = p.split('/');
        const name = parts.pop();
        let d = base;
        for (const s of parts) d = await d.getDirectoryHandle(s, { create: !!create });
        return { d, name };
      };
      window.__fx = {
        cur: null,
        walk: (d) => walk(d, ''),
        // 每次都从一个干净的目录开始：OPFS 会跟着 profile 留下来，
        // 上一轮跑剩的目录会让「空文件夹」「再导一次」这些断言全部失效
        scratch: async (n) => {
          try { await root.removeEntry(n, { recursive: true }); } catch {}
          return root.getDirectoryHandle(n, { create: true });
        },
        read: async (d, p) => { const a = await at(d, p, false); return (await (await a.d.getFileHandle(a.name)).getFile()).text(); },
        put: async (d, p, text) => {
          const a = await at(d, p, true);
          const w = await (await a.d.getFileHandle(a.name, { create: true })).createWritable();
          await w.write(text); await w.close();
        },
      };
      return true;
    })()`);
    await js(`window.showDirectoryPicker = () => Promise.resolve(window.__fx.cur)`);
    await js(`document.querySelector('#btn-settings').click()`);
    await waitFor(`!document.querySelector('#set-export-folder').hidden`, '设置页换成支持的样子');
    checkEq(await js(`document.querySelector('#set-export-folder').hidden`), false,
      '支持文件夹的浏览器上，按钮正常露出来');

    // —— 别人的文件夹：一个字节都不能碰 ——
    await js(`(async () => {
      window.__fx.cur = await window.__fx.scratch('别人的文件夹');
      await window.__fx.put(window.__fx.cur, '我的照片/假期.jpg', 'x');
      return true;
    })()`);
    await js(`document.querySelector('#set-export-folder').click()`);
    await waitFor(`!!document.querySelector('#fx-blocked-ok')`, '拒绝提示');
    check(
      await js(`document.querySelector('.modal-title').textContent.includes('已经有别的东西了')`),
      '往有别人文件的文件夹里导会被挡住，并说明原因'
    );
    checkEq(await js(`window.__fx.walk(window.__fx.cur).then(l => l.length)`), 1,
      '被挡住时一个字节都没写进去');
    await js(`document.querySelector('#fx-blocked-ok').click()`);

    // —— 空文件夹：正常导出 ——
    const libFiles = await idbAll('files');
    const libCourses = await idbAll('courses');
    const libSemesters = await idbAll('semesters');

    await js(`(async () => { window.__fx.cur = await window.__fx.scratch('导出目标'); return true; })()`);
    await js(`document.querySelector('#set-export-folder').click()`);
    await waitFor(`!!document.querySelector('#fx-report-ok')`, '导出完成报告', 60000);

    const tree = await js(`window.__fx.walk(window.__fx.cur)`);
    const paths = tree.map((t) => t.path);
    const libMeta = JSON.parse(await js(`window.__fx.read(window.__fx.cur, '_library.json')`));

    checkEq(libMeta.app, 'course-library', '_library.json 认得出是自己导出的');
    check(
      !paths.some((p) => /[\\:*?"<>|]/.test(p)),
      '写出去的路径里没有 Windows 不允许的字符',
      paths.filter((p) => /[\\:*?"<>|]/.test(p)).join(' / ')
    );
    checkEq(
      paths.filter(isSidecar).length,
      1 + libSemesters.length + libCourses.length,
      '侧车文件数 = 1 个 _library + 每个学期一份 _semester + 每门课一份 _courselib'
    );
    checkEq(
      paths.filter((p) => !isSidecar(p)).map((p) => p.split('/').pop()).sort().join('|'),
      libFiles.map((f) => f.name).sort().join('|'),
      '磁盘上的资料文件和库里的文件记录一一对应，一个不多一个不少'
    );
    checkEq(
      await js(`(async () => {
        const disk = (await window.__fx.walk(window.__fx.cur))
          .filter((t) => !(t.name.startsWith('_') && t.name.endsWith('.json')))
          .map((t) => t.size).sort((a, b) => a - b);
        const blobs = await new Promise((res, rej) => {
          const r = indexedDB.open('course-library-db');
          r.onsuccess = () => {
            const q = r.result.transaction('blobs','readonly').objectStore('blobs').getAll();
            q.onsuccess = () => res(q.result.map((x) => (x.blob ? x.blob.size : -1)).sort((a, b) => a - b));
            q.onerror = () => rej(q.error);
          };
          r.onerror = () => rej(r.error);
        });
        return JSON.stringify(disk) === JSON.stringify(blobs);
      })()`),
      true,
      '每个写出去的文件字节数和库里的 blob 一模一样，不是空壳'
    );

    const sem = libSemesters[0];
    const someCourse = libCourses.find((c) => c.semesterId === sem.id);
    const courseMetaPath = `${sem.name}/${someCourse.name}/_courselib.json`;
    check(paths.includes(courseMetaPath), '课程目录里有 _courselib.json', courseMetaPath);
    const courseMeta = JSON.parse(await js(`window.__fx.read(window.__fx.cur, ${JSON.stringify(courseMetaPath)})`));
    checkEq(courseMeta.name, someCourse.name, '课程侧车记着课程名');
    check(
      Array.isArray(courseMeta.aliases) && typeof courseMeta.sortOrder === 'number',
      '课程侧车带着别名和排序，下次读回来能还原'
    );
    check(
      paths.every((p) => p.split('/')[0] !== '_回收站'),
      '这一级不建回收站目录（那是后面几级台阶的事）'
    );

    // —— 再导一次：叠在上次上面，且一个文件都不删 ——
    const stalePath = `${sem.name}/${someCourse.name}/课件/上次导出的旧版.pdf`;
    await js(`window.__fx.put(window.__fx.cur, ${JSON.stringify(stalePath)}, 'stale')`);
    const beforeSecond = paths.length + 1;

    await js(`document.querySelector('#fx-report-ok').click()`);
    await js(`document.querySelector('#set-export-folder').click()`);
    await waitFor(`!!document.querySelector('#fx-report-ok')`, '第二次导出', 60000);

    const report2 = await js(`document.querySelector('.modal-body').textContent`);
    check(report2.includes('上次导出的旧版.pdf'), '第二次导出会把多出来的旧文件点名列出来');
    check(report2.includes('一个都没动'), '并说明导出没有删除权，一个都没删');
    check(
      (await js(`window.__fx.walk(window.__fx.cur)`)).some((t) => t.path === stalePath),
      '那个多出来的文件确实还躺在原地'
    );
    checkEq(
      (await js(`window.__fx.walk(window.__fx.cur)`)).length,
      beforeSecond,
      '再导一次不会写出「xxx(2)」，文件数不变'
    );
    await js(`document.querySelector('#fx-report-ok').click()`);
    // 这一节把 showDirectoryPicker 换成了 OPFS 替身，还给真实的那个，
    // 免得后面的节次以为浏览器支持文件夹授权
    await js(`delete window.showDirectoryPicker`);

    // ============ 10. 备份 → 还原 ============
    // 还原会先清空整个资料库再写回去。这条路走错一次，用户一学期的资料就没了，
    // 所以它比别的功能更该被测到。顺序是刻意的：先放两个坏包进去，
    // 确认它们被挡在清空之前；再放真包，确认数据一个不少地长回来。
    console.log('\n[10] 备份与还原');

    // 把一段 blob 塞进 #backup-input 并触发 change。
    // input.files 是只读的，直接赋值不行；走 DataTransfer 是浏览器里
    // 唯一不需要真实文件路径就能模拟「选了某个文件」的正规做法。
    const feedBackup = (blobExpr) => js(`(async () => {
      const blob = await ${blobExpr};
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'backup.zip', { type: 'application/zip' }));
      const input = document.querySelector('#backup-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      return true;
    })()`);

    const openSettings = async () => {
      await js(`document.querySelector('#btn-settings').click()`);
      await waitFor(`!!document.querySelector('#set-restore')`, '设置页');
    };

    // 点开某门课，数它下面有几个文件行
    const rowsIn = async (courseName = '高等数学') => {
      await js(`(() => {
        const b = [...document.querySelectorAll('#sidebar .course-item')]
          .find(e => e.querySelector('.course-label')?.textContent === ${JSON.stringify(courseName)});
        b && b.click();
      })()`);
      await sleep(400);
      return js(`document.querySelectorAll('.file-row').length`);
    };
    const rowsInMath = () => rowsIn('高等数学');

    const beforeRestore = await rowsInMath();
    check(beforeRestore >= 4, '还原前「高等数学」下有文件', `读到 ${beforeRestore} 行`);

    // —— 坏包一：根本不是 zip（比如选错了文件）——
    await openSettings();
    await feedBackup(`new Blob(['这不是一个 zip'], { type: 'application/zip' })`);
    await waitFor(`!!document.querySelector('#rs-ok')`, '还原确认框（坏包一）');
    await js(`document.querySelector('#rs-ok').click()`);

    let rejected = true;
    try {
      await waitFor(
        `document.querySelector('#toast').textContent.includes('还原失败')`,
        '坏包一被拒收',
        20000
      );
    } catch { rejected = false; }
    check(rejected, '选了非备份文件：明确报错，不开始还原');
    checkEq(await rowsInMath(), beforeRestore, '坏包一之后原数据完好无损');

    // —— 坏包二：有 metadata.json，但包里几乎没有它声称的文件 ——
    // 这是「下载没下完 / 传到一半断了」的典型样子，也是
    // importBackup 里那道预检专门要拦的情况：包看着像真的，
    // 清空之后才发现解不出东西，那时候已经来不及了。
    await openSettings();
    await feedBackup(`(async () => {
      const z = new JSZip();
      z.file('metadata.json', JSON.stringify({
        app: 'course-library', version: 1, exportedAt: Date.now(),
        semesters: [], courses: [], categories: [],
        files: Array.from({ length: 10 }, (_, i) => ({
          id: 'x' + i, name: 'f' + i + '.txt', path: '缺失/f' + i + '.txt',
        })),
      }));
      return z.generateAsync({ type: 'blob' });
    })()`);
    await waitFor(`!!document.querySelector('#rs-ok')`, '还原确认框（坏包二）');
    await js(`document.querySelector('#rs-ok').click()`);

    rejected = true;
    try {
      await waitFor(
        `document.querySelector('#toast').textContent.includes('不完整')`,
        '坏包二被拒收',
        20000
      );
    } catch { rejected = false; }
    check(rejected, '残缺的备份包：在清空之前就被拦下');
    checkEq(await rowsInMath(), beforeRestore, '坏包二之后原数据完好无损');

    // —— 真包：清空之后必须一模一样地长回来 ——
    await openSettings();
    await feedBackup(`Promise.resolve(window.__backupBlob)`);
    await waitFor(`!!document.querySelector('#rs-ok')`, '还原确认框');
    await js(`document.querySelector('#rs-ok').click()`);
    await waitFor(
      `document.querySelector('#toast').textContent.includes('还原完成')`,
      '还原完成',
      60000
    );

    checkEq(await rowsInMath(), beforeRestore, '还原后「高等数学」的文件一个不少');
    const afterCourses = await js(`document.querySelectorAll('#sidebar .course-label').length`);
    check(afterCourses >= 3, '还原后课程都在', `读到 ${afterCourses} 门课`);

    // 正文按设计不进备份包，还原后要重新提取一遍。
    // 「还原完了但搜不到东西」等于白还原，所以要等到搜索真的能用为止。
    await js(`(() => {
      const i = document.querySelector('#search');
      i.value = '洛必达法则';
      i.dispatchEvent(new Event('input'));
    })()`);
    let contentBack = true;
    try {
      await waitFor(`document.querySelectorAll('.file-row').length >= 1`, '还原后正文重新提取完成', 40000);
    } catch { contentBack = false; }
    check(contentBack, '还原后正文被重新提取，内容搜索恢复可用');

    await js(`(() => {
      const i = document.querySelector('#search');
      i.value = '';
      i.dispatchEvent(new Event('input'));
    })()`);
    await sleep(600);

    // ============ 11. 弹层 ============
    // 「编辑课程」上压着「删除课程」时，Esc 只该关掉上面那层。
    // 关整摞会把下面那份没保存的编辑一起丢掉，用户白白重填一遍。
    console.log('\n[11] 弹层行为');

    await rowsInMath();
    await js(`document.querySelector('#btn-edit-course').click()`);
    await waitFor(`!!document.querySelector('#c-name')`, '课程编辑弹窗');
    await js(`(() => {
      const i = document.querySelector('#c-name');
      i.value = '高等数学（改了一半）';
      i.dispatchEvent(new Event('input'));
    })()`);
    await js(`document.querySelector('#c-del').click()`);
    await waitFor(`!!document.querySelector('#cd-cancel')`, '删除确认弹窗');

    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(250);

    checkEq(
      await js(`document.querySelectorAll('.modal-backdrop').length`),
      1,
      'Esc 只关掉最上面那层弹窗'
    );
    checkEq(
      await js(`document.querySelector('#c-name')?.value`),
      '高等数学（改了一半）',
      '下面那层弹窗还在，没保存的输入没丢'
    );

    // 收尾：把这一层也关掉，别影响后面的测试
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(250);
    checkEq(await js(`document.querySelectorAll('.modal-backdrop').length`), 0, '再按一次 Esc 全部关干净');

    // ============ 12. 删除学期 ============
    // 建错一个学期（打错字、重复建）过去是删不掉的，只能一直挂在那儿。
    // 但学期下面挂着课程、课程下面挂着文件，所以「能删」和「不能悄悄删干净」
    // 得同时成立：确认框要把「这个学期下的文件全没」说透，删完不能留下孤儿记录。
    // 空学期和有文件的学期分开测——两种情况该说的话不一样。
    console.log('\n[12] 删除学期');

    const semCountOf = (name) => js(`
      [...document.querySelectorAll('#sidebar .sem-block')]
        .filter(b => b.querySelector('.sem-label')?.textContent === ${JSON.stringify(name)}).length`);

    // 直接问 IndexedDB。界面渲染对不对是一回事，库里有没有留下
    // 永远读不到、却照样占着配额的孤儿 blob 是另一回事。
    const idbCount = (store) => js(`new Promise((res, rej) => {
      const r = indexedDB.open('course-library-db');
      r.onsuccess = () => {
        const q = r.result.transaction(${JSON.stringify(store)},'readonly').objectStore(${JSON.stringify(store)}).count();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      };
      r.onerror = () => rej(r.error);
    })`);

    // 先建一个专门用来删的学期，并在里面建一门课
    await js(`document.querySelector('#side-new-sem').click()`);
    await waitFor(`!!document.querySelector('#sem-name')`, '新建学期弹窗');
    await js(`(() => {
      const i = document.querySelector('#sem-name');
      i.value = '2030 春（待删）';
      i.dispatchEvent(new Event('input'));
      document.querySelector('#sem-ok').click();
    })()`);
    await waitFor(`!!document.querySelector('#c-name')`, '紧接着弹出的新建课程弹窗');
    await js(`(() => {
      const i = document.querySelector('#c-name');
      i.value = '临时课程';
      i.dispatchEvent(new Event('input'));
      document.querySelector('#c-ok').click();
    })()`);
    await waitFor(`!document.querySelector('#c-name')`, '临时课程创建完成');
    checkEq(await semCountOf('2030 春（待删）'), 1, '临时学期已建好');

    const openDelSem = async () => {
      await js(`(() => {
        const b = [...document.querySelectorAll('#sidebar .sem-block')]
          .find(x => x.querySelector('.sem-label')?.textContent === '2030 春（待删）');
        b.querySelector('.sem-del').click();
      })()`);
      await waitFor(`!!document.querySelector('#sd-ok')`, '删除学期确认框');
      return js(`document.querySelector('.modal-body').textContent`);
    };

    // —— 先看空学期。这时候不该吓唬人：一个文件都没有却说「文件都会被删」，
    // 用户会以为自己弄丢了什么，反而学会忽略这个提示。 ——
    const warnEmpty = await openDelSem();
    check(
      warnEmpty.includes('还没有文件') && warnEmpty.includes('不可撤销'),
      '空学期的确认框不虚报要删文件',
      `实际文案：「${warnEmpty.replace(/\s+/g, ' ').trim()}」`
    );
    await js(`document.querySelector('#sd-cancel').click()`);
    await waitFor(`!document.querySelector('#sd-ok')`, '取消后确认框关掉');

    // —— 再往这个学期里挪一个文件进去，测「有文件」的那套说法 ——
    // 借现成的「移动」功能搬，不额外造 fixture：fixture 目录一变，
    // 前面几节按整目录导入的计数全都要跟着改。挑「新建文件夹(3).docx」，
    // 它是手动指定过归属的，不属于任何版本组，搬走不影响别处的断言。
    await rowsInMath();
    const moveTarget = await js(`(() => {
      const row = [...document.querySelectorAll('.file-row')]
        .find(r => r.querySelector('.file-name').textContent.trim().startsWith('新建文件夹(3).docx'));
      return row ? { id: row.dataset.id, name: row.querySelector('.file-name').textContent.trim() } : null;
    })()`);
    check(!!moveTarget, '找到了要搬去临时学期的文件', JSON.stringify(moveTarget));

    await js(`document.querySelector('.file-row[data-id="${moveTarget.id}"] [data-move]').click()`);
    await waitFor(`!!document.querySelector('#mv-ok')`, '移动弹窗');
    await js(`(() => {
      const sel = document.querySelector('#mv-course');
      sel.value = [...sel.options].find(o => o.textContent === '临时课程').value;
      sel.onchange();
      document.querySelector('#mv-ok').click();
    })()`);
    await waitFor(`document.querySelector('#toast').textContent.includes('已移动')`, '文件已挪进临时课程');

    // 数「高等数学」下面的文件——固定看一门课，避免视图自己跑偏导致前后不可比
    const mathFilesBeforeDel = await rowsInMath();
    const blobsBeforeDel = await idbCount('blobs');

    // —— 有文件的学期：这句话必须说透 ——
    const delWarn = await openDelSem();
    check(
      delWarn.includes('所有文件') && delWarn.includes('共 1 个') && delWarn.includes('不可撤销'),
      '确认框写明该学期下的所有文件都会被删，并给出数量',
      `实际文案：「${delWarn.replace(/\s+/g, ' ').trim()}」`
    );

    await js(`document.querySelector('#sd-ok').click()`);
    await waitFor(`document.querySelector('#toast').textContent.includes('学期已删除')`, '学期删除完成');

    checkEq(await semCountOf('2030 春（待删）'), 0, '学期确实删掉了');
    checkEq(
      await js(`
        [...document.querySelectorAll('#sidebar .course-label')]
          .filter(e => e.textContent === '临时课程').length`),
      0,
      '学期下的课程一并删掉，没留孤儿'
    );
    // 别把原库里的东西误伤：原来的课和文件都得还在
    check(
      (await js(`document.querySelectorAll('#sidebar .course-label').length`)) >= 2,
      '原有课程没被误删'
    );
    checkEq(await rowsInMath(), mathFilesBeforeDel, '原有文件没被误删');

    // 被删掉的那个文件，本体也要跟着走。只清 files 表的话，界面上它没了，
    // 但 blob 还压在库里占着配额，而且这辈子再也读不到——这种残留最难发现。
    checkEq(await idbCount('blobs'), blobsBeforeDel - 1, '文件本体一并删掉，没留下占配额的孤儿');

    // ============ 13. 重复文件的提示 ============
    // 同一份文件导两次，过去只会静悄悄多出一条记录，要用户自己发现。
    // 现在预览里标出来，并给一个一次点击就排除的按钮——但默认不替用户跳过：
    // 同名同大小也可能是两份都该留的文件，替用户丢东西比不提醒更糟。
    console.log('\n[13] 重复文件的提示');

    // 把已经导进来过的那个 pptx 再选一次
    await cdp.setFileInput('#file-input', [join(fixturesDir, '工程力学-第3章-课件.pptx')]);
    await waitFor(`!!document.querySelector('#preview-ok')`, '导入预览');

    checkEq(
      await js(`document.querySelectorAll('.dup-tag').length`),
      1,
      '预览里标出了「可能重复」'
    );

    const dropLabel = await js(`document.querySelector('#drop-dups').textContent`);
    const dropHidden = await js(`document.querySelector('#drop-dups').hidden`);
    check(!dropHidden && /\d/.test(dropLabel), '给出了排除重复项的入口', `按钮文案：「${dropLabel}」`);

    // 不点排除按钮的时候，重复项照样在待导入列表里——默认行为没变
    checkEq(
      await js(`document.querySelector('#preview-ok').disabled`),
      false,
      '默认仍然照常导入，不擅自替用户跳过'
    );

    checkEq(
      await js(`document.querySelectorAll('#preview-body tr').length`),
      1,
      '不点排除时重复项仍在待导入列表里'
    );

    await js(`document.querySelector('#drop-dups').click()`);
    await waitFor(
      `document.querySelector('#toast').textContent.includes('没有要导入的')`,
      '全部排除后关闭预览',
      10000
    );
    checkEq(
      await js(`document.querySelectorAll('.modal-backdrop').length`),
      0,
      '全部都是重复项时直接收工，不会导入一份空列表'
    );

    // ============ 14. Service Worker 与离线 ============
    // 离线可用是这个产品的核心承诺（数据本来就在本地，没道理断网就打不开），
    // 所以真断网重载一次，确认外壳和数据都还在。
    console.log('\n[14] Service Worker 与离线');

    let swReady = false;
    for (let i = 0; i < 40 && !swReady; i++) {
      swReady = await js(`navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))`);
      if (!swReady) await sleep(250);
    }
    check(swReady, 'Service Worker 已注册并激活');

    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    await cdp.send('Page.reload');

    let offlineOk = false;
    try {
      await waitFor(`document.querySelector('#view')?.innerHTML.length`, '断网后应用启动', 12000);
      offlineOk = true;
    } catch {}

    check(offlineOk, '断网后依然能打开应用');

    if (offlineOk) {
      const offlineFiles = await js(`document.querySelectorAll('#sidebar .course-label').length`);
      check(offlineFiles >= 3, '断网后课程列表仍在（数据在本地，不依赖网络）', `读到 ${offlineFiles} 门课`);
      await js(`(() => {
        const b = [...document.querySelectorAll('#sidebar .course-item')]
          .find(e => e.querySelector('.course-label')?.textContent === '高等数学');
        b && b.click();
      })()`);
      await sleep(500);
      const offlineRows = await js(`document.querySelectorAll('.file-row').length`);
      check(offlineRows >= 4, '断网后文件列表仍能渲染', `渲染了 ${offlineRows} 个文件行`);
    }

    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });

    // ============ 15. 存储写满时的表现 ============
    // 浏览器给网页的配额是有限的，塞满了就是塞满了——迟早会碰上。
    // 本来想用 CDP 的 Storage.overrideQuotaForOrigin 把配额压小来制造这个局面，
    // 试过了：这个实验性命令对 IndexedDB 不生效（在 Chrome 里它只影响 estimate 报出来的数），
    // 把配额压到 1KB、重载过，3KB 的文件照样写得进去。真塞几 GB 又不现实。
    // 所以改用故障注入：拦下往 blobs 表里的写，抛出的正是 Chrome 配额爆掉时抛的那个
    // 异常形状（DOMException / QuotaExceededError）。它验的是「撞上配额之后应用怎么办」，
    // 而那正是这一段要保证的事。
    console.log('\n[15] 存储写满时的表现');

    // 要导进去的那门课，先记下它现在有几个文件
    const mechBefore = await rowsIn('工程力学');

    await js(`(() => {
      window.__origPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'blobs') throw new DOMException('Quota exceeded.', 'QuotaExceededError');
        return window.__origPut.apply(this, args);
      };
    })()`);

    // 只导这一个：它能被自动认出课程，预览里不需要人工指定，可以直接确认
    await cdp.setFileInput('#file-input', [join(fixturesDir, '工程力学-第3章-课件.pptx')]);
    await waitFor(`!!document.querySelector('#preview-ok')`, '导入预览');
    await js(`document.querySelector('#preview-ok').click()`);

    let reported = true;
    try {
      await waitFor(
        `document.querySelector('#toast').textContent.includes('存储空间不够')`,
        '提示存储空间不足',
        30000
      );
    } catch { reported = false; }
    // 把真实提示带进失败信息里：这一条挂掉时，最想知道的就是它到底说了什么
    const quotaToast = await js(`document.querySelector('#toast').textContent`);
    check(reported, '写满时给出明确提示，而不是静默失败', `实际提示：「${quotaToast}」`);

    // 这条是重点：进度框是模态的，挂着不走等于整个应用卡死，用户只能刷新
    checkEq(
      await js(`document.querySelectorAll('.modal-backdrop').length`),
      0,
      '写满后进度框已关闭，应用没有卡死'
    );
    check(
      (await js(`document.querySelectorAll('#sidebar .course-label').length`)) >= 3,
      '写满后界面仍然可用'
    );
    // 文件和它的本体是在同一个事务里写的，写不进去就该两边都没有：
    // 只剩一条没有本体的记录，用户会看到一个点开是空的文件，比报错还难查。
    checkEq(
      await rowsIn('工程力学'),
      mechBefore,
      '写不进去的文件没有留下半条记录（事务整体回滚）'
    );

    // 撤掉注入，免得污染后面的异常检查
    await js(`(() => { if (window.__origPut) IDBObjectStore.prototype.put = window.__origPut; })()`);

    // ============ 16. 备份包里的 id 不可信 ============
    // 库里的 id 都是 uid() 生成的，所以拼 HTML 时到处直接写 ${x.id} 进属性。
    // 但备份包是别人给的文件，metadata.json 里的 id 想写什么写什么——
    // 一个带引号加事件属性的 id 就能从 data-* 里逃出来执行脚本。
    // 这里塞一个这样的人造包进去，验证它被当成普通数据、没有变成代码。
    console.log('\n[16] 备份包里的 id 不可信');

    await openSettings();
    await feedBackup(`(async () => {
      const evil = 'x" onmouseover="window.__pwned=1" data-x="';
      const z = new JSZip();
      z.file('metadata.json', JSON.stringify({
        app: 'course-library', version: 1, exportedAt: Date.now(),
        semesters: [{ id: evil, name: '正常人名字', sortOrder: 0 }],
        courses: [{ id: evil, name: '正常人课程', semesterId: evil, aliases: [], sortOrder: 0 }],
        categories: [{
          id: evil, courseId: evil, name: '正常人分类', key: 'other', sortOrder: 1,
          // 图标同样来自备份包，同样会被拼进 HTML
          icon: '<img src=x onerror="window.__pwned2=1">',
        }],
        files: [{ id: evil, courseId: evil, categoryId: evil, name: '正常.txt', size: 5, ext: 'txt', path: 'a/正常.txt' }],
      }));
      z.file('a/正常.txt', new Blob(['hello']));
      return z.generateAsync({ type: 'blob' });
    })()`);
    await waitFor(`!!document.querySelector('#rs-ok')`, '还原确认框');
    await js(`document.querySelector('#rs-ok').click()`);
    await waitFor(
      `document.querySelector('#toast').textContent.includes('还原完成')`,
      '还原完成',
      40000
    );

    checkEq(await js(`typeof window.__pwned`), 'undefined', 'id 里的脚本没有被执行');
    checkEq(
      await js(`document.querySelectorAll('[onmouseover]').length`),
      0,
      '没有属性从 data-* 里逃出来'
    );
    checkEq(await js(`typeof window.__pwned2`), 'undefined', '分类图标里的脚本没有被执行');
    checkEq(
      await js(`document.querySelectorAll('img[src="x"]').length`),
      0,
      '图标是按文本渲染的，没有被当成标签'
    );
    checkEq(
      await js(`[...document.querySelectorAll('#sidebar .course-label')].some(e => e.textContent === '正常人课程')`),
      true,
      '课程本身照常还原，只是 id 换成了自己发的'
    );
    checkEq(
      await js(`document.querySelectorAll('.sem-del').length`),
      1,
      '结构完整，没有因为脏 id 而渲染崩掉'
    );

    // ============ 17. 无未捕获异常 ============
    console.log('\n[17] 异常检查');
    check(pageErrors.length === 0, '全程没有未捕获异常', pageErrors.join('\n        '));

  } finally {
    cleanup();
  }

  console.log(`\n${'='.repeat(52)}`);
  if (failures.length) {
    console.log(`结果：${pass} 通过，${failures.length} 失败`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`结果：${pass} 通过，0 失败`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n冒烟测试中断：', err.message);
  process.exit(1);
});
