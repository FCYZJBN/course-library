// 正文提取引擎：把 docx / pptx / xlsx / pdf / txt 的内容抽成纯文本
//
// 关键点：docx、pptx、xlsx 本质上都是 ZIP 包里的 XML，而 JSZip 已经在技术栈里
// （用来打包导出），所以这几种格式不需要任何新依赖，解包读标签即可。
// 只有 PDF 要额外用 pdf.js，而且是动态 import —— 不导入 PDF 就完全不加载它。
//
// 提取全程在本机完成，不联网、不上传。公式与排版会丢失，但这对「按关键词搜索」
// 没有影响（要搜的词在正文文本里），本模块的用途也不是还原版式。

import { extOf } from './util.js';

const ZIP_BASED = new Set(['docx', 'pptx', 'xlsx']);
const PLAIN = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'log', 'htm', 'html', 'xml']);

// 单份文件最多留多少字符，防止几百页的 PDF 把库撑爆
const MAX_CHARS = 2_000_000;

export function isExtractable(nameOrExt) {
  const ext = nameOrExt.includes('.') ? extOf(nameOrExt) : String(nameOrExt).toLowerCase();
  return ZIP_BASED.has(ext) || PLAIN.has(ext) || ext === 'pdf';
}

// —— 纯文本 ——
// 中文 .txt 有不少是 GBK 编码（尤其 Windows 记事本存的），直接按 UTF-8 读会变乱码，
// 所以先严格试 UTF-8，失败再退到 GBK。
async function readPlainText(blob) {
  const buf = await blob.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

// —— OOXML 公共：解包并读某个 XML 为 DOM ——
async function readXml(zip, path) {
  const f = zip.file(path);
  if (!f) return null;
  const text = await f.async('string');
  if (!text) return null;
  return new DOMParser().parseFromString(text, 'application/xml');
}

function textOfNodes(root, tagName) {
  const nodes = root.getElementsByTagName(tagName);
  let out = '';
  for (let i = 0; i < nodes.length; i++) out += nodes[i].textContent || '';
  return out;
}

// —— docx ——
async function extractDocx(blob) {
  const zip = await JSZip.loadAsync(blob);
  const doc = await readXml(zip, 'word/document.xml');
  if (!doc) return '';

  const paras = doc.getElementsByTagName('w:p');
  const lines = [];
  for (let i = 0; i < paras.length; i++) {
    const line = textOfNodes(paras[i], 'w:t');
    if (line.trim()) lines.push(line);
  }
  return lines.join('\n');
}

// —— pptx ——
// 幻灯片顺序不能靠文件名排序（slide2 不一定排在第 2 位），
// 必须读 presentation.xml 的 sldIdLst，再经 rels 映射到真实文件路径。
async function extractPptx(blob) {
  const zip = await JSZip.loadAsync(blob);

  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pres = await readXml(zip, 'ppt/presentation.xml');
  const rels = await readXml(zip, 'ppt/_rels/presentation.xml.rels');

  const order = [];
  if (pres && rels) {
    const relMap = {};
    const relNodes = rels.getElementsByTagName('Relationship');
    for (let i = 0; i < relNodes.length; i++) {
      relMap[relNodes[i].getAttribute('Id')] = relNodes[i].getAttribute('Target');
    }
    const sldIds = pres.getElementsByTagName('p:sldId');
    for (let i = 0; i < sldIds.length; i++) {
      const rid = sldIds[i].getAttributeNS(R_NS, 'id') || sldIds[i].getAttribute('r:id');
      const target = relMap[rid];
      if (target) order.push(target.replace(/^\.\.\//, '').replace(/^\/?ppt\//, ''));
    }
  }

  // 兜底：拿不到顺序就按文件里的自然序号排
  if (!order.length) {
    order.push(
      ...Object.keys(zip.files)
        .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
        .map((p) => p.replace(/^ppt\//, ''))
        .sort((a, b) => {
          const na = Number(a.match(/(\d+)/)?.[1] || 0);
          const nb = Number(b.match(/(\d+)/)?.[1] || 0);
          return na - nb;
        })
    );
  }

  const out = [];
  for (let i = 0; i < order.length; i++) {
    const slideDoc = await readXml(zip, 'ppt/' + order[i]);
    if (!slideDoc) continue;
    const body = textOfNodes(slideDoc, 'a:t');
    if (body.trim()) out.push(`[第 ${i + 1} 页] ${body}`);

    // 备注页里常有关键补充，一并收进来
    const notesMatch = order[i].match(/slides\/slide(\d+)\.xml/);
    if (notesMatch) {
      const notesPath = `ppt/notesSlides/notesSlide${notesMatch[1]}.xml`;
      const notesDoc = await readXml(zip, notesPath);
      if (notesDoc) {
        const notes = textOfNodes(notesDoc, 'a:t');
        if (notes.trim()) out.push(`[第 ${i + 1} 页·备注] ${notes}`);
      }
    }
  }
  return out.join('\n');
}

// —— xlsx ——
async function extractXlsx(blob) {
  const zip = await JSZip.loadAsync(blob);
  const parts = [];

  const shared = await readXml(zip, 'xl/sharedStrings.xml');
  if (shared) {
    const si = shared.getElementsByTagName('si');
    for (let i = 0; i < si.length; i++) {
      const t = textOfNodes(si[i], 't');
      if (t.trim()) parts.push(t);
    }
  }

  // 内联字符串与数值（公式算出来的结果也在 v 里）
  const sheets = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort();
  for (const p of sheets) {
    const doc = await readXml(zip, p);
    if (!doc) continue;
    const isNodes = doc.getElementsByTagName('is');
    for (let i = 0; i < isNodes.length; i++) {
      const t = textOfNodes(isNodes[i], 't');
      if (t.trim()) parts.push(t);
    }
  }
  return parts.join('\n');
}

// —— pdf（懒加载 pdf.js）——
let _pdfjs = null;
async function loadPdfJs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import('../vendor/pdf.min.mjs');
  _pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return _pdfjs;
}

async function extractPdf(blob) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await blob.arrayBuffer());

  const doc = await pdfjs.getDocument({
    data,
    // 中文 PDF 常用 CID 字体，没这份 cMap 数据会抽不出文字
    cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href,
    cMapPacked: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const out = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let line = '';
      for (const item of tc.items) {
        if (typeof item.str === 'string') line += item.str;
        if (item.hasEOL) line += '\n';
      }
      if (line.trim()) out.push(line);
      page.cleanup();
      // 已经抽够量就停，不必把整本几百页读完
      if (out.join('').length > MAX_CHARS) break;
    }
  } finally {
    await doc.destroy();
  }
  return out.join('\n');
}

/**
 * 提取入口。永远不抛异常——失败返回带 status 的结果，让调用方标 failed 即可，
 * 绝不能因为一份文件提取失败就中断整批导入。
 * @returns {Promise<{status: 'done'|'empty'|'failed'|'unsupported', text: string}>}
 */
export async function extractText(blob, name) {
  const ext = extOf(name);
  try {
    let text = '';

    if (PLAIN.has(ext)) text = await readPlainText(blob);
    else if (ext === 'docx') text = await extractDocx(blob);
    else if (ext === 'pptx') text = await extractPptx(blob);
    else if (ext === 'xlsx') text = await extractXlsx(blob);
    else if (ext === 'pdf') text = await extractPdf(blob);
    else return { status: 'unsupported', text: '' };

    // 归一空白：换行保留，连续空格压成一个
    text = text.replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    if (!text) return { status: 'empty', text: '' };
    return { status: 'done', text: text.slice(0, MAX_CHARS) };
  } catch (err) {
    console.warn('[extractor] 提取失败:', name, err);
    return { status: 'failed', text: '' };
  }
}
