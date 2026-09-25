// =============================================
// AICRMADSY — Shared App JS
// =============================================

// Pakai window.__SB_URL secara dinamis (bukan const) supaya
// nilai terbaru setelah initConfig() langsung terpakai

function getSB() {
  return {
    url: window.__SB_URL || '',
    key: window.__SB_KEY || ''
  };
}

// Supabase REST helper
async function sbGet(table, params = '') {
  const { url, key } = getSB();
  const r = await fetch(`${url}/rest/v1/${table}?${params}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function sbPost(table, body, opts = {}) {
  const { url, key } = getSB();
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
  return opts.prefer === 'return=minimal' ? null : r.json();
}

async function sbPatch(table, params, body) {
  const { url, key } = getSB();
  const r = await fetch(`${url}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
}

async function sbDelete(table, params) {
  const { url, key } = getSB();
  const r = await fetch(`${url}/rest/v1/${table}?${params}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!r.ok) throw new Error(await r.text());
}

// ---- AUTH ----
function getUser() {
  try { return JSON.parse(localStorage.getItem('crm_user') || 'null'); } catch { return null; }
}

function requireAuth() {
  const user = getUser();
  if (!user) { window.location.href = 'login.html'; return null; }
  return user;
}

function logout() {
  localStorage.removeItem('crm_user');
  window.location.href = 'login.html';
}

// ---- TOAST ----
function toast(msg, type = 'info', duration = 3000) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = `show ${type}`;
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), duration);
}

// ---- STATUS HELPERS ----
const STATUS_LABELS = {
  baru:     'Data Baru',
  sukses:   'Sukses',
  fu_aktif: 'FU Aktif',
  repeat:   'Repeat',
  dormant:  'Dormant',
  selesai:  'Selesai'
};

const STATUS_BADGE = {
  baru:     'badge-gray',
  sukses:   'badge-green',
  fu_aktif: 'badge-yellow',
  repeat:   'badge-blue',
  dormant:  'badge-red',
  selesai:  'badge-purple'
};

function statusBadge(status) {
  const label = STATUS_LABELS[status] || status;
  const cls   = STATUS_BADGE[status]  || 'badge-gray';
  return `<span class="badge ${cls}">${label}</span>`;
}

// ---- SIDEBAR RENDER ----
function renderSidebar(activePage) {
  const user = getUser();
  if (!user) return;

  const nav = [
    { section: 'Menu Utama' },
    { id: 'dashboard',  label: 'Dashboard',    icon: '📊', href: 'dashboard.html' },
    { id: 'customers',  label: 'Customer',      icon: '👥', href: 'customers.html' },
    { id: 'followup',   label: 'Follow-up',     icon: '📅', href: 'followup.html' },
    { id: 'chat',       label: 'Inbox Chat',    icon: '💬', href: 'dashboard.html#inbox' },
    { section: 'Produk & Pengaturan' },
    { id: 'products',   label: 'Produk',        icon: '📦', href: 'products.html' },
    { id: 'settings',   label: 'Pengaturan',    icon: '⚙️',  href: 'settings.html' },
  ];

  let html = `
    <div class="sidebar">
      <div class="sb-header">
        <div class="sb-logo-placeholder">AI</div>
        <div>
          <div class="sb-title">AI CRM Adsy</div>
          <div class="sb-subtitle">Follow-up Engine</div>
        </div>
      </div>
      <nav class="sb-nav">`;

  for (const item of nav) {
    if (item.section) {
      html += `<div class="sb-section"><div class="sb-section-label">${item.section}</div>`;
      continue;
    }
    const active = activePage === item.id ? 'active' : '';
    html += `
      <a href="${item.href}" class="sb-item ${active}">
        <span class="icon">${item.icon}</span>
        <span>${item.label}</span>
      </a>`;
  }

  html += `</div></div>
      <div class="sb-footer">
        <div class="sb-user">
          <div class="sb-avatar">${(user.username || 'U')[0].toUpperCase()}</div>
          <div>
            <div class="sb-user-name">${user.username || ''}</div>
            <div class="sb-user-role">CRM Agent</div>
          </div>
        </div>
        <button onclick="logout()" class="btn btn-ghost btn-sm" style="width:100%;margin-top:6px;justify-content:center">Logout</button>
      </div>
    </div>`;

  const el = document.getElementById('sidebar');
  if (el) el.innerHTML = html;
}

// ---- DATE HELPERS ----
function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---- PHONE NORMALIZE ----
function normalizePhone(p) {
  if (!p) return '';
  p = p.replace(/\D/g, '');
  if (p.startsWith('0')) p = '62' + p.slice(1);
  if (p.startsWith('+')) p = p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return p;
}

// ---- LOADING ----
function showLoading(id, msg = 'Memuat...') {
  const el = document.getElementById(id);
  if (el) el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text3)"><div class="spinner" style="margin:0 auto 12px"></div><div>${msg}</div></div>`;
}
