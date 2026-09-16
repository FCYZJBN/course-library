// 内容检索：在提取出的正文里找关键词
//
// 中文没有词边界，子串匹配就够了，不需要分词或建全文索引；
// 几百到几千份文件线性扫一遍在百毫秒量级，完全够用。
//
// 用游标逐条扫，而不是 getAll 一次性读进来——正文可能有几十 MB，
// 整个读进内存会让搜索在低配机器上明显卡顿。

import { scanTexts } from './db.js';
import { snippetAround } from './util.js';

/**
 * 在全部正文里搜索关键词。
 * @returns {Promise<Map<string, {count:number, snippet:string}>>} fileId -> 命中信息
 */
export async function searchTexts(query) {
  const q = String(query || '').trim().toLowerCase();
  const hits = new Map();
  if (!q) return hits;

  await scanTexts((rec) => {
    const text = rec.text;
    if (!text) return;

    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx < 0) return;

    // 统计命中次数，命中多的排前面
    let count = 0;
    let cursor = idx;
    while (cursor >= 0) {
      count++;
      cursor = lower.indexOf(q, cursor + q.length);
    }

    hits.set(rec.id, { count, snippet: snippetAround(text, query) });
  });

  return hits;
}
