// api/followup-sender.js — cron job: kirim FU otomatis tiap jam
// Setup cron VPS: tiap jam → curl POST /api/followup-sender
// Header: x-cron-secret: adsysukses2026
//
// Anti-ban features:
// 1. Smart timing     — tiap customer punya jam kirim optimal (belajar dari response)
// 2. Spread window    — tiap customer dapat slot menit random dalam 2 jam → tidak barengan
// 3. AI auto-vary     — Claude Haiku rephrase template → tiap pesan unik, tidak mirip
// 4. Random delay     — 5-15 detik antar kirim → tidak kelihatan bot
// 5. Max per run      — maks 20 pesan per jam → tidak blasting massal
// 6. Auto-label       — customer yang tidak balas 3x FU → label tidak_responsif, di-skip otomatis

const SB_URL      = process.env.SUPABASE_URL;
const SB_KEY      = process.env.SUPABASE_SERVICE_KEY;
const BAILEYS     = process.env.BAILEYS_URL || 'http://13.140.178.4:3000';
const SECRET      = process.env.WEBHOOK_SECRET || 'adsysukses2026';
const CRON_SECRET = process.env.CRON_SECRET || 'adsysukses2026';

const DEFAULT_SEND_HOUR  = 9;   // jam 9 WIB default
const MIN_RESPONSES      = 2;   // minimal balas sebelum pakai smart timing
const SPREAD_WINDOW_H    = 2;   // spread dalam 2 jam dari jam target
const MAX_PER_RUN        = 20;  // maks kirim per jam
const DELAY_MIN_MS       = 5000;  // delay min antar pesan (5 detik)
const DELAY_MAX_MS       = 15000; // delay max antar pesan (15 detik)
const MAX_NO_REPLY       = 3;   // maks FU berturut-turut tanpa balas → auto tidak_responsif

