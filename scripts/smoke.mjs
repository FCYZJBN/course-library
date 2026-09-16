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

  // —— 本地服务器 ——
  const server = startServer(PORT);
  await sleep(800);

  const cleanup = () => {
    chrome.dispose();
    try { server.kill(); } catch {}
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
    console.log('\n[1] 启动与空状态');
    await cdp.goto(`http://127.0.0.1:${PORT}/`);
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

    let n = 0;
    for (let i = 0; i < 100; i++) {
      n = await textCount();
      if (n >= 6) break;
      await sleep(300);
    }
    check(n >= 6, '六种格式的正文都提取入库（txt/docx/pptx/xlsx/pdf）', `已提取 ${n} 份`);

    // 提取状态记在 files 表上（texts 表只存正文），按文件看才有意义
    const extractRows = await js(`new Promise((res, rej) => {
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
    console.log('        提取状态：' + extractRows.map((r) => `${r.name}=${r.status}(${r.len}字)`).join(', '));
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

    // ============ 9. Service Worker 与离线 ============
    // 离线可用是这个产品的核心承诺（数据本来就在本地，没道理断网就打不开），
    // 所以真断网重载一次，确认外壳和数据都还在。
    console.log('\n[9] Service Worker 与离线');

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

    // ============ 10. 无未捕获异常 ============
    console.log('\n[10] 异常检查');
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
