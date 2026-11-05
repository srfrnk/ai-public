const assert = require('assert');
const http = require('http');
const { startBroker } = require('../../dist/secrets/broker');

(async () => {
  let seen;
  const up = http.createServer((req, res) => { seen = req.headers; seen.url = req.url; res.end('ok'); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  process.env.TEST_SECRET = 'REAL-KEY';
  const b = await startBroker({ version: '1.0', secrets: [{
    name: 'svc', env: 'TEST_SECRET', upstream: `http://127.0.0.1:${up.address().port}/base`,
    inject: { header: 'x-api-key' }, container_env: { K: '{token}', U: '{proxy}' } }] }, '127.0.0.1');
  assert(b.withheldHostEnv.includes('TEST_SECRET'));
  assert(!JSON.stringify(b.containerEnv).includes('REAL-KEY'));
  const req = (path, headers) => new Promise(r => http.get({ host: '127.0.0.1', port: b.port, path, headers }, res => { let d=''; res.on('data', c => d+=c); res.on('end', () => r({ code: res.statusCode, d })); }));

  assert.strictEqual((await req('/svc/v1/x', {})).code, 401, 'no token');
  assert.strictEqual((await req('/svc/v1/x', { 'x-api-key': 'wrong' })).code, 401, 'bad token');
  assert.strictEqual((await req('/nope/x', { 'x-api-key': b.token })).code, 404, 'unknown route');
  const ok = await req('/svc/v1/x?q=1', { 'x-api-key': b.token, authorization: 'Bearer ' + b.token });
  assert.strictEqual(ok.code, 200);
  assert.strictEqual(seen['x-api-key'], 'REAL-KEY');
  assert.strictEqual(seen.authorization, undefined);
  assert.strictEqual(seen.url, '/base/v1/x?q=1');
  assert.strictEqual(await startBroker({ version: '1.0', secrets: [{ name: 'a', env: 'UNSET_XYZ', upstream: 'https://x', inject: { header: 'h' } }] }, '127.0.0.1'), undefined);
  await b.stop(); up.close();
  console.log('broker tests passed');
})().catch(e => { console.error(e); process.exit(1); });
