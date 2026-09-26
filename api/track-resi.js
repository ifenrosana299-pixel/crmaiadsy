const { trackShipment, trackPos } = require('../lib/mengantar');

const COURIER_MAP = {
  'JNE': 'JNE', 'JNT': 'JT', 'JT': 'JT', 'J&T': 'JT',
  'SICEPAT': 'SiCepat', 'SICE': 'SiCepat',
  'ANTERAJA': 'anteraja', 'ANTER': 'anteraja',
  'NINJA': 'Ninja',
  'SAP': 'SAP',
  'LION': 'lion', 'LIONPARCEL': 'lion',
  'TIKI': 'tiki',
  'IDEXPRESS': 'iDexpress', 'IDEX': 'iDexpress',
  'REX': 'rex',
  'GRAB': 'grab',
  'GOJEK': 'gojek', 'GOSEND': 'gojek',
  'NINJAXPRESS': 'Ninja',
};

const RETUR_PATTERN   = /retur|dikembalikan|\brts\b|\brto\b|return to sender/i;
const PROBLEM_PATTERN = /gagal|kendala|bermasalah|tidak ditemukan|alamat tidak (lengkap|dikenal)|tidak ada orang|tidak ditempat|tidak dihuni|menunggu konfirmasi|disimpan di gudang|ditolak|pindah alamat|box undel/i;
const OTW_PATTERN     = /sedang diantar|dalam pengantaran|out for delivery|kurir menuju|\botw\b|akan dikirim ke alamat|with delivery courier|delivery courier|diantar ke alamat|on delivery|1st attempt|2nd attempt|percobaan/i;
const KOTA_PATTERN    = /kota tujuan|gudang tujuan|tiba di kota|received at destination|received at warehouse|process and forward|inbound|sti-dest/i;

function isPickupPhase(e) {
  return !!(e && e.code && /pickup/i.test(e.code));
}
function isSelfReceipt(e) {
  if (!e || !e.place) return false;
  const m = /diterima oleh\s+(.+)/i.exec(e.descOnly || '');
  if (!m) return false;
  const norm = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return norm(m[1]) === norm(e.place);
}

function mapTrackingStage(json) {
  if (!json || !json.success || !json.data) return { stage: 'DIKIRIM', step: 2 };
  const d = json.data;
  const history = Array.isArray(d.history) ? d.history : [];
  const cat = (d.statusCategory || d.status || '').toUpperCase();

  const entries = history.map(h => ({
    desc:     [h.desc, h.code].filter(Boolean).join(' '),
    descOnly: h.desc || '',
    code:     h.code || null,
    place:    h.counter_name || h.city_name || null,
    receivedBy: (h.receiver || '').trim() || null,
    group:    (h.type && h.type.group) || null,
    tag:      (h.type && h.type.tag) || null,
  }));

  const latest    = entries.length ? entries[entries.length - 1] : null;
  const latestD   = (latest && latest.desc || '').toLowerCase();

  // Retur
  if (cat.includes('RETUR') || cat.includes('RETURN') || entries.some(e => RETUR_PATTERN.test(e.desc))) {
    return { stage: 'RETUR', step: 4, detail: d };
  }
  // Sampai
  if (cat === 'DELIVERED' || (/diterima oleh|\bdelivered\b|\bpod\b/.test(latestD) && !isSelfReceipt(latest)) || (latest && latest.receivedBy)) {
    return { stage: 'SAMPAI', step: 5, detail: d };
  }
  // Bermasalah
  const hasStructProblem = entries.some(e => !isPickupPhase(e) && (e.group === 'UNDELIVERED' || e.tag === 'actionRequired'));
  if (hasStructProblem || entries.some(e => !isPickupPhase(e) && PROBLEM_PATTERN.test(e.desc))) {
    return { stage: 'BERMASALAH', step: 3, detail: d };
  }
  // Hitung step tertinggi
  let step = 2;
  entries.forEach(e => {
    if (isPickupPhase(e)) return;
    const dlow = (e.desc || '').toLowerCase();
    if (OTW_PATTERN.test(dlow))   step = Math.max(step, 4);
    else if (KOTA_PATTERN.test(dlow)) step = Math.max(step, 3);
  });
  const stage = step >= 4 ? 'OTW' : step >= 3 ? 'KOTA_TUJUAN' : 'DIKIRIM';
  return { stage, step, detail: d };
}

function normalizeCourier(raw) {
  const key = (raw || '').toUpperCase().replace(/[^A-Z0-9&]/g, '');
  return COURIER_MAP[key] || raw;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { resi, ekspedisi } = req.query;
  if (!resi || !ekspedisi) {
    return res.status(400).json({ error: 'resi and ekspedisi required' });
  }

  try {
    const eksKey = (ekspedisi || '').toUpperCase().replace(/[^A-Z]/g, '');
    const isPos  = eksKey === 'POS' || eksKey.includes('POSINDONESIA');

    let raw;
    if (isPos) {
      raw = await trackPos(resi);
    } else {
      const courier = normalizeCourier(ekspedisi);
      raw = await trackShipment(resi, courier);
    }

    const { stage, step, detail } = mapTrackingStage(raw);
    res.status(200).json({ stage, step, detail });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
