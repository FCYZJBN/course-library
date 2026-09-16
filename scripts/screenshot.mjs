// 生成 README 用的截图：node scripts/make-fixtures.mjs && node scripts/screenshot.mjs
//
// 不手动画界面——用和冒烟测试同一套 CDP 手段，真的把应用跑起来、真的导入文件，
// 再截当前画面。好处是截图永远和真实界面一致，改了样式重跑一次就行。

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Cdp, ROOT, sleep, startServer, startChrome } from './cdp.mjs';
import { makeDocx, makePptx, makeXlsx, makePdf, slideXml } from './make-fixtures.mjs';

const PORT = 8012;
const DEBUG_PORT = 9412;
const SHOTS = join(ROOT, 'docs', 'screenshots');

// 比测试用的夹具更丰富一些，让截图看起来像个真实在用的库
function demoFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'cl-demo-'));
  const files = [];
  const add = (name, buf) => {
    writeFileSync(join(dir, name), buf);
    files.push(join(dir, name));
  };

  add('高等数学-第1章-课件.pptx', makePptx([
    slideXml('第一章 函数与极限', '数列极限的定义与性质'),
    slideXml('第二章 导数与微分', '洛必达法则与未定式'),
  ]));
  add('高数期末复习笔记.txt',
    '高等数学 期末复习笔记\n第三章 微分中值定理\n洛必达法则用于求未定式极限\n泰勒公式展开要点\n');
  add('高数期末复习笔记 v2.txt', '第二版\n补充了泰勒公式的证明\n');
  add('高数期末复习笔记 最终版.txt', '最终版\n洛必达法则完整推导\n');
  add('高数作业3.docx', makeDocx([
    '高等数学 第三次作业',
    '1. 求极限 lim(x→0) sin x / x',
    '2. 用洛必达法则求未定式极限',
  ]));
  add('高数成绩统计.xlsx', makeXlsx(['平时成绩', '期中成绩', '期末成绩', '总评']));

  add('大学物理-第2章-课件.pptx', makePptx([
    slideXml('第二章 刚体定轴转动', '转动惯量与角动量守恒'),
  ]));
  add('大物实验报告.docx', makeDocx([
    '大学物理实验报告',
    '实验名称：用拉伸法测金属丝的杨氏模量',
    '数据处理：逐差法求平均值',
  ]));
  add('大物期末试卷.pdf', makePdf([
    'University Physics Final Exam',
    'Problem 1: Youngs Modulus Experiment',
    'Problem 2: Simple Harmonic Motion',
  ]));

  add('工程力学-第3章-课件.pptx', makePptx([
    slideXml('第三章 应力状态分析', '平面应力状态的莫尔圆'),
  ]));
  add('工程力学-作业2.docx', makeDocx(['工程力学第二次作业', '轴向拉压杆的应力与变形']));

  // 故意留一个认不出归属的：截图里要能看到标黄待指定的那一行，
  // 这是这个工具最想让人看见的交互
  add('新建文件夹(3).docx', makeDocx(['从微信里存下来的，文件名没有任何线索']));

  return { dir, files };
}

