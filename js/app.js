/* ── AI CRM Adsy · Shared Utilities ── */

/* ── initConfig: wajib dipanggil PERTAMA sebelum fetch Supabase ── */
async function initConfig() {
  if (window.__SB_URL && window.__SB_KEY) return; // sudah di-load
  try {
    const r = await fetch('/api/config');
    const d = await r.json();
    window.__SB_URL = d.url || d.supabase_url || '';
    window.__SB_KEY = d.key || d.anon_key || d.supabase_anon_key || '';
    window.__BAILEYS_URL = d.baileys_url || '';
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

/* ── renderSidebar: inject sidebar HTML ke #sidebar ── */
function renderSidebar(activePage) {
  const SVG = {
    analytics:  `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><line x1='18' y1='20' x2='18' y2='10'/><line x1='12' y1='20' x2='12' y2='4'/><line x1='6' y1='20' x2='6' y2='14'/></svg>`,
    dashboard:  `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><path d='M7.9 20A9 9 0 1 0 4 16.1L2 22Z'/></svg>`,
    customers:  `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><path d='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M22 21v-2a4 4 0 0 0-3-3.87'/><path d='M16 3.13a4 4 0 0 1 0 7.75'/></svg>`,
    followup:   `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><path d='M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9'/><path d='M10.3 21a1.94 1.94 0 0 0 3.4 0'/></svg>`,
    cases:      `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='5' width='6' height='6' rx='1'/><path d='m3 17 2 2 4-4'/><path d='M13 6h8'/><path d='M13 12h8'/><path d='M13 18h8'/></svg>`,
    contacts:   `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M23 21v-2a4 4 0 0 0-3-3.87'/><path d='M16 3.13a4 4 0 0 1 0 7.75'/></svg>`,
    aiinsights: `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><path d='m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z'/></svg>`,
    broadcast:  `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><path d='M22 8.01c0-4.42-4.48-8-10-8S2 3.59 2 8.01c0 2.83 1.84 5.31 4.62 6.76L6 18l3.58-2.46C10.34 15.8 11.16 16 12 16c5.52 0 10-3.58 10-7.99Z'/></svg>`,
    products:   `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><path d='m7.5 4.27 9 5.15'/><path d='M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z'/><path d='m3.3 7 8.7 5 8.7-5'/><path d='M12 22V12'/></svg>`,
    settings:   `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><path d='M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'/><circle cx='12' cy='12' r='3'/></svg>`,
  };
  const nav = [
    ['analytics',  'analytics.html',  'Ringkasan'],
    ['dashboard',  'dashboard.html',  'Percakapan'],
    ['customers',  'customers.html',  'Customer'],
    ['followup',   'followup.html',   'Follow-up'],
    ['cases',      'cases.html',      'Cases'],
    ['contacts',   'contacts.html',   'Kontak'],
    ['aiinsights', 'aiinsights.html', 'AI Insights'],
    ['broadcast',  'broadcast.html',  'Broadcast'],
    ['products',   'products.html',   'Katalog & SOP'],
  ];

  const user = getUser();
  const nama = user?.nama_toko || user?.username || 'User';
  const inisial = nama.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  const navHtml = nav.map(([key, href, label]) => {
    const active = key === activePage ? ' active' : '';
    return `<a class="sb-item${active}" href="${href}"><span class="si">${SVG[key]}</span> ${label}</a>`;
  }).join('\n    ');

  const html = `
<div class="sb-brand">
  <div class="sb-logo">CRM</div>
  <div>
    <div class="sb-title">AI CRM Adsy</div>
    <div class="sb-subtitle">Follow-up Engine</div>
  </div>
</div>
<div class="bot-online" id="sb-bot-status"><div class="bot-dot"></div> Bot online</div>
<div class="sb-nav">
    ${navHtml}
    <div class="sb-divider"></div>
    <div class="sb-section">Akun</div>
    <a class="sb-item${'settings' === activePage ? ' active' : ''}" href="settings.html"><span class="si">${SVG.settings}</span> Pengaturan</a>
</div>
<div class="sb-user">
  <div class="sb-avatar" id="sb-av">${inisial}</div>
  <div style="flex:1;min-width:0">
    <div style="font-size:12px;font-weight:500;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" id="sb-name">${nama}</div>
    <button style="font-size:11px;color:#475569;border:none;background:none;cursor:pointer;padding:0" onclick="logout()">Logout</button>
  </div>
</div>`;

  // Inject ke #sidebar (atau return HTML kalau tidak ada element)
  const el = document.getElementById('sidebar') || document.getElementById('sidebar-container');
  if (el) {
    el.innerHTML = html;
    // Load prod-switcher setelah sidebar ter-render
    if (typeof window.__loadProdSwitcher === 'function') window.__loadProdSwitcher();
  }
  return html;
}
