/**
 * Vercel Serverless — Webhook dari Baileys
 * Terima pesan → routing CTWA/form/inbound → Claude template prompt → balas via Baileys
 * Blueprint §2 (routing), §3 (template prompt), §4 (pricing engine akan ditambah)
 */

const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY      = process.env.ANTHROPIC_KEY;
const BAILEYS_URL        = process.env.BAILEYS_URL;
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;
const MENGANTAR_KEY      = process.env.MENGANTAR_KEY;
const GROQ_API_KEY       = process.env.GROQ_API_KEY;
const WA_GROUP_JID       = process.env.WA_GROUP_JID; // JID grup WA tujuan recap order
const VALIDASI_URL       = process.env.VALIDASI_SUPABASE_URL;
const VALIDASI_KEY       = process.env.VALIDASI_SUPABASE_KEY;

/* ── FETCH WITH TIMEOUT ───────────────────────────────────── */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ── SUPABASE HELPERS ─────────────────────────────────────── */
const sbH = () => ({
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
});

async function sbGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: sbH() });
  if (!res.ok) throw new Error(`sbGet ${table}: ${await res.text()}`);
  return res.json();
}

async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbH(), 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPost ${table}: ${await res.text()}`);
  return res.json();
}

async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: { ...sbH(), 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPatch ${table}: ${await res.text()}`);
  return res.json();
}

/* ── NORMALISASI NOMOR WA ─────────────────────────────────── */
function normalizeWA(num) {
  // Strip @s.whatsapp.net / @lid / @g.us suffix dulu
  const raw = String(num).split('@')[0];
  let n = raw.replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  // LID format: hasil normalisasi lebih dari 13 digit = bukan nomor HP asli
  // Kembalikan digit asli tanpa prefix 62 supaya lookup konsisten
  if (n.length > 13) return raw.replace(/\D/g, '');
  return n;
}

/* ── FIND / CREATE CUSTOMER ───────────────────────────────── */
async function findOrCreateCustomer(userId, waNumber, nama, replyJid = null) {
  const normalized = normalizeWA(waNumber);
  const isLid      = replyJid && replyJid.includes('@lid');

  // Cari by wa_number dulu
  let existing = await sbGet('customers', `?user_id=eq.${userId}&wa_number=eq.${normalized}`);
  if (existing.length) {
    const c = existing[0];
    // Update reply_jid kalau belum ada (agar lookup future bisa by LID juga)
    if (replyJid && !c.reply_jid) {
      await sbPatch('customers', `?id=eq.${c.id}`, { reply_jid: replyJid }).catch(() => {});
      c.reply_jid = replyJid;
    }
    return c;
  }

  // Kalau tidak ketemu, cari by reply_jid (handle LID yang sudah tersimpan sebelumnya)
  if (replyJid) {
    const byJid = await sbGet('customers', `?user_id=eq.${userId}&reply_jid=eq.${encodeURIComponent(replyJid)}`);
    if (byJid.length) {
      // Ketemu by LID — update wa_number ke nomor asli yang sudah resolve
      const old = byJid[0];
      const updates = {};
      if (old.wa_number !== normalized && !isLid) {
        updates.wa_number = normalized;
        old.wa_number = normalized;
        console.log(`[customer] Update wa_number LID → ${normalized} untuk id=${old.id}`);
      }
      if (Object.keys(updates).length) {
        await sbPatch('customers', `?id=eq.${old.id}`, updates).catch(() => {});
      }
      return old;
    }
  }

  // Benar-benar customer baru — simpan reply_jid kalau LID agar next message bisa lookup
  const rows = await sbPost('customers', {
    user_id: userId,
    wa_number: normalized,
    nama: nama || normalized,
    ...(isLid ? { reply_jid: replyJid } : {}),
  });
  return rows[0];
}

/* ── FIND / CREATE CONVERSATION ──────────────────────────── */
async function findOrCreateConversation(userId, customerId, sumber, productId) {
  // Kalau ada productId, cari conversation spesifik untuk produk itu dulu
  // Ini penting agar chat Notelli & Jawara tidak tercampur di inbox
  let existing = [];
  if (productId) {
    existing = await sbGet('conversations',
      `?user_id=eq.${userId}&customer_id=eq.${customerId}&product_id=eq.${productId}&order=created_at.desc&limit=1`
    ).catch(() => []);
  }
  // Fallback: cari conversation terbaru apapun produknya (backward compat / tanpa produk)
  if (!existing.length) {
    existing = await sbGet('conversations',
      `?user_id=eq.${userId}&customer_id=eq.${customerId}&product_id=is.null&order=created_at.desc&limit=1`
    ).catch(() => []);
  }

  if (existing.length) {
    const conv = existing[0];
    // Kalau sudah di-closing → tetap di Closing, tandai has_new_message
    if (conv.status === 'selesai') {
      console.log(`Re-open conversation ${conv.id} — tetap di Closing, set has_new_message`);
      const reopenedAt = new Date().toISOString();
      const prevState = conv.state || {};
      const newState = {
        tahap: 'sambut',
        produk_locked: !!prevState.produk_locked,
        reopened_at: reopenedAt,
        has_new_message: true, // tampil badge "Pelanggan Baru" di tab Closing
        // Simpan wilayah lama sebagai referensi → Claude konfirmasi ke customer dulu sebelum pakai
        // Tidak langsung auto-hitung (customer mungkin ganti alamat), tapi tidak tanya dari nol
        prev_wilayah: prevState.wilayah || null,
        wilayah:      null,  // clear — diisi ulang setelah customer konfirmasi
        ongkir:       null,
        keluhan:      null,
        alamat:       null,
        metode_bayar: null,
        qty:          null,
        // Clear state transient
        proposed_wilayah:       null,
        pending_kecamatan:      null,
        followed_up:            false,
        followed_up_days:       [],
        order_placed:           false, // reset — bisa order lagi
        awaiting_order_confirm: false,
        awaiting_order_correction: false,
        foto_terkirim:          false,
      };
      const updated = await sbPatch('conversations', `?id=eq.${conv.id}`, {
        status: 'selesai', // tetap di tab Closing
        last_msg_at: reopenedAt,
        ringkasan: null,
        state: newState,
      });
      return updated[0] || { ...conv, status: 'selesai', state: newState };
    }
    return conv;
  }

  // Customer baru sama sekali → buat conversation baru
  // Form lead = prioritas high, inbound/ctwa = low
  const prioritas = sumber === 'form' ? 'high' : 'low';
  const rows = await sbPost('conversations', {
    user_id: userId,
    customer_id: customerId,
    sumber,
    product_id: productId || null,
    status: 'baru',
    prioritas,
    state: { tahap: 'sambut', produk_locked: !!productId, is_form_lead: sumber === 'form' },
  });
  return rows[0];
}

/* ── ROUTING: CTWA referral → produk ─────────────────────── */
async function resolveProduct(userId, referral, messageText) {
  // 1. Coba dari CTWA referral
  if (referral?.ad_id || referral?.headline) {
    const identifier = referral.ad_id || referral.headline;
    const mapping = await sbGet('ad_mapping',
      `?user_id=eq.${userId}&identifier=eq.${encodeURIComponent(identifier)}&aktif=eq.true&limit=1`
    );
    if (mapping.length && mapping[0].product_id) {
      const prod = await sbGet('products', `?id=eq.${mapping[0].product_id}&aktif=eq.true&limit=1`);
      if (prod.length) return { product: prod[0], sumber: 'ctwa' };
    }
  }

  // 2. Fallback: deteksi dari isi chat (keyword sederhana)
  if (messageText) {
    const products = await sbGet('products', `?user_id=eq.${userId}&aktif=eq.true`);
    const msgLower = messageText.toLowerCase();
    for (const p of products) {
      const namaLower = p.nama.toLowerCase();
      if (msgLower.includes(namaLower) || namaLower.split(' ').some(w => w.length > 3 && msgLower.includes(w))) {
        return { product: p, sumber: 'inbound' };
      }
    }
    // Kembalikan produk pertama aktif jika hanya 1 produk
    if (products.length === 1) return { product: products[0], sumber: 'inbound' };
  }

  return { product: null, sumber: 'inbound' };
}

