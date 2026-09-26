const https = require('https');
const querystring = require('querystring');

const MENGANTAR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.mengantar.com/',
  'Origin': 'https://www.mengantar.com'
};

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function trackShipment(trackingNumber, courier) {
  const url = `https://app.mengantar.com/api/order/getPublic?tracking_number=${encodeURIComponent(trackingNumber)}&courier=${encodeURIComponent(courier)}`;
  return httpGetJson(url, MENGANTAR_HEADERS);
}

async function trackPos(resi) {
  const body = querystring.stringify({ kode_booking: resi });
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.bosampuh.id',
      path: '/api_home/lacak_kiriman',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
        'Referer': 'https://www.bosampuh.id/',
        'Origin': 'https://www.bosampuh.id'
      }
    };
    const req = https.request(options, (resp) => {
      let raw = '';
      resp.on('data', chunk => raw += chunk);
      resp.on('end', () => {
        try {
          const parsed = typeof raw === 'string' && raw.startsWith('"')
            ? JSON.parse(JSON.parse(raw))
            : JSON.parse(raw);
          resolve({ success: true, data: parsed });
        } catch (e) { reject(new Error('Parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { trackShipment, trackPos };
