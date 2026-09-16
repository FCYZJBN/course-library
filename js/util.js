// 通用工具：id、转义、格式化、文件名解析

// HTML 转义，用于把用户输入安全地插入 innerHTML，防止 XSS
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// 生成唯一 id
export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

// 字节数 -> 人类可读，如 1.2 MB
export function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

// 时间戳 -> YYYY-MM-DD
export function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr() {
  return toDateStr(new Date());
}

// 时间戳 -> YYYY-MM-DD HH:mm
export function formatDateTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${toDateStr(d)} ${hh}:${mm}`;
}

// 相对时间，如「3 天前」
export function relativeTime(ts) {
  const diff = Date.now() - Number(ts || 0);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return toDateStr(new Date(Number(ts)));
}

// 取扩展名（小写，不含点）；无扩展名返回 ''
// 扩展名 = 结尾处的 .字母数字。刻意不用 lastIndexOf('.')：
// 识别时传进来的可能是「文件名 + 目录名」（如 "笔记.doc 高等数学 作业"），
// 按最后一个点切会把点后面的目录名整段当成扩展名丢掉，目录线索就白传了。
const EXT_RE = /\.([A-Za-z0-9]{1,6})$/;

export function extOf(name) {
  return splitExt(name).ext;
}

// 拆成 { base, ext }，base 不含扩展名
export function splitExt(name) {
  const s = String(name);
  const m = s.match(EXT_RE);
  if (!m || m.index === 0) return { base: s, ext: '' };
  return { base: s.slice(0, m.index), ext: m[1].toLowerCase() };
}

// 自然排序比较（让「第2章」排在「第10章」前面）
export function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ax = String(a).toLowerCase().match(re) || [];
  const bx = String(b).toLowerCase().match(re) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = Number(ax[i]);
    const bn = Number(bx[i]);
    if (!isNaN(an) && !isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

export function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// 把一段文本按关键词截取上下文，用于搜索结果高亮预览
export function snippetAround(text, keyword, radius = 40) {
  if (!text || !keyword) return '';
  const lower = text.toLowerCase();
  const idx = lower.indexOf(String(keyword).toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + keyword.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
