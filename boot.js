/* 北海道行程 App｜GitHub 版啟動與同步層（boot.js）
   - 旅伴密碼：鎖整個 App；金鑰存在本機 localStorage（地圖頁同網域共用）
   - 擁有者：網址 #owner 貼 GitHub token → 匯入初始化檔 → App 在手機加密後發布
   - 自動發布 data/live.enc；照片 data/ph/<id>.enc；行程與程式 data/trip.enc（皆用旅伴金鑰加密）
   - 封存 archive/*.enc 用私密密碼加密 */
(() => {
  const REPO = 'aydrac/hokkaido-2026';
  const API = (localStorage.getItem('hkd26-api') || 'https://api.github.com') + '/repos/' + REPO;
  const K = { key: 'hkd26-ck', tok: 'hkd26-token', data: 'hkd26-data', pause: 'hkd26-pause', pubs: 'hkd26-pubstr', pubat: 'hkd26-pubat', phpub: 'hkd26-phpub', bak: 'hkd26-bak', arc: 'hkd26-arc', arcph: 'hkd26-arcph', setup: 'hkd26-setup', tripc: 'hkd26-tripc', livec: 'hkd26-livec', tokbad: 'hkd26-tokbad' };
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const te = new TextEncoder(), td = new TextDecoder();
  const b64e = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- 加密 ---------- */
  async function pbkdf(pw, salt, iter) {
    const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, 256));
  }
  const aesKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function encB(key, u8) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, u8));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
  }
  const decB = async (key, u8) => new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(0, 12) }, key, u8.subarray(12)));
  const encJ = (key, o) => encB(key, te.encode(JSON.stringify(o)));
  const decJ = async (key, u8) => JSON.parse(td.decode(await decB(key, u8)));
  /* 與 App 私密資料相同格式（{v,iter,salt,iv,ct}） */
  async function vaultDec(v, pw) {
    const k = await aesKey(await pbkdf(pw, b64d(v.salt), v.iter));
    return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(v.iv) }, k, b64d(v.ct))));
  }
  async function vaultEnc(obj, pw) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), iter = 250000;
    const k = await aesKey(await pbkdf(pw, salt, iter));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, te.encode(JSON.stringify(obj))));
    return { v: 1, iter, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
  }
  let CK = null;
  async function ckey() { if (!CK) { const r = ls.get(K.key); if (!r) throw new Error('nokey'); CK = await aesKey(b64d(r)); } return CK; }

  /* ---------- IndexedDB（擁有者：行程原始碼與照片） ---------- */
  const idb = (() => {
    let p;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('hkd26', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('ph'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (st, mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(st, mode); const q = fn(t.objectStore(st)); t.oncomplete = () => res(q ? q.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
    return { get: (s, k) => tx(s, 'readonly', o => o.get(k)), put: (s, k, v) => tx(s, 'readwrite', o => o.put(v, k)), keys: s => tx(s, 'readonly', o => o.getAllKeys()), clear: s => tx(s, 'readwrite', o => o.clear()) };
  })();

  /* ---------- GitHub ---------- */
  const tok = () => ls.get(K.tok);
  const SHA = {};
  class GhErr extends Error { constructor(s, m) { super(m || ('GitHub ' + s)); this.status = s; } }
  async function gh(path, opt = {}) {
    const h = Object.assign({ Accept: 'application/vnd.github+json' }, opt.headers || {});
    const t = opt.token || tok(); if (t) h.Authorization = 'Bearer ' + t;
    const r = await fetch(API + path, { method: opt.method || 'GET', headers: h, body: opt.body, cache: 'no-store' });
    if (r.status === 401 && t && !opt.token) markTokBad();
    return r;
  }
  /* 讀檔：GitHub API（不受 Pages 快取影響）→ 失敗改用 Pages 網址 */
  async function getFile(path, etag) {
    try {
      const h = { Accept: 'application/vnd.github.raw' }; if (etag) h['If-None-Match'] = etag;
      const r = await gh('/contents/' + path, { headers: h });
      if (r.status === 304) return { same: true };
      if (r.status === 404) return { missing: true };
      if (r.ok) return { data: new Uint8Array(await r.arrayBuffer()), etag: r.headers.get('ETag') };
    } catch (e) {}
    try {
      const r = await fetch(path + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.status === 404) return { missing: true };
      if (r.ok) return { data: new Uint8Array(await r.arrayBuffer()) };
    } catch (e) {}
    return { error: true };
  }
  async function putFile(path, u8, msg, isNew) {
    for (let a = 0; a < 3; a++) {
      if (!isNew && SHA[path] === undefined) {
        const r = await gh('/contents/' + path);
        if (r.status === 401) throw new GhErr(401);
        SHA[path] = r.ok ? (await r.json()).sha : null;
      }
      const body = { message: msg || ('update ' + path), content: b64e(u8) }; if (SHA[path]) body.sha = SHA[path];
      const r = await gh('/contents/' + path, { method: 'PUT', body: JSON.stringify(body) });
      if (r.ok) { SHA[path] = (await r.json()).content.sha; return; }
      if (r.status === 401) throw new GhErr(401);
      if (r.status === 409 || r.status === 422) { delete SHA[path]; isNew = false; continue; }
      throw new GhErr(r.status);
    }
    throw new GhErr(409);
  }

  /* ---------- 照片 ---------- */
  const PH = {
    urls: {}, pend: {}, fail: {},
    url(id) {
      if (this.urls[id]) return this.urls[id];
      if (!this.pend[id] && !(this.fail[id] > Date.now())) this.pend[id] = this.load(id).then(u => { delete this.pend[id]; if (u) { this.urls[id] = u; reRender(); } else this.fail[id] = Date.now() + 60000; });
      return '';
    },
    async load(id) {
      try {
        if (BOOT.owner) { const b = await idb.get('ph', id); if (b) return URL.createObjectURL(b); }
        let u8 = null;
        try { const r = await fetch('data/ph/' + id + '.enc'); if (r.ok) u8 = new Uint8Array(await r.arrayBuffer()); } catch (e) {}
        if (!u8) { const f = await getFile('data/ph/' + id + '.enc'); u8 = f.data; }
        if (!u8) return null;
        return URL.createObjectURL(new Blob([await decB(await ckey(), u8)], { type: 'image/jpeg' }));
      } catch (e) { return null; }
    },
    async upload(blob) { const id = rid(); await idb.put('ph', id, blob); this.urls[id] = URL.createObjectURL(blob); return { id }; },
    async preload() { const ks = await idb.keys('ph'); await Promise.all(ks.map(async k => { const b = await idb.get('ph', k); if (b) this.urls[k] = URL.createObjectURL(b); })); }
  };
  let rrT = 0;
  const reRender = () => { clearTimeout(rrT); rrT = setTimeout(() => { if (typeof render === 'function' && !document.querySelector('#scrim')) render(); }, 300); };

  /* ---------- 畫面（鎖畫面、擁有者設定） ---------- */
  const STYLE = `#boot{position:fixed;inset:0;z-index:900;background:var(--paper,#F6F1EA);color:var(--ink,#2B2622);display:flex;align-items:center;justify-content:center;padding:calc(env(safe-area-inset-top,0px) + 24px) 22px calc(env(safe-area-inset-bottom,0px) + 24px);overflow:auto;font-family:'Noto Serif TC',serif}
#boot[hidden]{display:none}
.bt-c{width:100%;max-width:380px;display:flex;flex-direction:column;gap:12px}
.bt-eb{font:500 11px Inter,system-ui,sans-serif;letter-spacing:.24em;color:#B5533C}
.bt-c h1{font:700 26px 'Noto Serif TC',serif;margin:0 0 4px}
.bt-c h2{font:700 19px 'Noto Serif TC',serif;margin:0}
.bt-c p{margin:0;font-size:14px;line-height:1.7;color:#5E564D}
.bt-c label{font-size:13px;color:#5E564D;display:flex;flex-direction:column;gap:6px}
.bt-c input[type=password],.bt-c input[type=text]{font:16px Inter,system-ui,sans-serif;padding:12px 14px;border:1px solid #D8CFC2;border-radius:12px;background:#fff;color:#2B2622;width:100%;box-sizing:border-box}
.bt-c button{font:600 15px 'Noto Serif TC',serif;padding:13px 16px;border-radius:12px;border:0;background:#2B2622;color:#F6F1EA;cursor:pointer}
.bt-c button.sub{background:transparent;color:#5E564D;border:1px solid #D8CFC2}
.bt-c button:disabled{opacity:.5}
.bt-err{color:#B5533C !important;min-height:1.2em}
.bt-steps{font:500 11px Inter,system-ui,sans-serif;color:#9A8F82;letter-spacing:.12em}
.bt-log{font:13px/1.8 Inter,system-ui,sans-serif;color:#5E564D;white-space:pre-line}
.ghst{position:absolute;top:calc(env(safe-area-inset-top,0px) + 10px);right:12px;z-index:60;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.ghst button{font:600 12px 'Noto Serif TC',serif;padding:6px 11px;border-radius:999px;border:0;background:rgba(43,38,34,.72);color:#F6F1EA;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);cursor:pointer}
.ghst button.warn{background:rgba(181,83,60,.9)}
.ghm{display:flex;flex-direction:column;gap:10px;padding:4px 0 8px}
.ghm button{text-align:left}
.ghm p{margin:0;font-size:13px;color:var(--mute,#7A7468)}
.ghsave dl{margin:0 0 12px}
.ghsave .row{display:flex;gap:8px;flex-wrap:wrap}
.ghsave .msg{font-size:13px;color:var(--mute,#7A7468);margin:10px 0 0;white-space:pre-line}`;
  const box = () => { let b = document.getElementById('boot'); if (!b) { b = document.createElement('div'); b.id = 'boot'; document.body.appendChild(b); } b.hidden = false; return b; };
  const hideBox = () => { const b = document.getElementById('boot'); if (b) b.hidden = true; };
  const E = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function screen(html) { const b = box(); b.innerHTML = `<div class="bt-c">${html}</div>`; return b; }
  const ask = (html, fn) => { const b = screen(html); const f = b.querySelector('form'); if (f) f.onsubmit = async e => { e.preventDefault(); const err = b.querySelector('.bt-err'); const btn = f.querySelector('button[type=submit]'); if (err) err.textContent = ''; if (btn) btn.disabled = true; try { await fn(b); } catch (x) { if (err) err.textContent = x.message || String(x); } if (btn) btn.disabled = false; }; return b; };

  /* ---------- 啟動 ---------- */
  const BOOT = window.BOOT = { owner: false, page: 'app', live: null, src: null, ph: id => PH.url(id), tokBad: !!ls.get(K.tokbad) };
  BOOT.liveState = () => BOOT.owner ? ((ls.get(K.data) || {}).state || {}) : ((BOOT.live && BOOT.live.state) || {});

  BOOT.start = async page => {
    BOOT.page = page;
    const st = document.createElement('style'); st.textContent = STYLE; document.head.appendChild(st);
    if (/[?&]embed=1/.test(location.search)) document.documentElement.classList.add('embed');
    if (location.hash === '#owner') return ownerSetup();
    const src = ls.get(K.tok) ? await idb.get('kv', 'src').catch(() => null) : null;
    if (src) { BOOT.owner = true; BOOT.src = src; return run(src.data, page === 'map' ? src.map : src.app); }
    if (!ls.get(K.key)) return lockScreen();
    return viewerLoad();
  };

  async function lockScreen(msg) {
    const lf = await getFile('data/lock.json');
    if (!lf.data) return screen(`<div class="bt-eb">HOKKAIDO 2026</div><h1>北海道紅葉の旅</h1><p>${lf.missing ? '行程還沒有發布。' : '目前無法連線，請確認網路後重新整理。'}</p>`);
    const lock = JSON.parse(td.decode(lf.data));
    ask(`<div class="bt-eb">HOKKAIDO 2026</div><h1>北海道紅葉の旅</h1><p>這是私人行程，請輸入旅伴密碼。</p>
      <form><label>旅伴密碼<input type="password" name="pw" autocomplete="current-password" required autofocus></label><p class="bt-err">${E(msg || '')}</p><button type="submit">開啟</button></form><p>每台裝置只要輸入一次，之後會記住。</p>`, async b => {
      const pw = b.querySelector('[name=pw]').value;
      const raw = await pbkdf(pw, b64d(lock.salt), lock.iter);
      try { await decB(await aesKey(raw), b64d(lock.check)); } catch (e) { throw new Error('密碼不對，請再試一次'); }
      ls.set(K.key, b64e(raw)); CK = null;
      return viewerLoad();
    });
  }

  async function viewerLoad() {
    screen(`<div class="bt-eb">HOKKAIDO 2026</div><p>載入中…</p>`);
    let key; try { key = await ckey(); } catch (e) { return lockScreen(); }
    let tf = await getFile('data/trip.enc'), tb = tf.data;
    if (tb) ls.set(K.tripc, b64e(tb)); else if (ls.get(K.tripc)) tb = b64d(ls.get(K.tripc));
    if (!tb) return screen(`<h1>北海道紅葉の旅</h1><p>${tf.missing ? '行程還沒有發布。' : '目前無法連線，請確認網路後重新整理。'}</p>`);
    let trip; try { trip = await decJ(key, tb); } catch (e) { ls.del(K.key); ls.del(K.tripc); CK = null; return lockScreen('旅伴密碼已更換，請輸入新密碼'); }
    await fetchLive(true);
    return run(trip.data, BOOT.page === 'map' ? trip.map : trip.app);
  }
  let liveTag = null;
  async function fetchLive(first) {
    const f = await getFile('data/live.enc', first ? null : liveTag);
    let u8 = f.data;
    if (u8) { liveTag = f.etag || null; ls.set(K.livec, b64e(u8)); }
    else if (first && ls.get(K.livec)) u8 = b64d(ls.get(K.livec));
    if (!u8) return false;
    try { const lv = await decJ(await ckey(), u8); const ch = !BOOT.live || BOOT.live.at !== lv.at; BOOT.live = lv; return ch; } catch (e) { return false; }
  }

  function run(dataJS, codeJS) {
    const s = document.createElement('script');
    s.textContent = dataJS + '\n;\n' + codeJS;
    document.body.appendChild(s);
    if (BOOT.page === 'map') hideBox();
  }

  /* App 程式最後呼叫（取代原本的 initBackend） */
  BOOT.attach = async () => {
    hideBox();
    const _r = render; render = function () { const r = _r.apply(this, arguments); try { decorate(); } catch (e) {} return r; };
    if (BOOT.owner) {
      ENV.mode = 'local'; ENV.canWrite = true; loadLocal();
      ENV.assets = { upload: b => PH.upload(b) };
      await PH.preload().catch(() => {});
      render(); tryWeather(); tryLiveFx();
      try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
      checkToken(); startPublisher();
    } else {
      ENV.mode = 'gh'; ENV.canWrite = false; applyLive();
      render(); tryWeather(); tryLiveFx(); startPoller();
    }
  };
  function applyLive() {
    const lv = BOOT.live; if (!lv) return;
    D.state = Object.assign(DEF_STATE(), lv.state || {});
    if (typeof BD !== 'undefined') { const prev = JSON.stringify(BD.snap || null); BD.snap = lv.cur || null; if (prev !== JSON.stringify(BD.snap) && UI.view === 'plan' && !BD.anim && typeof birdStart === 'function') birdStart(); }
  }
  function startPoller() {
    const poll = async () => { if (document.hidden) return; if (await fetchLive(false)) { applyLive(); if (!document.querySelector('#scrim')) render(); } };
    setInterval(poll, 5 * 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }

  /* ---------- 擁有者：自動發布 ---------- */
  const MASKRE = /[¥￥]\s?\d[\d,]*(?:\s*[~～–-]\s*[¥￥]?\d[\d,]*)?|TWD\s?\d[\d,]*/g;
  const mask = o => typeof o === 'string' ? o.replace(MASKRE, () => '$$$$') : Array.isArray(o) ? o.map(mask) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, mask(v)])) : o;
  function payload() {
    const s = D.state;
    return JSON.stringify({ v: 1, state: { checks: s.checks || {}, edits: mask(s.edits || {}), extras: mask(s.extras || []), pack: s.pack || {}, photos: s.photos || {}, foodv: s.foodv || {}, foodr: mask(s.foodr || {}) }, cur: (typeof BD !== 'undefined' && BD.snap) || null });
  }
  const PUB = { busy: false, seen: null, changed: 0, err: '' };
  const paused = () => !!ls.get(K.pause);
  function markTokBad() { if (!BOOT.tokBad) { BOOT.tokBad = true; ls.set(K.tokbad, 1); reDecorate(); } }
  async function checkToken() {
    try { const r = await gh(''); if (r.ok) { BOOT.tokBad = false; ls.del(K.tokbad); reDecorate(); } } catch (e) {}
  }
  function startPublisher() {
    PUB.seen = payload();
    setInterval(() => {
      const p = payload();
      if (p !== PUB.seen) { PUB.seen = p; PUB.changed = Date.now(); }
      if (PUB.changed && Date.now() - PUB.changed >= 10000 && !paused()) { PUB.changed = 0; if (p !== ls.get(K.pubs)) publish(); }
    }, 2500);
    if (!paused() && PUB.seen !== ls.get(K.pubs)) setTimeout(() => publish(), 3000);
    setInterval(reDecorate, 60e3);
  }
  async function publish() {
    if (PUB.busy || !tok() || BOOT.tokBad) return false;
    PUB.busy = true; PUB.err = ''; reDecorate();
    let ok = false;
    try {
      const key = await ckey(), done = new Set(ls.get(K.phpub) || []);
      for (const p of Object.values(D.state.photos || {})) {
        const id = p && p.asset; if (!id || done.has(id)) continue;
        const b = await idb.get('ph', id); if (!b) continue;
        await putFile('data/ph/' + id + '.enc', await encB(key, new Uint8Array(await b.arrayBuffer())), 'photo', true);
        done.add(id); ls.set(K.phpub, [...done]);
      }
      const p = payload(), body = JSON.parse(p); body.at = Date.now();
      await putFile('data/live.enc', await encJ(key, body), 'live');
      ls.set(K.pubs, p); ls.set(K.pubat, body.at); ok = true;
    } catch (e) { PUB.err = e.status === 401 ? '' : '發布失敗，稍後會再試'; if (e.status !== 401) PUB.changed = Date.now() + 50000; }
    PUB.busy = false; reDecorate(); return ok;
  }

  /* ---------- 首頁狀態標籤、資訊頁「資料保存」 ---------- */
  const ago = t => { if (!t) return '尚未'; const m = Math.floor((Date.now() - t) / 60000); return m < 1 ? '剛剛' : m < 60 ? m + ' 分前' : m < 1440 ? Math.floor(m / 60) + ' 小時前' : Math.floor(m / 1440) + ' 天前'; };
  const fmtT = t => { if (!t) return '尚未'; const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const bakDays = () => { const t = ls.get(K.bak) || ls.get(K.setup) || Date.now(); return Math.floor((Date.now() - t) / 864e5); };
  function reDecorate() { try { decorate(); } catch (e) {} }
  function decorate() {
    if (!BOOT.owner || typeof UI === 'undefined') return;
    const main = document.getElementById('main'); if (!main) return;
    const old = main.querySelector('.ghst'); if (old) old.remove();
    if (UI.view === 'home') {
      const st = BOOT.tokBad ? ['warn', '⚠ token 已過期'] : paused() ? ['', '⏸ 暫停中'] : PUB.busy ? ['', '☁ 發布中…'] : PUB.err ? ['warn', '⚠ ' + PUB.err] : payload() !== ls.get(K.pubs) ? ['', '☁ 待發布…'] : ['', '☁ 已同步・' + ago(ls.get(K.pubat))];
      const d = bakDays();
      main.insertAdjacentHTML('afterbegin', `<div class="ghst"><button type="button" class="${st[0]}" data-gh="menu">${st[1]}</button>${d >= 1 ? `<button type="button" class="warn" data-gh="bak">⚠ ${d} 天未備份</button>` : ''}</div>`);
      main.querySelector('[data-gh=menu]').onclick = openMenu;
      const bk = main.querySelector('[data-gh=bak]'); if (bk) bk.onclick = () => { UI.view = 'info'; UI.itab = 'other'; render(); setTimeout(() => { const c = document.querySelector('.ghsave'); if (c) c.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60); };
    }
    if (UI.view === 'info' && UI.itab === 'other') {
      const body = main.querySelector('.ibody'); if (!body || body.querySelector('.ghsave')) return;
      body.insertAdjacentHTML('beforeend', `<section class="icard ghsave"><header class="icard-h"><h2>資料保存</h2><span>バックアップ</span></header>
        <dl class="kv"><dt>上次備份</dt><dd class="num">${fmtT(ls.get(K.bak))}</dd><dt>上次封存</dt><dd class="num">${fmtT(ls.get(K.arc))}</dd></dl>
        <p class="faint" style="font-size:13px;margin:0 0 12px">匯出備份會存成一個檔案（含照片），私密資料仍保持加密；封存會把全部紀錄用私密密碼加密後存到 GitHub。</p>
        <div class="row"><button class="btn" data-gh="exp">匯出備份</button><button class="btn" data-gh="imp">匯入備份</button><button class="btn" data-gh="arc">封存旅程</button></div>
        <input type="file" accept=".json,application/json" hidden data-gh="file"><p class="msg" data-gh="msg"></p></section>`);
      const c = body.querySelector('.ghsave'), msg = t => { c.querySelector('[data-gh=msg]').textContent = t; };
      c.querySelector('[data-gh=exp]').onclick = () => exportBackup(msg);
      c.querySelector('[data-gh=imp]').onclick = () => c.querySelector('[data-gh=file]').click();
      c.querySelector('[data-gh=file]').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f, msg); };
      c.querySelector('[data-gh=arc]').onclick = () => archiveSheet();
    }
  }
  function openMenu() {
    const p = paused();
    openSheet(sheetHead('同步', '自動發布') + `<div class="ghm">
      <p>${BOOT.tokBad ? 'token 已過期或失效：資料仍保存在這支手機。到 GitHub 重新產生 token 後，用網址加上 #owner 貼上新 token 即可恢復。' : p ? '目前暫停中：修改只存在這支手機，旅伴看不到。' : '停手約 10 秒後自動發布給旅伴。上次發布：' + fmtT(ls.get(K.pubat))}</p>
      ${BOOT.tokBad ? '' : `<button class="btn" data-m="toggle">${p ? '恢復自動發布（立即發布）' : '暫停自動發布'}</button><button class="btn" data-m="now">立即發布</button>`}
      <button class="btn" data-m="rm">移除 token（這支手機改成瀏覽模式）</button></div>`, s => {
      s.addEventListener('click', async e => {
        const b = e.target.closest('[data-m]'); if (!b) return;
        if (b.dataset.m === 'toggle') { if (p) { ls.del(K.pause); closeSheet(); render(); const ok = await publish(); toast(ok ? '已恢復並發布' : '已恢復自動發布'); } else { ls.set(K.pause, 1); closeSheet(); render(); toast('已暫停自動發布'); } }
        if (b.dataset.m === 'now') { closeSheet(); const ok = await publish(); toast(ok ? '已發布' : '發布失敗，請確認網路'); }
        if (b.dataset.m === 'rm') { if (!confirm('移除 token 後，這支手機會變成瀏覽模式，看到的是最後一次發布的內容。\n手機裡的資料不會刪除，之後用 #owner 重新貼 token 就能回到編輯模式。\n確定移除？')) return; ls.del(K.tok); location.reload(); }
      });
    });
  }

  /* ---------- 備份／匯入／封存 ---------- */
  async function allPhotos(ids) { const out = {}; for (const k of ids || await idb.keys('ph')) { const b = await idb.get('ph', k); if (b) out[k] = b64e(new Uint8Array(await b.arrayBuffer())); } return out; }
  async function exportBackup(msg) {
    msg('正在打包…');
    try {
      const o = { kind: 'hkd26-backup', v: 1, at: Date.now(), src: BOOT.src, data: { state: D.state, journal: D.journal, expenses: D.expenses }, photos: await allPhotos() };
      const d = new Date(), name = `hokkaido-backup-${d.getMonth() + 1}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.json`;
      const file = new File([JSON.stringify(o)], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: '北海道行程備份' }); } catch (e) { if (e.name === 'AbortError') { msg('已取消'); return; } throw e; }
      } else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
      ls.set(K.bak, Date.now()); msg(''); render(); toast('已匯出備份');
    } catch (e) { msg('匯出失敗：' + (e.message || e)); }
  }
  async function readJSON(f) { const o = JSON.parse(await f.text()); if (!o || (o.kind !== 'hkd26-backup' && o.kind !== 'hkd26-init')) throw new Error('這不是行程的備份檔或初始化檔'); return o; }
  async function saveImport(o, keepRecords) {
    for (const [k, v] of Object.entries(o.photos || {})) await idb.put('ph', k, new Blob([b64d(v)], { type: 'image/jpeg' }));
    await idb.put('kv', 'src', o.src);
    if (!keepRecords) { const d = o.data || {}; ls.set(K.data, { state: d.state || {}, journal: d.journal || [], expenses: d.expenses || [] }); ls.del(K.pubs); }
  }
  async function importFile(f, msg) {
    try {
      const o = await readJSON(f);
      if (o.kind === 'hkd26-init') {
        if (!confirm('這是初始化檔：會更新程式與行程資料，你在手機上的紀錄會保留。\n接著需要輸入私密密碼，重新加密發布行程。繼續？')) return;
        const pw = prompt('請輸入私密密碼'); if (!pw) return;
        await checkPriv(pw, D.state.vault || o.data.state.vault);
        msg('正在更新…'); await saveImport({ src: o.src, photos: {} }, true); BOOT.src = o.src;
        await publishTrip(o.src, pw); msg(''); toast('已更新，重新載入'); setTimeout(() => location.reload(), 800); return;
      }
      if (!confirm(`匯入 ${fmtT(o.at)} 的備份？\n這支手機目前的紀錄會被備份內容取代。`)) return;
      msg('正在匯入…'); await saveImport(o, false); msg(''); toast('已匯入，重新載入'); setTimeout(() => location.reload(), 800);
    } catch (e) { msg('匯入失敗：' + (e.message || e)); }
  }
  async function checkPriv(pw, vault) { if (!vault) return; try { await vaultDec(vault, pw); } catch (e) { throw new Error('私密密碼不對'); } }
  async function publishTrip(src, pw) {
    const key = await ckey();
    const priv = await vaultEnc({ data: src.data, app: src.app }, pw);
    await putFile('data/trip.enc', await encJ(key, { v: 1, at: Date.now(), data: src.pdata, app: src.papp, map: src.map, priv }), 'trip');
  }
  function archiveSheet() {
    openSheet(sheetHead('封存旅程', 'アーカイブ') + `<div class="ghm"><p>把全部紀錄（行程修改、記錄、花費、照片、私密資料）用私密密碼加密後存到 GitHub，可以封存很多次，每次都會另存一份。</p>
      <label style="display:flex;flex-direction:column;gap:6px;font-size:13px">私密密碼<input type="password" data-a="pw" style="font-size:16px;padding:10px 12px;border:1px solid var(--line,#ddd);border-radius:10px"></label>
      <button class="btn" data-a="go">開始封存</button><p data-a="msg"></p></div>`, s => {
      const m = t => { s.querySelector('[data-a=msg]').textContent = t; };
      s.querySelector('[data-a=go]').onclick = async e => {
        const pw = s.querySelector('[data-a=pw]').value; if (!pw) return m('請輸入私密密碼');
        e.target.disabled = true;
        try { await archive(pw, m); closeSheet(); render(); toast('已封存到 GitHub'); } catch (x) { m(x.status === 401 ? 'token 已過期，無法封存' : (x.message || '封存失敗，請確認網路')); e.target.disabled = false; }
      };
    });
  }
  async function archive(pw, m) {
    await checkPriv(pw, D.state.vault || (typeof VAULT_SEED !== 'undefined' ? VAULT_SEED : null));
    m('準備金鑰…');
    const lf = await getFile('data/lock.json'); if (!lf.data) throw new Error('讀不到 lock.json，請確認網路');
    const lock = JSON.parse(td.decode(lf.data));
    const key = await aesKey(await pbkdf(pw, b64d(lock.asalt), lock.iter));
    const ids = await idb.keys('ph'), done = new Set(ls.get(K.arcph) || []);
    let n = 0;
    for (const id of ids) {
      if (done.has(id)) continue; const b = await idb.get('ph', id); if (!b) continue;
      m(`上傳照片 ${++n}…`);
      await putFile('archive/ph/' + id + '.enc', await encB(key, new Uint8Array(await b.arrayBuffer())), 'archive photo', true);
      done.add(id); ls.set(K.arcph, [...done]);
    }
    m('上傳紀錄…');
    const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    await putFile(`archive/${stamp}.enc`, await encJ(key, { kind: 'hkd26-archive', v: 1, at: Date.now(), src: BOOT.src, data: { state: D.state, journal: D.journal, expenses: D.expenses }, photos: ids }), 'archive ' + stamp, true);
    ls.set(K.arc, Date.now());
  }

  /* ---------- 擁有者設定（#owner） ---------- */
  const leaveOwner = () => { history.replaceState(null, '', location.pathname + location.search); };
  async function ownerSetup() {
    ask(`<div class="bt-steps">擁有者設定 1／4</div><h2>貼上 GitHub token</h2>
      <p>有 token 的手機＝編輯模式，修改會自動發布給旅伴。token 只存在這支手機。</p>
      <form><label>Fine-grained token<input type="password" name="t" autocomplete="off" placeholder="github_pat_…" required></label><p class="bt-err"></p><button type="submit">驗證</button></form>
      <button class="sub" data-x>取消</button>`, async b => {
      const t = b.querySelector('[name=t]').value.trim();
      const r = await gh('', { token: t }).catch(() => null);
      if (!r) throw new Error('連不上 GitHub，請確認網路');
      if (!r.ok) throw new Error('token 無效，或沒有 hokkaido-2026 的權限');
      ls.set(K.tok, t); ls.del(K.tokbad); BOOT.tokBad = false;
      try { await putFile('data/owner.json', te.encode(JSON.stringify({ at: Date.now() })), 'owner check'); }
      catch (e) { ls.del(K.tok); throw new Error('這個 token 不能寫入（Contents 要選 Read and write）'); }
      const src = await idb.get('kv', 'src').catch(() => null);
      if (src && ls.get(K.key)) { leaveOwner(); location.reload(); return; }
      return stepImport();
    });
    const x = document.querySelector('#boot [data-x]'); if (x) x.onclick = () => { leaveOwner(); location.reload(); };
  }
  let IMP = null;
  function stepImport() {
    ask(`<div class="bt-steps">擁有者設定 2／4</div><h2>匯入初始化檔</h2>
      <p>選擇 Claude 給你的「初始化檔」（hokkaido-init.json），或之前匯出的備份檔。</p>
      <form><label>檔案<input type="file" name="f" accept=".json,application/json" required></label><p class="bt-err"></p><button type="submit">下一步</button></form>`, async b => {
      const f = b.querySelector('[name=f]').files[0]; if (!f) throw new Error('請選擇檔案');
      IMP = await readJSON(f);
      return stepCompanion();
    });
  }
  async function stepCompanion() {
    const lf = await getFile('data/lock.json');
    if (lf.error) throw new Error('連不上 GitHub，請確認網路');
    const lock = lf.data ? JSON.parse(td.decode(lf.data)) : null;
    ask(`<div class="bt-steps">擁有者設定 3／4</div><h2>${lock ? '輸入旅伴密碼' : '設定旅伴密碼'}</h2>
      <p>${lock ? '行程已經發布過，請輸入目前的旅伴密碼。' : '旅伴打開網址時要輸入這組密碼才看得到行程；每台裝置輸入一次就會記住。'}</p>
      <form><label>旅伴密碼<input type="password" name="a" autocomplete="new-password" minlength="4" required></label>${lock ? '' : '<label>再輸入一次<input type="password" name="b" autocomplete="new-password" required></label>'}<p class="bt-err"></p><button type="submit">下一步</button></form>`, async b => {
      const a = b.querySelector('[name=a]').value;
      if (lock) {
        const raw = await pbkdf(a, b64d(lock.salt), lock.iter);
        try { await decB(await aesKey(raw), b64d(lock.check)); } catch (e) { throw new Error('旅伴密碼不對'); }
        ls.set(K.key, b64e(raw)); CK = null; return stepPrivate(null);
      }
      if (a.length < 4) throw new Error('至少 4 個字');
      if (a !== b.querySelector('[name=b]').value) throw new Error('兩次輸入不一樣');
      const salt = crypto.getRandomValues(new Uint8Array(16)), asalt = crypto.getRandomValues(new Uint8Array(16)), iter = 250000;
      const raw = await pbkdf(a, salt, iter), key = await aesKey(raw);
      const nl = { v: 1, iter, salt: b64e(salt), asalt: b64e(asalt), check: b64e(await encB(key, te.encode('hkd26'))) };
      ls.set(K.key, b64e(raw)); CK = null;
      return stepPrivate(nl);
    });
  }
  function stepPrivate(newLock) {
    ask(`<div class="bt-steps">擁有者設定 4／4</div><h2>輸入私密密碼</h2>
      <p>就是原本「私密資料」那組密碼。金額與私密資料會用它另外加密保存；這組密碼不會存在手機。</p>
      <form><label>私密密碼<input type="password" name="p" autocomplete="off" required></label><p class="bt-err"></p><button type="submit">開始發布</button></form>`, async b => {
      const pw = b.querySelector('[name=p]').value;
      await checkPriv(pw, (IMP.data && IMP.data.state && IMP.data.state.vault) || null);
      return doSetup(newLock, pw);
    });
  }
  async function doSetup(newLock, pw) {
    const b = screen(`<h2>發布中…</h2><p class="bt-log"></p>`), log = t => { b.querySelector('.bt-log').textContent += t + '\n'; };
    try {
      log('儲存到這支手機'); await saveImport(IMP, false); ls.set(K.setup, ls.get(K.setup) || Date.now()); ls.del(K.phpub); ls.del(K.pubs);
      const key = await ckey();
      if (newLock) { log('建立旅伴密碼鎖'); await putFile('data/lock.json', te.encode(JSON.stringify(newLock)), 'lock'); }
      log('加密並上傳行程'); await publishTrip(IMP.src, pw);
      const st = (IMP.data && IMP.data.state) || {}, done = new Set();
      const ids = Object.values(st.photos || {}).map(p => p && p.asset).filter(Boolean);
      let n = 0;
      for (const id of ids) { const b64 = (IMP.photos || {})[id]; if (!b64) continue; log(`加密照片 ${++n}／${ids.length}`); await putFile('data/ph/' + id + '.enc', await encB(key, b64d(b64)), 'photo', true); done.add(id); }
      ls.set(K.phpub, [...done]);
      log('完成！'); await sleep(600); leaveOwner(); location.reload();
    } catch (e) {
      b.innerHTML = `<div class="bt-c"><h2>發布沒有完成</h2><p>${E(e.status === 401 ? 'token 被拒絕' : (e.message || e))}</p><p>資料已存在手機，可以再按一次重試。</p><button id="rt">重試</button></div>`;
      b.querySelector('#rt').onclick = () => doSetup(newLock, pw);
    }
  }
})();
