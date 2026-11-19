/* Giấy đi đường — theo dõi hạn giấy đi đường của khách vay mua xe.
   Toàn bộ dữ liệu lưu trong IndexedDB trên chính điện thoại, không gửi đi đâu. */
'use strict';
(function () {
  const APP_VERSION = '1.2.0';
  const DAY = 86400000;
  const VN_OFFSET = 7 * 3600000; // Việt Nam: UTC+7, không đổi giờ mùa hè
  const RENEW_DAYS = 90;
  const INS_RENEW_YEARS = 1;
  const COMMON_INSURERS = ['Bảo Việt', 'PVI', 'PTI', 'Bảo Minh', 'MIC', 'BIC', 'VBI', 'PJICO', 'BSH'];
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
  /** Cộng năm, giữ ngày/tháng; 29/02 sang năm không nhuận thành 28/02. */
  function addYears(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
    return `${y + n}-${pad(m)}-${pad(Math.min(d, last))}`;
  }
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
  function statusOfDate(iso, today) {
    const d = diffDays(today, iso);
    if (d < 0) return { key: 'over', days: d, text: `Quá hạn ${-d} ngày` };
    if (d === 0) return { key: 'soon', days: 0, text: 'Hết hạn hôm nay' };
    if (d === 1) return { key: 'soon', days: 1, text: 'Mai hết hạn' };
    if (d <= 7) return { key: 'soon', days: d, text: `Còn ${d} ngày` };
    if (d <= 30) return { key: 'month', days: d, text: `Còn ${d} ngày` };
    return { key: 'ok', days: d, text: `Còn ${d} ngày` };
  }
  const statusOf = (c, today) => statusOfDate(c.expiry, today);
  /** Hạn bảo hiểm; null nếu khách chưa nhập (khách cũ). */
  const insStatusOf = (c, today) => (c.insExpiry ? statusOfDate(c.insExpiry, today) : null);
  const RANK = { ok: 0, month: 1, soon: 2, over: 3 };
  const FILTER_NAMES = { over: 'Quá hạn', soon: 'Còn ≤ 7 ngày', month: 'Còn 8–30 ngày' };
  const KIND_NAMES = { paper: 'Giấy đi đường', ins: 'Bảo hiểm' };

  /* ---------- Tìm kiếm không dấu ---------- */
  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().trim();
  }
  const plateKey = (s) => norm(s).replace(/[^a-z0-9]/g, '');
  function matches(c, q) {
    const nq = norm(q);
    if (!nq) return true;
    if (norm(c.name).includes(nq) || norm(c.insCompany).includes(nq)) return true;
    const pq = plateKey(q);
    return pq.length > 0 && (plateKey(c.plate).includes(pq) || plateKey(c.insNumber).includes(pq));
  }

  /* ---------- Nhận dạng thông tin trong chữ đọc từ ảnh giấy tờ ----------
     Chỉ là gợi ý: người dùng luôn xem lại và chọn mục nào điền vào form. */
  /** Bỏ dấu từng ký tự, giữ nguyên độ dài để vị trí khớp với chuỗi gốc. */
  const normKeep = (s) => Array.from(String(s)).map((ch) => {
    if (ch === 'đ' || ch === 'Đ') return 'd';
    return ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().charAt(0) || ' ';
  }).join('');
  const titleCaseVN = (s) => s.toLocaleLowerCase('vi').replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('vi'));

  function findDates(lines) {
    const out = [];
    lines.forEach((line, i) => {
      const n = normKeep(line);
      const add = (d, mo, y, idx) => {
        const iso = `${y}-${pad(+mo)}-${pad(+d)}`;
        if (+y < 2000 || +y > 2100 || !isValidISO(iso)) return;
        // Nhãn có thể nằm cuối dòng trên ("Có giá trị đến:" ↵ "12/12/2026")
        const before = n.slice(Math.max(0, idx - 40), idx);
        const ctx = (n.slice(0, idx).trim().length < 3 && i > 0 ? normKeep(lines[i - 1]).slice(-30) + ' ' : '') + before;
        if (/sinh/.test(ctx)) return; // bỏ ngày sinh
        out.push({ iso, ctx });
      };
      let m;
      const r1 = /(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4})/g;
      while ((m = r1.exec(n))) add(m[1], m[2], m[3], m.index);
      const r2 = /ngay\s*(\d{1,2})\s*thang\s*(\d{1,2})\s*nam\s*(\d{4})/g;
      while ((m = r2.exec(n))) add(m[1], m[2], m[3], m.index);
    });
    return out;
  }
  const isEndCtx = (ctx) => /het han|gia tri den|hieu luc den|den ngay|den het|\bden\b.{0,16}$/.test(ctx);
  const isStartCtx = (ctx) => /ngay cap|cap ngay|bat dau|hieu luc tu|\btu\b.{0,16}$/.test(ctx);

  /** Ngày hết hạn = ngày có nhãn "hết hạn/đến…", không có thì lấy ngày muộn nhất; ngày cấp tương tự. */
  function pickDates(dates, today) {
    if (!dates.length) return {};
    const isos = dates.map((d) => d.iso).sort();
    const ends = dates.filter((d) => isEndCtx(d.ctx));
    let expiry = ends.length ? ends[ends.length - 1].iso : null;
    if (!expiry) {
      if (isos.length === 1) return isos[0] > today ? { expiry: isos[0] } : { issue: isos[0] };
      expiry = isos[isos.length - 1];
    }
    const start = dates.find((d) => isStartCtx(d.ctx) && d.iso < expiry);
    const issue = start ? start.iso : (isos[0] < expiry ? isos[0] : '');
    return { issue, expiry };
  }

  function findPlate(lines) {
    let best = null;
    lines.forEach((line) => {
      const u = normKeep(line).toUpperCase();
      const re = /(?:^|[^0-9A-Z])(\d{2})\s?[-–]?\s?([A-Z]{1,2}\d?)\s?[-–.]?\s?(\d{3}\s?[.,]?\s?\d{2}|\d{4})(?![0-9])/g;
      let m;
      while ((m = re.exec(u))) {
        const d = m[3].replace(/\D/g, '');
        const plate = `${m[1]}${m[2]}-${d.length === 5 ? d.slice(0, 3) + '.' + d.slice(3) : d}`;
        const labeled = /bien|bks/i.test(u.slice(0, m.index + 1));
        if (!best || (labeled && !best.labeled)) best = { plate, labeled };
      }
    });
    return best ? best.plate : '';
  }

  const NAME_KEYS = ['nguoi duoc bao hiem', 'ten chu xe', 'chu xe', 'ho va ten', 'ho ten', 'ten khach hang', 'khach hang', 'nguoi mua bao hiem', 'ben mua bao hiem'];
  function findName(lines) {
    for (const key of NAME_KEYS) {
      for (const line of lines) {
        const idx = normKeep(line).indexOf(key);
        if (idx < 0) continue;
        let rest = line.slice(idx + key.length).replace(/^[\s:.\-–]+/, '');
        const cut = normKeep(rest).search(/dia chi|nam sinh|ngay sinh|sdt|dien thoai|cccd|cmnd|[0-9(,;]/);
        if (cut >= 0) rest = rest.slice(0, cut);
        rest = rest.replace(/[\s:.\-–]+$/, '').replace(/\s+/g, ' ');
        if (/^[\p{L} ]{4,50}$/u.test(rest) && rest.split(' ').length >= 2) return titleCaseVN(rest);
      }
    }
    return '';
  }

  // Tên hãng ngân hàng (BIDV, VietinBank, Agribank…) hay xuất hiện vì ngân hàng là bên thụ hưởng,
  // nên chỉ nhận khi đi kèm chữ "bảo hiểm".
  const INSURER_PATTERNS = [
    [/bao viet/, 'Bảo Việt'], [/\bpvi\b/, 'PVI'], [/\bpti\b|bao hiem buu dien/, 'PTI'], [/bao minh/, 'Bảo Minh'],
    [/\bmic\b|bao hiem quan doi/, 'MIC'], [/\bbic\b|bao hiem bidv/, 'BIC'], [/\bvbi\b|bao hiem vietinbank/, 'VBI'],
    [/pjico|bao hiem petrolimex/, 'PJICO'], [/\bbsh\b|bao hiem sai gon ?- ?ha noi/, 'BSH'], [/\babic\b|bao hiem agribank/, 'ABIC'],
    [/bao long/, 'Bảo Long'], [/\bvni\b|bao hiem hang khong/, 'Bảo hiểm Hàng không (VNI)'], [/liberty/, 'Liberty'],
    [/tokio marine/, 'Tokio Marine'], [/\bmsig\b/, 'MSIG'], [/\bpacific cross\b/, 'Pacific Cross'],
  ];
  function findInsurer(text) {
    const n = normKeep(text).replace(/\s+/g, ' ');
    let best = null;
    INSURER_PATTERNS.forEach(([re, name]) => {
      const m = n.match(re);
      if (m && (!best || m.index < best.index)) best = { index: m.index, name };
    });
    return best ? best.name : '';
  }

  const NUMBER_KEYS = ['so hop dong bao hiem', 'so giay chung nhan', 'giay chung nhan so', 'so gcn', 'gcn so', 'so don bao hiem',
    'hop dong bao hiem so', 'so hop dong', 'hop dong so', 'so hd', 'hd so', 'policy no'];
  function findContractNo(lines) {
    for (const key of NUMBER_KEYS) {
      for (const line of lines) {
        const n = normKeep(line);
        const idx = n.indexOf(key);
        if (idx < 0 || /tin dung|cho vay|\bvay\b/.test(n)) continue; // bỏ số hợp đồng vay
        const m = line.slice(idx + key.length).match(/^[\s:.#°º-]*([A-Za-z0-9][A-Za-z0-9/\-.]{3,30})/);
        if (m && /\d/.test(m[1])) return m[1].replace(/[./-]+$/, '');
      }
    }
    return '';
  }

  /** Đọc toàn bộ thông tin có thể từ chữ trong ảnh. type: 'paper' | 'ins' (đoán theo nội dung). */
  function parseDoc(text, today) {
    const clean = String(text || '').normalize('NFC');
    const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const n = normKeep(clean);
    const { issue = '', expiry = '' } = pickDates(findDates(lines), today || todayISO());
    return {
      type: /bao hiem/.test(n) && !/giay di duong/.test(n) ? 'ins' : 'paper',
      name: findName(lines),
      plate: findPlate(lines),
      issue, expiry,
      insCompany: findInsurer(clean),
      insNumber: findContractNo(lines),
      insExpiry: expiry,
    };
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
    kind: 'all',        // 'all' | 'paper' (giấy đi đường) | 'ins' (bảo hiểm)
    filter: null,       // 'over' | 'soon' | 'month' | null — áp dụng cho loại hạn đang xem
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

    const kind = state.kind;
    const rows = state.customers.map((c) => ({ c, s: statusOf(c, today), si: insStatusOf(c, today) }));

    const counts = { paper: { over: 0, soon: 0, month: 0, ok: 0 }, ins: { over: 0, soon: 0, month: 0, ok: 0 } };
    let insTotal = 0;
    rows.forEach((r) => { counts.paper[r.s.key]++; if (r.si) { counts.ins[r.si.key]++; insTotal++; } });
    ['paper', 'ins'].forEach((k) => ['over', 'soon', 'month'].forEach((f) => { $(`#n-${k}-${f}`).textContent = counts[k][f]; }));
    $('#n-ins-total').textContent = insTotal < rows.length ? `· ${insTotal}/${rows.length} khách đã nhập` : '';
    $$('.stat').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind && b.dataset.filter === state.filter)));
    $$('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));

    // Ngày dùng để sắp xếp: theo loại đang xem; "Tất cả" thì lấy hạn nào đến trước
    const dateOf = (r) => (kind === 'paper' ? r.c.expiry : kind === 'ins' ? r.c.insExpiry
      : (r.c.insExpiry && r.c.insExpiry < r.c.expiry ? r.c.insExpiry : r.c.expiry));
    let shown = rows;
    if (kind === 'ins') shown = shown.filter((r) => r.si);
    if (state.filter) shown = shown.filter((r) => (kind === 'ins' ? r.si : r.s).key === state.filter);
    if (state.query) shown = shown.filter((r) => matches(r.c, state.query));
    shown.sort((a, b) => { const da = dateOf(a), db = dateOf(b); return da < db ? -1 : da > db ? 1 : a.c.name.localeCompare(b.c.name, 'vi'); });

    const total = rows.length;
    const filtering = kind !== 'all' || state.filter || state.query;
    let info;
    if (filtering) {
      const parts = [];
      if (kind !== 'all') parts.push(KIND_NAMES[kind]);
      if (state.filter) parts.push(FILTER_NAMES[state.filter]);
      if (state.query) parts.push(`“${state.query}”`);
      info = `Đang xem: ${parts.join(' · ')} — ${shown.length}/${total} khách`;
    } else {
      info = total ? `${total} khách · hạn gần nhất ở trên` : '';
    }
    $('#list-info').textContent = info;
    $('#btn-clear-filter').hidden = !filtering;

    $('#list').innerHTML = shown.map(cardHTML).join('');

    const empty = $('#empty');
    if (state.dbError) {
      empty.hidden = false;
      empty.innerHTML = `<h3>Không mở được bộ nhớ</h3><p>${esc(state.dbError)}</p>`;
    } else if (state.ready && total === 0) {
      empty.hidden = false;
      empty.innerHTML = '<h3>Chưa có khách nào</h3><p>Bấm nút + để thêm khách đầu tiên.</p><button class="btn btn-primary" data-act="add-first">Thêm khách</button>';
    } else if (total > 0 && shown.length === 0 && kind === 'ins' && insTotal === 0 && !state.query) {
      empty.hidden = false;
      empty.innerHTML = '<h3>Chưa có khách nào nhập bảo hiểm</h3><p>Bấm vào tên khách để thêm công ty và ngày hết hạn bảo hiểm.</p>';
    } else if (total > 0 && shown.length === 0) {
      empty.hidden = false;
      empty.innerHTML = '<h3>Không có khách phù hợp</h3><p>Thử bỏ lọc hoặc tìm từ khác.</p>';
    } else {
      empty.hidden = true;
      empty.innerHTML = '';
    }
    renderBanners();
  }

  const ICON_CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CAL = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function cardHTML({ c, s, si }) {
    const kind = state.kind;
    // Màu cả thẻ: theo loại hạn đang xem; "Tất cả" thì lấy hạn gấp hơn
    const main = kind === 'paper' ? s : kind === 'ins' ? si : (si && RANK[si.key] > RANK[s.key] ? si : s);
    const renewals = (c.history || []).length;
    const insRenewals = (c.insHistory || []).length;
    const counts = [renewals && `giấy ${renewals} lần`, insRenewals && `BH ${insRenewals} lần`].filter(Boolean);

    const paperRow = `<div class="due st-${s.key}">
        <div class="due-info"><span class="due-label">Giấy đi đường</span>
          <span class="due-date">Hết hạn <b>${fmtDate(c.expiry)}</b>${c.issue ? ` · cấp ${fmtDate(c.issue)}` : ''}</span></div>
        <span class="pill">${esc(s.text)}</span>
      </div>`;
    let insRow = '';
    if (si) {
      insRow = `<div class="due st-${si.key}">
        <div class="due-info"><span class="due-label">Bảo hiểm${c.insCompany ? ' · ' + esc(c.insCompany) : ''}</span>
          <span class="due-date">Hết hạn <b>${fmtDate(c.insExpiry)}</b>${c.insNumber ? ` · HĐ ${esc(c.insNumber)}` : ''}</span></div>
        <span class="pill">${esc(si.text)}</span>
      </div>`;
    } else if (kind === 'all') {
      insRow = '<div class="due due-none"><span class="due-label">Bảo hiểm: chưa nhập</span></div>';
    }
    const rowsHTML = kind === 'ins' ? insRow + paperRow : paperRow + insRow;

    let actions;
    if (kind === 'all' && si) {
      actions = `<div class="card-actions three">
        <button class="btn btn-primary" type="button" data-act="renew">Gia hạn giấy</button>
        <button class="btn btn-primary" type="button" data-act="renew-ins">Gia hạn BH</button>
        <button class="btn btn-ghost cal-btn" type="button" data-act="cal" aria-label="Thêm vào Lịch">${ICON_CAL}Lịch</button>
      </div>`;
    } else {
      const renewBtn = kind === 'ins'
        ? `<button class="btn btn-primary" type="button" data-act="renew-ins">${ICON_CHECK}Đã gia hạn BH</button>`
        : `<button class="btn btn-primary" type="button" data-act="renew">${ICON_CHECK}Đã gia hạn giấy</button>`;
      actions = `<div class="card-actions">${renewBtn}
        <button class="btn btn-ghost" type="button" data-act="cal">${ICON_CAL}Thêm vào Lịch</button>
      </div>`;
    }

    return `<li class="card tone-${main.key}" data-id="${esc(c.id)}">
      <button class="card-main" type="button" data-act="edit" aria-label="Sửa thông tin ${esc(c.name)}">
        <div class="card-top"><span class="name">${esc(c.name)}</span>${c.plate ? `<span class="plate">${esc(c.plate)}</span>` : ''}</div>
        <div class="dues">${rowsHTML}</div>
        ${counts.length ? `<div class="renew-count">Đã gia hạn: ${counts.join(', ')}</div>` : ''}
        ${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}
      </button>
      ${actions}
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
    $('#f-ins-company').value = c ? (c.insCompany || '') : '';
    $('#f-ins-number').value = c ? (c.insNumber || '') : '';
    setDate('f-ins-expiry', c ? c.insExpiry : '');
    $('#btn-delete').hidden = !c;
    fillInsurerList();
    resetOcr('form');

    const hist = (c && c.history) || [];
    $('#form-history').hidden = hist.length === 0;
    $('#history-list').innerHTML = hist.slice().reverse().map((h) => `<li>
        Ngày ${fmtDate(h.renewedOn)}: hạn ${fmtDate(h.oldExpiry)} → <b>${fmtDate(h.newExpiry)}</b>
        ${h.newIssue ? `<div class="h-note">Cấp mới ${fmtDate(h.newIssue)}</div>` : ''}
        ${h.note ? `<div class="h-note">${esc(h.note)}</div>` : ''}
      </li>`).join('');
    const insHist = (c && c.insHistory) || [];
    $('#form-ins-history').hidden = insHist.length === 0;
    $('#ins-history-list').innerHTML = insHist.slice().reverse().map((h) => `<li>
        Ngày ${fmtDate(h.renewedOn)}: hạn ${h.oldExpiry ? fmtDate(h.oldExpiry) : '?'} → <b>${fmtDate(h.newExpiry)}</b>
        ${h.newCompany ? `<div class="h-note">${esc(h.newCompany)}${h.newNumber ? ' · HĐ ' + esc(h.newNumber) : ''}</div>` : ''}
        ${h.note ? `<div class="h-note">${esc(h.note)}</div>` : ''}
      </li>`).join('');
    openSheet('#sheet-form');
  }

  /** Gợi ý tên công ty bảo hiểm: các tên đã nhập + vài công ty phổ biến. */
  function fillInsurerList() {
    const seen = new Map();
    state.customers.map((c) => c.insCompany).concat(COMMON_INSURERS).forEach((n) => {
      if (n && !seen.has(norm(n))) seen.set(norm(n), n);
    });
    $('#ins-companies').innerHTML = Array.from(seen.values()).map((n) => `<option value="${esc(n)}">`).join('');
  }
  function scrollToFirstErr(form) {
    const f = $('.has-err', form);
    if (f) f.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    const insCompany = $('#f-ins-company').value.trim().replace(/\s+/g, ' ');
    const insNumber = $('#f-ins-number').value.trim();
    const insExpiry = parseVNDate($('#f-ins-expiry').value);
    let ok = true;
    if (!name) { setErr('f-name', 'Cần nhập họ tên.'); ok = false; }
    if (issue === null) { setErr('f-issue', 'Ngày không hợp lệ (dd/mm/yyyy).'); ok = false; }
    if (expiry === null) { setErr('f-expiry', 'Ngày không hợp lệ (dd/mm/yyyy).'); ok = false; }
    else if (!expiry) { setErr('f-expiry', 'Cần nhập ngày hết hạn.'); ok = false; }
    if (ok && issue && expiry < issue) { setErr('f-expiry', 'Ngày hết hạn phải sau ngày cấp.'); ok = false; }
    // Bảo hiểm không bắt buộc, nhưng đã nhập thì cần đủ công ty + ngày hết hạn
    if (insExpiry === null) { setErr('f-ins-expiry', 'Ngày không hợp lệ (dd/mm/yyyy).'); ok = false; }
    else if (!insExpiry && (insCompany || insNumber)) { setErr('f-ins-expiry', 'Cần nhập ngày hết hạn bảo hiểm.'); ok = false; }
    if (insExpiry && !insCompany) { setErr('f-ins-company', 'Cần nhập công ty bảo hiểm.'); ok = false; }
    if (!ok) { scrollToFirstErr(form); return; }

    const now = new Date().toISOString();
    const old = editingId ? byId(editingId) : null;
    const ins = { insCompany, insNumber, insExpiry };
    const c = old
      ? Object.assign({}, old, { name, plate, issue, expiry, note }, ins, { updatedAt: now })
      : Object.assign({ id: uid(), name, plate, issue, expiry, note, history: [] }, ins, { insHistory: [], createdAt: now, updatedAt: now });
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
    resetOcr('renew');
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
    toast(`Đã gia hạn đến ${fmtDate(newExpiry)}`, { label: 'Thêm vào Lịch', fn: () => openCal(byId(updated.id), 'paper') }, 8000);
  }

  /* ---------- Gia hạn bảo hiểm ---------- */
  let insRenewingId = null;
  function openInsRenew(c) {
    if (!c.insExpiry) { openForm(c); return; }
    insRenewingId = c.id;
    const form = $('#ins-form');
    form.reset();
    clearAllErr(form);
    fillInsurerList();
    const si = insStatusOf(c, state.today);
    $('#i-name').textContent = c.name;
    $('#i-sub').textContent = `${c.plate ? c.plate + ' · ' : ''}${c.insCompany ? c.insCompany + ' · ' : ''}Hạn cũ ${fmtDate(c.insExpiry)} (${si.text.toLowerCase()})`;
    setDate('i-expiry', addYears(c.insExpiry, INS_RENEW_YEARS));
    $('#i-company').value = c.insCompany || '';
    $('#i-number').value = c.insNumber || '';
    $('#chip-i-old').textContent = `+1 năm từ hạn cũ (${fmtDate(addYears(c.insExpiry, INS_RENEW_YEARS))})`;
    $('#chip-i-today').textContent = `+1 năm từ hôm nay (${fmtDate(addYears(state.today, INS_RENEW_YEARS))})`;
    resetOcr('ins');
    openSheet('#sheet-ins');
  }

  async function saveInsRenew(ev) {
    ev.preventDefault();
    const c = byId(insRenewingId);
    if (!c) { closeSheet(); return; }
    const form = $('#ins-form');
    clearAllErr(form);
    const newExpiry = parseVNDate($('#i-expiry').value);
    const company = $('#i-company').value.trim().replace(/\s+/g, ' ');
    const number = $('#i-number').value.trim();
    const note = $('#i-note').value.trim();
    let ok = true;
    if (newExpiry === null) { setErr('i-expiry', 'Ngày không hợp lệ.'); ok = false; }
    else if (!newExpiry) { setErr('i-expiry', 'Cần nhập hạn mới.'); ok = false; }
    if (!company) { setErr('i-company', 'Cần nhập công ty bảo hiểm.'); ok = false; }
    if (!ok) { scrollToFirstErr(form); return; }
    if (newExpiry <= c.insExpiry) {
      const go = await ask('Hạn mới không sau hạn cũ', `Hạn cũ: ${fmtDate(c.insExpiry)}\nHạn mới: ${fmtDate(newExpiry)}\nVẫn lưu?`, [
        { label: 'Vẫn lưu', value: true, style: 'btn-primary' },
        { label: 'Sửa lại', value: false },
      ]);
      if (!go) return;
    }
    const entry = {
      renewedOn: state.today,
      oldExpiry: c.insExpiry, newExpiry,
      oldCompany: c.insCompany || '', newCompany: company,
      oldNumber: c.insNumber || '', newNumber: number,
      note, at: new Date().toISOString(),
    };
    const updated = Object.assign({}, c, {
      insCompany: company,
      insNumber: number,
      insExpiry: newExpiry,
      insHistory: (c.insHistory || []).concat([entry]),
      updatedAt: new Date().toISOString(),
    });
    try { await DB.put(updated); } catch (e) { toast('Không lưu được: ' + e.message); return; }
    state.customers = state.customers.map((x) => (x.id === updated.id ? updated : x));
    closeSheet();
    render();
    toast(`Đã gia hạn bảo hiểm đến ${fmtDate(newExpiry)}`, { label: 'Thêm vào Lịch', fn: () => openCal(byId(updated.id), 'ins') }, 8000);
  }

  /* ---------- Chụp giấy tờ → đọc chữ ngay trên điện thoại ----------
     Dùng Tesseract.js để sẵn trong thư mục ocr/ (tải lần đầu khi bấm, sau đó chạy cả khi không có mạng).
     Ảnh chỉ được đọc trong bộ nhớ rồi bỏ đi, không lưu, không gửi đi đâu. */
  const OCR_TARGETS = { // khối chụp ảnh → loại giấy → [thông tin, ô nhập]
    form: {
      paper: [['name', 'f-name'], ['plate', 'f-plate'], ['issue', 'f-issue'], ['expiry', 'f-expiry']],
      ins: [['name', 'f-name'], ['plate', 'f-plate'], ['insCompany', 'f-ins-company'], ['insNumber', 'f-ins-number'], ['insExpiry', 'f-ins-expiry']],
    },
    renew: { paper: [['issue', 'r-issue'], ['expiry', 'r-expiry']] },
    ins: { ins: [['insExpiry', 'i-expiry'], ['insCompany', 'i-company'], ['insNumber', 'i-number']] },
  };
  const OCR_LABELS = { name: 'Họ tên', plate: 'Biển số', issue: 'Ngày cấp', expiry: 'Ngày hết hạn', insCompany: 'Công ty bảo hiểm', insNumber: 'Số HĐ bảo hiểm', insExpiry: 'Hết hạn bảo hiểm' };
  const OCR_DATES = new Set(['issue', 'expiry', 'insExpiry']);
  const ICON_CAMERA = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const ocrState = {}; // theo khối: { parsed, text, type }

  let ocrWorkerP = null;
  let ocrProgress = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Không tải được ' + src));
      document.head.appendChild(s);
    });
  }
  function getOcrWorker() {
    if (!ocrWorkerP) {
      ocrWorkerP = (async () => {
        const base = new URL('ocr/', location.href).href;
        if (!window.Tesseract) await loadScript(base + 'tesseract.min.js');
        return window.Tesseract.createWorker('vie', 1, { // 1 = chế độ LSTM
          workerPath: base + 'worker.min.js',
          corePath: base, // tự chọn bản có/không SIMD tùy máy
          langPath: base,
          gzip: true,
          workerBlobURL: false,
          logger: (m) => { if (ocrProgress) ocrProgress(m); },
        });
      })();
      ocrWorkerP.catch(() => { ocrWorkerP = null; });
    }
    return ocrWorkerP;
  }
  /** Thu nhỏ ảnh (ảnh iPhone 12MP đọc rất chậm) — cạnh dài tối đa 2000px. */
  async function imageToCanvas(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * scale); cv.height = Math.round(img.naturalHeight * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      return cv;
    } finally { URL.revokeObjectURL(url); }
  }

  function setupOcrBlocks() {
    $$('.ocr[data-ocr]').forEach((box) => {
      const key = box.dataset.ocr;
      box.innerHTML = `<button type="button" class="btn btn-ghost ocr-btn">${ICON_CAMERA}Chụp giấy để tự điền</button>
        <input type="file" accept="image/*" class="ocr-file" hidden>
        <p class="ocr-status" hidden></p>
        <div class="ocr-result" hidden></div>`;
      $('.ocr-btn', box).addEventListener('click', () => { const f = $('.ocr-file', box); f.value = ''; f.click(); });
      $('.ocr-file', box).addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) runOcr(key, f); });
      $('.ocr-result', box).addEventListener('click', (e) => {
        const t = e.target.closest('[data-ocr-type]');
        if (t) { ocrState[key].type = t.dataset.ocrType; renderOcrResult(key); return; }
        if (e.target.closest('[data-ocr-apply]')) applyOcr(key);
        else if (e.target.closest('[data-ocr-cancel]')) resetOcr(key);
      });
    });
  }
  function ocrStatus(key, text) {
    const st = $(`.ocr[data-ocr="${key}"] .ocr-status`);
    st.hidden = !text; st.textContent = text || '';
  }
  function resetOcr(key) {
    delete ocrState[key];
    ocrStatus(key, '');
    const res = $(`.ocr[data-ocr="${key}"] .ocr-result`);
    res.hidden = true; res.innerHTML = '';
  }

  async function runOcr(key, file) {
    const box = $(`.ocr[data-ocr="${key}"]`);
    const btn = $('.ocr-btn', box);
    resetOcr(key);
    btn.disabled = true;
    const first = !ocrWorkerP;
    ocrStatus(key, first ? 'Đang tải bộ đọc chữ (chỉ lần đầu, khoảng 5 MB)…' : 'Đang đọc chữ…');
    ocrProgress = (m) => {
      const pct = m.progress ? ` ${Math.round(m.progress * 100)}%` : '';
      if (m.status === 'recognizing text') ocrStatus(key, 'Đang đọc chữ…' + pct);
      else if (/loading|initializ/.test(m.status) && first) ocrStatus(key, 'Đang tải bộ đọc chữ (chỉ lần đầu, khoảng 5 MB)…' + pct);
    };
    try {
      const [worker, canvas] = await Promise.all([getOcrWorker(), imageToCanvas(file)]);
      const { data } = await worker.recognize(canvas);
      const parsed = parseDoc(data.text, state.today);
      const types = Object.keys(OCR_TARGETS[key]);
      ocrState[key] = { parsed, text: data.text, type: types.includes(parsed.type) ? parsed.type : types[0] };
      ocrStatus(key, '');
      renderOcrResult(key);
    } catch (e) {
      const offline = navigator.onLine === false && first;
      ocrStatus(key, offline ? 'Lần đầu dùng cần có mạng để tải bộ đọc chữ. Kết nối mạng rồi thử lại.'
        : 'Không đọc được ảnh: ' + ((e && e.message) || e));
    } finally {
      ocrProgress = null;
      btn.disabled = false;
    }
  }

  function renderOcrResult(key) {
    const st = ocrState[key];
    const res = $(`.ocr[data-ocr="${key}"] .ocr-result`);
    const types = Object.keys(OCR_TARGETS[key]);
    const items = OCR_TARGETS[key][st.type].filter(([f]) => st.parsed[f]);
    const seg = types.length > 1 ? `<div class="seg ocr-seg">${types.map((t) => `<button type="button" data-ocr-type="${t}" aria-pressed="${t === st.type}">${KIND_NAMES[t]}</button>`).join('')}</div>` : '';
    const list = items.map(([f, id]) => {
      const val = OCR_DATES.has(f) ? fmtDate(st.parsed[f]) : st.parsed[f];
      const cur = $('#' + id).value.trim();
      // Form sửa khách: không tự ghi đè dữ liệu đang có; bảng gia hạn: ô đang là gợi ý nên ghi đè
      const checked = key !== 'form' || !cur || cur === val;
      return `<li><label><input type="checkbox" data-field="${f}" data-target="${id}" ${checked ? 'checked' : ''}>
        <span class="ocr-k">${OCR_LABELS[f]}</span><b>${esc(val)}</b>${cur && cur !== val ? `<small>đang là: ${esc(cur)}</small>` : ''}</label></li>`;
    }).join('');
    res.innerHTML = `${seg}
      ${items.length ? `<p class="ocr-title">Đọc được từ ảnh — chọn mục muốn điền:</p><ul class="ocr-items">${list}</ul>`
        : '<p class="ocr-title">Không nhận ra thông tin nào. Thử chụp lại gần hơn, đủ sáng, giấy phẳng, không bị lóa.</p>'}
      <div class="ocr-btns">
        ${items.length ? '<button type="button" class="btn btn-primary sm" data-ocr-apply>Điền vào form</button>' : ''}
        <button type="button" class="btn btn-ghost sm" data-ocr-cancel>Bỏ qua</button>
      </div>
      <details class="ocr-raw"><summary>Xem chữ đọc được</summary><pre>${esc(st.text.trim() || '(trống)')}</pre></details>`;
    res.hidden = false;
  }

  function applyOcr(key) {
    const st = ocrState[key];
    if (!st) return;
    let n = 0;
    $$(`.ocr[data-ocr="${key}"] input[type="checkbox"]:checked`).forEach((cb) => {
      const f = cb.dataset.field, id = cb.dataset.target;
      if (OCR_DATES.has(f)) setDate(id, st.parsed[f]); else $('#' + id).value = st.parsed[f];
      if (id === 'r-expiry') renewExpiryTouched = true;
      clearErr(id);
      n++;
    });
    resetOcr(key);
    ocrStatus(key, n ? `Đã điền ${n} mục từ ảnh. Kiểm tra lại rồi bấm Lưu.` : 'Chưa chọn mục nào.');
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
  function buildInsuranceICS(c) {
    const who = c.plate ? `${c.name} (${c.plate})` : c.name;
    const desc = [
      `Khách: ${c.name}`,
      c.plate && `Biển số: ${c.plate}`,
      c.insCompany && `Công ty bảo hiểm: ${c.insCompany}`,
      c.insNumber && `Số HĐ bảo hiểm: ${c.insNumber}`,
      `Ngày hết hạn bảo hiểm: ${fmtDate(c.insExpiry)}`,
      'Bảo hiểm vật chất xe — ngân hàng là bên thụ hưởng.',
      c.note && `Ghi chú: ${c.note}`,
    ].filter(Boolean).join('\n');
    const alarm = (trigger, text) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(text + who)}`, `TRIGGER:${trigger}`, 'END:VALARM'];
    return icsWrap([
      'BEGIN:VEVENT',
      `UID:${c.id}-bh-${icsDate(c.insExpiry)}@giay-di-duong`,
      `DTSTAMP:${icsStamp()}`,
      `DTSTART;VALUE=DATE:${icsDate(c.insExpiry)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(c.insExpiry, 1))}`,
      `SUMMARY:${icsText('Hết hạn bảo hiểm xe: ' + who)}`,
      `DESCRIPTION:${icsText(desc)}`,
      'TRANSP:TRANSPARENT',
      // Giống giấy đi đường: nhắc 8:00 sáng; thêm mốc trước 30 ngày để kịp nhắc khách tái tục
    ].concat(
      alarm('-P29DT16H', 'Còn 30 ngày hết hạn bảo hiểm xe: '),
      alarm('-P6DT16H', 'Còn 7 ngày hết hạn bảo hiểm xe: '),
      alarm('-PT16H', 'Ngày mai hết hạn bảo hiểm xe: '),
      ['END:VEVENT'],
    ));
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
  /** which: 'paper' | 'ins' | 'both' — hiện phần Lịch nào. */
  function openCal(c, which) {
    if (!c) return;
    which = which || 'both';
    calCustomerId = c.id;
    $('#cal-name').textContent = c.name;
    $('#cal-sub').textContent = c.plate || '';
    $('#cal-date').textContent = fmtDate(c.expiry);
    $('#cal-ins-date').textContent = c.insExpiry ? fmtDate(c.insExpiry) : '';
    $('#cal-paper').hidden = which === 'ins';
    $('#cal-ins').hidden = which === 'paper' || !c.insExpiry;
    const canShare = !!shareableFile(new Blob(['x'], { type: 'text/calendar' }), 'test.ics');
    $$('.cal-share').forEach((b) => { b.hidden = !canShare; });
    openSheet('#sheet-cal');
  }
  function calFile(kind) {
    const c = byId(calCustomerId);
    if (!c) return null;
    if (kind === 'ins') {
      if (!c.insExpiry) return null;
      return {
        blob: new Blob([buildInsuranceICS(c)], { type: 'text/calendar;charset=utf-8' }),
        name: `bao-hiem-${safeFileName(c.name)}-${icsDate(c.insExpiry)}.ics`,
      };
    }
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
      version: 2, // v2: thêm insCompany, insNumber, insExpiry, insHistory (bảo hiểm)
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
    // File sao lưu cũ (v1) không có phần bảo hiểm → để trống
    const insHistory = Array.isArray(raw.insHistory) ? raw.insHistory.filter((h) => h && isValidISO(h.newExpiry)).map((h) => ({
      renewedOn: isValidISO(h.renewedOn) ? h.renewedOn : h.newExpiry,
      oldExpiry: isValidISO(h.oldExpiry) ? h.oldExpiry : '',
      newExpiry: h.newExpiry,
      oldCompany: String(h.oldCompany || ''),
      newCompany: String(h.newCompany || ''),
      oldNumber: String(h.oldNumber || ''),
      newNumber: String(h.newNumber || ''),
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
      insCompany: String(raw.insCompany || '').trim(),
      insNumber: String(raw.insNumber || '').trim(),
      insExpiry: isValidISO(raw.insExpiry) ? raw.insExpiry : '',
      insHistory,
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
    state.kind = 'all'; state.filter = null; state.query = ''; $('#q').value = '';
    render();
    toast(`Đã khôi phục ${list.length} khách`);
    requestPersist();
  }

  /* ---------- Gắn sự kiện cho nút bấm ---------- */
  function bindEvents() {
    $$('.date-field').forEach(setupDateField);
    setupOcrBlocks();

    $('#btn-add').addEventListener('click', () => openForm(null));
    $('#btn-menu').addEventListener('click', () => { renderBackupInfo(); openSheet('#sheet-menu'); });
    $('#backdrop').addEventListener('click', () => closeSheet());
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet()));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#dialog').hidden) closeSheet(); });

    $$('.stat').forEach((b) => b.addEventListener('click', () => {
      // Bấm ô đếm → chuyển sang loại hạn đó và lọc theo nhóm; bấm lại → bỏ lọc nhóm
      if (state.kind === b.dataset.kind && state.filter === b.dataset.filter) state.filter = null;
      else { state.kind = b.dataset.kind; state.filter = b.dataset.filter; }
      render();
    }));
    $$('.seg button').forEach((b) => b.addEventListener('click', () => {
      state.kind = b.dataset.kind;
      if (state.kind === 'all') state.filter = null;
      render();
    }));
    $('#btn-clear-filter').addEventListener('click', () => { state.kind = 'all'; state.filter = null; state.query = ''; $('#q').value = ''; render(); });
    $('#q').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });

    $('#list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const li = e.target.closest('li[data-id]');
      if (!btn || !li) return;
      const c = byId(li.dataset.id);
      if (!c) return;
      if (btn.dataset.act === 'edit') openForm(c);
      else if (btn.dataset.act === 'renew') openRenew(c);
      else if (btn.dataset.act === 'renew-ins') openInsRenew(c);
      else if (btn.dataset.act === 'cal') openCal(c, state.kind === 'all' ? 'both' : state.kind);
    });
    $('#empty').addEventListener('click', (e) => { if (e.target.closest('[data-act="add-first"]')) openForm(null); });

    // Form khách
    $('#form').addEventListener('submit', saveForm);
    $('#btn-delete').addEventListener('click', deleteCurrent);
    ['f-name', 'f-plate', 'f-issue', 'f-expiry', 'f-ins-company', 'f-ins-expiry'].forEach((id) => $('#' + id).addEventListener('input', () => clearErr(id)));
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

    // Form gia hạn bảo hiểm
    $('#ins-form').addEventListener('submit', saveInsRenew);
    ['i-expiry', 'i-company'].forEach((id) => $('#' + id).addEventListener('input', () => clearErr(id)));
    $('#chip-i-old').addEventListener('click', () => {
      const c = byId(insRenewingId);
      if (!c) return;
      setDate('i-expiry', addYears(c.insExpiry, INS_RENEW_YEARS)); clearErr('i-expiry');
    });
    $('#chip-i-today').addEventListener('click', () => { setDate('i-expiry', addYears(state.today, INS_RENEW_YEARS)); clearErr('i-expiry'); });

    // Lịch
    $$('[data-cal]').forEach((b) => b.addEventListener('click', () => {
      const f = calFile(b.dataset.cal);
      if (f) downloadBlob(f.blob, f.name);
    }));
    $$('[data-cal-share]').forEach((b) => b.addEventListener('click', async () => {
      const kind = b.dataset.calShare;
      const f = calFile(kind);
      if (!f) return;
      const file = shareableFile(f.blob, f.name);
      if (!file) { downloadBlob(f.blob, f.name); return; }
      const title = kind === 'ins' ? 'Lịch hết hạn bảo hiểm xe' : 'Lịch hết hạn giấy đi đường';
      try { await navigator.share({ files: [file], title }); } catch (e) { /* hủy */ }
    }));

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
  window.__gdd = { parseVNDate, statusOf, insStatusOf, buildCustomerICS, buildInsuranceICS, buildBackupReminderICS, cleanCustomer, parseDoc, todayISO, addDays, addYears, diffDays, matches };

  start();
})();
