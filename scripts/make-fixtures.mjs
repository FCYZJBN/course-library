// 生成冒烟测试用的假文件：node scripts/make-fixtures.mjs
//
// docx / pptx / xlsx 都是 ZIP 包，这里手写一个最小 ZIP 写入器（只用 STORE 不压缩，
// 免去引入 zlib 之外的依赖），好让提取引擎在真实文件格式上被验证，而不是拿假数据糊弄。

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.fixtures');

// —— CRC32 ——
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// —— 最小 ZIP 写入器（STORE，UTF-8 文件名）——
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);   // 标志位：文件名为 UTF-8
    local.writeUInt16LE(0, 8);        // 压缩方法 0 = 不压缩
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);    // 日期：1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, cdBuf, eocd]);
}

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

// —— docx ——
export function makeDocx(paragraphs) {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

  return makeZip([
    { name: '[Content_Types].xml', data: CT },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: doc },
  ]);
}

// —— pptx ——
// 故意让 presentation.xml 里声明的顺序与文件名顺序相反，
// 用来验证提取引擎是真的读了 sldIdLst，而不是偷懒按文件名排序。
export function makePptx(slideXmlList) {
  const files = [
    { name: '[Content_Types].xml', data: CT },
    { name: '_rels/.rels', data: ROOT_RELS },
  ];

  slideXmlList.forEach((xml, i) => {
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: xml });
  });

  const sldIds = slideXmlList
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
    .reverse()  // 反序声明
    .join('');

  files.push({
    name: 'ppt/presentation.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`,
  });

  files.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slideXmlList.map((_, i) =>
  `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
).join('')}
</Relationships>`,
  });

  return makeZip(files);
}

export function slideXml(title, body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p>
<a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
}

// —— xlsx ——
export function makeXlsx(rows) {
  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${rows.length}" uniqueCount="${rows.length}">
${rows.map((r) => `<si><t>${r}</t></si>`).join('')}</sst>`;

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
${rows.map((_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>${i}</v></c></row>`).join('')}
</sheetData></worksheet>`;

  return makeZip([
    { name: '[Content_Types].xml', data: CT },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/sharedStrings.xml', data: shared },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

// —— PDF ——
export function makePdf(lines) {
  const content = lines
    .map((l, i) => `BT /F1 14 Tf 72 ${720 - i * 26} Td (${l}) Tj ET`)
    .join('\n');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

// ============================ 生成 ============================

function generate() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const written = [];

  function out(name, buf) {
    writeFileSync(join(OUT, name), buf);
    written.push(name);
  }

  // 1. 纯文本 —— 内容含「洛必达法则」，用于测内容搜索
  out('高数期末复习笔记.txt',
    '高等数学 期末复习笔记\n第三章 微分中值定理\n洛必达法则用于求未定式极限\n泰勒公式展开要点\n');

  // 1b/1c 同一份笔记的三个版本，用来验证版本分组：
  // 三者的 baseKey 剥掉版本标记后都是「高数期末复习笔记」，应被认成一组，
  // 其中「最终版」是显式声明的最新版，另外两份标为旧版。
  out('高数期末复习笔记 v2.txt', '第二版内容\n洛必达法则补充例题\n');
  out('高数期末复习笔记 最终版.txt', '最终版内容\n洛必达法则完整推导\n');

  // 2. 课件 pptx —— 内容含「应力状态」
  out('工程力学-第3章-课件.pptx', makePptx([
    slideXml('第一章 绪论', '材料力学的基本任务'),
    slideXml('第二章 应力状态分析', '平面应力状态的莫尔圆'),
  ]));

  // 3. 作业 docx —— 内容含「杨氏模量」
  out('大物实验报告.docx', makeDocx([
    '大学物理实验报告',
    '实验名称：用拉伸法测金属丝的杨氏模量',
    '数据处理：逐差法求平均值',
  ]));

  // 4. 真题 pdf —— 内容为 ASCII（PDF 内嵌中文需要 CID 字体，这里不引入）
  out('大物期末试卷.pdf', makePdf([
    'University Physics Final Exam',
    'Problem 1: Youngs Modulus Experiment',
    'Problem 2: Simple Harmonic Motion',
  ]));

  // 5. 认不出归属的文件 —— 应落到「待整理」
  out('新建文件夹(3).docx', makeDocx(['一些随手记的内容，文件名没有任何课程线索']));

  // 6. 表格 xlsx —— 验证 xlsx 提取
  out('高数成绩统计.xlsx', makeXlsx(['平时成绩', '期中成绩', '期末成绩']));

  console.log(`已生成 ${written.length} 个测试文件到 .fixtures/：`);
  for (const n of written) console.log('  ' + n);
}

// 作为模块被 import 时（screenshot.mjs 会这么做）只借出构造函数，不写盘
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) generate();