/* ── BUILD TEMPLATE SYSTEM PROMPT (Blueprint §3) ─────────── */
function buildTemplatePrompt(product, customer, conversation, sumber, userRekening = null) {
  // ── CRM POST-PURCHASE: context untuk balas customer yang merespons follow-up ──
  const csNama     = product?.persona_cs_nama || 'Sari';
  const namaProduk = product?.nama || 'produk kami';
  const namaCustomer = customer?.nama || 'Kak';
  const tglDelivered = customer?.tgl_delivered
    ? new Date(customer.tgl_delivered).toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' })
    : null;
  const catatanCustomer = customer?.catatan || '';
  const sopFu = Array.isArray(product?.sop_followup)
    ? product.sop_followup.join('\n')
    : (product?.sop_followup || '');

  const rekeningInfo = userRekening
    ? userRekening
    : '(belum diisi — kalau customer mau repeat order, bilang "nanti kami kirimkan detail pemesanannya ya kak 🙏")';

  const alamatTersimpan = customer?.alamat
    ? [customer.alamat.jalan, customer.alamat.kelurahan, customer.alamat.kecamatan,
       customer.alamat.kabupaten, customer.alamat.provinsi].filter(Boolean).join(', ')
    : null;

  return `IDENTITAS & KONTEKS
Kamu "${csNama}", tim after-sales/CRM yang follow-up customer post-purchase via WhatsApp.
Kalau ditanya "kamu robot/AI/bot?" → jawab santai: "Hehe bukan kak, aku ${csNama} dari tim after-sales 😊" — JANGAN akui sebagai AI.

KONTEKS CRM POST-PURCHASE
Customer ini SUDAH membeli dan menerima produk${tglDelivered ? ` (delivered: ${tglDelivered})` : ''}.
Produk       : ${namaProduk}
Customer     : ${namaCustomer}
${catatanCustomer ? `Catatan      : ${catatanCustomer}` : ''}
${sopFu ? `SOP Follow-up:\n${sopFu}` : ''}
Product Knowledge: ${product?.product_knowledge || '(belum diisi)'}
Cara pakai   : ${product?.cara_pakai || '(lihat kemasan)'}
Rekening     : ${rekeningInfo}

TUJUAN UTAMA
- Cek pengalaman/kepuasan customer setelah pakai produk
- Bantu kalau ada kendala pakai, pertanyaan produk, atau keluhan
- Secara natural (tidak memaksa) dorong repeat order kalau customer puas
- Jaga hubungan baik → loyalitas jangka panjang

PRINSIP UTAMA
- Customer sudah beli — BUKAN leads baru. JANGAN mulai dari nol seperti konsultasi baru.
- DENGARKAN dulu pengalaman mereka. Jangan langsung promosi.
- Kalau customer komplain/kecewa → EMPATI dulu, bantu selesaikan, JANGAN defensif.
- Repeat order = akibat kepuasan, bukan hasil dikejar agresif.
- Kalau customer tanya hal di luar kemampuan → jujur, tawarkan eskalasi ke tim.

DATA CHAT & PRODUK
Sumber chat     : ${sumber === 'ctwa' ? 'CTWA (dari iklan)' : sumber === 'form' ? 'Form (isi formulir)' : 'Inbound (customer chat duluan)'}

ALUR PERCAKAPAN CRM
Ini customer yang sudah beli (bukan leads baru). Konteks: mereka balas pesan follow-up kita.

1. CEK PENGALAMAN — tanyakan bagaimana pengalaman pakai produk (sudah berapa lama, ada kendala?)
2. DENGARKAN — kalau ada keluhan/masalah, empati dulu dan bantu selesaikan
3. EDUKASI kalau ada pertanyaan cara pakai, efek, dll — jawab dari Product Knowledge
4. DORONG REPEAT ORDER secara natural kalau customer puas:
   - "Stok mau habis nggak kak? Mau kami kirimkan lagi?"
   - "Kalau mau repeat order, bisa langsung ke kami ya kak 😊"
   - JANGAN paksa, JANGAN kesan desperate

GAYA NGOBROL
- Panggil dengan nama customer (${namaCustomer}) atau "Kak"; kalimat PENDEK (1–2 kalimat per balasan)
- Hangat, sabar, peduli; emoji secukupnya 😊🙏
- JANGAN paragraf panjang/kaku/formal
- ⚠️ DILARANG semua markdown — JANGAN *bold*, JANGAN **bold**, JANGAN _italic_. Ini WhatsApp.
- ⛔ BLACKLIST: "sistem", "tim terkait", "admin", "CS", "sedang diproses", "akan diproses", "server", "error", "maintenance"

HANDLE SITUASI UMUM
- Customer puas → perkuat dengan afirmasi, dorong repeat order & minta review/testimoni kalau mau
- Customer ada masalah produk → empati + bantu cari solusi dari product knowledge
- Customer tidak cocok/kecewa → minta maaf dengan tulus, tawarkan solusi, JANGAN defensif
- Customer tanya harga repeat order → kasih info rekening: ${rekeningInfo}
- Customer mau order lagi → ikuti alur REPEAT ORDER di bawah

REPEAT ORDER
Kalau customer bilang mau order lagi / beli lagi / repeat:
1. Konfirmasi alamat tersimpan${alamatTersimpan ? `: "Masih dikirim ke ${alamatTersimpan} ya kak? 😊"` : ': tanyakan alamat pengiriman'}
   - Kalau customer bilang sama/iya → lanjut ke step 2
   - Kalau customer bilang ganti → minta alamat baru, catat
2. Tanya jumlah: "Mau berapa ${namaProduk}?"
3. Setelah dapat konfirmasi alamat + qty → tulis marker di AKHIR balasanmu (jangan tampilkan ke customer):
   [REPEAT_ORDER_CONFIRMED:qty=N]
   Contoh balasan: "Siap kak! Pesanannya ${namaProduk} ya, nanti kami proses segera 🙏 [REPEAT_ORDER_CONFIRMED:qty=2]"
4. Kasih info rekening: ${rekeningInfo}
PENTING: Tulis [REPEAT_ORDER_CONFIRMED:qty=N] HANYA setelah customer konfirmasi alamat + qty. Jangan tulis kalau customer masih ragu.

ETIS
- JANGAN klaim medis berlebihan.
- Komplain produk serius → empati dan eskalasi ke tim, jangan asal janji.
- CS manusia bisa ambil alih kapanpun dari dashboard.

TUJUAN AKHIR
Customer merasa DIPERHATIKAN setelah beli. Kepuasan → loyalitas → repeat order natural.`;
}

const PROVINSI_JAWA = ['dki jakarta','jawa barat','jawa tengah','di yogyakarta','yogyakarta','jawa timur','banten'];
function isDalamJawa(provinsi) {
  if (!provinsi) return false;
  const p = provinsi.toLowerCase().trim();
  const result = PROVINSI_JAWA.some(j => p === j || p.includes(j));
  console.log(`[PROMO] isDalamJawa("${provinsi}") = ${result}`);
  return result;
}
function getPromoPotongan(promo, provinsi, ongkirAsli = 0) {
  if (!promo) return 0;
  const isPersen = promo.unit === 'persen';
  const calc = (nilai) => isPersen ? Math.round(ongkirAsli * (nilai / 100)) : (nilai || 0);
  if (promo.tipe === 'potong') return calc(promo.nilai);
  if (promo.tipe === 'potong_wilayah') return isDalamJawa(provinsi) ? calc(promo.nilai_jawa) : calc(promo.nilai_luar);
  return 0;
}

// Cari harga bundling untuk qty tertentu. Kalau tidak match → fallback harga satuan × qty
function resolveHargaBundling(product, qty = 1) {
  const satuan = product?.harga || 0;
  const bundling = product?.harga_bundling;
  if (!Array.isArray(bundling) || !bundling.length) return satuan * qty;
  const exact = bundling.find(p => p.qty === qty);
  if (exact) return exact.harga;
  // Tidak ada paket yang cocok → satuan × qty
  return satuan * qty;
}

function formatPromoOngkir(promo) {
  if (!promo || promo.tipe === 'none') return 'tidak ada';
  const isPersen = promo.unit === 'persen';
  const fmt = (v) => isPersen ? `${v}%` : `Rp ${(v||0).toLocaleString('id-ID')}`;
  if (promo.tipe === 'gratis_penuh') return 'GRATIS ongkir';
  if (promo.tipe === 'potong') return `Hemat ${fmt(promo.nilai)} dari ongkir (semua wilayah)`;
  if (promo.tipe === 'potong_wilayah') return `Dalam Jawa hemat ${fmt(promo.nilai_jawa)} · Luar Jawa hemat ${fmt(promo.nilai_luar)}`;
  if (promo.tipe === 'gratis_sd') return `Gratis ongkir s/d Rp ${promo.nilai?.toLocaleString('id-ID')}`;
  return 'ada promo';
}

/* ── GET HISTORY & CONTEXT INJECTION ─────────────────────── */
async function getContextMessages(conversationId, afterTimestamp = null, limit = 20) {
  // Ambil N pesan TERAKHIR — caller bisa set limit lebih kecil kalau ada ringkasan
  const timeFilter = afterTimestamp ? `&created_at=gte.${encodeURIComponent(afterTimestamp)}` : '';
  const msgs = await sbGet('conv_messages',
    `?conversation_id=eq.${conversationId}&order=created_at.desc&limit=${limit}${timeFilter}`
  );
  msgs.reverse();

  const mapped = msgs.map(m => ({
    role: m.role === 'customer' ? 'user' : 'assistant',
    content: m.isi || '',
  })).filter(m => m.content.trim());

  // Gabungkan consecutive same role (Claude API wajib alternating)
  const result = [];
  for (const msg of mapped) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.content += '\n' + msg.content;
    } else {
      result.push({ ...msg });
    }
  }

  // Harus mulai dari 'user'
  if (result.length && result[0].role === 'assistant') result.shift();

  // Harus diakhiri 'user' (Claude API tidak boleh berakhir dengan assistant)
  while (result.length && result[result.length - 1].role === 'assistant') result.pop();

  return result;
}

/* ── UPDATE RINGKASAN BERJALAN (non-blocking) ─────────────── */
async function updateRingkasan(conversationId) {
  try {
    const msgs = await sbGet('conv_messages',
      `?conversation_id=eq.${conversationId}&order=created_at.asc`
    );
    if (msgs.length < 6) return; // belum cukup untuk diringkas

    const transcript = msgs.map(m =>
      `${m.role === 'customer' ? 'Customer' : 'AI'}: ${m.isi}`
    ).join('\n');

    const ringkasan = await callClaude(
      'Buat ringkasan singkat percakapan CS ini dalam 3-5 kalimat bahasa Indonesia. Fokus pada: keluhan customer, produk yang dibahas, tahap percakapan (konsultasi/tertarik/mau beli/sudah order), dan data yang sudah terkumpul (nama/HP/alamat). Singkat dan padat.',
      [{ role: 'user', content: transcript }],
      'claude-haiku-4-5-20251001'
    );

    if (ringkasan) {
      await sbPatch('conversations', `?id=eq.${conversationId}`, { ringkasan });
    }
  } catch (e) {
    console.error('updateRingkasan error:', e.message);
  }
}

