/* ── AI CRM Adsy · Shared Utilities ── */

/* ── initConfig: wajib dipanggil PERTAMA sebelum fetch Supabase ── */
async function initConfig() {
  if (window.__SB_URL && window.__SB_KEY) return; // sudah di-load
  try {
    const r = await fetch('/api/config');
    const d = await r.json();
    window.__SB_URL = d.url || d.supabase_url || '';
    window.__SB_KEY = d.key || d.anon_key || '';
  } catch(e) {
    console.error('[initConfig] gagal fetch /api/config:', e);
  }
}

/* ── Supabase REST helpers — semua baca window.__SB_URL saat dipanggil ── */
async function sbGet(table, params = '') {
  const r = await fetch(`${window.__SB_URL}/rest/v1/${table}?${params}`, {
    headers: { apikey: window.__SB_KEY, Authorization: `Bearer ${window.__SB_KEY}` }
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function sbPost(table, body, opts = {}) {
  const r = await fetch(`${window.__SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: window.__SB_KEY,
      Authorization: `Bearer ${window.__SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function sbPatch(table, params, body) {
  const r = await fetch(`${window.__SB_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      apikey: window.__SB_KEY,
      Authorization: `Bearer ${window.__SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function sbDelete(table, params) {
  const r = await fetch(`${window.__SB_URL}/rest/v1/${table}?${params}`, {
    method: 'DELETE',
    headers: { apikey: window.__SB_KEY, Authorization: `Bearer ${window.__SB_KEY}` },
  });
  if (!r.ok) throw new Error(await r.text());
  return true;
}

/* ── AUTH & SESSION ── */
function getUser() {
  try { return JSON.parse(localStorage.getItem('crm_user')); } catch { return null; }
}

function requireAuth() {
  const u = getUser();
  if (!u) { window.location.href = 'login.html'; return null; }
  return u;
}

function logout() {
  localStorage.removeItem('crm_user');
  window.location.href = 'login.html';
}

/* ── TOAST ── */
function toast(msg, type = 'default', dur = 2800) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e293b;color:#e2e8f0;padding:10px 18px;border-radius:10px;font-size:13px;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none;white-space:nowrap;border:1px solid rgba(255,255,255,.08);box-shadow:0 8px 24px rgba(0,0,0,.4)';
    document.body.appendChild(el);
  }
  if (type === 'error') { el.style.background = '#3b1f1f'; el.style.borderColor = 'rgba(239,68,68,.3)'; }
  else if (type === 'ok') { el.style.background = '#1a2e1a'; el.style.borderColor = 'rgba(34,197,94,.3)'; }
  else { el.style.background = '#1e293b'; el.style.borderColor = 'rgba(255,255,255,.08)'; }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, dur);
}
// alias
function showToast(msg, dur) { toast(msg, 'default', dur); }

/* ── UTILS ── */
function initials(n) {
  return (n || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function avatarColor(n) {
  const colors = ['#6366f1','#3b82f6','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'];
  let h = 0; for (let c of (n || '')) h = (h * 31 + c.charCodeAt(0)) % colors.length;
  return colors[Math.abs(h)];
}

function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
  );
}

function timeStr(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const diff = now - d;
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm lalu';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' jam lalu';
  return d.toLocaleDateString('id-ID', { day:'numeric', month:'short' });
}

function formatPhone(raw) {
  if (!raw) return '—';
  const n = String(raw).split('@')[0].replace(/\D/, '');
  if (!n) return '—';
  if (n.length >= 10 && n.length <= 13) {
    const local = n.startsWith('62') ? n.slice(2) : n;
    return '+62 ' + local.slice(0, 3) + '-' + local.slice(3, 7) + '-' + local.slice(7);
  }
  return n;
}

function updateDatetime(elId = 'th-datetime') {
  const el = document.getElementById(elId);
  if (!el) return;
  const now = new Date();
  const opts = { weekday:'long', day:'numeric', month:'long', year:'numeric' };
  const wib = now.toLocaleString('id-ID', { ...opts, timeZone:'Asia/Jakarta' });
  const time = now.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Jakarta' });
  el.textContent = `${wib} · ${time} WIB`;
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = isLight ? '☀️' : '🌙';
  localStorage.setItem('cs_theme', isLight ? 'light' : 'dark');
}

// Apply saved theme immediately
(function() {
  if (localStorage.getItem('cs_theme') === 'light') document.body.classList.add('light');
})();

/* ── checkBotStatus ── */
async function checkBotStatus() {
  const sbBot = document.getElementById('sb-bot-status');
  const user = getUser();
  if (!sbBot || !user) return;
  try {
    const res = await fetch('/api/baileys-proxy?path=' + encodeURIComponent('/session/status/' + user.id));
    const s = await res.json();
    if (s.status === 'connected') {
      sbBot.innerHTML = '<div class="bot-dot"></div> Bot online';
      sbBot.style.color = '#22c55e';
    } else {
      sbBot.innerHTML = '⚠️ WA offline';
      sbBot.style.color = '#f59e0b';
    }
  } catch(e) {
    sbBot.innerHTML = '⚠️ WA offline';
    sbBot.style.color = '#f59e0b';
  }
}

/* ── Auth object (compatibility shim untuk halaman yang pakai Auth.xxx) ── */
const Auth = {
  getUser: getUser,
  guard: () => { if (!getUser()) window.location.href = 'login.html'; },
  logout: logout,
  isLoggedIn: () => !!getUser(),
};