async function sb(table, params = '', opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${params ? '?' + params : ''}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || (opts.method === 'POST' ? 'return=representation' : 'return=minimal')
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

async function sendWA(sessionId, to, text, imageUrl = null) {
  const r = await fetch(`${BAILEYS}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: SECRET,
      session_id: sessionId,
      wa_number: to,
      message: imageUrl ? undefined : (text || ''),
      image_url: imageUrl || undefined,
      caption: imageUrl ? (text || undefined) : undefined,
    }),
    signal: AbortSignal.timeout(30000)
  });
  const d = await r.json();
  if (!d.success && !d.ok) throw new Error(d.error || 'WA send failed');
  return d;
}

async function getAnthropicKey(userId) {
  const rows = await sb('users', `id=eq.${userId}&select=anthropic_key`);
  return rows[0]?.anthropic_key || process.env.ANTHROPIC_KEY;
}

// AI auto-vary: rephrase pesan supaya tiap customer dapat kalimat unik
async function rephraseWithAI(text, apiKey) {
  if (!apiKey || !text) return text;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'Kamu adalah asisten yang menulis ulang pesan WhatsApp. Tugasmu hanya menulis ulang pesan yang diberikan dengan kalimat yang sedikit berbeda tapi makna dan informasinya tetap sama persis. Jangan tambah atau kurangi informasi apapun. Jangan ubah nama, nomor, resi, atau data spesifik. Balas HANYA dengan teks pesan barunya saja, tanpa penjelasan, tanpa tanda kutip.',
      messages: [{
        role: 'user',
        content: `Tulis ulang pesan WA ini:\n\n${text}`
      }]
    });
    return msg.content[0].text.trim();
  } catch(e) {
    return text;
  }
}

// Re-engagement: ubah pesan menjadi versi yang memancing balasan
// Untuk customer yang sudah beberapa kali tidak membalas FU
async function reEngageWithAI(text, customer, noReplyCount, apiKey) {
  if (!apiKey) return text;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    // Pilih strategi berdasarkan sudah berapa kali tidak balas
    const strategies = [
      'Ubah menjadi pertanyaan singkat yang mudah dijawab (1-2 kata cukup). Contoh: tanya kabar produk dengan "Masih oke Kak?" atau "Gimana produknya Kak?"',
      'Buat sangat casual dan personal, seolah teman lama yang menyapa. Max 1 kalimat + 1 pertanyaan pendek.',
      'Mulai dengan pengakuan tidak enak ganggu, lalu sampaikan inti pesan dalam 1 kalimat saja. Buat terasa manusiawi.',
    ];
    const strategy = strategies[Math.min(noReplyCount - MAX_NO_REPLY, strategies.length - 1)];

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: `Kamu menulis ulang pesan WhatsApp untuk customer yang sudah ${noReplyCount}x tidak membalas pesan sebelumnya. Tujuan: buat pesan yang lebih mungkin dibalas. ${strategy} Jangan ubah nama atau data spesifik. Balas HANYA teks pesannya.`,
      messages: [{
        role: 'user',
        content: `Customer: ${customer.nama || 'Kak'}, produk: ${customer.produk || 'produk'}.\n\nPesan asli:\n${text}\n\nTulis versi re-engagement-nya:`
      }]
    });
    return msg.content[0].text.trim();
  } catch(e) {
    return text;
  }
}

async function generatePesan(rule, customer, order, apiKey, reEngage = false) {
  const hari = rule.hari_sebelum_deliv ?? rule.hari_setelah_delivered ?? '';
  const templates = rule.templates || [];

  if (templates.length) {
    const tmpl      = templates[Math.floor(Math.random() * templates.length)];
    const rawText   = (typeof tmpl === 'object' && tmpl) ? (tmpl.text || '') : (tmpl || '');
    const image_url = (typeof tmpl === 'object' && tmpl) ? (tmpl.image_url || null) : null;

    // Isi variabel dulu
    const filled = rawText
      .replace(/{nama}/g,        customer.nama         || 'Kak')
      .replace(/{produk}/g,      customer.produk       || order?.produk || 'produk')
      .replace(/{hari}/g,        hari)
      .replace(/{resi}/g,        order?.nomer_resi     || '-')
      .replace(/{ekspedisi}/g,   order?.ekspedisi      || '-')
      .replace(/{status_resi}/g, order?.status_resi    || '-')
      .replace(/{alamat}/g,      order?.alamat         || '-');

    // Re-engagement mode: gunakan strategi khusus memancing balasan
    // Fallback ke rephrase biasa kalau tidak ada API key
    let text;
    if (reEngage && filled.length > 20) {
      text = await reEngageWithAI(filled, customer, customer.fu_no_reply_count || MAX_NO_REPLY, apiKey);
    } else if (filled.length > 20) {
      text = await rephraseWithAI(filled, apiKey);
    } else {
      text = filled;
    }
    return { text, image_url };
  }

  // Fallback: AI generate full
  if (!apiKey) return null;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const prompt = reEngage
    ? `Buat 1 pesan WA singkat yang memancing balasan untuk customer ${customer.nama || 'Kak'} yang beli ${customer.produk || 'produk'} — dia sudah ${customer.fu_no_reply_count || MAX_NO_REPLY}x tidak balas pesan sebelumnya. Ini pesan reorder reminder. Buat pertanyaan yang mudah dijawab, max 2 kalimat. Balas hanya teks pesannya.`
    : `Buat 1 pesan follow-up WA singkat (max 2 kalimat) untuk customer ${customer.nama || 'Kak'} yang beli ${customer.produk || 'produk'}, ini hari ke-${rule.hari_setelah_delivered} setelah barang diterima. Balas hanya teks pesannya.`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }]
  });
  return { text: msg.content[0].text.trim(), image_url: null };
}

function nowWIBHour() {
  const now = new Date();
  return ((now.getUTCHours() + 7) % 24) + (now.getUTCMinutes() / 60);
}

// Assign slot menit random untuk customer baru (0 s/d SPREAD_WINDOW_H*60 menit)
// Disimpan di DB supaya konsisten tiap hari
function getSpreadSlot(customer) {
  if (customer.send_minute_slot != null) return customer.send_minute_slot;
  // Belum ada → assign random, akan disimpan saat update customer
  return Math.floor(Math.random() * SPREAD_WINDOW_H * 60);
}

function shouldSendNow(customer, scheduledDate, today) {
  // Jadwal hari ini → kirim langsung di cron berikutnya (max 1 jam tunggu)
  if (scheduledDate === today) return true;

  // Jadwal hari lain yang sudah tiba → pakai smart timing (jam 9 WIB)
  const currentHour = nowWIBHour();
  const targetHour  = (customer.response_count >= MIN_RESPONSES && customer.optimal_send_hour != null)
    ? customer.optimal_send_hour
    : DEFAULT_SEND_HOUR;

  // Spread: tambahkan slot menit customer ke jam target
  const slot        = getSpreadSlot(customer);
  const spreadHour  = targetHour + (slot / 60);

  // Kirim kalau jam sekarang dalam window ±30 menit dari spread target
  const diff = Math.abs(currentHour - spreadHour);
  return diff <= 0.5; // ±30 menit
}

function randomDelay() {
  const ms = Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1)) + DELAY_MIN_MS;
  return new Promise(r => setTimeout(r, ms));
}

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'];
  if (secret !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).end();

  const today     = new Date().toISOString().slice(0, 10);
  const forceMode = req.query.force === 'true' || req.body?.force === true;
  const results   = { sent: 0, failed: 0, skipped: 0, skipped_timing: 0, details: [], force: forceMode };

  try {
    const schedules = await sb('followup_schedule',
      `scheduled_date=lte.${today}&status=eq.pending` +
      `&select=*,customers(nama,wa_number,produk,product_id,optimal_send_hour,response_count,send_minute_slot,fu_status,fu_no_reply_count,fu_sent_count)` +
      `,followup_rules(nama,templates,hari_setelah_delivered,hari_sebelum_deliv,buffer_reorder_hari,tipe)`);

    if (!schedules.length) {
      return res.json({ ...results, message: 'Tidak ada jadwal hari ini' });
    }

    // Shuffle supaya tiap run tidak selalu customer yang sama duluan
    const shuffled = schedules.sort(() => Math.random() - 0.5);

    let sentCount = 0;

    for (const s of shuffled) {
      // Maks per run
      if (sentCount >= MAX_PER_RUN) break;

      const customer = s.customers;
      const rule     = s.followup_rules || {};

      if (!customer?.wa_number) {
        await sb('followup_schedule', `id=eq.${s.id}`, { method: 'PATCH', body: { status: 'skipped' } });
        results.skipped++;
        continue;
      }

      // Blacklist: stop permanent (set manual oleh CS)
      if (customer.fu_status === 'blacklist') {
        await sb('followup_schedule', `id=eq.${s.id}`, { method: 'PATCH', body: { status: 'skipped' } });
        results.skipped++;
        results.details.push({ customer: customer.nama, status: 'skipped', reason: 'blacklist' });
        continue;
      }

      // Tidak responsif: kurangi intensitas — skip semua rule KECUALI reorder
      // Reorder tetap dikirim karena relevan (produk mau habis) tapi pakai pesan re-engagement
      if (customer.fu_status === 'tidak_responsif' && !forceMode) {
        const ruleType = rule?.tipe || 'setelah_deliv';
        if (ruleType !== 'reorder') {
          await sb('followup_schedule', `id=eq.${s.id}`, { method: 'PATCH', body: { status: 'skipped' } });
          results.skipped++;
          results.details.push({ customer: customer.nama, status: 'skipped', reason: 'tidak_responsif_reduced' });
          continue;
        }
        // Reorder rule → lanjut tapi tandai sebagai re-engagement
      }

      // Smart timing + spread: skip kalau belum waktunya (bypass kalau force mode)
      if (!forceMode && !shouldSendNow(customer, s.scheduled_date, today)) {
        results.skipped_timing++;
        continue;
      }

      try {
        const apiKey = await getAnthropicKey(s.user_id);

        const orders = await sb('orders',
          `nomer_hp=eq.${customer.wa_number}&user_id=eq.${s.user_id}&order=created_at.desc&limit=1&select=produk,nomer_resi,ekspedisi,status_resi,alamat`
        ).catch(() => []);
        const order = orders[0] || null;

        // Skip rule sebelum_deliv kalau paket sudah SAMPAI — pesan "dalam perjalanan" tidak relevan
        if (rule?.tipe === 'sebelum_deliv' && order?.status_resi === 'SAMPAI') {
          await sb('followup_schedule', `id=eq.${s.id}`, { method: 'PATCH', body: { status: 'skipped' } });
          results.skipped++;
          results.details.push({ customer: customer.nama, status: 'skipped', reason: 'sudah_sampai' });
          continue;
        }

        const reEngage = customer.fu_status === 'tidak_responsif';
        const hasil = await generatePesan(rule, customer, order, apiKey, reEngage);
        if (!hasil) {
          await sb('followup_schedule', `id=eq.${s.id}`, { method: 'PATCH', body: { status: 'skipped' } });
          results.skipped++;
          continue;
        }
        const { text: pesan, image_url: pesanImage } = hasil;

        let sessionId = s.user_id;
        if (customer.product_id) {
          const prod = await sb('products', `id=eq.${customer.product_id}&select=wa_session_id`);
          sessionId = prod[0]?.wa_session_id || s.user_id;
        }

        await sendWA(sessionId, customer.wa_number, pesan, pesanImage || null);

        // Buat / update conversation
        let convs = await sb('conversations',
          `user_id=eq.${s.user_id}&customer_id=eq.${s.customer_id}&status=neq.selesai&limit=1`);
        let convId;

        // Context FU untuk diinject ke state conversation — dipakai webhook saat customer balas
        const hariNum = rule.tipe === 'sebelum_deliv' ? rule.hari_sebelum_deliv
          : rule.tipe === 'reorder' ? rule.buffer_reorder_hari
          : rule.hari_setelah_delivered;
        const fuContext = {
          fu_rule_nama: rule.nama || s.rule_nama || null,
          fu_tipe:      rule.tipe || 'setelah_deliv',
          fu_hari:      hariNum ?? null,
          fu_sent_at:   new Date().toISOString(),
        };

        if (convs.length) {
          convId = convs[0].id;
          // Merge fu_context ke state yang sudah ada
          const prevState = convs[0].state || {};
          await sb('conversations', `id=eq.${convId}`, {
            method: 'PATCH',
            body: { updated_at: new Date().toISOString(), state: { ...prevState, ...fuContext } }
          });
        } else {
          const newConv = await sb('conversations', '', {
            method: 'POST',
            body: { user_id: s.user_id, customer_id: s.customer_id, product_id: customer.product_id || null, status: 'baru', sumber: 'fu', state: fuContext }
          });
          convId = newConv[0].id;
        }

        const isiLog = pesanImage ? `[Gambar] ${pesan}` : pesan;
        await sb('conv_messages', '', {
          method: 'POST', prefer: 'return=minimal',
          body: { conversation_id: convId, isi: isiLog, role: 'ai' }
        });

        // Simpan send_minute_slot kalau belum ada
        const slotUpdate = customer.send_minute_slot == null
          ? { send_minute_slot: getSpreadSlot(customer) }
          : {};

        // Hitung counter baru
        const newNoReplyCount = (customer.fu_no_reply_count || 0) + 1;
        const newSentCount    = (customer.fu_sent_count || 0) + 1;
        // Auto-label tidak_responsif kalau sudah MAX_NO_REPLY kali tanpa balas
        const autoStatus = newNoReplyCount >= MAX_NO_REPLY ? 'tidak_responsif' : 'aktif';

        await Promise.all([
          sb('followup_schedule', `id=eq.${s.id}`, {
            method: 'PATCH', body: { status: 'sent', sent_at: new Date().toISOString(), pesan_terkirim: isiLog }
          }),
          sb('customers', `id=eq.${s.customer_id}`, {
            method: 'PATCH', body: {
              last_fu_at:         new Date().toISOString(),
              status:             'fu_aktif',
              fu_status:          autoStatus,
              fu_no_reply_count:  newNoReplyCount,
              fu_sent_count:      newSentCount,
              ...slotUpdate
            }
          })
        ]);

        results.sent++;
        sentCount++;
        results.details.push({ customer: customer.nama, status: 'sent' });
      } catch(e) {
        await sb('followup_schedule', `id=eq.${s.id}`, { method: 'PATCH', body: { status: 'failed' } });
        results.failed++;
        results.details.push({ customer: customer?.nama, status: 'failed', error: e.message });
      }

      // Random delay 5-15 detik antar kirim
      await randomDelay();
    }

    return res.json(results);
  } catch(e) {
    return res.status(500).json({ error: e.message, ...results });
  }
}
