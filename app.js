/* Giấy đi đường — theo dõi hạn giấy đi đường của khách vay mua xe.
   Toàn bộ dữ liệu lưu trong IndexedDB trên chính điện thoại, không gửi đi đâu. */
'use strict';
(function () {
  const APP_VERSION = '1.0.0';
  const DAY = 86400000;
  const VN_OFFSET = 7 * 3600000; // Việt Nam: UTC+7, không đổi giờ mùa hè
  const RENEW_DAYS = 90;
  const BACKUP_EVERY_DAYS = 7;

  /* ---------- Tiện ích ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const pad = (n) => String(n).padStart(2, '0');
  const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

  /* ---------- Ngày tháng (giờ Việt Nam) ----------
     Ngày được lưu dạng "yyyy-mm-dd" (chỉ ngày, không có giờ), hiển thị dạng dd/mm/yyyy. */
  function todayISO() { return new Date(Date.now() + VN_OFFSET).toISOString().slice(0, 10); }
  function isoToMs(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); }
  function msToISO(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(iso, n) { return msToISO(isoToMs(iso) + n * DAY); }
  function diffDays(fromISO, toISO) { return Math.round((isoToMs(toISO) - isoToMs(fromISO)) / DAY); }
  function fmtDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
  function isValidISO(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return y >= 1990 && y <= 2200 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  /** Đọc ngày người dùng gõ. Trả về "yyyy-mm-dd", "" nếu bỏ trống, null nếu sai. */
  function parseVNDate(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    let m, y, mo, d;
    if ((m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = s.match(/^(\d{2})(\d{2})(\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    else return null;
    const iso = `${y}-${pad(mo)}-${pad(d)}`;
    return isValidISO(iso) ? iso : null;
  }

  /** Trạng thái theo số ngày còn lại: over (đỏ), soon (cam), month (vàng), ok. */
  function statusOf(c, today) {
    const d = diffDays(today, c.expiry);
    if (d < 0) return { key: 'over', days: d, text: `Quá hạn ${-d} ngày` };
    if (d === 0) return { key: 'soon', days: 0, text: 'Hết hạn hôm nay' };
    if (d === 1) return { key: 'soon', days: 1, text: 'Mai hết hạn' };
    if (d <= 7) return { key: 'soon', days: d, text: `Còn ${d} ngày` };
    if (d <= 30) return { key: 'month', days: d, text: `Còn ${d} ngày` };
    return { key: 'ok', days: d, text: `Còn ${d} ngày` };
  }
  const FILTER_NAMES = { over: 'Quá hạn', soon: 'Còn ≤ 7 ngày', month: 'Còn 8–30 ngày' };

  /* ---------- Tìm kiếm không dấu ---------- */
  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().trim();
  }
  const plateKey = (s) => norm(s).replace(/[^a-z0-9]/g, '');
  function matches(c, q) {
    const nq = norm(q);
    if (!nq) return true;
    if (norm(c.name).includes(nq)) return true;
    const pq = plateKey(q);
    return pq.length > 0 && plateKey(c.plate).includes(pq);
  }

  /* ---------- Cơ sở dữ liệu trên máy (IndexedDB) ---------- */
  const DB = (() => {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) { reject(new Error('Trình duyệt không hỗ trợ lưu dữ liệu (IndexedDB).')); return; }
        const req = indexedDB.open('giay-di-duong', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('customers')) db.createObjectStore('customers', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
        req.onerror = () => reject(req.error);
      });
      dbp.catch(() => { dbp = null; });
      return dbp;
    }
    async function run(store, mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        let result;
        if (req && typeof req === 'object' && 'onsuccess' in req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Lưu dữ liệu bị hủy'));
      });
    }
    return {
      all: () => run('customers', 'readonly', (st) => st.getAll()),
      put: (c) => run('customers', 'readwrite', (st) => st.put(c)),
      del: (id) => run('customers', 'readwrite', (st) => st.delete(id)),
      putMany: (list) => run('customers', 'readwrite', (st) => { list.forEach((c) => st.put(c)); }),
      replaceAll: (list) => run('customers', 'readwrite', (st) => { st.clear(); list.forEach((c) => st.put(c)); }),
      getMeta: async (key) => { const r = await run('meta', 'readonly', (st) => st.get(key)); return r ? r.value : undefined; },
      setMeta: (key, value) => run('meta', 'readwrite', (st) => st.put({ key, value })),
    };
  })();

  async function requestPersist() {
    try {
      if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    } catch (e) { /* bỏ qua */ }
  }

  /* ---------- Trạng thái app ---------- */
  const state = {
    customers: [],
    filter: null,       // 'over' | 'soon' | 'month' | null
    query: '',
    today: todayISO(),
    lastBackupAt: null, // chuỗi ISO thời điểm sao lưu gần nhất
    snoozeUntil: 0,     // tạm ẩn nhắc sao lưu đến thời điểm này (ms)
    ready: false,
    dbError: null,
  };
  const byId = (id) => state.customers.find((c) => c.id === id);

  /* ---------- Hiển thị danh sách ---------- */
  function render() {
    const today = state.today;
    $('#today-label').textContent = 'Hôm nay: ' + fmtDate(today);

    const rows = state.customers.map((c) => ({ c, s: statusOf(c, today) }));
    rows.sort((a, b) => (a.c.expiry < b.c.expiry ? -1 : a.c.expiry > b.c.expiry ? 1 : a.c.name.localeCompare(b.c.name, 'vi')));

    const counts = { over: 0, soon: 0, month: 0, ok: 0 };
    rows.forEach((r) => { counts[r.s.key]++; });
    $('#n-over').textContent = counts.over;
    $('#n-soon').textContent = counts.soon;
    $('#n-month').textContent = counts.month;
    $$('.stat').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));

    let shown = rows;
    if (state.filter) shown = shown.filter((r) => r.s.key === state.filter);
    if (state.query) shown = shown.filter((r) => matches(r.c, state.query));

    const total = rows.length;
    let info;
    if (state.filter || state.query) {
      const parts = [];
      if (state.filter) parts.push(FILTER_NAMES[state.filter]);
      if (state.query) parts.push(`“${state.query}”`);
      info = `Đang lọc: ${parts.join(' · ')} — ${shown.length}/${total} khách`;
    } else {
      info = total ? `${total} khách · hạn gần nhất ở trên` : '';
    }
    $('#list-info').textContent = info;
    $('#btn-clear-filter').hidden = !(state.filter || state.query);

    $('#list').innerHTML = shown.map(cardHTML).join('');

    const empty = $('#empty');
    if (state.dbError) {
      empty.hidden = false;
      empty.innerHTML = `<h3>Không mở được bộ nhớ</h3><p>${esc(state.dbError)}</p>`;
    } else if (state.ready && total === 0) {
      empty.hidden = false;
      empty.innerHTML = '<h3>Chưa có khách nào</h3><p>Bấm nút + để thêm khách đầu tiên.</p><button class="btn btn-primary" data-act="add-first">Thêm khách</button>';
    } else if (total > 0 && shown.length === 0) {
      empty.hidden = false;
      empty.innerHTML = '<h3>Không có khách phù hợp</h3><p>Thử bỏ lọc hoặc tìm từ khác.</p>';
    } else {
      empty.hidden = true;
      empty.innerHTML = '';
    }
    renderBanners();
  }

  function cardHTML({ c, s }) {
    const renewals = (c.history || []).length;
    return `<li class="card st-${s.key}" data-id="${esc(c.id)}">
      <button class="card-main" type="button" data-act="edit" aria-label="Sửa thông tin ${esc(c.name)}">
        <div class="card-top"><span class="name">${esc(c.name)}</span><span class="badge">${esc(s.text)}</span></div>
        <div class="card-meta">
          ${c.plate ? `<span class="plate">${esc(c.plate)}</span>` : ''}
          <span>Hết hạn <b>${fmtDate(c.expiry)}</b></span>
          ${c.issue ? `<span>Cấp ${fmtDate(c.issue)}</span>` : ''}
          ${renewals ? `<span class="renew-count">Đã gia hạn ${renewals} lần</span>` : ''}
        </div>
        ${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}
      </button>
      <div class="card-actions">
        <button class="btn btn-primary" type="button" data-act="renew">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Đã gia hạn
        </button>
        <button class="btn btn-ghost" type="button" data-act="cal">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          Thêm vào Lịch
        </button>
      </div>
    </li>`;
  }

  /* ---------- Nhắc sao lưu & mẹo cài app ---------- */
  function backupRefTime() {
    if (state.lastBackupAt) return Date.parse(state.lastBackupAt);
    const created = state.customers.map((c) => Date.parse(c.createdAt)).filter((n) => !isNaN(n));
    return created.length ? Math.min(...created) : Date.now();
  }
  function renderBanners() {
    const tip = $('#install-tip');
    tip.hidden = !(isIOS && !isStandalone && !localStorageGet('tipClosed'));

    const bb = $('#backup-banner');
    if (!state.customers.length || Date.now() < state.snoozeUntil) { bb.hidden = true; return; }
    const days = Math.floor((Date.now() - backupRefTime()) / DAY);
    if (days < BACKUP_EVERY_DAYS) { bb.hidden = true; return; }
    $('#backup-text').textContent = state.lastBackupAt
      ? `Đã ${days} ngày chưa sao lưu. Nên xuất file để không mất dữ liệu nếu đổi/mất điện thoại.`
      : 'Bạn chưa sao lưu lần nào. Nên xuất file để không mất dữ liệu nếu đổi/mất điện thoại.';
    bb.hidden = false;
  }
  function localStorageGet(k) { try { return localStorage.getItem('gdd-' + k); } catch (e) { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem('gdd-' + k, v); } catch (e) { /* bỏ qua */ } }

  function renderBackupInfo() {
    let text;
    if (state.lastBackupAt) {
      const d = new Date(Date.parse(state.lastBackupAt) + VN_OFFSET).toISOString().slice(0, 10);
      const ago = diffDays(d, state.today);
      text = `Sao lưu gần nhất: <b>${fmtDate(d)}</b> (${ago === 0 ? 'hôm nay' : ago + ' ngày trước'}).`;
    } else {
      text = '<b>Chưa sao lưu lần nào.</b>';
    }
    $('#backup-info').innerHTML = `${text}<br>Đang có ${state.customers.length} khách trong app.`;
  }

  /* ---------- Bảng trượt (sheet) ---------- */
  let openSheetEl = null;
  function openSheet(id) {
    if (openSheetEl) closeSheet(true);
    const el = $(id);
    const bd = $('#backdrop');
    $('#toast').hidden = true; // không để thông báo che nội dung bảng
    bd.hidden = false; el.hidden = false;
    el.querySelector('.sheet-body').scrollTop = 0;
    document.body.classList.add('modal-open');
    void el.offsetWidth; // để hiệu ứng trượt chạy
    bd.classList.add('show'); el.classList.add('show');
    openSheetEl = el;
  }
  function closeSheet(instant) {
    const el = openSheetEl;
    if (!el) return;
    openSheetEl = null;
    if (document.activeElement && el.contains(document.activeElement)) document.activeElement.blur();
    const bd = $('#backdrop');
    el.classList.remove('show'); bd.classList.remove('show');
    document.body.classList.remove('modal-open');
    const done = () => { if (!el.classList.contains('show')) el.hidden = true; if (!openSheetEl) bd.hidden = true; };
    if (instant) done(); else setTimeout(done, 300);
  }

  /* ---------- Hộp xác nhận ---------- */
  function ask(title, message, buttons) {
    return new Promise((resolve) => {
      const wrap = $('#dialog');
      $('#dlg-title').textContent = title;
      $('#dlg-msg').textContent = message;
      const box = $('#dlg-btns');
      box.innerHTML = '';
      buttons.forEach((b) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'btn ' + (b.style || 'btn-ghost');
        el.textContent = b.label;
        el.addEventListener('click', () => { wrap.hidden = true; resolve(b.value); });
        box.appendChild(el);
      });
      wrap.hidden = false;
    });
  }

  /* ---------- Thông báo nhỏ ---------- */
  let toastTimer = null;
  function toast(msg, action, ms) {
    const t = $('#toast');
    $('#toast-msg').textContent = msg;
    const btn = $('#toast-act');
    if (action) {
      btn.hidden = false; btn.textContent = action.label;
      btn.onclick = () => { t.hidden = true; action.fn(); };
    } else { btn.hidden = true; btn.onclick = null; }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || (action ? 6000 : 2800));
  }

  /* ---------- Ô nhập ngày dd/mm/yyyy (gõ số hoặc bấm lịch để chọn) ---------- */
  function setupDateField(wrap) {
    const text = $('input[type="text"]', wrap);
    const picker = $('input[type="date"]', wrap);
    text.addEventListener('input', () => {
      const raw = text.value;
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) { const iso = parseVNDate(raw); if (iso) text.value = fmtDate(iso); return; }
      if (/^\d{1,2}(\/(\d{1,2}(\/\d{0,4})?)?)?$/.test(raw) || raw === '') return; // đang gõ đúng dạng
      const digits = raw.replace(/\D/g, '').slice(0, 8);
      let out = digits.slice(0, 2);
      if (digits.length > 2) out += '/' + digits.slice(2, 4);
      if (digits.length > 4) out += '/' + digits.slice(4, 8);
      text.value = out;
    });
    text.addEventListener('blur', () => {
      const iso = parseVNDate(text.value);
      if (iso) text.value = fmtDate(iso);
    });
    const sync = () => { picker.value = parseVNDate(text.value) || ''; };
    picker.addEventListener('pointerdown', sync);
    picker.addEventListener('focus', sync);
    picker.addEventListener('click', () => { try { if (picker.showPicker) picker.showPicker(); } catch (e) { /* bỏ qua */ } });
    const apply = () => {
      if (!picker.value) return;
      text.value = fmtDate(picker.value);
      text.dispatchEvent(new Event('input', { bubbles: true }));
      clearErr(text.id);
    };
    picker.addEventListener('input', apply);
    picker.addEventListener('change', apply);
  }
  const setDate = (id, iso) => { $('#' + id).value = iso ? fmtDate(iso) : ''; };
  /** Chỉ trả về ngày khi đã gõ đủ dd/mm/yyyy (tránh gợi ý sai khi đang gõ dở năm). */
  const completeDate = (text) => (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(text).trim()) ? parseVNDate(text) : null);

  function setErr(id, msg) {
    const input = $('#' + id);
    const field = input.closest('.field');
    if (field) field.classList.add('has-err');
    const e = $(`[data-err="${id}"]`);
    if (e) e.textContent = msg;
  }
  function clearErr(id) {
    const input = $('#' + id);
    const field = input && input.closest('.field');
    if (field) field.classList.remove('has-err');
    const e = $(`[data-err="${id}"]`);
    if (e) e.textContent = '';
  }
  function clearAllErr(form) { $$('.err', form).forEach((e) => { e.textContent = ''; }); $$('.has-err', form).forEach((f) => f.classList.remove('has-err')); }

  /* ---------- Thêm / sửa / xóa khách ---------- */
  let editingId = null;
  function openForm(c) {
    editingId = c ? c.id : null;
    const form = $('#form');
    form.reset();
    clearAllErr(form);
    $('#form-title').textContent = c ? 'Sửa thông tin khách' : 'Thêm khách';
    $('#f-name').value = c ? c.name : '';
    $('#f-plate').value = c ? (c.plate || '') : '';
    setDate('f-issue', c ? c.issue : '');
    setDate('f-expiry', c ? c.expiry : '');
    $('#f-note').value = c ? (c.note || '') : '';
    $('#btn-delete').hidden = !c;

    const hist = (c && c.history) || [];
    $('#form-history').hidden = hist.length === 0;
    $('#history-list').innerHTML = hist.slice().reverse().map((h) => `<li>
        Ngày ${fmtDate(h.renewedOn)}: hạn ${fmtDate(h.oldExpiry)} → <b>${fmtDate(h.newExpiry)}</b>
        ${h.newIssue ? `<div class="h-note">Cấp mới ${fmtDate(h.newIssue)}</div>` : ''}
        ${h.note ? `<div class="h-note">${esc(h.note)}</div>` : ''}
      </li>`).join('');
    openSheet('#sheet-form');
  }

  async function saveForm(ev) {
    ev.preventDefault();
    const form = $('#form');
    clearAllErr(form);
    const name = $('#f-name').value.trim().replace(/\s+/g, ' ');
    const plate = $('#f-plate').value.trim().replace(/\s+/g, ' ').toUpperCase();
    const issue = parseVNDate($('#f-issue').value);
    const expiry = parseVNDate($('#f-expiry').value);
    const note = $('#f-note').value.trim();
    let ok = true;
    if (!name) { setErr('f-name', 'Cần nhập họ tên.'); ok = false; }
    if (issue === null) { setErr('f-issue', 'Ngày không hợp lệ (dd/mm/yyyy).'); ok = false; }
    if (expiry === null) { setErr('f-expiry', 'Ngày không hợp lệ (dd/mm/yyyy).'); ok = false; }
    else if (!expiry) { setErr('f-expiry', 'Cần nhập ngày hết hạn.'); ok = false; }
    if (ok && issue && expiry < issue) { setErr('f-expiry', 'Ngày hết hạn phải sau ngày cấp.'); ok = false; }
    if (!ok) return;

    const now = new Date().toISOString();
    const old = editingId ? byId(editingId) : null;
    const c = old
      ? Object.assign({}, old, { name, plate, issue, expiry, note, updatedAt: now })
      : { id: uid(), name, plate, issue, expiry, note, history: [], createdAt: now, updatedAt: now };
    try {
      await DB.put(c);
    } catch (e) { toast('Không lưu được: ' + e.message); return; }
    if (old) state.customers = state.customers.map((x) => (x.id === c.id ? c : x));
    else state.customers.push(c);
    closeSheet();
    render();
    toast(old ? 'Đã lưu thay đổi' : `Đã thêm ${c.name}`);
    requestPersist();
  }

  async function deleteCurrent() {
    const c = byId(editingId);
    if (!c) return;
    const yes = await ask('Xóa khách này?', `${c.name}${c.plate ? ' — ' + c.plate : ''}\nSẽ xóa cả lịch sử gia hạn.`, [
      { label: 'Xóa', value: true, style: 'btn-danger' },
      { label: 'Không xóa', value: false },
    ]);
    if (!yes) return;
    try { await DB.del(c.id); } catch (e) { toast('Không xóa được: ' + e.message); return; }
    state.customers = state.customers.filter((x) => x.id !== c.id);
    closeSheet();
    render();
    toast(`Đã xóa ${c.name}`, {
      label: 'Hoàn tác',
      fn: async () => { await DB.put(c); state.customers.push(c); render(); toast('Đã khôi phục'); },
    });
  }

  /* ---------- Gia hạn ---------- */
  let renewingId = null;
  let renewExpiryTouched = false;
  function openRenew(c) {
    renewingId = c.id;
    renewExpiryTouched = false;
    const form = $('#renew-form');
    form.reset();
    clearAllErr(form);
    const s = statusOf(c, state.today);
    $('#r-name').textContent = c.name;
    $('#r-sub').textContent = `${c.plate ? c.plate + ' · ' : ''}Hạn cũ ${fmtDate(c.expiry)} (${s.text.toLowerCase()})`;
    setDate('r-issue', state.today);
    setDate('r-expiry', addDays(state.today, RENEW_DAYS));
    $('#chip-r-old').textContent = `+90 ngày từ hạn cũ (${fmtDate(addDays(c.expiry, RENEW_DAYS))})`;
    openSheet('#sheet-renew');
  }

  async function saveRenew(ev) {
    ev.preventDefault();
    const c = byId(renewingId);
    if (!c) { closeSheet(); return; }
    const form = $('#renew-form');
    clearAllErr(form);
    const newIssue = parseVNDate($('#r-issue').value);
    const newExpiry = parseVNDate($('#r-expiry').value);
    const note = $('#r-note').value.trim();
    let ok = true;
    if (newIssue === null) { setErr('r-issue', 'Ngày không hợp lệ.'); ok = false; }
    if (newExpiry === null) { setErr('r-expiry', 'Ngày không hợp lệ.'); ok = false; }
    else if (!newExpiry) { setErr('r-expiry', 'Cần nhập hạn mới.'); ok = false; }
    if (ok && newIssue && newExpiry < newIssue) { setErr('r-expiry', 'Hạn mới phải sau ngày cấp mới.'); ok = false; }
    if (!ok) return;
    if (newExpiry <= c.expiry) {
      const go = await ask('Hạn mới không sau hạn cũ', `Hạn cũ: ${fmtDate(c.expiry)}\nHạn mới: ${fmtDate(newExpiry)}\nVẫn lưu?`, [
        { label: 'Vẫn lưu', value: true, style: 'btn-primary' },
        { label: 'Sửa lại', value: false },
      ]);
      if (!go) return;
    }
    const entry = {
      renewedOn: state.today,
      oldIssue: c.issue || '', oldExpiry: c.expiry,
      newIssue: newIssue || '', newExpiry,
      note, at: new Date().toISOString(),
    };
    const updated = Object.assign({}, c, {
      issue: newIssue || c.issue,
      expiry: newExpiry,
      history: (c.history || []).concat([entry]),
      updatedAt: new Date().toISOString(),
    });
    try { await DB.put(updated); } catch (e) { toast('Không lưu được: ' + e.message); return; }
    state.customers = state.customers.map((x) => (x.id === updated.id ? updated : x));
    closeSheet();
    render();
    toast(`Đã gia hạn đến ${fmtDate(newExpiry)}`, { label: 'Thêm vào Lịch', fn: () => openCal(byId(updated.id)) }, 8000);
  }

  /* ---------- File Lịch (.ics) ---------- */
  function icsText(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function icsFold(line) { // mỗi dòng tối đa 75 byte theo chuẩn iCalendar
    const enc = new TextEncoder();
    if (enc.encode(line).length <= 75) return line;
    const out = []; let cur = ''; let bytes = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > 75) { out.push(cur); cur = ' ' + ch; bytes = 1 + b; }
      else { cur += ch; bytes += b; }
    }
    out.push(cur);
    return out.join('\r\n');
  }
  const icsStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const icsDate = (iso) => iso.replace(/-/g, '');
  function icsWrap(eventLines) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Giay di duong//PWA//VI', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']
      .concat(eventLines, ['END:VCALENDAR']);
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }
  function buildCustomerICS(c) {
    const who = c.plate ? `${c.name} (${c.plate})` : c.name;
    const desc = [
      `Khách: ${c.name}`,
      c.plate && `Biển số: ${c.plate}`,
      c.issue && `Ngày cấp: ${fmtDate(c.issue)}`,
      `Ngày hết hạn: ${fmtDate(c.expiry)}`,
      c.note && `Ghi chú: ${c.note}`,
    ].filter(Boolean).join('\n');
    return icsWrap([
      'BEGIN:VEVENT',
      `UID:${c.id}-${icsDate(c.expiry)}@giay-di-duong`,
      `DTSTAMP:${icsStamp()}`,
      `DTSTART;VALUE=DATE:${icsDate(c.expiry)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(c.expiry, 1))}`,
      `SUMMARY:${icsText('Hết hạn giấy đi đường: ' + who)}`,
      `DESCRIPTION:${icsText(desc)}`,
      'TRANSP:TRANSPARENT',
      // Sự kiện cả ngày bắt đầu 0:00 → -6 ngày 16 giờ = 8:00 sáng trước 7 ngày
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText('Còn 7 ngày hết hạn giấy đi đường: ' + who)}`, 'TRIGGER:-P6DT16H', 'END:VALARM',
      // -16 giờ = 8:00 sáng hôm trước
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText('Ngày mai hết hạn giấy đi đường: ' + who)}`, 'TRIGGER:-PT16H', 'END:VALARM',
      'END:VEVENT',
    ]);
  }
  function buildBackupReminderICS() {
    // Thứ Sáu gần nhất (kể cả hôm nay) lúc 17:00 giờ VN = 10:00 UTC, lặp lại hằng tuần
    const dow = new Date(isoToMs(state.today)).getUTCDay(); // 0 = Chủ nhật, 5 = thứ Sáu
    const first = addDays(state.today, (5 - dow + 7) % 7);
    return icsWrap([
      'BEGIN:VEVENT',
      'UID:weekly-backup@giay-di-duong',
      `DTSTAMP:${icsStamp()}`,
      `DTSTART:${icsDate(first)}T100000Z`,
      `DTEND:${icsDate(first)}T101500Z`,
      'RRULE:FREQ=WEEKLY',
      `SUMMARY:${icsText('Sao lưu dữ liệu app Giấy đi đường')}`,
      `DESCRIPTION:${icsText('Mở app Giấy đi đường → nút ••• → Sao lưu dữ liệu. Lưu file vào Tệp/iCloud Drive hoặc gửi cho chính mình.')}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText('Đến giờ sao lưu dữ liệu Giấy đi đường')}`, 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT',
    ]);
  }
  function safeFileName(s) {
    return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'khach';
  }

  /* ---------- Tải / chia sẻ file ---------- */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function shareableFile(blob, filename) {
    if (!navigator.canShare || !navigator.share) return null;
    const types = [blob.type, 'text/plain'];
    for (const type of types) {
      const f = new File([blob], filename, { type });
      try { if (navigator.canShare({ files: [f] })) return f; } catch (e) { /* bỏ qua */ }
    }
    return null;
  }

  let calCustomerId = null;
  function openCal(c) {
    if (!c) return;
    calCustomerId = c.id;
    $('#cal-name').textContent = c.name;
    $('#cal-sub').textContent = c.plate || '';
    $('#cal-date').textContent = fmtDate(c.expiry);
    const blob = new Blob([buildCustomerICS(c)], { type: 'text/calendar' });
    $('#cal-share').hidden = !shareableFile(blob, 'test.ics');
    openSheet('#sheet-cal');
  }
  function calFile() {
    const c = byId(calCustomerId);
    if (!c) return null;
    return {
      blob: new Blob([buildCustomerICS(c)], { type: 'text/calendar;charset=utf-8' }),
      name: `het-han-${safeFileName(c.name)}-${icsDate(c.expiry)}.ics`,
    };
  }

  /* ---------- Sao lưu (xuất) & khôi phục (nhập) ---------- */
  async function markBackedUp() {
    state.lastBackupAt = new Date().toISOString();
    state.snoozeUntil = 0;
    try { await DB.setMeta('lastBackupAt', state.lastBackupAt); await DB.setMeta('snoozeUntil', 0); } catch (e) { /* bỏ qua */ }
    renderBanners();
    renderBackupInfo();
  }

  async function exportData() {
    if (!state.customers.length) { toast('Chưa có dữ liệu để sao lưu'); return; }
    const data = {
      app: 'giay-di-duong',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: state.customers.length,
      customers: state.customers,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const filename = `giay-di-duong-sao-luu-${state.today}.json`;
    if (isIOS) {
      const f = shareableFile(blob, filename);
      if (f) {
        try {
          await navigator.share({ files: [f], title: 'Sao lưu Giấy đi đường' });
          await markBackedUp();
          toast('Đã sao lưu. Nhớ chọn “Lưu vào Tệp” hoặc gửi cho chính bạn.');
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return; // người dùng bấm hủy
        }
      }
    }
    downloadBlob(blob, filename);
    await markBackedUp();
    toast('Đã xuất file sao lưu');
  }

  function cleanCustomer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').trim();
    const expiry = String(raw.expiry || '');
    if (!name || !isValidISO(expiry)) return null;
    const issue = isValidISO(raw.issue) ? raw.issue : '';
    const now = new Date().toISOString();
    const history = Array.isArray(raw.history) ? raw.history.filter((h) => h && isValidISO(h.newExpiry)).map((h) => ({
      renewedOn: isValidISO(h.renewedOn) ? h.renewedOn : h.newExpiry,
      oldIssue: isValidISO(h.oldIssue) ? h.oldIssue : '',
      oldExpiry: isValidISO(h.oldExpiry) ? h.oldExpiry : '',
      newIssue: isValidISO(h.newIssue) ? h.newIssue : '',
      newExpiry: h.newExpiry,
      note: String(h.note || ''),
      at: String(h.at || ''),
    })) : [];
    return {
      id: String(raw.id || uid()),
      name,
      plate: String(raw.plate || '').trim().toUpperCase(),
      issue,
      expiry,
      note: String(raw.note || ''),
      history,
      createdAt: String(raw.createdAt || now),
      updatedAt: String(raw.updatedAt || now),
    };
  }

  async function importFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (e) { await ask('Không đọc được file', 'File này không phải file sao lưu của app.', [{ label: 'Đóng', value: 0 }]); return; }
    const rawList = Array.isArray(data) ? data : (data && Array.isArray(data.customers) ? data.customers : null);
    if (!rawList) { await ask('Không đọc được file', 'File này không phải file sao lưu của app.', [{ label: 'Đóng', value: 0 }]); return; }
    const list = rawList.map(cleanCustomer).filter(Boolean);
    const skipped = rawList.length - list.length;
    if (!list.length) { await ask('File không có dữ liệu', 'Không tìm thấy khách hợp lệ trong file.', [{ label: 'Đóng', value: 0 }]); return; }

    const when = data.exportedAt ? fmtDate(new Date(Date.parse(data.exportedAt) + VN_OFFSET).toISOString().slice(0, 10)) : '';
    const msg = `File có ${list.length} khách${when ? ', sao lưu ngày ' + when : ''}.${skipped ? `\n(${skipped} dòng lỗi sẽ bị bỏ qua.)` : ''}\nHiện app đang có ${state.customers.length} khách.`;
    const choice = await ask('Khôi phục dữ liệu', msg, [
      { label: 'Thay thế toàn bộ bằng file', value: 'replace', style: 'btn-primary' },
      { label: 'Gộp thêm vào dữ liệu hiện có', value: 'merge' },
      { label: 'Hủy', value: null },
    ]);
    if (!choice) return;
    try {
      if (choice === 'replace') {
        if (state.customers.length) {
          const sure = await ask('Chắc chắn thay thế?', `${state.customers.length} khách hiện có sẽ bị thay bằng ${list.length} khách trong file.`, [
            { label: 'Thay thế', value: true, style: 'btn-danger' },
            { label: 'Hủy', value: false },
          ]);
          if (!sure) return;
        }
        await DB.replaceAll(list);
        state.customers = list;
      } else {
        await DB.putMany(list);
        const map = new Map(state.customers.map((c) => [c.id, c]));
        list.forEach((c) => map.set(c.id, c));
        state.customers = Array.from(map.values());
      }
    } catch (e) { toast('Không khôi phục được: ' + e.message); return; }
    await markBackedUp(); // dữ liệu vừa lấy từ file sao lưu nên coi như đã có bản sao lưu
    closeSheet();
    state.filter = null; state.query = ''; $('#q').value = '';
    render();
    toast(`Đã khôi phục ${list.length} khách`);
    requestPersist();
  }

  /* ---------- Gắn sự kiện cho nút bấm ---------- */
  function bindEvents() {
    $$('.date-field').forEach(setupDateField);

    $('#btn-add').addEventListener('click', () => openForm(null));
    $('#btn-menu').addEventListener('click', () => { renderBackupInfo(); openSheet('#sheet-menu'); });
    $('#backdrop').addEventListener('click', () => closeSheet());
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet()));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#dialog').hidden) closeSheet(); });

    $$('.stat').forEach((b) => b.addEventListener('click', () => {
      state.filter = state.filter === b.dataset.filter ? null : b.dataset.filter;
      render();
    }));
    $('#btn-clear-filter').addEventListener('click', () => { state.filter = null; state.query = ''; $('#q').value = ''; render(); });
    $('#q').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });

    $('#list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const li = e.target.closest('li[data-id]');
      if (!btn || !li) return;
      const c = byId(li.dataset.id);
      if (!c) return;
      if (btn.dataset.act === 'edit') openForm(c);
      else if (btn.dataset.act === 'renew') openRenew(c);
      else if (btn.dataset.act === 'cal') openCal(c);
    });
    $('#empty').addEventListener('click', (e) => { if (e.target.closest('[data-act="add-first"]')) openForm(null); });

    // Form khách
    $('#form').addEventListener('submit', saveForm);
    $('#btn-delete').addEventListener('click', deleteCurrent);
    ['f-name', 'f-plate', 'f-issue', 'f-expiry'].forEach((id) => $('#' + id).addEventListener('input', () => clearErr(id)));
    $('#f-plate').addEventListener('blur', (e) => { e.target.value = e.target.value.toUpperCase(); });
    $('#f-issue').addEventListener('input', () => {
      // Có ngày cấp mà chưa có ngày hết hạn → tự gợi ý +90 ngày
      const iso = completeDate($('#f-issue').value);
      if (iso && !$('#f-expiry').value.trim()) setDate('f-expiry', addDays(iso, RENEW_DAYS));
    });
    $('#chip-form-90').addEventListener('click', () => {
      const iso = parseVNDate($('#f-issue').value);
      if (!iso) { setErr('f-issue', 'Nhập ngày cấp trước.'); return; }
      setDate('f-expiry', addDays(iso, RENEW_DAYS));
      clearErr('f-expiry');
    });
    $('#f-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#f-plate').focus(); } });
    $('#f-plate').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#f-issue').focus(); } });

    // Form gia hạn
    $('#renew-form').addEventListener('submit', saveRenew);
    $('#r-issue').addEventListener('input', () => {
      clearErr('r-issue');
      const iso = completeDate($('#r-issue').value);
      if (iso && !renewExpiryTouched) setDate('r-expiry', addDays(iso, RENEW_DAYS));
    });
    $('#r-expiry').addEventListener('input', () => { renewExpiryTouched = true; clearErr('r-expiry'); });
    $('#chip-r-issue').addEventListener('click', () => {
      const iso = parseVNDate($('#r-issue').value) || state.today;
      setDate('r-expiry', addDays(iso, RENEW_DAYS)); renewExpiryTouched = true; clearErr('r-expiry');
    });
    $('#chip-r-old').addEventListener('click', () => {
      const c = byId(renewingId);
      if (!c) return;
      setDate('r-expiry', addDays(c.expiry, RENEW_DAYS)); renewExpiryTouched = true; clearErr('r-expiry');
    });

    // Lịch
    $('#cal-download').addEventListener('click', () => {
      const f = calFile();
      if (f) downloadBlob(f.blob, f.name);
    });
    $('#cal-share').addEventListener('click', async () => {
      const f = calFile();
      if (!f) return;
      const file = shareableFile(f.blob, f.name);
      if (!file) { downloadBlob(f.blob, f.name); return; }
      try { await navigator.share({ files: [file], title: 'Lịch hết hạn giấy đi đường' }); } catch (e) { /* hủy */ }
    });

    // Sao lưu
    $('#m-export').addEventListener('click', exportData);
    $('#bb-now').addEventListener('click', exportData);
    $('#bb-later').addEventListener('click', async () => {
      state.snoozeUntil = Date.now() + DAY;
      try { await DB.setMeta('snoozeUntil', state.snoozeUntil); } catch (e) { /* bỏ qua */ }
      renderBanners();
      toast('Sẽ nhắc lại vào ngày mai');
    });
    $('#m-import').addEventListener('click', () => { const inp = $('#import-file'); inp.value = ''; inp.click(); });
    $('#import-file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) importFile(f); });
    $('#m-remind').addEventListener('click', () => {
      const blob = new Blob([buildBackupReminderICS()], { type: 'text/calendar;charset=utf-8' });
      downloadBlob(blob, 'nhac-sao-luu-hang-tuan.ics');
    });
    $('#tip-close').addEventListener('click', () => { localStorageSet('tipClosed', '1'); renderBanners(); });

    // Mở lại app (hoặc qua nửa đêm) → tính lại số ngày theo hôm nay
    const refreshDay = () => { const t = todayISO(); if (t !== state.today) { state.today = t; render(); } };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshDay(); renderBanners(); } });
    setInterval(refreshDay, 60000);
  }

  /* ---------- Chạy offline (service worker) ---------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const okOrigin = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!okOrigin) return;
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      toast('Đã có bản cập nhật mới.', { label: 'Tải lại', fn: () => location.reload() }, 15000);
    });
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch((err) => console.warn('Không đăng ký được service worker:', err));
  }

  /* ---------- Khởi động ---------- */
  async function start() {
    $('#app-version').textContent = APP_VERSION;
    bindEvents();
    render();
    try {
      const [list, last, snooze] = await Promise.all([DB.all(), DB.getMeta('lastBackupAt'), DB.getMeta('snoozeUntil')]);
      state.customers = list || [];
      state.lastBackupAt = last || null;
      state.snoozeUntil = Number(snooze) || 0;
    } catch (e) {
      state.dbError = (e && e.message) || 'Lỗi không xác định';
    }
    state.ready = true;
    render();
    registerSW();
  }

  // Cho phép kiểm thử từ bên ngoài (không ảnh hưởng người dùng)
  window.__gdd = { parseVNDate, statusOf, buildCustomerICS, buildBackupReminderICS, todayISO, addDays, diffDays, matches };

  start();
})();
