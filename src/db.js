// 数据层：IndexedDB 封装（全部 Promise 化）
//
// 存储分三张表，关键是「把大对象和小记录分开」：
//   - files  纯元数据，字段小，可以随便 getAll 遍历
//   - blobs  文件本体（Blob），只在下载/导出时按 id 单独取，绝不批量读
//   - texts  提取出的正文，搜索时用游标逐条扫描
// 如果把它们塞进一条记录，getAll 会把几 GB 内容一次性读进内存，直接卡死。

const DB_NAME = 'course-library-db';
const DB_VERSION = 1;

let _dbPromise = null;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains('semesters')) {
        db.createObjectStore('semesters', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('courses')) {
        const s = db.createObjectStore('courses', { keyPath: 'id' });
        s.createIndex('semesterId', 'semesterId');
      }
      if (!db.objectStoreNames.contains('categories')) {
        const s = db.createObjectStore('categories', { keyPath: 'id' });
        s.createIndex('courseId', 'courseId');
      }
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: 'id' });
        s.createIndex('courseId', 'courseId');
        s.createIndex('categoryId', 'categoryId');
        s.createIndex('courseCategory', ['courseId', 'categoryId']);
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('texts')) {
        db.createObjectStore('texts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

// 把一组读写操作放进事务里跑。
// 为什么不直接把 store.put 一排写完：如果中间有一条同步抛出（比如值没法结构化
// 克隆，抛 DataCloneError），异常会直接穿过调用者，而事务还活着——它会在空闲时
// 自动提交，于是前面几条生效了、后面几条没生效。调用方以为整批失败，
// 实际上库被改了一半。删除同理，删一半比不删更糟。
// 所以这里显式 abort：要么整批成功，要么一条都不留。
function runInTx(tx, fn) {
  try {
    fn();
  } catch (err) {
    try { tx.abort(); } catch {}
    throw err;
  }
  return txDone(tx);
}

export async function getAll(storeName) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  return reqToPromise(tx.objectStore(storeName).getAll());
}

export async function get(storeName, key) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  return reqToPromise(tx.objectStore(storeName).get(key));
}

export async function getByIndex(storeName, indexName, key) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  return reqToPromise(tx.objectStore(storeName).index(indexName).getAll(key));
}

export async function put(storeName, value) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  return runInTx(tx, () => tx.objectStore(storeName).put(value));
}

export async function putMany(storeName, values) {
  if (!values.length) return;
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  return runInTx(tx, () => values.forEach((v) => store.put(v)));
}

export async function remove(storeName, key) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  return runInTx(tx, () => tx.objectStore(storeName).delete(key));
}

export async function removeMany(storeName, keys) {
  if (!keys.length) return;
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  return runInTx(tx, () => keys.forEach((k) => store.delete(k)));
}

export async function clear(storeName) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  return runInTx(tx, () => tx.objectStore(storeName).clear());
}

// 一次事务里同时写多张表：导入文件时元数据、正文、本体必须一起落库
export async function putTx(entries) {
  const stores = Object.keys(entries);
  const db = await openDB();
  const tx = db.transaction(stores, 'readwrite');
  return runInTx(tx, () => {
    stores.forEach((name) => {
      const store = tx.objectStore(name);
      const val = entries[name];
      if (val == null) return;
      if (Array.isArray(val)) val.forEach((v) => store.put(v));
      else store.put(val);
    });
  });
}

// 一次事务里跨表删除
export async function deleteTx(entries) {
  const stores = Object.keys(entries);
  const db = await openDB();
  const tx = db.transaction(stores, 'readwrite');
  return runInTx(tx, () => {
    stores.forEach((name) => {
      const store = tx.objectStore(name);
      const keys = entries[name];
      if (keys == null) return;
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => store.delete(k));
    });
  });
}

// 用游标逐条扫描 texts，避免把整张表（可能几十 MB 正文）一次性读进内存
export async function scanTexts(onRecord) {
  const db = await openDB();
  const tx = db.transaction('texts', 'readonly');
  const req = tx.objectStore('texts').openCursor();
  let count = 0;
  await new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      onRecord(cursor.value);
      count++;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return count;
}

// —— 领域封装 ——
export const semesters = {
  all: () => getAll('semesters'),
  add: (s) => put('semesters', s),
  update: (s) => put('semesters', s),
  remove: (id) => remove('semesters', id),
};

export const courses = {
  all: () => getAll('courses'),
  bySemester: (semesterId) => getByIndex('courses', 'semesterId', semesterId),
  add: (c) => put('courses', c),
  update: (c) => put('courses', c),
  remove: (id) => remove('courses', id),
};

export const categories = {
  all: () => getAll('categories'),
  byCourse: (courseId) => getByIndex('categories', 'courseId', courseId),
  add: (c) => put('categories', c),
  update: (c) => put('categories', c),
  remove: (id) => remove('categories', id),
};

export const files = {
  all: () => getAll('files'),
  get: (id) => get('files', id),
  byCourse: (courseId) => getByIndex('files', 'courseId', courseId),
  add: (f) => put('files', f),
  update: (f) => put('files', f),
  remove: (id) => remove('files', id),
};

export const settings = {
  get: async (key, fallback) => {
    const row = await get('settings', key);
    return row ? row.value : fallback;
  },
  set: (key, value) => put('settings', { key, value }),
};
