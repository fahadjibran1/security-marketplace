'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const KEY = fs.readFileSync(path.join(__dirname, '..', '.blk004.secret'), 'utf8').trim();
const SVC = 'srv-da8t3d0ae00c73d7g5jg';

function req(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const r = https.request({
      hostname: 'api.render.com', port: 443, path: apiPath, method,
      headers: {
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function run() {
  const all = await req('GET', `/v1/services/${SVC}/env-vars`);
  if (!Array.isArray(all.data)) { console.error('Unexpected response:', all); process.exit(1); }
  console.log('Total env vars:', all.data.length);
  const keep = all.data.filter(v => !v.envVar.key.startsWith('BOOTSTRAP_'));
  console.log('After removing BOOTSTRAP_*:', keep.length);
  const payload = { envVars: keep.map(v => ({ key: v.envVar.key, value: v.envVar.value })) };
  const upd = await req('PUT', `/v1/services/${SVC}/env-vars`, payload);
  if (upd.status !== 200) { console.error('Update failed:', upd.status, JSON.stringify(upd.data)); process.exit(1); }
  const remaining = upd.data.map(v => v.envVar?.key || v.key).sort();
  console.log('Remaining env var keys:');
  remaining.forEach(k => console.log(' ', k));
  const bootstrapGone = !remaining.some(k => k.startsWith('BOOTSTRAP_'));
  console.log('BOOTSTRAP_* vars removed:', bootstrapGone ? 'YES' : 'NO');
}

run().catch(e => { console.error('ERR:', e.message); process.exit(1); });
