// 无头 Chrome + CDP 的公共辅助：smoke.mjs 和 screenshot.mjs 共用
//
// 为什么不用 Puppeteer：这个项目刻意不引入任何 npm 依赖（没有构建步骤，
// 克隆下来就能跑）。而 CDP 本身只是一个 WebSocket 上加了几条 JSON 消息，
// 自己写这几十行比拉进来一棵依赖树划算得多。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function findChrome() {
  const found = [...CHROME_CANDIDATES, process.env.CHROME_PATH].filter(Boolean).find((p) => existsSync(p));
  if (!found) throw new Error('找不到 Chrome，可用 CHROME_PATH 环境变量指定路径');
  return found;
}

/** 起本地静态服务器 */
export function startServer(port) {
  return spawn(process.execPath, [join(ROOT, 'scripts', 'serve.js'), String(port)], { stdio: 'ignore' });
}

/** 起无头 Chrome，返回进程句柄和临时用户目录 */
export function startChrome({ debugPort, windowSize = '1440,900' }) {
  const profile = mkdtempSync(join(tmpdir(), 'course-lib-'));
  const proc = spawn(findChrome(), [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--hide-scrollbars',
    `--window-size=${windowSize}`,
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  return {
    proc,
    profile,
    dispose() {
      try { proc.kill(); } catch {}
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

/** 等到 CDP 端口能连上，返回页面的 WebSocket 调试地址 */
async function waitForTarget(debugPort, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
  }
  throw new Error('连不上无头 Chrome 的调试端口');
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  static async connect(debugPort) {
    const url = await waitForTarget(debugPort);
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 60000);
    });
  }

  /** 在页面里求值。表达式可以是返回 Promise 的异步代码。 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面内报错：${d.exception?.description || d.text}`);
    }
    return r.result.value;
  }

  /** 轮询等待某个表达式为真 */
  async waitFor(expr, label, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval(`!!(${expr})`)) return true;
      } catch {}
      await sleep(150);
    }
    throw new Error(`等待超时：${label}`);
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
  }

  /**
   * 把文件塞进 <input type=file>。
   * 有些 Chrome 版本设完文件会自己派发 change，有些不派发，所以这里看情况补一刀：
   * 页面若已经处理过（处理完会把 input.value 清空），files.length 就是 0，此时不能再派发，
   * 否则应用会收到一次「空的导入」，白白弹一句「没有可导入的文件」。
   */
  async setFileInput(selector, files) {
    const doc = await this.send('DOM.getDocument');
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!nodeId) throw new Error(`页面里找不到 ${selector}`);
    await this.send('DOM.setFileInputFiles', { files, nodeId });
    await sleep(300);
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el.files && el.files.length) el.dispatchEvent(new Event('change'));
    })()`);
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
}
