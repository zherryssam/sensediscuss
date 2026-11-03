// 로컬 개발·테스트용 서버: gas/Code.gs 를 Google 서비스 목(mock)과 함께 그대로 실행해서
// 실제 Apps Script 웹앱(/exec)처럼 동작시킵니다. 배포에는 필요 없어요 (GitHub Pages + Apps Script만 쓰면 됩니다).
//   node dev-server.js   →   http://localhost:3000/teacher.html
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DOCS = path.join(__dirname, 'docs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/* ---------- Google 서비스 목 ---------- */
const cacheData = new Map();
const cache = {
  get: k => { const e = cacheData.get(k); return e && e.exp > Date.now() ? e.v : null; },
  put: (k, v, ttl = 600) => { cacheData.set(k, { v: String(v), exp: Date.now() + ttl * 1000 }); },
  getAll(keys) { const o = {}; for (const k of keys) { const v = this.get(k); if (v != null) o[k] = v; } return o; },
};

function makeSheet(name, id) {
  let rows = [];
  return {
    getName: () => name,
    getSheetId: () => id,
    appendRow: r => { rows.push(r.slice()); },
    getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
    getRange: (r, c, nr = 1, nc = 1) => ({
      setValues: vals => {
        for (let i = 0; i < nr; i++) {
          rows[r - 1 + i] ||= [];
          for (let j = 0; j < nc; j++) rows[r - 1 + i][c - 1 + j] = vals[i][j];
        }
      },
    }),
    clear: () => { rows = []; },
    setFrozenRows: () => {},
    _rows: () => rows,
  };
}
const sheets = {};
let sheetSeq = 1;
const spreadsheet = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = makeSheet(n, sheetSeq++)),
  getUrl: () => 'https://docs.google.com/spreadsheets/d/DEV',
};

const sandbox = {
  console,
  CacheService: { getScriptCache: () => cache },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, openById: () => spreadsheet },
  Utilities: { getUuid: () => crypto.randomUUID() },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: text => ({ text, setMimeType() { return this; } }),
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'gas', 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });

/* ---------- HTTP ---------- */
const readBody = req => new Promise(res => { let d = ''; req.on('data', c => (d += c)); req.on('end', () => res(d)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/exec') {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...headers, 'Access-Control-Allow-Headers': '*' }); return res.end(); }
    const out = req.method === 'POST'
      ? sandbox.doPost({ postData: { contents: await readBody(req) } })
      : sandbox.doGet({ parameter: Object.fromEntries(url.searchParams) });
    res.writeHead(200, headers);
    return res.end(out.text);
  }
  if (url.pathname === '/__dev/clear-cache') { cacheData.clear(); res.writeHead(200); return res.end('cache cleared'); } // 캐시 유실 시 시트 복구 테스트용
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(DOCS, rel));
  if (!file.startsWith(DOCS)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log('🧪 로컬 테스트 서버 (gas/Code.gs 시뮬레이션)');
  console.log(`   교사 화면: http://localhost:${PORT}/teacher.html`);
  console.log(`   학생 화면: http://localhost:${PORT}/`);
});

module.exports = { sheets };