async function saveMessage(conversationId, role, isi, wamid = null) {
  const payload = { conversation_id: conversationId, role, isi };
  if (wamid) payload.wamid = wamid;
  return sbPost('conv_messages', payload);
}

/* ── CALL CLAUDE ──────────────────────────────────────────── */
async function callClaude(systemPrompt, messages, model = 'claude-sonnet-4-6', apiKey = null) {
  const key = apiKey || ANTHROPIC_KEY;
  if (!key) throw new Error('ANTHROPIC_KEY belum diset');

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: systemPrompt,
      messages,
    }),
  }, 30000); // 30 detik timeout untuk AI
  const data = await res.json();
  if (data.error) throw new Error(`Claude: ${data.error.message}`);
  return data.content?.[0]?.text || '';
}

/* ── TRANSCRIBE VOICE NOTE via Groq Whisper ──────────────────── */
async function transcribeAudio(base64Audio) {
  if (!GROQ_API_KEY) return null;
  try {
    const buffer = Buffer.from(base64Audio.replace('data:audio/ogg;base64,', ''), 'base64');
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'audio.ogg');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'id');
    formData.append('response_format', 'json');

    const res = await fetchWithTimeout('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: formData,
    }, 15000); // 15 detik untuk transcribe audio
    const data = await res.json();
    return data.text || null;
  } catch(e) {
    console.error('Groq transcribe error:', e.message);
    return null;
  }
}

/* ── DETEKSI KONFIRMASI WILAYAH (webhook-level, tidak bergantung Claude) ── */

// Filter dasar untuk kata yang PASTI bukan wilayah (validasi utama tetap via Supabase)
const BUKAN_WILAYAH = /^(ya|oke|siap|baik|iya|tidak|gak|ga|mau)\s/i;