async function main() {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const { dir, files } = demoFiles();

  const server = startServer(PORT);
  const chrome = startChrome({ debugPort: DEBUG_PORT, windowSize: '1400,1000' });
  await sleep(900);

  const cleanup = () => {
    chrome.dispose();
    try { server.kill(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', cleanup);

  try {
    const cdp = await Cdp.connect(DEBUG_PORT);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');

    const js = (e) => cdp.eval(e);

    // 截图前等提示条自己消失——压在半透明弹窗上的黑色气泡很难看
    const settle = async () => {
      for (let i = 0; i < 30; i++) {
        if (await js(`document.querySelector('#toast').classList.contains('hidden')`)) break;
        await sleep(200);
      }
      await sleep(250);
    };

    const shot = async (name) => {
      await settle();
      await cdp.screenshot(join(SHOTS, name));
      console.log(`  ${name}`);
    };

    await cdp.goto(`http://127.0.0.1:${PORT}/`);
    await cdp.waitFor(`document.querySelector('#view')?.innerHTML.length`, '应用启动');

    // —— 建学期 ——
    await js(`document.querySelector('#guide-new-sem').click()`);
    await cdp.waitFor(`!!document.querySelector('#sem-name')`, '学期弹窗');
    await js(`(() => {
      document.querySelector('#sem-name').value = '2025-2026 第一学期';
      document.querySelector('#sem-ok').click();
    })()`);
    await cdp.waitFor(`!!document.querySelector('#c-name')`, '课程弹窗');

    // —— 建课程（别名叫自动填充，截图里正好能看到）——
    const makeCourse = async (name) => {
      await js(`(() => {
        const i = document.querySelector('#c-name');
        i.value = ${JSON.stringify(name)};
        i.dispatchEvent(new Event('input'));
      })()`);
      await js(`document.querySelector('#c-ok').click()`);
      await cdp.waitFor(`!document.querySelector('#c-name')`, `建课 ${name}`);
    };

    await makeCourse('高等数学');
    for (const name of ['大学物理', '工程力学']) {
      await js(`document.querySelector('#side-new-course').click()`);
      await cdp.waitFor(`!!document.querySelector('#c-name')`, '新建课程弹窗');
      await makeCourse(name);
    }

    // —— 导入，先截「预览确认」这张 ——
    await cdp.setFileInput('#file-input', files);
    await cdp.waitFor(`!!document.querySelector('#preview-body')`, '导入预览');

    // 滚到底：让标黄「待手动指定」的那一行和灰掉的「确认导入」一起入镜，
    // 这比展示表格顶部更能说明这个工具的态度
    await js(`document.querySelector('.modal-body').scrollTop = 999999`);
    await shot('01-导入预览确认.png');

    // 手动指定未识别的文件，然后确认
    await js(`(() => {
      const sel = [...document.querySelectorAll('select[data-kind="course"]')].find(s => !s.value);
      if (!sel) return;
      sel.value = [...sel.options].find(o => o.textContent === '高等数学').value;
      sel.onchange();
    })()`);
    await cdp.waitFor(`!document.querySelector('#preview-ok').disabled`, '全部指定完毕');
    await js(`document.querySelector('#preview-ok').click()`);
    await cdp.waitFor(`!!document.querySelector('.file-row')`, '文件列表');

    // 等正文提取跑完，好让搜索截图里真的有命中片段
    await cdp.waitFor(`new Promise((res) => {
      const r = indexedDB.open('course-library-db');
      r.onsuccess = () => {
        const c = r.result.transaction('files','readonly').objectStore('files').openCursor();
        const statuses = [];
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) return res(statuses.length > 0 && statuses.every(s => s !== 'pending'));
          statuses.push(cur.value.extractStatus);
          cur.continue();
        };
      };
      r.onerror = () => res(false);
    })`, '后台提取完成', 60000);

    // —— 课程视图（版本标记在这里）——
    await js(`(() => {
      const b = [...document.querySelectorAll('#sidebar .course-item')]
        .find(e => e.querySelector('.course-label')?.textContent === '高等数学');
      b.click();
    })()`);
    await sleep(600);
    await shot('02-课程资料.png');

    // —— 内容搜索 ——
    await js(`(() => {
      const i = document.querySelector('#search');
      i.value = '洛必达法则';
      i.dispatchEvent(new Event('input'));
    })()`);
    await sleep(1200);
    await shot('03-内容搜索.png');

    await js(`(() => {
      const i = document.querySelector('#search');
      i.value = '';
      i.dispatchEvent(new Event('input'));
    })()`);
    await sleep(600);

    // —— 待整理（那个认不出的文件已被分配，这里换成裁剪前后都好看的主视图）——
    await js(`document.querySelector('#btn-settings').click()`);
    await cdp.waitFor(`!!document.querySelector('#set-backup')`, '设置页');
    await sleep(400);
    await shot('04-备份与设置.png');

    console.log(`\n截图已写入 docs/screenshots/`);
  } finally {
    cleanup();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('生成截图失败：', err.message);
  process.exit(1);
});
