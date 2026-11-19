const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

for (const file of [
  'backend/server.js', 'backend/database.js', 'backend/opay.js', 'frontend/register.js', 'frontend/wallet.js', 'frontend/admin-wallet.js',
  'frontend/community.js', 'frontend/login.js', 'frontend/forgot-password.js',
  'frontend/profile-photo.js', 'frontend/reset-password.js', 'frontend/referrals.js'
]) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
}

for (const file of [
  'frontend/index.html', 'frontend/register.html', 'frontend/community.html', 'frontend/community.css', 'frontend/wallet.html', 'frontend/admin-wallet.html', 'frontend/login.html',
  'frontend/forgot-password.html', 'frontend/reset-password.html', 'frontend/referrals.html'
]) assert.ok(fs.existsSync(path.join(root, file)), `${file} missing`);

assert.ok(fs.existsSync(path.join(root, 'frontend/assets/baba-go-again-tinubu-2027.png')), 'welcome poster missing');
const registerHtml = fs.readFileSync(path.join(root, 'frontend/register.html'), 'utf8');
const registerJs = fs.readFileSync(path.join(root, 'frontend/register.js'), 'utf8');
assert.ok(registerHtml.includes('register.js?v=20261019-locationfix10'), 'registration script cache-buster missing');
assert.match(registerJs, /stateSelect\.disabled\s*=\s*false/, 'state selector must be enabled after loading');
assert.match(registerJs, /const requestId = \+\+stateRequestId/, 'state changes must invalidate older requests');
assert.match(registerJs, /resetSelect\(wardSelect, 'Select an LGA first'\)/, 'state change must clear dependent ward selection');
assert.match(registerJs, /resetSelect\(pollingSelect, 'Select a ward first'\)/, 'state change must clear dependent polling unit');
assert.match(registerJs, /referralCode:\s*\(referralCodeInput/, 'registration must submit referral code');
assert.match(registerJs, /referralParams\.get\('ref'\)/, 'registration must read referral links');
const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
const database = fs.readFileSync(path.join(root, 'backend/database.js'), 'utf8');
for (const route of [
  "app.get('/api/community/feed'", "app.post('/api/community/posts'",
  "app.get('/api/community/groups'", "app.post('/api/community/groups/:id/join'",
  "app.get('/api/community/events'", "app.post('/api/community/events/:id/attend'",
  "app.post('/api/volunteers/apply'"
]) assert.ok(server.includes(route), `Missing community route: ${route}`);
for (const table of ['community_posts','post_comments','community_groups','group_members','community_events','event_attendees','volunteer_applications','wallet_transactions','wallet_payouts'])
  assert.ok(database.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Missing table: ${table}`);
assert.match(fs.readFileSync(path.join(root,'frontend/community.html'),'utf8'), /community\.js/);
assert.match(fs.readFileSync(path.join(root,'frontend/login.js'),'utf8'), /location\.href\s*=\s*['\"]\/community['\"]/);
assert.ok(server.includes("app.get('/referrals'"), 'Missing member referral page route');\nconst walletHtml = fs.readFileSync(path.join(root,'frontend/wallet.html'),'utf8');
const adminWalletHtml = fs.readFileSync(path.join(root,'frontend/admin-wallet.html'),'utf8');
const walletServer = fs.readFileSync(path.join(root,'backend/server.js'),'utf8');
for (const route of ["app.get('/api/wallet/me'", "app.post('/api/wallet/payouts'", "app.post('/api/admin/wallet/credit'", "app.post('/api/admin/wallet/payouts/:id/approve'", "app.post('/api/admin/wallet/payouts/:id/check-status'"]) assert.ok(walletServer.includes(route), `Missing wallet route: ${route}`);
assert.match(walletHtml, /payoutForm/);
assert.match(adminWalletHtml, /payoutQueue/);
assert.match(fs.readFileSync(path.join(root,'backend/opay.js'),'utf8'), /\/api\/v3\/transfer\/toBank/);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bga-db-smoke-'));
try {
  const dbPath = path.join(tempDir, 'smoke.sqlite');
  const dbCheck = spawnSync(process.execPath, ['-e', `
    (async () => {
      const db = require(${JSON.stringify(path.join(root, 'backend/database.js'))});
      await db.ready();
      const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table'");
      const names = new Set(tables.map(row => row.name));
      for (const table of ['users','community_posts','post_comments','community_groups','group_members','community_events','event_attendees','volunteer_applications','wallet_transactions','wallet_payouts','wallet_transactions','wallet_payouts']) {
        if (!names.has(table)) throw new Error('Missing database table: ' + table);
      }
      const result = await db.get('SELECT COUNT(*) AS n FROM users');
      if (result.n !== 0) throw new Error('Expected empty smoke database');
      console.log('Database initialization and community schema passed.');
    })().catch(error => { console.error(error); process.exit(1); });
  `], { encoding:'utf8', env:{...process.env, BGA_DATABASE_PATH:dbPath} });
  assert.equal(dbCheck.status, 0, `Database integration check failed: ${dbCheck.stderr || dbCheck.stdout}`);
  assert.match(dbCheck.stdout, /Database initialization and community schema passed/);
} finally {
  fs.rmSync(tempDir, {recursive:true, force:true});
}

console.log('Baba Go Again smoke checks passed (syntax, required assets, location-cascade, wallet schema, and OPay route checks).');
