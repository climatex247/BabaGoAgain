const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

for (const file of [
  'backend/server.js', 'backend/database.js', 'backend/schema-mysql.js', 'backend/opay.js', 'frontend/register.js', 'frontend/wallet.js', 'frontend/admin-wallet.js',
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
assert.ok(registerHtml.includes('register.js?v=20261119-referralroot1'), 'registration script cache-buster missing');
assert.match(registerJs, /stateSelect\.disabled\s*=\s*false/, 'state selector must be enabled after loading');
assert.match(registerJs, /const requestId = \+\+stateRequestId/, 'state changes must invalidate older requests');
assert.match(registerJs, /resetSelect\(wardSelect, 'Select an LGA first'\)/, 'state change must clear dependent ward selection');
assert.match(registerJs, /resetSelect\(pollingSelect, 'Select a ward first'\)/, 'state change must clear dependent polling unit');
assert.match(registerJs, /referralCode:\s*\(referralCodeInput/, 'registration must submit referral code');
assert.match(registerJs, /referralParams\.get\('ref'\)/, 'registration must read referral links');
const mysqlAdapter = fs.readFileSync(path.join(root, 'backend/database-mysql.js'), 'utf8');
assert.ok(mysqlAdapter.includes('OR\\s+REPLACE\\s+INTO') && mysqlAdapter.includes("'REPLACE INTO'"),'MySQL adapter must translate SQLite replace inserts');
const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
const database = fs.readFileSync(path.join(root, 'backend/database.js'), 'utf8');
const mysqlSchema = fs.readFileSync(path.join(root, 'backend/schema-mysql.js'), 'utf8');
for (const table of ['volunteer_applications','wallet_transactions','wallet_payouts']) {
  assert.match(mysqlSchema, new RegExp('CREATE TABLE IF NOT EXISTS ' + table), `MySQL startup must bootstrap ${table}`);
}
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
assert.ok(server.includes("app.get('/profile'"), 'Missing member profile page route');
assert.ok(server.includes("app.get('/referrals'"), 'Missing member referral page route');
const walletHtml = fs.readFileSync(path.join(root,'frontend/wallet.html'),'utf8');
const adminWalletHtml = fs.readFileSync(path.join(root,'frontend/admin-wallet.html'),'utf8');
const walletServer = fs.readFileSync(path.join(root,'backend/server.js'),'utf8');
for (const route of ["app.get('/api/wallet/me'", "app.post('/api/wallet/payouts'", "app.post('/api/admin/wallet/credit'", "app.post('/api/admin/wallet/payouts/:id/approve'", "app.post('/api/admin/wallet/payouts/:id/check-status'"]) assert.ok(walletServer.includes(route), `Missing wallet route: ${route}`);
assert.match(walletHtml, /payoutForm/);
assert.match(adminWalletHtml, /payoutQueue/);
assert.match(walletServer, /if \(e\.statusCode === 409\)\s*\{\s*return res\.status\(409\)\.json\(/, 'Concurrent payout rejection conflicts must return HTTP 409');
assert.match(walletServer, /idempotencyKey/,'Wallet credits must require an idempotency key');
assert.match(walletServer, /BGA-CREDIT-/,'Wallet credit references must be deterministic for retries');
assert.match(walletServer, /BigInt\(row\?\.balance \|\| '0'\)/,'Wallet aggregate balance must be parsed without Number precision loss');
assert.match(walletServer, /balanceKoboExact/,'Wallet API must expose an exact balance string');
assert.match(walletServer, /balance < BigInt\(amountKobo\)/,'Payout balance checks must use exact integer arithmetic');
assert.match(walletServer, /CAST\(amount_kobo AS CHAR\) AS amountKobo/,'Wallet transaction amounts must be serialized as exact strings');
const walletUi = fs.readFileSync(path.join(root,'frontend/wallet.js'),'utf8');
assert.match(walletUi, /BigInt\(kobo \|\| 0\)/,'Wallet UI must format large kobo values exactly');
assert.match(walletUi, /BigInt\(t\.amountKobo\)/,'Wallet transaction signs must use exact integer arithmetic');
const adminWalletUi = fs.readFileSync(path.join(root,'frontend/admin-wallet.js'),'utf8');
assert.match(adminWalletUi, /BigInt\(kobo\|\|0\)/,'Admin payout amounts must be formatted exactly');
assert.match(walletServer, /This credit was already processed/,'Wallet credit retries must not add a duplicate ledger entry');
assert.match(walletServer, /INSERT INTO bga_admin_audit[\s\S]*?wallet_credit/,'Administrator credits must create an audit record');
assert.match(walletServer, /await initializeFeatures\(\)/,'HTTP server startup must wait for feature and administrator schemas');
const featuresSource = fs.readFileSync(path.join(root,'backend/features.js'),'utf8');
assert.match(featuresSource, /user_id VARCHAR\(191\) NOT NULL REFERENCES users\(id\)[\s\S]*?role VARCHAR\(50\) NOT NULL/,'MySQL administrator role keys must use indexable types');
assert.match(featuresSource, /return async function initializeFeatures\(\)/,'Feature schema readiness must be awaited during startup');
assert.match(featuresSource, /CREATE INDEX IF NOT EXISTS idx_bga_messages_conversation/,'Conversation index must be defined');
assert.match(featuresSource, /ALTER TABLE bga_messages MODIFY COLUMN created_at VARCHAR\(40\)/,'MySQL message timestamp index column must be bounded');
assert.match(featuresSource, /ALTER TABLE bga_media_posts MODIFY COLUMN media_type VARCHAR\(20\)/,'MySQL media category index column must be bounded');
assert.match(featuresSource, /ALTER TABLE bga_community_reports MODIFY COLUMN target_id VARCHAR\(191\)/,'MySQL report unique-key column must be bounded');
assert.match(featuresSource, /Refusing to narrow/,'Schema migration must refuse to truncate existing values');
assert.match(featuresSource, /evidence_url VARCHAR\(1000\) NOT NULL DEFAULT ''/,'Profile evidence links must not be narrowed to 191 characters');
assert.match(featuresSource, /description VARCHAR\(1500\) NOT NULL DEFAULT ''/,'Media descriptions must retain their supported length');
assert.match(featuresSource, /details VARCHAR\(1000\) NOT NULL DEFAULT ''/,'Community report details must retain their supported length');
assert.doesNotMatch(featuresSource, /\bid TEXT PRIMARY KEY/i,'MySQL feature tables must not use TEXT primary keys');
assert.match(featuresSource, /id VARCHAR\(191\) PRIMARY KEY/,'Feature table identifiers must use bounded MySQL primary-key columns');
assert.match(featuresSource, /const featureForeignKeys = \[/,'Feature relationships must have explicit MySQL foreign-key migrations');
assert.match(featuresSource, /information_schema\.TABLE_CONSTRAINTS/,'Foreign-key migrations must be idempotent');
assert.match(featuresSource, /orphan_count/,'Foreign-key migrations must detect orphan rows before enforcement');
assert.match(featuresSource, /CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci/,'Foreign-key columns must match the users table collation');
assert.match(featuresSource, /fk_bga_notifications_user/,'Notification ownership must be protected by a user foreign key');
assert.match(featuresSource, /CREATE TABLE IF NOT EXISTS bga_notifications/,'Notifications table must be initialized before wallet notification writes');
assert.equal((featuresSource.match(/CREATE TABLE IF NOT EXISTS bga_notifications/g)||[]).length,1,'Notifications must have one shared startup schema, not request-time DDL');
assert.doesNotMatch(walletServer, /CREATE TABLE IF NOT EXISTS bga_notifications/,'Community and wallet routes must use the shared notification schema');
assert.match(featuresSource, /ADD CONSTRAINT.*FOREIGN KEY/,'Feature relationships must be enforced by real table-level foreign keys');
assert.doesNotMatch(featuresSource, /VARCHAR\(191\) NOT NULL REFERENCES/,'MySQL must not rely on ignored inline REFERENCES syntax');
assert.match(featuresSource, /is_read TINYINT NOT NULL DEFAULT 0/,'Notification read state must use a MySQL integer type');
assert.match(featuresSource, /is_read TINYINT NOT NULL DEFAULT 0/,'Shared notification schema must be MySQL compatible');
assert.doesNotMatch(walletServer, /CREATE TABLE IF NOT EXISTS bga_notifications/,'Wallet routes must rely on the shared startup notification schema');
assert.match(walletServer, /The payout status changed during reconciliation/,'OPay status reconciliation must detect concurrent state changes');
assert.match(walletServer, /This failed payout was already refunded/,'Repeated failed-status checks must not add another refund');
assert.match(featuresSource, /CREATE INDEX'\)/,'Feature indexes must be created with MySQL-compatible syntax');
const adminWalletJs = fs.readFileSync(path.join(root,'frontend/admin-wallet.js'),'utf8');
assert.match(adminWalletJs, /crypto\.randomUUID\(\)/,'Admin credit form must generate an idempotency key');
assert.match(adminWalletJs, /pendingCreditKey/,'Admin credit form must reuse the same key when retrying an unchanged request');
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