// Ekstrak wilayah yang AI sedang konfirmasikan — pertanyaan ("Sumba NTT ya kak?")
function extractProposedWilayah(aiMsg) {
  const lines = aiMsg.split(/[.\n]/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    // Pattern 1: "ke X ya kak?" / "jadi X ya kak?"
    let m = line.match(/(?:jadi\s+ke\s+|jadi\s+|ke\s+)([A-Za-z][A-Za-z\s,]{2,60}?)\s+ya\s+kak[?😊🙏\s]/i);

    // Pattern 2: "Berarti X ya kak?" / "Berarti X ya?"
    if (!m) m = line.match(/berarti\s+([A-Za-z][A-Za-z\s,]{2,60}?)\s+ya[\s?😊🙏]/i);

    // Pattern 3: "X ya kak?" di akhir (tanda tanya = pertanyaan)
    if (!m) m = line.match(/([A-Za-z][A-Za-z\s,]{5,60}?)\s+ya\s+kak\s*\?/i);

    // Pattern 4: "X ya 😊" — bot konfirmasi wilayah tanpa kata "kak" (misal: "Bangunjiwo, Kasihan, Bantul ya 😊")
    // Harus ada koma (agar tidak terlalu agresif menangkap kalimat biasa)
    if (!m) m = line.match(/([A-Za-z][A-Za-zÀ-ÿ\s,\.]{5,60}?,\s*[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s,\.]{2,40}?)\s+ya\s*[😊🙏😄🙂✅]/u);

    if (m) {
      let candidate = m[1].trim().replace(/[,?!]+$/, '');
      // Kalau candidate diawali kata bukan-wilayah (misal "Baik kak, Sewon, Bantul") → strip prefix sebelum koma pertama
      if (BUKAN_WILAYAH.test(candidate)) {
        const firstComma = candidate.indexOf(',');
        if (firstComma > 0) candidate = candidate.slice(firstComma + 1).trim();
      }
      const wordCount = candidate.split(/\s+/).length;
      // Filter dasar saja, validasi utama via Supabase
      if (candidate.length >= 3 && wordCount <= 8 && !BUKAN_WILAYAH.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// extractConfirmedWilayah dihapus — pakai [WILAYAH_OK:] marker saja

/* ── EXTRACT LOKASI PAKAI HAIKU (untuk reply customer setelah AI tanya alamat) ── */
async function extractLokasiHaiku(text, apiKey) {
  const key = apiKey || ANTHROPIC_KEY;
  if (!key) return null;
  const prompt = `Dari teks berikut, ekstrak nama kelurahan/desa, kecamatan, dan kabupaten/kota di Indonesia jika ada.
Teks: "${text}"
Jawab dengan JSON saja tanpa penjelasan: {"kelurahan":"...","kecamatan":"...","kabupaten":"..."} atau null jika tidak ada nama wilayah Indonesia yang jelas.
Isi field yang ada saja, kosongkan yang tidak disebutkan. Jangan mengarang.`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 80, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() || '';
    if (!raw || raw === 'null') return null;
    const parsed = JSON.parse(raw);
    if (!parsed.kecamatan && !parsed.kabupaten && !parsed.kelurahan) return null;
    return parsed;
  } catch { return null; }
}

/* ── SEARCH WILAYAH LOKAL (tabel wilayah_id di Supabase) ─── */
async function cariWilayah(keyword, limit = 50) {
  try {
    const cleanPart = s => s.trim().toLowerCase()
      .replace(/\bkota\b/gi, '').replace(/\bkabupaten\b/gi, '').replace(/\bkab\b/gi, '')
      .replace(/\bprovinsi\b/gi, '').replace(/\bprov\b/gi, '').trim();

    // Kalau input comma-separated (misal: "Medan Timur, Medan" atau "Kranggan, Galur, Kulonprogo")
    const parts = keyword.split(',').map(cleanPart).filter(s => s.length >= 2);
    if (parts.length >= 2) {
      const [part1, part2, part3] = parts;

      // Coba: part1=kecamatan, part2=kabupaten
      const byKecKab = await sbGet('wilayah_id',
        `?kecamatan=ilike.*${encodeURIComponent(part1)}*&kabupaten=ilike.*${encodeURIComponent(part2)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`
      ).catch(() => []);
      if (byKecKab.length > 0) return byKecKab;

      // Coba: part1=kelurahan, part2=kecamatan
      const byKelKec = await sbGet('wilayah_id',
        `?kelurahan=ilike.*${encodeURIComponent(part1)}*&kecamatan=ilike.*${encodeURIComponent(part2)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`
      ).catch(() => []);
      if (byKelKec.length > 0) return byKelKec;

      // Coba dengan part3 kalau ada (kelurahan, kecamatan, kabupaten)
      if (part3) {
        const byAll = await sbGet('wilayah_id',
          `?kecamatan=ilike.*${encodeURIComponent(part2)}*&kabupaten=ilike.*${encodeURIComponent(part3)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`
        ).catch(() => []);
        if (byAll.length > 0) return byAll;
      }
    }

    const kw = cleanPart(keyword);
    if (kw.length < 2) return [];

    // Cari di semua level dengan limit tinggi untuk kabupaten/provinsi
    const [byKec, byKab, byKel, byProv] = await Promise.all([
      sbGet('wilayah_id', `?kecamatan=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`).catch(() => []),
      sbGet('wilayah_id', `?kabupaten=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=100`).catch(() => []), // limit tinggi untuk kab
      sbGet('wilayah_id', `?kelurahan=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`).catch(() => []),
      sbGet('wilayah_id', `?provinsi=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=100`).catch(() => []), // limit tinggi untuk prov
    ]);

    // Gabung & deduplikasi berdasarkan kecamatan+kabupaten
    const seen = new Set();
    const merged = [];
    // Prioritas: kecamatan > kelurahan > kabupaten > provinsi (dari spesifik ke umum)
    for (const row of [...byKec, ...byKel, ...byKab, ...byProv]) {
      const key = `${row.kecamatan}||${row.kabupaten}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(row);
      }
    }
    return merged;
  } catch(e) {
    console.error('cariWilayah error:', e.message);
    return [];
  }
}

// Format wilayah untuk tampil ke Claude/customer (kecamatan + kabupaten + provinsi)
function formatWilayah(row) {
  return [row.kecamatan, row.kabupaten, row.provinsi].filter(Boolean).join(', ');
}

// Format wilayah untuk query ke Mengantar — strip prefix Kabupaten/Kota agar Mengantar bisa match
function formatWilayahMengantar(row) {
  const stripKab = s => (s || '').replace(/^(kabupaten|kota|kab\.?)\s*/i, '').trim();
  return [row.kelurahan, row.kecamatan, stripKab(row.kabupaten), row.provinsi].filter(Boolean).join(', ');
}

// Ambil semua kelurahan di satu kecamatan (untuk ditawarkan ke customer sebagai pilihan)
async function getKelurahanByKecamatan(kecamatan, kabupaten) {
  try {
    const rows = await sbGet('wilayah_id',
      `?kecamatan=ilike.${encodeURIComponent(kecamatan)}&kabupaten=ilike.${encodeURIComponent(kabupaten)}&select=kelurahan&order=kelurahan.asc&limit=20`
    );
    // Deduplikasi
    return [...new Set(rows.map(r => r.kelurahan))];
  } catch(e) {
    console.error('getKelurahanByKecamatan error:', e.message);
    return [];
  }
}

// Bersihkan kata sopan/filler dari pesan sebelum search wilayah
// Contoh: "sewon kak" → "sewon", "pendowoharjo ya" → "pendowoharjo"
function cleanKelInput(msg) {
  return msg.trim().toLowerCase()
    .replace(/\b(kak|bang|pak|bu|mbak|mas|kang|mba|ya|iya|ok|oke|siap|dong|deh|lah|nih|sih|gan|bro|sis)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Deteksi apakah pesan customer adalah konfirmasi singkat
function isConfirmation(msg) {
  const lower = msg.toLowerCase().trim().replace(/[.!]+$/, '');
  return /^(iya|ya|yakin|bener|betul|ok|oke|okey|yep|yup|iyah|bnar|benar|yes|confirm|bisa|boleh|lanjut)(\s+kak)?$/.test(lower);
}

/* ── PEMBULATAN ke kelipatan terdekat ────────────────────── */
function bulatkan(nilai, kelipatan = 500) {
  const bawah = Math.floor(nilai / kelipatan) * kelipatan;
  const atas  = bawah + kelipatan;
  return (nilai - bawah) <= (atas - nilai) ? bawah : atas;
}

/* ── MENGANTAR PUBLIC API ─────────────────────────────────── */
const MENGANTAR_ORIGIN_ID = process.env.MENGANTAR_ORIGIN_ID || '5fc63315f8f44b34aa4c44c7';
const MENGANTAR_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
};

async function mengantarFetch(path, timeoutMs = 20000) {
  try {
    const res = await fetchWithTimeout(`https://app.mengantar.com/api/${path}`, { headers: MENGANTAR_HEADERS }, timeoutMs);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[mengantarFetch] HTTP ${res.status} — ${body.slice(0, 200)}`);
      return null;
    }
    const text = await res.text();
    try { return JSON.parse(text); } catch(e) {
      console.error(`[mengantarFetch] JSON parse error — ${text.slice(0, 200)}`);
      return null;
    }
  } catch(e) {
    console.error(`[mengantarFetch] ${path.split('?')[0]} — ${e.message}`);
    return null;
  }
}

/* ── HITUNG ONGKIR via Mengantar public API ───────────────── */
async function hitungOngkir(wilayah, product, qty = 1, userMngOriginId = null) {
  console.log(`[hitungOngkir] START wilayah="${wilayah}" qty=${qty} originId=${userMngOriginId || MENGANTAR_ORIGIN_ID}`);
  try {
    // Step 1: Cari di tabel lokal wilayah_id
    const lokalMatch = await cariWilayah(wilayah, 3);
    let lokal = lokalMatch[0] || null;
    if (lokalMatch.length > 1) {
      const kw = wilayah.toLowerCase();
      const scored = lokalMatch.map(r => {
        let score = 0;
        if (r.kelurahan.toLowerCase() === kw) score += 50;
        else if (r.kelurahan.toLowerCase().includes(kw)) score += 30;
        if (r.kecamatan.toLowerCase() === kw) score += 40;
        else if (r.kecamatan.toLowerCase().includes(kw)) score += 20;
        if (r.kabupaten.toLowerCase().includes(kw)) score += 10;
        return { row: r, score };
      });
      scored.sort((a, b) => b.score - a.score);
      lokal = scored[0].row;
    }

    // Step 2: Bangun query Mengantar
    const stripKab = s => (s || '').replace(/^(kabupaten|kota|kab\.?)\s*/i, '').trim();
    let queryMengantar = wilayah;
    let queryDisplay   = wilayah;
    if (lokal) {
      queryMengantar = formatWilayahMengantar(lokal);
      queryDisplay   = formatWilayah(lokal);
      console.log(`[hitungOngkir] lokal: "${lokal.kelurahan}, ${lokal.kecamatan}, ${lokal.kabupaten}" → query: "${queryMengantar}"`);
    }

    // Step 3: Cari destination_id — dengan fallback query bertahap
    // API baru lebih cocok dengan keyword tunggal (satu kata/frasa) daripada comma-separated
    // Pecah wilayah string jadi bagian-bagian (format: kelurahan, kecamatan, kabupaten, provinsi)
    const wParts = wilayah.split(',').map(s => s.trim()).filter(Boolean);
    const [wKel = '', wKec = '', wKab = '', wProv = ''] = wParts;

    const queryFallbacks = lokal ? [
      // Pakai data lokal yang sudah terstruktur
      lokal.kelurahan,
      [lokal.kelurahan, lokal.kecamatan].filter(Boolean).join(' '),
      lokal.kecamatan,
      [lokal.kecamatan, stripKab(lokal.kabupaten)].filter(Boolean).join(' '),
    ] : [
      // Tidak ada di DB lokal — gunakan parts dari wilayah string
      // Prioritas: kelurahan+kecamatan dulu (paling spesifik), baru satu per satu
      wKel && wKec ? `${wKel} ${wKec}` : null,
      wKec && wKab ? `${wKec} ${stripKab(wKab)}` : null,
      wKel,
      wKec,
    ].filter(Boolean);

    // Kirim semua query fallback secara parallel, gabung SEMUA hasil untuk scoring
    const searchResults = await Promise.all(
      queryFallbacks.map(q =>
        mengantarFetch(`address/autofill?keyword=${encodeURIComponent(q)}`, 15000)
          .then(json => {
            const res = Array.isArray(json) ? json : (json?.data || []);
            console.log(`[hitungOngkir] search "${q}" → ${res.length} results`);
            return res;
          })
          .catch(() => [])
      )
    );
    // Gabung semua hasil (deduplikasi by _id) untuk scoring komprehensif
    const seenIds = new Set();
    const allAreas = searchResults.flat().filter(a => {
      const id = a._id || a.id;
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    if (!allAreas.length) {
      console.error(`[hitungOngkir] Semua search fallback gagal untuk "${queryMengantar}"`);
      return null;
    }

    // Step 3b: Pilih area terbaik — scoring dari SEMUA hasil semua keyword
    const normStr = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const aSubdistrict = a => a.SUBDISTRICT_NAME || a.subdistrict || '';
    const aDistrict    = a => a.DISTRICT_NAME    || a.district    || '';
    const aCity        = a => a.CITY_NAME        || a.city        || a.regency || '';
    const aProvince    = a => a.PROVINCE_NAME    || a.province    || '';
    // Pecah wilayah penuh jadi parts untuk scoring (kelurahan, kecamatan, kabupaten, provinsi)
    const wilayahParts = wilayah.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    let bestArea = allAreas[0], bestScore = -1;
    for (const a of allAreas) {
      let score = 0;
      if (lokal) {
        if (normStr(aSubdistrict(a)) === normStr(lokal.kelurahan)) score += 50;
        else if (aSubdistrict(a).toLowerCase().includes(lokal.kelurahan.toLowerCase())) score += 30;
        if (normStr(aDistrict(a)) === normStr(lokal.kecamatan)) score += 30;
        else if (aDistrict(a).toLowerCase().includes(lokal.kecamatan.toLowerCase())) score += 15;
        if (normStr(aCity(a)) === normStr(lokal.kabupaten)) score += 20;
        if (normStr(aProvince(a)) === normStr(lokal.provinsi)) score += 10;
      } else {
        const aFull = [aSubdistrict(a), aDistrict(a), aCity(a), aProvince(a)].filter(Boolean).join(' ').toLowerCase();
        for (const part of wilayahParts) {
          if (normStr(aSubdistrict(a)) === normStr(part)) score += 50;
          else if (aSubdistrict(a).toLowerCase().includes(part)) score += 25;
          if (normStr(aDistrict(a)) === normStr(part)) score += 30;
          else if (aDistrict(a).toLowerCase().includes(part)) score += 15;
          if (normStr(aCity(a)) === normStr(part)) score += 20;
          else if (aCity(a).toLowerCase().includes(part)) score += 10;
          if (normStr(aProvince(a)) === normStr(part)) score += 10;
        }
      }
      if (score > bestScore) { bestScore = score; bestArea = a; }
    }
    const areas = allAreas; // untuk kompatibilitas log di bawah

    const areaId  = bestArea._id || bestArea.id;
    const areaNama = aSubdistrict(bestArea) || bestArea.name || wilayah;
    console.log(`[hitungOngkir] best area: "${areaNama}" id=${areaId} score=${bestScore}`);
    if (!areaId) { console.error('[hitungOngkir] areaId null'); return null; }

    // Step 3c: Ambil estimasi tarif
    const weight = ((product?.berat_gram || 1000) / 1000) * qty;
    const originId = userMngOriginId || MENGANTAR_ORIGIN_ID;
    const ratesJson = await mengantarFetch(
      `order/allEstimatePublic?origin_id=${originId}&destination_id=${areaId}&weight=${weight}`,
      30000
    );
    if (!ratesJson) { console.error(`[hitungOngkir] allEstimatePublic null`); return null; }
    console.log(`[hitungOngkir] rates success=${ratesJson.success}`);
    if (!ratesJson.success) {
      console.error(`[hitungOngkir] allEstimatePublic gagal: ${JSON.stringify(ratesJson).slice(0,200)}`);
      return null;
    }

    const rawData = ratesJson.data || {};
    let rates = Object.entries(rawData)
      .filter(([name, info]) => !name.toLowerCase().includes('cargo') && !info.unsupported && (info.price || 0) > 0)
      .map(([name, info]) => ({ courier_name: name, price: info.price }));
    if (!rates.length) return null;

    // Step 4: Filter whitelist
    const whitelist = await sbGet('courier_whitelist',
      `?user_id=eq.${product?.user_id || ''}&aktif=eq.true`
    ).catch(() => []);
    console.log(`[hitungOngkir] whitelist=${whitelist.map(w=>w.nama).join(',')} rates=${rates.map(r=>`${r.courier_name}:${r.price}`).join(',')}`);
    if (whitelist.length) {
      const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const filtered = rates.filter(r => {
        const rn = norm(r.courier_name);
        return whitelist.some(w => { const wn = norm(w.nama); return rn === wn || rn.startsWith(wn) || wn.startsWith(rn); });
      });
      if (filtered.length) rates = filtered;
    }

    // Step 5: Pilih termurah
    rates.sort((a, b) => a.price - b.price);
    const best       = rates[0];
    const ekspedisi  = best.courier_name;
    const ongkirAsli = best.price;

    // Step 6: Promo ongkir
    const promo    = product?.promo_ongkir;
    const provinsi = lokal?.provinsi || bestArea.province || '';
    let ongkirPromo = ongkirAsli;
    if (promo?.tipe === 'gratis_penuh')        ongkirPromo = 0;
    else if (promo?.tipe === 'potong')         ongkirPromo = Math.max(0, ongkirAsli - getPromoPotongan(promo, null, ongkirAsli));
    else if (promo?.tipe === 'potong_wilayah') ongkirPromo = Math.max(0, ongkirAsli - getPromoPotongan(promo, provinsi, ongkirAsli));
    else if (promo?.tipe === 'gratis_sd')      ongkirPromo = Math.max(0, ongkirAsli - (promo.nilai || 0));

    const harga = resolveHargaBundling(product, qty);

    // Step 7: Hitung total
    const feeCOD             = Math.ceil((harga + ongkirPromo) * 0.05);
    const totalTransferBulat = bulatkan(harga + ongkirPromo);
    const totalCODBulat      = bulatkan(harga + ongkirPromo + feeCOD);
    const feeCODBulat        = totalCODBulat - harga - ongkirPromo;

    const allRates = rates.map(r => {
      let rPromo = r.price;
      if (promo?.tipe === 'gratis_penuh')        rPromo = 0;
      else if (promo?.tipe === 'potong')         rPromo = Math.max(0, r.price - getPromoPotongan(promo, null, r.price));
      else if (promo?.tipe === 'potong_wilayah') rPromo = Math.max(0, r.price - getPromoPotongan(promo, provinsi, r.price));
      else if (promo?.tipe === 'gratis_sd')      rPromo = Math.max(0, r.price - (promo.nilai || 0));
      const rFeeCOD = Math.ceil((harga + rPromo) * 0.05);
      return { nama: r.courier_name, ongkir: r.price, ongkirPromo: rPromo, totalTF: bulatkan(harga + rPromo), totalCOD: bulatkan(harga + rPromo + rFeeCOD) };
    });

    return {
      ekspedisi, ongkirAsli, ongkirPromo,
      totalTransfer: totalTransferBulat,
      totalCOD: totalCODBulat,
      feeCOD: feeCODBulat,
      harga, allRates,
      area: {
        kelurahan: lokal?.kelurahan || bestArea.SUBDISTRICT_NAME || bestArea.subdistrict || '',
        kecamatan: lokal?.kecamatan || bestArea.DISTRICT_NAME    || bestArea.district    || '',
        kota:      lokal?.kabupaten || bestArea.CITY_NAME        || bestArea.city        || bestArea.regency || '',
        provinsi:  lokal?.provinsi  || bestArea.PROVINCE_NAME    || bestArea.province    || '',
        kodePos:   bestArea.ZIP_CODE || bestArea.postal_code || bestArea.posCode || '',
      },
    };
  } catch(e) {
    console.error('[hitungOngkir] error:', e.message);
    return null;
  }
}

/* ── GOOGLE MAPS URL → KOORDINAT ─────────────────────────── */
function extractGoogleMapsCoords(text) {
  // Format: /@-7.9316498,110.2715208, (paling umum)
  const m1 = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
  // Format: ?q=-7.93,110.27
  const m2 = text.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
  return null;
}

async function resolveGoogleMapsUrl(text) {
  // Cari URL Maps di teks (termasuk goo.gl shortlink)
  const urlMatch = text.match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl|maps\.google\.com|www\.google\.com\/maps)[^\s]*/);
  if (!urlMatch) return null;

  let url = urlMatch[0];

  // Kalau shortlink → resolve redirect untuk dapat URL panjang
  if (url.includes('goo.gl')) {
    try {
      const res = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow' }, 8000);
      url = res.url; // URL final setelah redirect
      console.log(`Resolved goo.gl → ${url.slice(0, 100)}`);
    } catch(e) {
      console.error('Resolve goo.gl error:', e.message);
      return null;
    }
  }

  return extractGoogleMapsCoords(url);
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetchWithTimeout(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=id`,
      { headers: { 'User-Agent': 'BotWA-CS/1.0 (contact@adsy.id)' } },
      8000
    );
    const data = await res.json();
    const a = data.address || {};
    return {
      kelurahan: a.village || a.suburb || '',
      kecamatan: a.city_district || a.county || a.suburb || '',
      kota:      a.city || a.town || a.county || '',
      provinsi:  a.state || '',
    };
  } catch(e) {
    console.error('Nominatim error:', e.message);
    return null;
  }
}

/* ── KIRIM WA via Baileys server ──────────────────────────── */
async function sendWA(sessionId, waNumber, message, isOutbound = false, imageUrl = null, caption = null) {
  if (!BAILEYS_URL) throw new Error('BAILEYS_URL belum diset');
  const res = await fetchWithTimeout(`${BAILEYS_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
      session_id: sessionId,
      wa_number: waNumber,
      message: imageUrl ? undefined : (message || ''),
      is_outbound: isOutbound,
      image_url: imageUrl || undefined,
      caption: caption || undefined,
    }),
  }, 30000); // 30 detik (text + gambar)
  if (!res.ok) throw new Error(`Baileys send error: ${await res.text()}`);
  return res.json();
}

/* ── CEK WILAYAH RISK dari kodepos_stats (Validasiorder) ─── */
async function cekWilayahRisk(kodepos) {
  if (!kodepos || !VALIDASI_URL || !VALIDASI_KEY) return null;
  try {
    const res = await fetch(
      `${VALIDASI_URL}/rest/v1/kodepos_stats?kodepos=eq.${encodeURIComponent(kodepos)}&limit=1`,
      { headers: { 'apikey': VALIDASI_KEY, 'Authorization': `Bearer ${VALIDASI_KEY}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    const r = data[0];
    const pct   = r.pct ?? Math.round((r.retur / r.total) * 100);
    const level = pct >= 30 ? 'rawan' : pct >= 15 ? 'perhatian' : 'aman';
    const label = pct >= 30 ? `Rawan Tinggi (${pct}% RTS)` : pct >= 15 ? `Perlu Diperhatikan (${pct}% RTS)` : `Relatif Aman (${pct}% RTS)`;
    return { kodepos: String(kodepos), total: r.total, retur: r.retur, pct, level, label };
  } catch(e) {
    console.error('[cekWilayahRisk] error:', e.message);
    return null;
  }
}

/* ── BUILD INJEKSI ONGKIR untuk Claude ───────────────────── */
function buildOngkirInjeksi(hasil, product, konteks = '') {
  const fmt = (n) => `Rp ${n.toLocaleString('id-ID')}`;
  const ongkirAsli  = hasil.ongkirAsli;
  const ongkirPromo = hasil.ongkirPromo;
  const ongkirDisplay = ongkirAsli !== ongkirPromo
    ? `~${fmt(ongkirAsli)}~ ${fmt(ongkirPromo)}`
    : fmt(ongkirPromo);

  const areaFull = hasil.area
    ? [hasil.area.kecamatan, hasil.area.kota, hasil.area.provinsi].filter(Boolean).join(', ')
    : '';

  // Tabel semua kurir yang tersedia
  const tabelKurir = (hasil.allRates || []).map(r => {
    const potongan = r.ongkir !== r.ongkirPromo ? ` (hemat ${fmt(r.ongkir - r.ongkirPromo)})` : '';
    return `- ${r.nama}: ongkir ${fmt(r.ongkir)}${potongan} → TF total ${fmt(r.totalTF)} | COD total ${fmt(r.totalCOD)}`;
  }).join('\n');

  const hasBundling = Array.isArray(product?.harga_bundling) && product.harga_bundling.length > 0;
  const paketPrioritas = hasBundling ? product.harga_bundling.find(p => p.prioritas) : null;

  let hargaSection;

  if (hasBundling) {
    const defaultPaket  = paketPrioritas || product.harga_bundling[0];
    const defaultHarga  = defaultPaket.harga;
    const defaultFeeCOD = Math.ceil((defaultHarga + ongkirPromo) * 0.05);
    const defaultTotalTF  = defaultHarga + ongkirPromo;
    const defaultTotalCOD = defaultHarga + ongkirPromo + defaultFeeCOD;

    // Tabel semua paket (hanya ditampilkan ke Claude, TIDAK ke customer kecuali ditanya)
    const tabelSemuaPaket = product.harga_bundling.map(p => {
      const hp     = p.harga;
      const fee    = Math.ceil((hp + ongkirPromo) * 0.05);
      const tTF    = hp + ongkirPromo;
      const tCOD   = hp + ongkirPromo + fee;
      return `- Paket ${p.qty} box${p.prioritas ? ' ⭐' : ''}: TF total ${fmt(tTF)} | COD total ${fmt(tCOD)}`;
    }).join('\n');

    hargaSection = `Tampilkan HANYA paket PRIORITAS ini ke customer (jangan ubah angka):

Paket ${defaultPaket.qty} box ${product?.nama || 'Produk'}:
💳 Transfer: ${fmt(defaultHarga)} + ongkir ${ongkirDisplay} = TOTAL ${fmt(defaultTotalTF)}
📦 COD: ${fmt(defaultHarga)} + ongkir ${ongkirDisplay} + admin ${fmt(defaultFeeCOD)} = TOTAL ${fmt(defaultTotalCOD)}

Via ${hasil.ekspedisi} ya kak 🚗

Setelah tampilkan harga, tanya metode bayar: "Kakak enaknya COD atau Transfer? 😊"

PAKET LAIN (jangan sebut ke customer kecuali customer nanya ada paket/harga lain):
${tabelSemuaPaket}`;

  } else {
    // Produk tanpa bundling — tampilkan harga satuan normal
    hargaSection = `Tampilkan PERSIS ini ke customer (jangan ubah angka):

${product?.nama || 'Produk'} ${fmt(hasil.harga)}

💳 Transfer
${product?.nama || 'Produk'} ${fmt(hasil.harga)} + ongkir ${ongkirDisplay} = TOTAL ${fmt(hasil.totalTransfer)}

📦 COD
${product?.nama || 'Produk'} ${fmt(hasil.harga)} + ongkir ${ongkirDisplay} + admin ${fmt(hasil.feeCOD)} = TOTAL ${fmt(hasil.totalCOD)}

Via ${hasil.ekspedisi} ya kak 🚗

SETELAH tampilkan harga di atas, tanya dengan santai: "Biasanya kakak lebih suka pakai kurir apa kak? Bisa aku cekkan juga 😊"`;
  }

  return `[SISTEM] ${konteks}Ongkir sudah dihitung. Rekomendasi termurah: ${hasil.ekspedisi}.
${areaFull ? `Area yang dicocokkan sistem: ${areaFull}. Sebutkan nama area ini ke customer saat konfirmasi, contoh: "Oke kak, ongkir ke ${areaFull} ya 😊"` : ''}

${hargaSection}

DATA SEMUA KURIR TERSEDIA (untuk jawab kalau customer tanya kurir lain — jangan sebut ke customer kecuali ditanya):
${tabelKurir}

Kalau customer tanya harga kurir lain (misal "kalau JNE berapa?"), jawab langsung dari data di atas. Jangan bilang "sistem pilih otomatis".
Kalau customer MINTA kurir tertentu (misal "JNE aja", "pakai sicepat dong") → konfirmasi dan tampilkan total baru pakai kurir itu, lalu tulis marker [GANTI_KURIR:nama_kurir] di akhir pesan.
Contoh: "Oke kak, pakai JNE ya! Total Transfer Rp X / COD Rp Y 😊 [GANTI_KURIR:JNE]"`;
}

/* ── UPDATE CONVERSATION STATE ───────────────────────────── */
// ⚠️ CATATAN: Fungsi ini punya potensi race condition jika 2 request masuk bersamaan.
// Debounce 1500ms di handler utama sudah mitigasi sebagian besar kasus.
// Untuk fix penuh, perlu pakai Supabase RPC dengan jsonb_concat atau optimistic locking.
async function updateConvState(convId, stateUpdate) {
  // Ambil state sekarang dulu
  const existing = await sbGet('conversations', `?id=eq.${convId}&limit=1`);
  if (!existing.length) return;
  const currentState = existing[0].state || {};
  await sbPatch('conversations', `?id=eq.${convId}`, {
    state: { ...currentState, ...stateUpdate },
    last_msg_at: new Date().toISOString(),
  });
}

/* ── NOMOR URUT ORDER HARIAN ──────────────────────────────── */
async function getOrderNumber(userId) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const rows = await sbGet('conversations',
    `?user_id=eq.${userId}&status=eq.selesai&last_msg_at=gte.${today}T00:00:00Z&select=id`
  ).catch(() => []);
  return rows.length + 1; // +1 karena yang sekarang baru mau di-close
}

/* ── BUILD CLOSING RECAP MESSAGE ─────────────────────────── */
function buildClosingMessage({ nomorUrut, customer, alamat, ongkir, product, keluhan, metode, qty, csNama }) {
  const h          = ongkir?.harga      || 0;
  const ongkirAsli = ongkir?.ongkirAsli || 0;
  const ongkirPromo= ongkir?.ongkirPromo|| 0;
  const potongan   = ongkirAsli - ongkirPromo;
  const feeCOD     = ongkir?.feeCOD    || 0;
  const diskon     = 0;
  const ekspLabel  = (ongkir?.ekspedisi || 'KURIR').toUpperCase();
  const area       = ongkir?.area || {};
  const isCOD      = (metode || '').toLowerCase() !== 'transfer';
  const total      = isCOD ? (h + ongkirPromo + feeCOD) : (h + ongkirPromo);
  const no         = String(nomorUrut).padStart(2, '0');
  const cs         = (csNama || 'CS').toUpperCase();

  const formula = isCOD
    ? `${h}+${ongkirPromo}+${feeCOD}=${total}`
    : `${h}+${ongkirPromo}=${total}`;

  return `No. ${no}. ${ekspLabel}-MENG

Nama   : ${(customer?.nama || '').toUpperCase()}
No. Hp : ${customer?.wa_number || ''}
Alamat : ${(alamat || '-').toUpperCase()}|Pengirim CS ${cs}|${ongkirAsli}|${potongan}|${feeCOD}|${diskon}|${h}

${(area.kelurahan || '').toUpperCase()}
${(area.kecamatan || '').toUpperCase()}
${(area.kota      || '').toUpperCase()}
${(area.provinsi  || '').toUpperCase()}
${area.kodePos    || ''}

Jumlah pesanan: ${qty} ${(product?.nama || 'PRODUK').toUpperCase()}
Pembayaran: ${isCOD ? `COD ${ekspLabel}-MENG` : 'TRANSFER'}
Total pembayaran: ${formula}

${(product?.nama || 'PRODUK').toUpperCase()} ${qty} CS ${cs}

KELUHAN: ${keluhan || 'tidak disebutkan'}`.trim();
}

function buildCustomerConfirmMsg({ customer, alamat, area, qty, productNama, satuan, isCOD, ekspLabel, harga, ongkirAsli, ongkirPromo, feeCOD }) {
  const satuanLabel = satuan || 'pcs';
  const h  = harga       || 0;
  const op = ongkirPromo || 0;
  const oa = ongkirAsli  || op;
  const fc = isCOD ? (feeCOD || 0) : 0;
  const total = h + op + fc;

  const parts    = isCOD && fc > 0 ? [h, op, fc] : [h, op];
  const totalStr = `${parts.join('+')}=${total}`;

  return `✅ *Konfirmasi Order ${productNama || 'Produk'}*

*Nama:* ${customer?.nama || '-'}
*No. HP:* ${customer?.wa_number || '-'}
*Alamat:* ${alamat || '-'}

*Kelurahan/Desa:* ${area?.kelurahan || '-'}
*Kecamatan:* ${area?.kecamatan || '-'}
*Kabupaten:* ${area?.kota || '-'}
*Provinsi:* ${area?.provinsi || '-'}
*Kode Pos:* ${area?.kodePos || '-'}

*Jumlah Pesanan:* ${qty} ${satuanLabel} ${productNama || '-'}
*Pembayaran:* ${isCOD ? 'COD' : 'Transfer'} ${ekspLabel}
*Total Pembayaran:* ${totalStr}

Sudah bener kak? 😊`;
}

/* ── MAIN HANDLER ─────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  // Vercel body size config
  if (req.method === 'POST' && !req.body) {
    return res.status(400).json({ ok: false, reason: 'no_body' });
  }
  if (req.method === 'GET') return res.status(200).send('Webhook Baileys aktif ✅');
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = req.body || {};

    // Verifikasi secret
    console.log(`Secret check: body="${body.secret}" env="${WEBHOOK_SECRET}"`);
    if (body.secret !== WEBHOOK_SECRET) {
      console.warn('Secret tidak valid — tidak cocok');
      return res.status(200).json({ ok: false, reason: 'invalid_secret' });
    }

    const reply_jid   = body.reply_jid || normalizeWA(body.wa_number || ''); // untuk kirim WA (LID atau normal)
    const wa_number   = normalizeWA(body.wa_number || '');                  // nomor asli untuk disimpan ke customer
    const pushName    = body.push_name || wa_number;
    const msgId       = body.msg_id || null;  // WA message ID dari Baileys
    let message       = String(body.message || '').trim();
    const messageType = body.message_type || 'text';
    const mediaUrl    = body.media_url || null;
    const referral    = body.referral || null; // dari CTWA

    // ── Idempotency check: skip kalau msg_id sudah pernah diproses ──
    if (msgId) {
      const alreadyProcessed = await sbGet('conv_messages', `?wamid=eq.${encodeURIComponent(msgId)}&limit=1`);
      if (alreadyProcessed.length) {
        console.log(`[dedup] msg_id ${msgId} sudah diproses, skip`);
        return res.status(200).json({ ok: true, skipped: 'duplicate_msgid' });
      }
    }

    console.log(`wa_number="${wa_number}" reply_jid="${reply_jid}" message="${message}" type="${messageType}"`);
    if (!reply_jid || (!message && messageType === 'text')) {
      console.warn('wa_number atau message kosong');
      return res.status(200).json({ ok: false, reason: 'empty_message' });
    }

    console.log(`Pesan dari ${pushName} (${wa_number}): ${message.slice(0, 80)}`);

    // ── Resolve userId + product dari session_id ──────────────
    // Multi-WA: coba cari produk langsung via wa_session_id (1 WA = 1 produk)
    // Fallback: session_id = user_id (backward compat, produk pertama)
    const sessionId = body.session_id;
    if (!sessionId) {
      console.warn('session_id kosong');
      return res.status(200).json({ ok: false, reason: 'no_session_id' });
    }
    let userId, product, sumber;
    const prodBySession = await sbGet('products',
      `?wa_session_id=eq.${encodeURIComponent(sessionId)}&aktif=eq.true&limit=1`
    ).catch(() => []);
    if (prodBySession.length) {
      product = prodBySession[0];
      userId  = product.user_id;
      sumber  = 'inbound';
      // Deteksi CTWA
      if (referral?.ad_id || referral?.headline) {
        const identifier = referral.ad_id || referral.headline;
        const mapping = await sbGet('ad_mapping',
          `?user_id=eq.${userId}&identifier=eq.${encodeURIComponent(identifier)}&aktif=eq.true&limit=1`
        ).catch(() => []);
        if (mapping.length) sumber = 'ctwa';
      }
      console.log(`[multi-wa] produk "${product.nama}" via wa_session_id`);
    } else {
      // Fallback lama: session_id = user_id
      userId = sessionId;
      const resolved = await resolveProduct(userId, referral, message);
      product = resolved.product;
      sumber  = resolved.sumber;
    }

    // session WA yang dipakai untuk kirim balas (wa_session_id produk, fallback ke userId)
    const waSession = product?.wa_session_id || userId;

    // ── Ambil rekening dari users table ───────────────────────
    const userRows = await sbGet('users', `?id=eq.${userId}&select=rekening,anthropic_key,group_jid,default_sumber&limit=1`).catch(() => []);
    const userRekening      = userRows[0]?.rekening      || null;
    const userAnthropicKey  = userRows[0]?.anthropic_key || ANTHROPIC_KEY;
    const userGroupJid      = userRows[0]?.group_jid     || WA_GROUP_JID;
    const userDefaultSumber = userRows[0]?.default_sumber || null;
    console.log(`Produk: ${product?.nama || 'tidak diketahui'} (${sumber})`);

    // Model AI: jika user set default_sumber di settings → pakai model sesuai itu
    // (semua chat dianggap tipe yang dipilih user, override deteksi otomatis)
    const MODEL_SONNET = 'claude-sonnet-4-6';
    const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';
    const defaultModel = { ctwa: MODEL_HAIKU, form: MODEL_SONNET, inbound: MODEL_SONNET };
    const effectiveSumber = userDefaultSumber || sumber;
    const chatModel = defaultModel[effectiveSumber] || MODEL_SONNET;

    // ── Deteksi leads dari form web (pesan mengandung "isi form" + nama) ───
    let sumberFinal = sumber;
    const isFormLead = /isi form|sudah isi|formulir|form pemesanan|form order/i.test(message);
    let namaFromForm = null;
    if (isFormLead) {
      sumberFinal = 'form';
      // Extract nama: "atas nama X", "nama saya X", "nama: X"
      const namaMatch = message.match(/atas nama\s+([A-Za-z\s]+?)(?:[,.\n]|$)/i)
        || message.match(/nama saya\s+([A-Za-z\s]+?)(?:[,.\n]|$)/i)
        || message.match(/nama\s*[:=]\s*([A-Za-z\s]+?)(?:[,.\n]|$)/i);
      if (namaMatch) namaFromForm = namaMatch[1].trim();
      console.log(`[form lead] detected — nama: ${namaFromForm || '(tidak terdeteksi)'}`);
    }

    // ── Find/create customer & conversation ───────────────────
    const customer = await findOrCreateCustomer(userId, wa_number, namaFromForm || pushName, reply_jid);

    // Update nama dari form kalau lebih lengkap dari push_name
    if (namaFromForm && namaFromForm !== customer.nama) {
      await sbPatch('customers', `?id=eq.${customer.id}`, { nama: namaFromForm }).catch(() => {});
      customer.nama = namaFromForm;
      console.log(`[form lead] Update nama customer: ${namaFromForm}`);
    }

    // Simpan reply_jid (bisa berupa LID format seperti 224029940129807@lid)
    // supaya CS dari dashboard bisa kirim ke JID yang benar
    if (reply_jid && reply_jid !== customer.reply_jid) {
      await sbPatch('customers', `?id=eq.${customer.id}`, { reply_jid }).catch(() => {});
      customer.reply_jid = reply_jid;
    }

    const conversation = await findOrCreateConversation(userId, customer.id, sumberFinal, product?.id);

    // Update produk ke conversation jika baru ketemu
    if (product?.id && !conversation.product_id) {
      await sbPatch('conversations', `?id=eq.${conversation.id}`, { product_id: product.id });
    }

    // ── Transcribe voice note jika ada (Groq Whisper) ─────────
    if (messageType === 'audio' && mediaUrl) {
      const transkripsi = await transcribeAudio(mediaUrl);
      // Cek apakah hasil transkripsi bermakna (bukan noise)
      // Noise = tidak ada huruf/angka sama sekali, ATAU terlalu banyak huruf berulang (5+ kali, >5 kemunculan)
      const isNoise = !transkripsi || transkripsi.trim().length < 3
        || /^[^a-zA-Z0-9\u00C0-\u024F\u4E00-\u9FFF\u0600-\u06FF]*$/.test(transkripsi)
        || (transkripsi.match(/([a-zA-Z])\1{4,}/g) || []).length > 5; // huruf berulang 5+ kali, >5 kemunculan

      if (transkripsi && !isNoise) {
        console.log(`VN transcribed: ${transkripsi.slice(0, 80)}`);
        message = `[SISTEM: Customer kirim voice note, isi: "${transkripsi}". Balas sesuai isi voice note tersebut, jangan bilang tidak bisa dengar VN.]`;
      } else {
        console.log(`VN noise/gagal: ${transkripsi}`);
        message = `[SISTEM: Customer kirim voice note tapi isinya tidak jelas/noise. Minta customer kirim ulang VN-nya atau ketik pesannya.]`;
      }
    }

    // ── Handle sticker, video, dokumen, dan media lain ─────────
    if (messageType === 'sticker') {
      message = `[SISTEM: Customer kirim sticker. Balas dengan ramah dan lanjutkan percakapan, jangan bilang tidak bisa lihat sticker.]`;
    } else if (messageType === 'video') {
      message = `[SISTEM: Customer kirim video. Tanya dengan ramah apa isi videonya atau minta jelaskan dalam bentuk teks/foto.]`;
    } else if (messageType === 'document') {
      message = `[SISTEM: Customer kirim dokumen/file. Tanya dengan ramah isi dokumennya apa, karena sistem tidak bisa baca dokumen.]`;
    } else if (messageType === 'location') {
      // Location biasanya sudah di-handle via Google Maps URL, tapi kalau native location:
      if (!message || message === '[location]') {
        message = `[SISTEM: Customer kirim lokasi. Konfirmasi nama kota/kecamatannya untuk cek ongkir.]`;
      }
    }

    // ── Analisa gambar jika ada (Claude Vision) ────────────────
    let imageAnalysis = null;
    if (messageType === 'image' && mediaUrl && mediaUrl.startsWith('data:image')) {
      try {
        // Deteksi media type dari data URL (jpeg, png, webp, gif) — case-insensitive
        const mediaTypeMatch = mediaUrl.match(/^data:image\/([a-z0-9]+);base64,/i);
        const imageFormat = (mediaTypeMatch?.[1] || 'jpeg').toLowerCase();
        const mediaType = `image/${imageFormat}`;
        const base64Data = mediaUrl.replace(/^data:image\/[a-z0-9]+;base64,/i, '');

        const visionRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mediaType, data: base64Data },
                },
                {
                  type: 'text',
                  text: `Analisa gambar ini. Kemungkinan tipenya:
1. KTP (Kartu Tanda Penduduk) Indonesia
2. Gambar produk / foto unboxing / testimoni
3. Lainnya

Jawab dalam format JSON:
{
  "tipe": "ktp" atau "foto_produk" atau "lainnya",
  "keterangan": "penjelasan singkat isi gambar",
  "ktp": {
    "nama": "nama lengkap di KTP",
    "kota": "kota atau kabupaten"
  }
}

Field "ktp" hanya diisi jika tipe = "ktp", selainnya null.`,
                },
              ],
            }],
          }),
        }, 20000); // 20 detik untuk vision analysis
        const visionData = await visionRes.json();
        const raw = visionData.content?.[0]?.text || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) imageAnalysis = JSON.parse(jsonMatch[0]);
        console.log('Image analysis:', JSON.stringify(imageAnalysis));
      } catch(e) {
        console.error('Vision error:', e.message);
      }
    }

    // ── Simpan pesan masuk ─────────────────────────────────────
    const msgText = message || (imageAnalysis
      ? imageAnalysis.tipe === 'ktp'
        ? `[KTP terkirim — ${imageAnalysis.ktp?.nama || 'nama tidak terbaca'}]`
        : `[Gambar terkirim — ${imageAnalysis.keterangan || messageType}]`
      : `[${messageType}]`);
    const savedMsg = await saveMessage(conversation.id, 'customer', msgText, msgId);
    const savedMsgId = savedMsg?.[0]?.id;

    // ── Debounce: kalau customer kirim 2+ pesan cepat, proses hanya yang terakhir ──
    // 2500ms cukup untuk menangkap ketikan cepat berturut-turut
    await new Promise(r => setTimeout(r, 2500));
    if (savedMsgId) {
      const latestMsg = await sbGet('conv_messages',
        `?conversation_id=eq.${conversation.id}&role=eq.customer&order=created_at.desc&limit=1`
      );
      if (latestMsg[0]?.id && latestMsg[0].id !== savedMsgId) {
        console.log(`Debounce: ada pesan lebih baru (${latestMsg[0].id}), skip`);
        return res.status(200).json({ ok: true, skipped: 'debounced' });
      }
    }

    // ── Cek apakah sudah eskalasi → AI diam, CS manusia yang balas ──
    if (conversation.status === 'eskalasi') {
      console.log(`Conversation ${conversation.id} status eskalasi — AI skip, tunggu CS manusia`);
      // Tetap update last_msg_at agar inbox sort benar
      await sbPatch('conversations', `?id=eq.${conversation.id}`, {
        last_msg_at: new Date().toISOString(),
      }).catch(() => {});
      return res.status(200).json({ ok: true, skipped: 'eskalasi' });
    }

    // ── State conversation ────────────────────────────────────
    const convState = conversation.state || {};

    // ── Build system prompt + inject ringkasan ────────────────
    let systemPrompt = buildTemplatePrompt(product, customer, conversation, sumber, userRekening);

    // Inject data customer ke system prompt
    {
      let ctx = '\n\nDATA CUSTOMER:';
      ctx += `\n- No HP/WA: ${wa_number}`;
      if (customer?.nama && customer.nama !== wa_number) ctx += `\n- Nama: ${customer.nama}`;
      if (customer?.produk) ctx += `\n- Produk dibeli: ${customer.produk}`;
      if (customer?.tgl_delivered) ctx += `\n- Tgl delivered: ${new Date(customer.tgl_delivered).toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' })}`;
      if (customer?.catatan) ctx += `\n- Catatan: ${customer.catatan}`;
      if (convState.repeat_order) ctx += `\n- Sudah melakukan repeat order ✅`;
      systemPrompt += ctx;
    }

    if (conversation.ringkasan) {
      systemPrompt += `\n\nKONTEKS PERCAKAPAN SEBELUMNYA (ringkasan otomatis)\n${conversation.ringkasan}\n\nLanjutkan percakapan dari konteks ini. Jangan ulangi salam dari awal.`;
    }

    // ── Ambil pesan terakhir ──────────────────────────────────
    const historyLimit = conversation.ringkasan ? 10 : 20;
    const history = await getContextMessages(conversation.id, null, historyLimit);

    // ── Inject hasil analisa gambar ke history ────────────────
    if (imageAnalysis) {
      let notif;
      if (imageAnalysis.tipe === 'ktp') {
        const ktp = imageAnalysis.ktp || {};
        notif = `[SISTEM] Customer kirim foto KTP.\nNama: ${ktp.nama || '?'} | Kota: ${ktp.kota || '?'}\nSampaikan bahwa data sudah tercatat dan lanjutkan percakapan dengan natural.`;
        if (ktp.nama && ktp.nama !== customer.nama) {
          await sbPatch('customers', `?id=eq.${customer.id}`, { nama: ktp.nama });
        }
      } else {
        notif = `[SISTEM] Customer kirim gambar. ${imageAnalysis.keterangan ? `Keterangan: ${imageAnalysis.keterangan}.` : ''} Tanggapi dengan natural.`;
      }
      history.push({ role: 'user', content: notif });
    }

    // Safety: pastikan history tidak berakhir dengan assistant sebelum call Claude
    if (!history.length || history[history.length - 1].role === 'assistant') {
      history.push({ role: 'user', content: message || '[pesan customer]' });
    }

    const rawReply = await callClaude(systemPrompt, history, chatModel, userAnthropicKey);
    if (!rawReply) return res.status(200).json({ ok: true, skipped: 'no_reply' });

    // ── Handle [REPEAT_ORDER_CONFIRMED:qty=N] ─────────────────
    const repeatMatch = rawReply.match(/\[REPEAT_ORDER_CONFIRMED:qty=(\d+)\]/i);
    if (repeatMatch) {
      const qty = parseInt(repeatMatch[1]) || 1;
      try {
        await sbPost('repeat_orders', {
          user_id:         userId,
          customer_id:     customer.id,
          conversation_id: conversation.id,
          product_id:      product?.id || null,
          qty,
          alamat:          customer.alamat || null,
          status:          'pending',
          customer_nama:   customer.nama  || '',
          customer_phone:  wa_number,
          product_nama:    product?.nama  || '',
        });
        await updateConvState(conversation.id, {
          repeat_order: true,
          repeat_qty:   qty,
          repeat_at:    new Date().toISOString(),
        });
        console.log(`[REPEAT_ORDER] Saved: ${customer.nama} × ${qty}`);

        // Notif ke grup WA
        if (userGroupJid) {
          const tgl = new Date().toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' });
          const alamatStr = customer.alamat
            ? [customer.alamat.jalan, customer.alamat.kelurahan, customer.alamat.kecamatan,
               customer.alamat.kabupaten, customer.alamat.provinsi].filter(Boolean).join(', ')
            : '-';
          const notif = `🔄 *REPEAT ORDER*\n\n👤 ${customer.nama || wa_number}\n📦 ${product?.nama || '-'} × ${qty}\n📍 ${alamatStr}\n📞 ${wa_number}\n📅 ${tgl}`;
          await sendWA(waSession, userGroupJid, notif, true).catch(() => {});
        }
      } catch(e) {
        console.error('[REPEAT_ORDER] Error:', e.message);
      }
    }

    // Bersihkan marker dari reply
    const reply = rawReply
      .replace(/\[REPEAT_ORDER_CONFIRMED:qty=\d+\]/gi, '')
      .replace(/\[SISTEM[^\]]*\]/g, '')
      .trim();

    if (!reply) return res.status(200).json({ ok: true, skipped: 'empty_reply' });

    console.log(`Reply untuk ${wa_number}: ${reply.slice(0, 80)}`);

    // ── Simpan & kirim balasan ────────────────────────────────
    // ── Auto-kirim gambar produk kalau customer tanya foto ────
    const tanyaFoto = /\b(foto|gambar|pic|photo|tampilan|bentuk|wujud|lihat produk|gambarnya|fotonya|kirim dong|kirimnya|mana fotonya|mana gambarnya|belum terkirim|belum muncul|kirim ulang|kirim lagi)\b/i.test(message);
    const adaGambarProduk = product?.gambar_url;
    const sudahKirimFoto  = convState.foto_terkirim;

    if (tanyaFoto) console.log(`[FOTO] adaGambar=${!!adaGambarProduk} url=${adaGambarProduk||'null'}`);

    // Kirim teks reply dulu — capture wamid untuk fitur edit/hapus
    const { wamid: wamid_reply } = await sendWA(waSession, reply_jid, reply).catch(()=>({}));
    await saveMessage(conversation.id, 'ai', reply, wamid_reply);

    // Kalau customer tanya foto dan ada gambar produk → selalu kirim (tidak peduli sudah pernah)
    if (tanyaFoto && adaGambarProduk) {
      await new Promise(r => setTimeout(r, 800));
      try {
        const manfaat = (() => {
          // Prioritas 1: keluhan_cocok array
          if (Array.isArray(product.keluhan_cocok) && product.keluhan_cocok.length)
            return product.keluhan_cocok.slice(0, 3).join(' • ');
          // Prioritas 2: cari baris manfaat/kegunaan di product_knowledge
          if (product.product_knowledge) {
            const lines = product.product_knowledge.split('\n').map(l => l.trim()).filter(Boolean);
            // Cari section manfaat/kegunaan/khasiat
            let inManfaat = false;
            const bullets = [];
            for (const line of lines) {
              if (/manfaat|kegunaan|khasiat|fungsi|benefit/i.test(line)) { inManfaat = true; continue; }
              if (inManfaat && /^[-•✅*\d]/.test(line)) {
                bullets.push(line.replace(/^[-•✅*\d.)\s]+/, '').slice(0, 50));
                if (bullets.length >= 3) break;
              }
              if (inManfaat && line.length < 3) break; // baris kosong = section selesai
            }
            if (bullets.length) return bullets.join(' • ');
            // Fallback: ambil semua baris yang ada bullet
            const allBullets = lines
              .filter(l => /^[-•✅*]/.test(l))
              .map(l => l.replace(/^[-•✅*\s]+/, '').slice(0, 50))
              .slice(0, 3);
            if (allBullets.length) return allBullets.join(' • ');
          }
          return '';
        })();
        const caption = manfaat ? `${product.nama} bermanfaat untuk mengatasi:\n\n✅ ${manfaat}` : product.nama;
        console.log(`[FOTO] caption="${caption}"`);
        await sendWA(waSession, reply_jid, null, false, product.gambar_url, caption);
        await updateConvState(conversation.id, { foto_terkirim: true });
        console.log(`[FOTO] Gambar terkirim: ${product.gambar_url}`);
      } catch(e) {
        console.error(`[FOTO] Gagal kirim gambar:`, e.message);
      }
    }

    // ── Auto-kirim foto testimoni kalau customer minta bukti/review ────
    const tanyaTestimoni = /\b(testimoni|testi|bukti|review|hasil|nyata|beneran|real|ada yang sudah|yang udah pakai|yang sudah pakai|ada hasilnya|ada fotonya|foto hasilnya|foto buktinya|sebelum sesudah|before after|ada reviewnya|ada buktiny)\b/i.test(message);
    const testiList = Array.isArray(product?.testimoni_urls) ? product.testimoni_urls.filter(Boolean) : [];
    const sudahKirimTesti = convState.testimoni_terkirim;

    if (tanyaTestimoni && testiList.length > 0 && !sudahKirimTesti) {
      await new Promise(r => setTimeout(r, 800));
      try {
        for (let i = 0; i < testiList.length; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, 500));
          const caption = i === 0 ? `Ini testimoni dari customer kami kak 😊` : null;
          await sendWA(waSession, reply_jid, null, false, testiList[i], caption);
        }
        await updateConvState(conversation.id, { testimoni_terkirim: true });
        console.log(`[TESTI] ${testiList.length} foto testimoni terkirim`);
      } catch(e) {
        console.error(`[TESTI] Gagal kirim testimoni:`, e.message);
      }
    }

    // ── Update ringkasan berjalan (setiap 5 pesan) ──
    try {
      const allMsgs = await sbGet('conv_messages', `?conversation_id=eq.${conversation.id}&select=id`);
      if (allMsgs.length % 4 === 0) await updateRingkasan(conversation.id);
    } catch(e) {
      console.error('Ringkasan error:', e.message);
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook error:', err.message, err.stack);
    if (!res.headersSent) res.status(200).json({ ok: true, error: err.message });
  }
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};
