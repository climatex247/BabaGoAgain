'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Transform, Readable } = require('stream');
const { pipeline } = require('stream/promises');

const CATEGORIES = ['influencer', 'musician', 'politician', 'community_leader', 'religious_leader'];
const ADMIN_ROLES = ['profile_verification', 'community_moderator', 'media_moderator', 'member_support', 'wallet_admin'];
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

function safe(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function id() { return crypto.randomUUID(); }
function date() { return new Date().toISOString(); }
function escapedLike(value) { return String(value).replace(/[\\%_]/g, '\\$&'); }

function validMedia(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_MEDIA_BYTES) return false;
  if (mime === 'audio/mpeg') return (buffer.length > 3 && buffer.subarray(0,3).toString() === 'ID3') || (buffer.length > 1 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return buffer.length > 12 && buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WAVE';
  if (mime === 'audio/ogg') return buffer.length > 4 && buffer.subarray(0,4).toString() === 'OggS';
  if (mime === 'audio/mp4' || mime === 'video/mp4') return buffer.length > 12 && buffer.subarray(4,8).toString() === 'ftyp';
  if (mime === 'video/webm' || mime === 'audio/webm') return buffer.length > 4 && buffer.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  return false;
}

function install(app, ctx) {
  const { db, authenticatedUser, frontendPath, referrals } = ctx;
  function publitioSignature() {
    const apiKey = process.env.PUBLITIO_API_KEY;
    const apiSecret = process.env.PUBLITIO_API_SECRET;
    if (!apiKey || !apiSecret) throw new Error('Publitio API credentials are not configured.');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = String(crypto.randomInt(10000000, 100000000));
    const signature = crypto.createHash('sha1').update(timestamp + nonce + apiSecret).digest('hex');
    return { api_key: apiKey, api_timestamp: timestamp, api_nonce: nonce, api_signature: signature };
  }
  const publitioPublicReady = new Set();
  async function ensurePublitioPublic(mediaUrl, publitioFileId) {
    let parsed;
    try { parsed = new URL(String(mediaUrl || '')); }
    catch { throw new Error('Stored Publitio video URL is invalid.'); }
    if (parsed.protocol !== 'https:' || !(parsed.hostname === 'publit.io' || parsed.hostname.endsWith('.publit.io'))) {
      throw new Error('Stored video is not hosted by Publitio.');
    }
    const fileId = String(publitioFileId || '').trim();
    if (!fileId || !/^[A-Za-z0-9_-]{6,191}$/.test(fileId)) {
      throw new Error('Publitio file ID is missing. This older upload must be re-submitted before it can be published.');
    }
    if (publitioPublicReady.has(fileId)) return;
    const auth = publitioSignature();
    // Publitio documents file-update options as URL query parameters.
    const params = new URLSearchParams({...auth, privacy:'1'});
    const response = await fetch('https://api.publit.io/v1/files/update/' + encodeURIComponent(fileId) + '?' + params.toString(), {
      method:'PUT',
      headers:{Accept:'application/json'}
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success !== true) {
      const apiMessage = payload?.error?.message || payload?.message || '';
      throw new Error('Publitio could not publish this approved video (HTTP ' + response.status + ')' + (apiMessage ? ': ' + String(apiMessage).slice(0,180) : '.'));
    }
    publitioPublicReady.add(fileId);
  }
  let schemaPromise;

  async function ensureSchema() {
    if (!schemaPromise) schemaPromise = (async () => {
      await db.ready();
      const statements = [
        `CREATE TABLE IF NOT EXISTS bga_conversations (id VARCHAR(191) PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS bga_friend_requests (id VARCHAR(191) PRIMARY KEY, requester_id VARCHAR(191) NOT NULL, addressee_id VARCHAR(191) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at VARCHAR(40) NOT NULL, updated_at VARCHAR(40) NOT NULL, UNIQUE(requester_id,addressee_id), CHECK(status IN ('pending','accepted','declined')))`,
        `CREATE INDEX IF NOT EXISTS idx_bga_friend_requests_inbox ON bga_friend_requests(addressee_id,status,created_at)`,
        `CREATE TABLE IF NOT EXISTS bga_conversation_members (conversation_id VARCHAR(191) NOT NULL, user_id VARCHAR(191) NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY(conversation_id,user_id))`,
        `CREATE TABLE IF NOT EXISTS bga_messages (id VARCHAR(191) PRIMARY KEY, conversation_id VARCHAR(191) NOT NULL, sender_id VARCHAR(191) NOT NULL, body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at VARCHAR(40) NOT NULL, read_at VARCHAR(40))`,
        `CREATE TABLE IF NOT EXISTS bga_message_attachments (id VARCHAR(191) PRIMARY KEY, message_id VARCHAR(191) NOT NULL, conversation_id VARCHAR(191) NOT NULL, uploader_id VARCHAR(191) NOT NULL, publitio_file_id VARCHAR(191) NOT NULL UNIQUE, filename VARCHAR(191) NOT NULL, mime_type VARCHAR(100) NOT NULL, bytes BIGINT NOT NULL, created_at VARCHAR(40) NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS bga_notifications (id VARCHAR(191) PRIMARY KEY, user_id VARCHAR(191) NOT NULL, type VARCHAR(50) NOT NULL DEFAULT 'general', title VARCHAR(191) NOT NULL, body TEXT NOT NULL, link VARCHAR(500) NOT NULL DEFAULT '/notifications', is_read TINYINT NOT NULL DEFAULT 0, created_at VARCHAR(40) NOT NULL, read_at VARCHAR(40))`,
        `CREATE INDEX IF NOT EXISTS idx_bga_messages_conversation ON bga_messages(conversation_id,created_at)`,
        `CREATE TABLE IF NOT EXISTS bga_profile_applications (id VARCHAR(191) PRIMARY KEY, user_id VARCHAR(191) NOT NULL, category TEXT NOT NULL, display_name TEXT NOT NULL, biography TEXT NOT NULL, evidence_url VARCHAR(1000) NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), reviewed_by VARCHAR(191), reviewed_at TEXT, review_note VARCHAR(1000) NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(user_id))`,
        `CREATE TABLE IF NOT EXISTS bga_public_profiles (id VARCHAR(191) PRIMARY KEY, user_id VARCHAR(191) NOT NULL UNIQUE, category TEXT NOT NULL, display_name TEXT NOT NULL, biography TEXT NOT NULL, evidence_url VARCHAR(1000) NOT NULL DEFAULT '', verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS bga_follows (follower_id VARCHAR(191) NOT NULL, profile_id VARCHAR(191) NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(follower_id,profile_id))`,
        `CREATE TABLE IF NOT EXISTS bga_media_posts (id VARCHAR(191) PRIMARY KEY, user_id VARCHAR(191) NOT NULL, media_type VARCHAR(20) NOT NULL CHECK(media_type IN ('audio','video')), title TEXT NOT NULL, description VARCHAR(1500) NOT NULL DEFAULT '', media_url TEXT NOT NULL, publitio_file_id VARCHAR(191), mime_type VARCHAR(100) NOT NULL, bytes BIGINT NOT NULL, moderation_status VARCHAR(20) NOT NULL DEFAULT 'pending', reviewed_by VARCHAR(191), reviewed_at VARCHAR(40), created_at VARCHAR(40) NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS bga_media_upload_intents (id VARCHAR(191) PRIMARY KEY, user_id VARCHAR(191) NOT NULL, media_type TEXT NOT NULL, title TEXT NOT NULL, description VARCHAR(1500) NOT NULL DEFAULT '', mime_type TEXT NOT NULL, expires_at TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS idx_bga_media_created ON bga_media_posts(media_type,created_at)`,
        `CREATE TABLE IF NOT EXISTS bga_admin_roles (user_id VARCHAR(191) NOT NULL, role VARCHAR(50) NOT NULL, granted_by VARCHAR(191), granted_at TEXT NOT NULL, PRIMARY KEY(user_id,role))`,
        `CREATE TABLE IF NOT EXISTS bga_admin_audit (id VARCHAR(191) PRIMARY KEY, actor_id VARCHAR(191) NOT NULL, action VARCHAR(100) NOT NULL, target_id VARCHAR(191), details VARCHAR(2000) NOT NULL DEFAULT '', created_at VARCHAR(40) NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS bga_community_reports (
          id VARCHAR(191) PRIMARY KEY,
          reporter_id VARCHAR(191) NOT NULL,
          target_type VARCHAR(20) NOT NULL CHECK(target_type IN ('post','comment','group','event')),
          target_id VARCHAR(191) NOT NULL,
          reason TEXT NOT NULL,
          details VARCHAR(1000) NOT NULL DEFAULT '',
          status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dismissed','resolved','hidden')),
          reviewed_by VARCHAR(191),
          reviewed_at TEXT,
          review_note VARCHAR(1000) NOT NULL DEFAULT '',
          created_at VARCHAR(40) NOT NULL,
          UNIQUE(reporter_id,target_type,target_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_bga_reports_queue ON bga_community_reports(status,created_at)`
      ];
      for (const sql of statements) {
        if (/^CREATE INDEX IF NOT EXISTS/i.test(sql)) continue;
        await db.run(sql);
      }
      // Add moderation fields before foreign-key checks for older installations.
      try { await db.run("ALTER TABLE bga_media_posts ADD COLUMN publitio_file_id VARCHAR(191)"); } catch (e) { if (!/duplicate|exists|1060|SQLITE_ERROR/i.test(String(e.message))) throw e; }
      try { await db.run("ALTER TABLE bga_media_posts ADD COLUMN moderation_status VARCHAR(20) NOT NULL DEFAULT 'pending'"); } catch (e) { if (!/duplicate|exists|1060|SQLITE_ERROR/i.test(String(e.message))) throw e; }
      try { await db.run("ALTER TABLE bga_media_posts ADD COLUMN reviewed_by VARCHAR(191)"); } catch (e) { if (!/duplicate|exists|1060|SQLITE_ERROR/i.test(String(e.message))) throw e; }
      try { await db.run("ALTER TABLE bga_media_posts ADD COLUMN reviewed_at VARCHAR(40)"); } catch (e) { if (!/duplicate|exists|1060|SQLITE_ERROR/i.test(String(e.message))) throw e; }
      // Refuse unsafe narrowing: never truncate existing feature or audit data.
      const boundedColumns = [
        ['bga_messages','created_at',40],
        ['bga_media_posts','media_type',20],
        ['bga_media_posts','created_at',40],
        ['bga_media_posts','reviewed_by',191],
        ['bga_media_posts','reviewed_at',40],
        ['bga_community_reports','status',20],
        ['bga_community_reports','target_type',20],
        ['bga_community_reports','target_id',191],
        ['bga_community_reports','created_at',40],
        ['bga_admin_audit','details',2000],
        ['bga_conversations','id',191],
        ['bga_friend_requests','id',191],['bga_friend_requests','requester_id',191],['bga_friend_requests','addressee_id',191],
        ['bga_public_profiles','id',191],
        ['bga_profile_applications','evidence_url',1000],
        ['bga_profile_applications','review_note',1000],
        ['bga_public_profiles','evidence_url',1000],
        ['bga_media_posts','description',1500],
        ['bga_media_upload_intents','description',1500],
        ['bga_community_reports','details',1000],
        ['bga_community_reports','review_note',1000],
        ['bga_conversation_members','conversation_id',191],
        ['bga_conversation_members','user_id',191],
        ['bga_messages','conversation_id',191],
        ['bga_messages','sender_id',191],
        ['bga_profile_applications','user_id',191],
        ['bga_profile_applications','reviewed_by',191],
        ['bga_public_profiles','user_id',191],
        ['bga_follows','follower_id',191],
        ['bga_follows','profile_id',191],
        ['bga_media_posts','user_id',191],
        ['bga_media_upload_intents','user_id',191],
        ['bga_admin_roles','user_id',191],
        ['bga_admin_roles','granted_by',191],
        ['bga_admin_audit','actor_id',191],
        ['bga_community_reports','reporter_id',191],
        ['bga_community_reports','reviewed_by',191]
      ];
      for (const [table,column,maxLength] of boundedColumns) {
        const measured = await db.get('SELECT MAX(CHAR_LENGTH(\`' + column + '\`)) AS max_length FROM \`' + table + '\`');
        if (Number(measured?.max_length || 0) > maxLength) {
          throw new Error('Refusing to narrow ' + table + '.' + column + ': existing values exceed ' + maxLength + ' characters.');
        }
      }
      // Existing deployments may have TEXT columns that MySQL cannot index without a prefix.
      await db.run("ALTER TABLE bga_messages MODIFY COLUMN created_at VARCHAR(40) NOT NULL");
      await db.run("ALTER TABLE bga_media_posts MODIFY COLUMN media_type VARCHAR(20) NOT NULL");
      await db.run("ALTER TABLE bga_media_posts MODIFY COLUMN created_at VARCHAR(40) NOT NULL");
      await db.run("ALTER TABLE bga_media_posts MODIFY COLUMN reviewed_at VARCHAR(40)");
      await db.run("ALTER TABLE bga_community_reports MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'");
      await db.run("ALTER TABLE bga_community_reports MODIFY COLUMN target_type VARCHAR(20) NOT NULL");
      await db.run("ALTER TABLE bga_community_reports MODIFY COLUMN target_id VARCHAR(191) NOT NULL");
      await db.run("ALTER TABLE bga_community_reports MODIFY COLUMN created_at VARCHAR(40) NOT NULL");
      // Widen fields that previously passed through SQLite TEXT defaults; keep every existing value.
      await db.run("ALTER TABLE bga_profile_applications MODIFY COLUMN evidence_url VARCHAR(1000) NOT NULL DEFAULT ''");
      await db.run("ALTER TABLE bga_profile_applications MODIFY COLUMN review_note VARCHAR(1000) NOT NULL DEFAULT ''");
      await db.run("ALTER TABLE bga_public_profiles MODIFY COLUMN evidence_url VARCHAR(1000) NOT NULL DEFAULT ''");
      await db.run("ALTER TABLE bga_media_posts MODIFY COLUMN description VARCHAR(1500) NOT NULL DEFAULT ''");
      await db.run("ALTER TABLE bga_media_upload_intents MODIFY COLUMN description VARCHAR(1500) NOT NULL DEFAULT ''");
      await db.run("ALTER TABLE bga_community_reports MODIFY COLUMN details VARCHAR(1000) NOT NULL DEFAULT ''");
      await db.run("ALTER TABLE bga_community_reports MODIFY COLUMN review_note VARCHAR(1000) NOT NULL DEFAULT ''");
      // Match the actual users.id character set and collation before adding string foreign keys.
      // Existing installations may use a different MySQL default collation.
      const userIdColumn = await db.get(
        "SELECT DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='id'"
      );
      if (!userIdColumn || String(userIdColumn.DATA_TYPE).toLowerCase() !== 'varchar' ||
          Number(userIdColumn.CHARACTER_MAXIMUM_LENGTH) !== 191 ||
          !/^[A-Za-z0-9_]+$/.test(String(userIdColumn.CHARACTER_SET_NAME || '')) ||
          !/^[A-Za-z0-9_]+$/.test(String(userIdColumn.COLLATION_NAME || ''))) {
        throw new Error('users.id must be VARCHAR(191) with a valid MySQL character set and collation before feature foreign keys can be installed.');
      }
      // Friend-request IDs are checked by the API. Drop legacy table CHECK constraints before
      // changing ID collations: MySQL may evaluate requester_id <> addressee_id mid-migration
      // while one column has the old collation and the other already has users.id's collation.
      const friendChecks = await db.all(
        "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='bga_friend_requests' AND CONSTRAINT_TYPE='CHECK'"
      );
      for (const check of friendChecks) {
        if (!/^[A-Za-z0-9_]+$/.test(String(check.CONSTRAINT_NAME || ''))) throw new Error('Unexpected friend-request check constraint name.');
        await db.run('ALTER TABLE bga_friend_requests DROP CHECK \`' + check.CONSTRAINT_NAME + '\`');
      }
      const idCharset = userIdColumn.CHARACTER_SET_NAME;
      const idCollation = userIdColumn.COLLATION_NAME;
      // All IDs are bounded and validated above; nullable reviewer/grantor columns stay nullable.
      const featureFkColumns = [
        ['bga_conversations','id','NOT NULL'],
        ['bga_friend_requests','id','NOT NULL'],['bga_friend_requests','requester_id','NOT NULL'],['bga_friend_requests','addressee_id','NOT NULL'],
        ['bga_public_profiles','id','NOT NULL'],
        ['bga_conversation_members','conversation_id','NOT NULL'],['bga_conversation_members','user_id','NOT NULL'],
        ['bga_messages','conversation_id','NOT NULL'],['bga_messages','sender_id','NOT NULL'],
        ['bga_notifications','user_id','NOT NULL'],
        ['bga_profile_applications','user_id','NOT NULL'],['bga_profile_applications','reviewed_by','NULL'],
        ['bga_public_profiles','user_id','NOT NULL'],
        ['bga_follows','follower_id','NOT NULL'],['bga_follows','profile_id','NOT NULL'],
        ['bga_media_posts','user_id','NOT NULL'],['bga_media_posts','reviewed_by','NULL'],
        ['bga_media_upload_intents','user_id','NOT NULL'],
        ['bga_admin_roles','user_id','NOT NULL'],['bga_admin_roles','granted_by','NULL'],
        ['bga_admin_audit','actor_id','NOT NULL'],
        ['bga_community_reports','reporter_id','NOT NULL'],['bga_community_reports','reviewed_by','NULL']
      ];
      for (const [table,column,nullability] of featureFkColumns) {
        const current = await db.get(
          'SELECT DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,CHARACTER_SET_NAME,COLLATION_NAME,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
          [table,column]
        );
        if (!current) throw new Error('Required foreign-key column is missing: ' + table + '.' + column);
        const nullable = nullability === 'NULL';
        if (String(current.DATA_TYPE).toLowerCase() === 'varchar' &&
            Number(current.CHARACTER_MAXIMUM_LENGTH) === 191 &&
            current.CHARACTER_SET_NAME === idCharset &&
            current.COLLATION_NAME === idCollation &&
            (current.IS_NULLABLE === 'YES') === nullable) continue;
        await db.run('ALTER TABLE \`' + table + '\` MODIFY COLUMN \`' + column + '\` VARCHAR(191) CHARACTER SET ' + idCharset + ' COLLATE ' + idCollation + ' ' + nullability);
      }
      // MySQL ignores column-level REFERENCES clauses. Add real InnoDB foreign keys
      // explicitly, after validating legacy rows so startup never silently deletes data.
      const featureForeignKeys = [
        ['bga_friend_requests','fk_bga_friend_requests_requester','requester_id','users','id','CASCADE'],
        ['bga_friend_requests','fk_bga_friend_requests_addressee','addressee_id','users','id','CASCADE'],
        ['bga_conversation_members','fk_bga_conv_members_conversation','conversation_id','bga_conversations','id','CASCADE'],
        ['bga_conversation_members','fk_bga_conv_members_user','user_id','users','id','CASCADE'],
        ['bga_messages','fk_bga_messages_conversation','conversation_id','bga_conversations','id','CASCADE'],
        ['bga_messages','fk_bga_messages_sender','sender_id','users','id','CASCADE'],
        ['bga_notifications','fk_bga_notifications_user','user_id','users','id','CASCADE'],
        ['bga_profile_applications','fk_bga_profile_apps_user','user_id','users','id','CASCADE'],
        ['bga_profile_applications','fk_bga_profile_apps_reviewer','reviewed_by','users','id','SET NULL'],
        ['bga_public_profiles','fk_bga_public_profiles_user','user_id','users','id','CASCADE'],
        ['bga_follows','fk_bga_follows_follower','follower_id','users','id','CASCADE'],
        ['bga_follows','fk_bga_follows_profile','profile_id','bga_public_profiles','id','CASCADE'],
        ['bga_media_posts','fk_bga_media_posts_user','user_id','users','id','CASCADE'],
        ['bga_media_posts','fk_bga_media_posts_reviewer','reviewed_by','users','id','SET NULL'],
        ['bga_media_upload_intents','fk_bga_media_intents_user','user_id','users','id','CASCADE'],
        ['bga_admin_roles','fk_bga_admin_roles_user','user_id','users','id','CASCADE'],
        ['bga_admin_roles','fk_bga_admin_roles_grantor','granted_by','users','id','SET NULL'],
        ['bga_admin_audit','fk_bga_admin_audit_actor','actor_id','users','id','RESTRICT'],
        ['bga_community_reports','fk_bga_reports_reporter','reporter_id','users','id','CASCADE'],
        ['bga_community_reports','fk_bga_reports_reviewer','reviewed_by','users','id','SET NULL']
      ];
      for (const [table,constraint,column,parent,parentColumn,onDelete] of featureForeignKeys) {
        const exists = await db.get(
          "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=? AND CONSTRAINT_TYPE='FOREIGN KEY'",
          [table,constraint]
        );
        if (exists) continue;
        const orphans = await db.get(
          'SELECT COUNT(*) AS orphan_count FROM \`' + table + '\` child LEFT JOIN \`' + parent + '\` parent ON child.\`' + column + '\`=parent.\`' + parentColumn + '\` WHERE child.\`' + column + '\` IS NOT NULL AND parent.\`' + parentColumn + '\` IS NULL'
        );
        if (Number(orphans?.orphan_count || 0) > 0) {
          throw new Error('Cannot add ' + constraint + ': existing orphan rows must be reviewed before enabling this foreign key.');
        }
        await db.run('ALTER TABLE \`' + table + '\` ADD CONSTRAINT \`' + constraint + '\` FOREIGN KEY (\`' + column + '\`) REFERENCES \`' + parent + '\` (\`' + parentColumn + '\`) ON DELETE ' + onDelete);
      }
      // MySQL does not support SQLite's CREATE INDEX IF NOT EXISTS syntax.
      for (const sql of statements.filter(statement => /^CREATE INDEX IF NOT EXISTS/i.test(statement))) {
        const mysqlIndexSql = sql.replace(/^CREATE INDEX IF NOT EXISTS/i, 'CREATE INDEX');
        try {
          await db.run(mysqlIndexSql);
        } catch (error) {
          if (Number(error.errno) !== 1061 && error.code !== 'ER_DUP_KEYNAME') throw error;
        }
      }
      await db.run('ALTER TABLE bga_notifications MODIFY COLUMN body TEXT NOT NULL');
      // Widen legacy audit details safely; this preserves existing audit records.
      await db.run("ALTER TABLE bga_admin_audit MODIFY COLUMN details VARCHAR(2000) NOT NULL DEFAULT ''");

    })().catch(e => { schemaPromise = null; throw e; });
    await schemaPromise;
  }

  async function user(req, res) { await ensureSchema(); return authenticatedUser(req, res); }
  async function roles(userId) { const rows = await db.all('SELECT role FROM bga_admin_roles WHERE user_id=?', [userId]); return rows.map(x => x.role); }
  async function bootstrapFounder() {
    await ensureSchema();
    const email = safe(process.env.BGA_FOUNDER_EMAIL, 254).toLowerCase();
    if (!email) return;
    const founder = await db.get("SELECT id FROM users WHERE lower(email)=? AND status='active' AND email_verified=1", [email]);
    if (!founder) return;
    const existing = await db.get("SELECT user_id FROM bga_admin_roles WHERE user_id=? AND role='founder'", [founder.id]);
    if (!existing) {
      await db.run('INSERT OR IGNORE INTO bga_admin_roles (user_id,role,granted_by,granted_at) VALUES (?,?,?,?)', [founder.id,'founder',founder.id,date()]);
      await db.run('INSERT INTO bga_admin_audit (id,actor_id,action,target_id,details,created_at) VALUES (?,?,?,?,?,?)', [id(),founder.id,'founder_bootstrap',founder.id,'Founder role assigned to the verified account configured in BGA_FOUNDER_EMAIL.',date()]);
    }
  }
  async function requireRole(req, res, allowed) {
    const current = await user(req, res); if (!current) return null;
    await bootstrapFounder();
    const userRoles = await roles(current.id);
    if (!userRoles.includes('founder') && !allowed.some(r => userRoles.includes(r))) {
      res.status(403).json({ success:false, message:'You do not have permission to perform this action.' }); return null;
    }
    return current;
  }
  async function audit(actor, action, target, details = '') {
    await db.run('INSERT INTO bga_admin_audit (id,actor_id,action,target_id,details,created_at) VALUES (?,?,?,?,?,?)', [id(),actor,action,target || null,safe(details,1000),date()]);
  }


  app.get('/api/dashboard/summary', async (req,res) => {
    try {
      const me=await user(req,res); if(!me)return;
      if (referrals && typeof referrals.ensureSchema === 'function') await referrals.ensureSchema();
      await bootstrapFounder();
      const memberRoles=await roles(me.id);
      const invitedMembers=await db.all(`SELECT u.id,u.full_name AS name,u.email,u.created_at AS joinedAt,u.status,u.email_verified AS emailVerified
        FROM bga_referral_relationships r JOIN users u ON u.id=r.user_id
        WHERE r.sponsor_id=? ORDER BY u.created_at DESC LIMIT 100`,[me.id]);
      const unread=await db.get(`SELECT COUNT(*) AS n FROM bga_messages m
        JOIN bga_conversation_members cm ON cm.conversation_id=m.conversation_id
        WHERE cm.user_id=? AND m.sender_id<>? AND m.read_at IS NULL`,[me.id,me.id]);
      const pendingMedia=memberRoles.includes('founder')||memberRoles.includes('media_moderator')
        ? Number((await db.get("SELECT COUNT(*) AS n FROM bga_media_posts WHERE moderation_status='pending'"))?.n||0) : 0;
      res.json({success:true,data:{name:me.full_name,email:me.email,roles:memberRoles,referralCount:invitedMembers.length,verifiedReferralCount:invitedMembers.filter(x=>x.status==='active'&&Number(x.emailVerified)===1).length,referrals:invitedMembers,unreadMessages:Number(unread?.n||0),pendingMedia}});
    } catch(e) { console.error('dashboard summary',e); res.status(500).json({success:false,message:'Could not load dashboard.'}); }
  });

  app.get('/api/founder-dashboard/summary', async (req,res) => {
    try {
      const me=await requireRole(req,res,[]);
      if(!me)return;
      const memberRoles=await roles(me.id);
      if(!memberRoles.includes('founder'))return res.status(403).json({success:false,message:'Founder access is required.'});
      if (referrals && typeof referrals.ensureSchema === 'function') await referrals.ensureSchema();
      await ensureSchema();
      const counts=await db.get(`SELECT COUNT(*) AS totalMembers,
        SUM(CASE WHEN status='active' AND email_verified=1 THEN 1 ELSE 0 END) AS verifiedMembers,
        SUM(CASE WHEN status<>'active' OR email_verified<>1 THEN 1 ELSE 0 END) AS unverifiedMembers
        FROM users`);
      const referralCount=await db.get('SELECT COUNT(*) AS n FROM bga_referral_relationships');
      const adminCount=await db.get("SELECT COUNT(DISTINCT user_id) AS n FROM bga_admin_roles WHERE role<>'founder'");
      const mediaCount=await db.get("SELECT COUNT(*) AS n FROM bga_media_posts WHERE moderation_status='pending'");
      const profileCount=await db.get("SELECT COUNT(*) AS n FROM bga_profile_applications WHERE status='pending'");
      const reportCount=await db.get("SELECT COUNT(*) AS n FROM bga_community_reports WHERE status='pending'");
      const audit=await db.all(`SELECT a.action,a.details,a.created_at AS createdAt,u.full_name AS actorName
        FROM bga_admin_audit a JOIN users u ON u.id=a.actor_id
        ORDER BY a.created_at DESC LIMIT 12`);
      res.json({success:true,data:{founderName:me.full_name||me.email,totalMembers:Number(counts?.totalMembers||0),verifiedMembers:Number(counts?.verifiedMembers||0),unverifiedMembers:Number(counts?.unverifiedMembers||0),totalReferrals:Number(referralCount?.n||0),administrators:Number(adminCount?.n||0),pendingMedia:Number(mediaCount?.n||0),pendingProfiles:Number(profileCount?.n||0),pendingReports:Number(reportCount?.n||0),recentAudit:audit}});
    } catch(e) { console.error('founder dashboard summary',e); res.status(500).json({success:false,message:'Could not load founder control centre.'}); }
  });

  app.get('/api/member-profile', async (req, res) => {
    try {
      const me = await user(req, res);
      if (!me) return;
      const row = await db.get(
        `SELECT id, full_name AS name, phone, email, address,
        preferred_language AS preferredLanguage,
        state_name AS stateName, lga_name AS lgaName,
        ward_name AS wardName, polling_unit_id AS pollingUnitId,
        roles_json AS rolesJson, created_at AS joinedAt
        FROM users WHERE id=? AND status='active' AND email_verified=1`,
        [me.id]
      );
      if (!row) return res.status(403).json({
        success:false, message:'An active, verified account is required.'
      });
      try { row.roles = JSON.parse(row.rolesJson || '[]'); }
      catch { row.roles = []; }
      delete row.rolesJson;
      res.json({success:true, data:row});
    } catch (e) {
      console.error('member profile load', e);
      res.status(500).json({success:false, message:'Could not load your profile.'});
    }
  });

  app.put('/api/member-profile', async (req, res) => {
    try {
      const me = await user(req, res);
      if (!me) return;
      const name = safe(req.body.name, 100);
      const phone = safe(req.body.phone, 30);
      const address = safe(req.body.address, 300);
      const language = safe(req.body.preferredLanguage, 40) || 'English';

      if (name.length < 2)
        return res.status(400).json({success:false,message:'Enter your full name.'});
      if (!/^[+0-9 ()-]{7,30}$/.test(phone))
        return res.status(400).json({success:false,message:'Enter a valid phone number.'});
      if (address.length < 3)
        return res.status(400).json({success:false,message:'Enter your address.'});
      if (!['English','Hausa','Yoruba','Igbo','Pidgin'].includes(language))
        return res.status(400).json({success:false,message:'Choose a supported language.'});

      const duplicate = await db.get(
        'SELECT id FROM users WHERE phone=? AND id<>?', [phone, me.id]
      );
      if (duplicate)
        return res.status(409).json({success:false,message:'That phone number is already registered.'});

      await db.run(
        'UPDATE users SET full_name=?,phone=?,address=?,preferred_language=?,updated_at=? WHERE id=?',
        [name, phone, address, language, date(), me.id]
      );
      res.json({success:true,message:'Profile updated successfully.'});
    } catch (e) {
      console.error('member profile update', e);
      res.status(500).json({success:false,message:'Could not update your profile.'});
    }
  });

  app.get('/api/members/search', async (req,res) => {try{const me=await user(req,res);if(!me)return;const q=safe(req.query.q,80);if(q.length<2)return res.json({success:true,data:[]});const rows=await db.all("SELECT id,full_name AS name FROM users WHERE id<>? AND status='active' AND email_verified=1 AND full_name LIKE ? ORDER BY full_name LIMIT 20",[me.id,'%'+q.replace(/[%_\\]/g,'')+'%']);res.json({success:true,data:rows});}catch(e){res.status(500).json({success:false,message:'Could not search members.'});}});

  // Friendship lifecycle: only accepted friends may open or send private conversations.
  app.get('/api/friends', async (req,res) => {
    try { const me=await user(req,res); if(!me)return;
      const rows=await db.all(`SELECT u.id,u.full_name AS name,fr.updated_at AS since
        FROM bga_friend_requests fr JOIN users u ON u.id=CASE WHEN fr.requester_id=? THEN fr.addressee_id ELSE fr.requester_id END
        WHERE (fr.requester_id=? OR fr.addressee_id=?) AND fr.status='accepted'
        ORDER BY u.full_name`,[me.id,me.id,me.id]);
      res.json({success:true,data:rows});
    } catch(e){console.error('friends list',e);res.status(500).json({success:false,message:'Could not load friends.'});}
  });
  app.get('/api/friends/requests', async (req,res) => {
    try { const me=await user(req,res); if(!me)return;
      const incoming=await db.all(`SELECT fr.id,fr.requester_id AS userId,u.full_name AS name,fr.created_at AS createdAt
        FROM bga_friend_requests fr JOIN users u ON u.id=fr.requester_id
        WHERE fr.addressee_id=? AND fr.status='pending' ORDER BY fr.created_at DESC`,[me.id]);
      const outgoing=await db.all(`SELECT fr.id,fr.addressee_id AS userId,u.full_name AS name,fr.created_at AS createdAt
        FROM bga_friend_requests fr JOIN users u ON u.id=fr.addressee_id
        WHERE fr.requester_id=? AND fr.status='pending' ORDER BY fr.created_at DESC`,[me.id]);
      res.json({success:true,data:{incoming,outgoing}});
    } catch(e){console.error('friend requests',e);res.status(500).json({success:false,message:'Could not load friend requests.'});}
  });
  app.post('/api/friends/requests', async (req,res) => {
    try { const me=await user(req,res); if(!me)return;
      const target=safe(req.body.userId,191);
      if(!target || target===me.id)return res.status(400).json({success:false,message:'Choose another member.'});
      const other=await db.get("SELECT id FROM users WHERE id=? AND status='active' AND email_verified=1",[target]);
      const friendship=await db.get("SELECT id FROM bga_friend_requests WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)) LIMIT 1",[me.id,target,target,me.id]);
      if(!friendship)return res.status(403).json({success:false,message:'You can only start a private conversation with an accepted friend.'});
      if(!other)return res.status(404).json({success:false,message:'Member not found or not active.'});
      const accepted=await db.get("SELECT id FROM bga_friend_requests WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)) LIMIT 1",[me.id,target,target,me.id]);
      if(accepted)return res.status(409).json({success:false,message:'You are already friends.'});
      const reverse=await db.get("SELECT id FROM bga_friend_requests WHERE requester_id=? AND addressee_id=? AND status='pending'",[target,me.id]);
      if(reverse){await db.run("UPDATE bga_friend_requests SET status='accepted',updated_at=? WHERE id=? AND status='pending'",[date(),reverse.id]);return res.json({success:true,message:'Friend request accepted. You are now friends.'});}
      const prior=await db.get("SELECT id,status FROM bga_friend_requests WHERE requester_id=? AND addressee_id=?",[me.id,target]);
      if(prior?.status==='pending')return res.status(409).json({success:false,message:'Friend request already sent.'});
      if(prior)await db.run("UPDATE bga_friend_requests SET status='pending',created_at=?,updated_at=? WHERE id=?",[date(),date(),prior.id]);
      else await db.run("INSERT INTO bga_friend_requests (id,requester_id,addressee_id,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)",[id(),me.id,target,date(),date()]);
      try{await db.run('INSERT INTO bga_notifications (id,user_id,type,title,body,link,is_read,created_at) VALUES (?,?,?,?,?,?,0,?)',[id(),target,'friend_request','New friend request',safe(me.full_name,100)+' sent you a friend request.','/messages',date()]);}catch(e){console.error('friend request notification',e);}
      res.status(201).json({success:true,message:'Friend request sent.'});
    } catch(e){console.error('friend request send',e);res.status(500).json({success:false,message:'Could not send friend request.'});}
  });
  app.post('/api/friends/requests/:id/accept', async (req,res) => {
    try {const me=await user(req,res);if(!me)return;
      const result=await db.run("UPDATE bga_friend_requests SET status='accepted',updated_at=? WHERE id=? AND addressee_id=? AND status='pending'",[date(),req.params.id,me.id]);
      if(result.changes!==1)return res.status(404).json({success:false,message:'Pending friend request not found.'});
      res.json({success:true,message:'Friend request accepted.'});
    }catch(e){console.error('friend request accept',e);res.status(500).json({success:false,message:'Could not accept friend request.'});}
  });
  app.post('/api/friends/requests/:id/decline', async (req,res) => {
    try {const me=await user(req,res);if(!me)return;
      const result=await db.run("UPDATE bga_friend_requests SET status='declined',updated_at=? WHERE id=? AND addressee_id=? AND status='pending'",[date(),req.params.id,me.id]);
      if(result.changes!==1)return res.status(404).json({success:false,message:'Pending friend request not found.'});
      res.json({success:true,message:'Friend request declined.'});
    }catch(e){console.error('friend request decline',e);res.status(500).json({success:false,message:'Could not decline friend request.'});}
  });
  app.delete('/api/friends/:userId', async (req,res) => {
    try {const me=await user(req,res);if(!me)return;const target=safe(req.params.userId,191);
      const result=await db.run("DELETE FROM bga_friend_requests WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))",[me.id,target,target,me.id]);
      if(result.changes!==1)return res.status(404).json({success:false,message:'Friendship not found.'});
      res.json({success:true,message:'Friend removed.'});
    }catch(e){console.error('friend remove',e);res.status(500).json({success:false,message:'Could not remove friend.'});}
  });


  app.get('/messages', (req,res) => res.sendFile(path.join(frontendPath,'messages.html')));
  app.get('/media', (req,res) => res.sendFile(path.join(frontendPath,'media.html')));
  app.get('/public-figures', (req,res) => res.sendFile(path.join(frontendPath,'public-figures.html')));
  app.get('/admin-center', (req,res) => res.sendFile(path.join(frontendPath,'admin-center.html')));
  app.get('/founder-dashboard', (req,res) => res.sendFile(path.join(frontendPath,'founder-dashboard.html')));

  app.get('/api/messages/conversations', async (req,res) => {
    try {
      const me = await user(req,res); if (!me) return;
      const rows = await db.all(`SELECT c.id,c.updated_at AS updatedAt,
        (SELECT m.body FROM bga_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS lastMessage,
        (SELECT m.created_at FROM bga_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS lastAt,
        (SELECT u.full_name FROM bga_conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=c.id AND cm.user_id<>? LIMIT 1) AS otherName,
        (SELECT cm.user_id FROM bga_conversation_members cm WHERE cm.conversation_id=c.id AND cm.user_id<>? LIMIT 1) AS otherUserId
        FROM bga_conversations c JOIN bga_conversation_members mine ON mine.conversation_id=c.id AND mine.user_id=? ORDER BY c.updated_at DESC LIMIT 100`,[me.id,me.id,me.id]);
      res.json({success:true,data:rows});
    } catch(e) { console.error('conversation list',e); res.status(500).json({success:false,message:'Could not load conversations.'}); }
  });
  app.post('/api/messages/conversations', async (req,res) => {
    try {
      const me=await user(req,res); if(!me)return;
      const target=safe(req.body.userId,100);
      if (!target || target===me.id) return res.status(400).json({success:false,message:'Choose another member to message.'});
      const other=await db.get("SELECT id FROM users WHERE id=? AND status='active' AND email_verified=1",[target]);
      if(!other)return res.status(404).json({success:false,message:'Member not found or not active.'});
      const existing=await db.get(`SELECT a.conversation_id AS id FROM bga_conversation_members a JOIN bga_conversation_members b ON b.conversation_id=a.conversation_id WHERE a.user_id=? AND b.user_id=? AND (SELECT COUNT(*) FROM bga_conversation_members x WHERE x.conversation_id=a.conversation_id)=2 LIMIT 1`,[me.id,target]);
      if(existing)return res.json({success:true,data:{id:existing.id}});
      const conversation=id(),now=date();
      await db.transaction(async tx =>{await tx.run('INSERT INTO bga_conversations (id,created_at,updated_at) VALUES (?,?,?)',[conversation,now,now]);await tx.run('INSERT INTO bga_conversation_members (conversation_id,user_id,joined_at) VALUES (?,?,?)',[conversation,me.id,now]);await tx.run('INSERT INTO bga_conversation_members (conversation_id,user_id,joined_at) VALUES (?,?,?)',[conversation,target,now]);});
      res.status(201).json({success:true,data:{id:conversation}});
    } catch(e) { console.error('conversation create',e); res.status(500).json({success:false,message:'Could not start conversation.'}); }
  });
  app.get('/api/messages/conversations/:id', async (req,res) => {
    try { const me=await user(req,res);if(!me)return; const membership=await db.get('SELECT 1 AS ok FROM bga_conversation_members WHERE conversation_id=? AND user_id=?',[req.params.id,me.id]);if(!membership)return res.status(404).json({success:false,message:'Conversation not found.'}); await db.run('UPDATE bga_messages SET read_at=? WHERE conversation_id=? AND sender_id<>? AND read_at IS NULL',[date(),req.params.id,me.id]); const rows=await db.all(`SELECT m.id,m.body,m.created_at AS createdAt,m.sender_id AS senderId,m.read_at AS readAt,u.full_name AS senderName,a.id AS attachmentId,a.filename AS attachmentName,a.mime_type AS attachmentMime,a.bytes AS attachmentBytes FROM bga_messages m JOIN users u ON u.id=m.sender_id LEFT JOIN bga_message_attachments a ON a.message_id=m.id WHERE m.conversation_id=? ORDER BY m.created_at ASC LIMIT 300`,[req.params.id]);for(const row of rows){if(row.attachmentId){row.attachment={id:row.attachmentId,name:row.attachmentName,mimeType:row.attachmentMime,bytes:Number(row.attachmentBytes),url:'/api/messages/conversations/'+encodeURIComponent(req.params.id)+'/attachments/'+encodeURIComponent(row.attachmentId)};delete row.attachmentId;delete row.attachmentName;delete row.attachmentMime;delete row.attachmentBytes;}}res.json({success:true,data:rows}); }
    catch(e){console.error('message read',e);res.status(500).json({success:false,message:'Could not load messages.'});}
  });
  app.post('/api/messages/conversations/:id', async (req,res) => {
    try { const me=await user(req,res);if(!me)return;const body=safe(req.body.body,4000);if(!body)return res.status(400).json({success:false,message:'Message cannot be empty.'});const membership=await db.get('SELECT 1 AS ok FROM bga_conversation_members WHERE conversation_id=? AND user_id=?',[req.params.id,me.id]);if(!membership)return res.status(404).json({success:false,message:'Conversation not found.'});const otherMember=await db.get('SELECT user_id AS userId FROM bga_conversation_members WHERE conversation_id=? AND user_id<>? LIMIT 1',[req.params.id,me.id]);if(!otherMember)return res.status(403).json({success:false,message:'This private conversation is unavailable.'});const friendship=await db.get("SELECT id FROM bga_friend_requests WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)) LIMIT 1",[me.id,otherMember.userId,otherMember.userId,me.id]);if(!friendship)return res.status(403).json({success:false,message:'You must be accepted friends to send private messages.'});const msg=id(),now=date();await db.transaction(async tx =>{await tx.run('INSERT INTO bga_messages (id,conversation_id,sender_id,body,created_at) VALUES (?,?,?,?,?)',[msg,req.params.id,me.id,body,now]);await tx.run('UPDATE bga_conversations SET updated_at=? WHERE id=?',[now,req.params.id]);});try{const recipients=await db.all('SELECT user_id AS userId FROM bga_conversation_members WHERE conversation_id=? AND user_id<>?',[req.params.id,me.id]);for(const recipient of recipients){await db.run('INSERT INTO bga_notifications (id,user_id,type,title,body,link,is_read,created_at) VALUES (?,?,?,?,?,?,0,?)',[id(),recipient.userId,'message','New message from '+safe(me.full_name,100),body.slice(0,300),'/messages',now]);}}catch(notificationError){console.error('message notification',notificationError);}res.status(201).json({success:true,data:{id:msg,body,createdAt:now,senderId:me.id,senderName:me.full_name}}); }
    catch(e){console.error('message send',e);res.status(500).json({success:false,message:'Could not send message.'});}
  });



  // Private attachments are uploaded to Publitio with privacy=0 and streamed back
  // only after authenticating both conversation membership and current friendship.
  app.post('/api/messages/conversations/:id/attachments', async (req,res) => {
    let uploadedFileId = '';
    try {
      const me=await user(req,res); if(!me)return;
      const conversationId=safe(req.params.id,191);
      const membership=await db.get('SELECT 1 AS ok FROM bga_conversation_members WHERE conversation_id=? AND user_id=?',[conversationId,me.id]);
      if(!membership)return res.status(404).json({success:false,message:'Conversation not found.'});
      const other=await db.get('SELECT user_id AS userId FROM bga_conversation_members WHERE conversation_id=? AND user_id<>? LIMIT 1',[conversationId,me.id]);
      if(!other)return res.status(403).json({success:false,message:'Private conversation unavailable.'});
      const friendship=await db.get("SELECT id FROM bga_friend_requests WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)) LIMIT 1",[me.id,other.userId,other.userId,me.id]);
      if(!friendship)return res.status(403).json({success:false,message:'You must be accepted friends to share attachments.'});
      const mime=String(req.headers['content-type']||'').split(';')[0].toLowerCase();
      const extByMime={'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','audio/mpeg':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/ogg':'ogg','audio/mp4':'m4a','video/mp4':'mp4','video/webm':'webm'};
      if(!extByMime[mime])return res.status(415).json({success:false,message:'Supported files: JPG, PNG, GIF, WebP, MP3, WAV, OGG, M4A, MP4 and WebM.'});
      const maxBytes=mime.startsWith('image/')?15*1024*1024:(mime.startsWith('audio/')?25*1024*1024:100*1024*1024);
      const declared=Number(req.headers['content-length']||0);
      if(!Number.isSafeInteger(declared)||declared<12||declared>maxBytes)return res.status(413).json({success:false,message:'This file is empty or exceeds the size limit for its type.'});
      const filename=safe(req.headers['x-bga-filename'],120).replace(/[^A-Za-z0-9._ -]/g,'_').replace(/\s+/g,' ').trim()||('attachment.'+extByMime[mime]);
      const iterator=req[Symbol.asyncIterator]();
      let first=Buffer.alloc(0),total=0;
      while(first.length<16){const part=await iterator.next();if(part.done)break;first=Buffer.concat([first,part.value]);total+=part.value.length;if(total>maxBytes)return res.status(413).json({success:false,message:'File exceeds the upload limit.'});}
      const valid= mime==='image/jpeg'?first[0]===0xff&&first[1]===0xd8&&first[2]===0xff :
        mime==='image/png'?first.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
        mime==='image/gif'?first.subarray(0,3).toString()==='GIF' :
        mime==='image/webp'?first.subarray(0,4).toString()==='RIFF'&&first.subarray(8,12).toString()==='WEBP' :
        mime==='audio/mpeg'?(first.subarray(0,3).toString()==='ID3'||(first[0]===0xff&&(first[1]&0xe0)===0xe0)) :
        (mime==='audio/wav'||mime==='audio/x-wav')?first.subarray(0,4).toString()==='RIFF'&&first.subarray(8,12).toString()==='WAVE' :
        mime==='audio/ogg'?first.subarray(0,4).toString()==='OggS' :
        (mime==='audio/mp4'||mime==='video/mp4')?first.subarray(4,8).toString()==='ftyp' :
        first.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
      if(!valid)return res.status(415).json({success:false,message:'The file contents do not match the selected file type.'});
      const boundary='----BabaGoAgainPrivate'+crypto.randomBytes(18).toString('hex');
      const header=Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="'+filename+'"\r\nContent-Type: '+mime+'\r\n\r\n');
      const footer=Buffer.from('\r\n--'+boundary+'--\r\n');
      const auth=publitioSignature();
      const query=new URLSearchParams({...auth,privacy:'0'});
      async function* multipart(){
        yield header; yield first;
        while(true){const part=await iterator.next();if(part.done)break;total+=part.value.length;if(total>maxBytes)throw new Error('Attachment exceeds upload limit.');yield part.value;}
        if(total!==declared)throw new Error('Upload size did not match the declared file size.');
        yield footer;
      }
      const upstream=await fetch('https://api.publit.io/v1/files/create?'+query.toString(),{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':String(header.length+declared+footer.length),'Accept':'application/json'},body:multipart(),duplex:'half'});
      const payload=await upstream.json().catch(()=>({}));
      if(!upstream.ok||payload.success!==true||!payload.id)throw new Error('Private media storage rejected the upload (HTTP '+upstream.status+').');
      uploadedFileId=String(payload.id);
      let verified=await fetch('https://api.publit.io/v1/files/show/'+encodeURIComponent(uploadedFileId)+'?'+new URLSearchParams(publitioSignature()).toString(),{headers:{Accept:'application/json'}});
      let asset=await verified.json().catch(()=>({}));
      if(!verified.ok||asset.success!==true)throw new Error('Private attachment could not be verified.');
      if(!['private','0',0,false].includes(asset.privacy)){
        const update=new URLSearchParams({...publitioSignature(),privacy:'0'});
        const changed=await fetch('https://api.publit.io/v1/files/update/'+encodeURIComponent(uploadedFileId)+'?'+update.toString(),{method:'PUT',headers:{Accept:'application/json'}});
        const result=await changed.json().catch(()=>({}));
        if(!changed.ok||result.success!==true)throw new Error('Could not lock the uploaded file as private.');
        verified=await fetch('https://api.publit.io/v1/files/show/'+encodeURIComponent(uploadedFileId)+'?'+new URLSearchParams(publitioSignature()).toString(),{headers:{Accept:'application/json'}});
        asset=await verified.json().catch(()=>({}));
      }
      if(!['private','0',0,false].includes(asset.privacy))throw new Error('Storage did not confirm private file access.');
      const ext=String(asset.extension||'').toLowerCase().replace(/^\./,'');
      if(ext!==extByMime[mime])throw new Error('Stored attachment type did not match the uploaded file.');
      const actualSize=Number(asset.size);
      if(!Number.isFinite(actualSize)||actualSize!==declared||actualSize>maxBytes)throw new Error('Stored attachment size did not match the uploaded file.');
      const msg=id(),attachmentId=id(),now=date();
      const body=mime.startsWith('image/')?'Shared an image':mime.startsWith('audio/')?'Shared an audio file':'Shared a video';
      await db.transaction(async tx=>{
        await tx.run('INSERT INTO bga_messages (id,conversation_id,sender_id,body,created_at) VALUES (?,?,?,?,?)',[msg,conversationId,me.id,body,now]);
        await tx.run('INSERT INTO bga_message_attachments (id,message_id,conversation_id,uploader_id,publitio_file_id,filename,mime_type,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)',[attachmentId,msg,conversationId,me.id,uploadedFileId,filename,mime,actualSize,now]);
        await tx.run('UPDATE bga_conversations SET updated_at=? WHERE id=?',[now,conversationId]);
      });
      try{await db.run('INSERT INTO bga_notifications (id,user_id,type,title,body,link,is_read,created_at) VALUES (?,?,?,?,?,?,0,?)',[id(),other.userId,'message','Private attachment from '+safe(me.full_name,100),'A friend shared a private attachment with you.','/messages',now]);}catch(e){console.error('private attachment notification',e);}
      res.status(201).json({success:true,message:'Private attachment sent.',data:{id:msg,attachmentId}});
    }catch(e){
      if(uploadedFileId){try{const q=new URLSearchParams(publitioSignature());await fetch('https://api.publit.io/v1/files/delete/'+encodeURIComponent(uploadedFileId)+'?'+q.toString(),{method:'DELETE'});}catch(cleanup){console.error('private attachment cleanup failed',cleanup.message);}}
      console.error('private attachment upload failed',e.message);
      if(!res.headersSent)res.status(/upload limit|size did not match/i.test(e.message)?413:502).json({success:false,message:'Could not securely send this attachment. '+String(e.message).slice(0,160)});
    }
  });

  app.get('/api/messages/conversations/:id/attachments/:attachmentId', async (req,res) => {
    try{
      const me=await user(req,res);if(!me)return;
      const conversationId=safe(req.params.id,191);
      const member=await db.get('SELECT 1 AS ok FROM bga_conversation_members WHERE conversation_id=? AND user_id=?',[conversationId,me.id]);
      if(!member)return res.status(404).end();
      const other=await db.get('SELECT user_id AS userId FROM bga_conversation_members WHERE conversation_id=? AND user_id<>? LIMIT 1',[conversationId,me.id]);
      if(!other)return res.status(404).end();
      const friendship=await db.get("SELECT id FROM bga_friend_requests WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)) LIMIT 1",[me.id,other.userId,other.userId,me.id]);
      if(!friendship)return res.status(403).end();
      const attachment=await db.get('SELECT publitio_file_id AS fileId,filename,mime_type AS mimeType FROM bga_message_attachments WHERE id=? AND conversation_id=?',[req.params.attachmentId,conversationId]);
      if(!attachment)return res.status(404).end();
      const auth=new URLSearchParams(publitioSignature());
      const shown=await fetch('https://api.publit.io/v1/files/show/'+encodeURIComponent(attachment.fileId)+'?'+auth.toString(),{headers:{Accept:'application/json'}});
      const asset=await shown.json().catch(()=>({}));
      if(!shown.ok||asset.success!==true||!['private','0',0,false].includes(asset.privacy))return res.status(404).end();
      const signedUrl=String(asset.url_download||asset.url_preview||'');
      let parsed;try{parsed=new URL(signedUrl);}catch{return res.status(502).end();}
      if(parsed.protocol!=='https:'||!/(^|\.)publit\.io$/i.test(parsed.hostname))return res.status(502).end();
      const headers={Accept:'*/*'};
      if(req.headers.range)headers.Range=req.headers.range;
      const file=await fetch(signedUrl,{headers});
      if(!file.ok&&file.status!==206)return res.status(502).end();
      res.status(file.status);
      res.setHeader('Content-Type',attachment.mimeType);
      res.setHeader('Content-Disposition','inline; filename="'+attachment.filename.replace(/["\\\r\n]/g,'_')+'"');
      res.setHeader('Cache-Control','private, no-store');
      res.setHeader('X-Content-Type-Options','nosniff');
      for(const name of ['content-length','content-range','accept-ranges']){const value=file.headers.get(name);if(value)res.setHeader(name,value);}
      if(!file.body)return res.end();
      Readable.fromWeb(file.body).on('error',()=>res.destroy()).pipe(res);
    }catch(e){console.error('private attachment delivery failed',e.message);if(!res.headersSent)res.status(502).end();}
  });

  // Baba Go Again notification centre
  app.get('/notifications', (req,res) =>
    res.sendFile(path.join(frontendPath,'notifications.html'))
  );

  app.get('/api/notifications', async (req,res) => {
    try {
      const me = await user(req,res);
      if (!me) return;

      const rows = await db.all(
        'SELECT id,type,title,body,link,is_read AS isRead,created_at AS createdAt,read_at AS readAt FROM bga_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100',
        [me.id]
      );
      const unread = await db.get(
        'SELECT COUNT(*) AS count FROM bga_notifications WHERE user_id=? AND is_read=0',
        [me.id]
      );
      res.json({success:true,data:rows,unreadCount:unread.count});
    } catch(e) {
      console.error('notifications list',e);
      res.status(500).json({success:false,message:'Could not load notifications.'});
    }
  });

  app.post('/api/notifications/read-all', async (req,res) => {
    try {
      const me = await user(req,res);
      if (!me) return;

      await db.run(
        'UPDATE bga_notifications SET is_read=1,read_at=? WHERE user_id=? AND is_read=0',
        [date(),me.id]
      );
      res.json({success:true,message:'All notifications marked as read.'});
    } catch(e) {
      console.error('notifications read all',e);
      res.status(500).json({success:false,message:'Could not update notifications.'});
    }
  });

  app.post('/api/notifications/:id/read', async (req,res) => {
    try {
      const me = await user(req,res);
      if (!me) return;

      const result = await db.run(
        'UPDATE bga_notifications SET is_read=1,read_at=? WHERE id=? AND user_id=?',
        [date(),req.params.id,me.id]
      );
      res.json({success:true,updated:result.changes>0});
    } catch(e) {
      console.error('notification read',e);
      res.status(500).json({success:false,message:'Could not update notification.'});
    }
  });

  app.delete('/api/notifications/:id', async (req,res) => {
    try {
      const me = await user(req,res);
      if (!me) return;

      await db.run(
        'DELETE FROM bga_notifications WHERE id=? AND user_id=?',
        [req.params.id,me.id]
      );
      res.json({success:true});
    } catch(e) {
      console.error('notification delete',e);
      res.status(500).json({success:false,message:'Could not delete notification.'});
    }
  });

  app.delete('/api/notifications', async (req,res) => {
    try {
      const me = await user(req,res);
      if (!me) return;

      await db.run('DELETE FROM bga_notifications WHERE user_id=?',[me.id]);
      res.json({success:true,message:'Notifications cleared.'});
    } catch(e) {
      console.error('notifications clear',e);
      res.status(500).json({success:false,message:'Could not clear notifications.'});
    }
  });

app.get('/api/public-profiles', async (req,res) => {
    try { await ensureSchema(); const category=safe(req.query.category,40);const q=safe(req.query.q,80);let sql=`SELECT p.id,p.user_id AS userId,p.category,p.display_name AS displayName,p.biography,p.evidence_url AS officialLink,p.verified,p.created_at AS createdAt,(SELECT COUNT(*) FROM bga_follows f WHERE f.profile_id=p.id) AS followers FROM bga_public_profiles p WHERE 1=1`;const params=[];if(CATEGORIES.includes(category)){sql+=' AND p.category=?';params.push(category);}if(q){sql+=' AND (p.display_name LIKE ? OR p.biography LIKE ?)';const term='%'+q.replace(/[%_\\]/g,'')+'%';params.push(term,term);}sql+=' ORDER BY p.verified DESC,p.display_name COLLATE NOCASE LIMIT 100';const rows=await db.all(sql,params);res.json({success:true,data:rows}); }
    catch(e){console.error('public profiles list',e);res.status(500).json({success:false,message:'Could not load public profiles.'});}
  });
  app.post('/api/public-profiles/apply', async (req,res) => {
    try {const me=await user(req,res);if(!me)return;const category=safe(req.body.category,40),display=safe(req.body.displayName,100),bio=safe(req.body.biography,1500),link=safe(req.body.officialLink,300);if(!CATEGORIES.includes(category)||display.length<2||bio.length<20)return res.status(400).json({success:false,message:'Choose a category, enter a display name, and provide a biography of at least 20 characters.'});if(link&&!/^https:\/\//i.test(link))return res.status(400).json({success:false,message:'Official link must start with https://'});const old=await db.get('SELECT status FROM bga_profile_applications WHERE user_id=?',[me.id]);if(old&&old.status==='pending')return res.status(409).json({success:false,message:'You already have a pending application.'});const appId=id(),now=date();await db.run('INSERT OR REPLACE INTO bga_profile_applications (id,user_id,category,display_name,biography,evidence_url,status,created_at) VALUES (?,?,?,?,?,?,?,?)',[appId,me.id,category,display,bio,link,'pending',now]);res.status(201).json({success:true,message:'Profile application submitted for review.',data:{id:appId,status:'pending'}});}
    catch(e){console.error('profile apply',e);res.status(500).json({success:false,message:'Could not submit profile application.'});}
  });
  app.get('/api/public-profiles/mine', async (req,res) => {try{const me=await user(req,res);if(!me)return;const profile=await db.get('SELECT id,category,display_name AS displayName,biography,evidence_url AS officialLink,verified FROM bga_public_profiles WHERE user_id=?',[me.id]);const application=await db.get('SELECT status,review_note AS reviewNote,created_at AS createdAt FROM bga_profile_applications WHERE user_id=?',[me.id]);res.json({success:true,data:{profile,application}});}catch(e){res.status(500).json({success:false,message:'Could not load your profile status.'});}});
  app.post('/api/public-profiles/:id/follow', async (req,res) => {try{const me=await user(req,res);if(!me)return;const profile=await db.get('SELECT id,user_id FROM bga_public_profiles WHERE id=?',[req.params.id]);if(!profile)return res.status(404).json({success:false,message:'Profile not found.'});if(profile.user_id===me.id)return res.status(400).json({success:false,message:'You cannot follow your own profile.'});const existing=await db.get('SELECT 1 AS ok FROM bga_follows WHERE follower_id=? AND profile_id=?',[me.id,profile.id]);if(existing){await db.run('DELETE FROM bga_follows WHERE follower_id=? AND profile_id=?',[me.id,profile.id]);return res.json({success:true,following:false});}await db.run('INSERT INTO bga_follows (follower_id,profile_id,created_at) VALUES (?,?,?)',[me.id,profile.id,date()]);res.json({success:true,following:true});}catch(e){console.error('follow',e);res.status(500).json({success:false,message:'Could not update follow status.'});}});

  app.get('/api/media', async (req,res) => {try{await ensureSchema();const type=safe(req.query.type,10);if(type&&!['audio','video'].includes(type))return res.status(400).json({success:false,message:'Media type must be audio or video.'});const rows=await db.all(`SELECT m.id,m.media_type AS mediaType,m.title,m.description,m.media_url AS mediaUrl,m.publitio_file_id AS publitioFileId,m.mime_type AS mimeType,m.bytes,m.created_at AS createdAt,u.full_name AS authorName FROM bga_media_posts m JOIN users u ON u.id=m.user_id WHERE m.moderation_status='approved' ${type?'AND m.media_type=?':''} ORDER BY m.created_at DESC LIMIT 100`,type?[type]:[]);for(const item of rows){if(item.mediaType==='video'){try{await ensurePublitioPublic(item.mediaUrl,item.publitioFileId);}catch(err){console.error('Approved Publitio video publish check failed:',item.id,err.message);}}}res.json({success:true,data:rows});}catch(e){console.error('media list',e);res.status(500).json({success:false,message:'Could not load media.'});}});

  // Founder/moderator queue: uploaded media remains private until approved.
  app.get('/api/admin-center/media', async (req,res) => {
    try { const me=await requireRole(req,res,['media_moderator']); if(!me)return;
      const rows=await db.all(`SELECT m.id,m.media_type AS mediaType,m.title,m.description,m.media_url AS mediaUrl,m.created_at AS createdAt,u.full_name AS authorName,u.email FROM bga_media_posts m JOIN users u ON u.id=m.user_id WHERE m.moderation_status='pending' ORDER BY m.created_at ASC LIMIT 100`);
      res.json({success:true,data:rows});
    } catch(e) { console.error('media moderation queue',e); res.status(500).json({success:false,message:'Could not load pending media.'}); }
  });
  app.post('/api/admin-center/media/:id/review', async (req,res) => {
    try { const me=await requireRole(req,res,['media_moderator']); if(!me)return;
      const decision=safe(req.body.decision,20);
      if(!['approve','reject'].includes(decision))return res.status(400).json({success:false,message:'Choose approve or reject.'});
      const item=await db.get("SELECT id FROM bga_media_posts WHERE id=? AND moderation_status='pending'",[req.params.id]);
      if(!item)return res.status(404).json({success:false,message:'Pending media was not found.'});
      if(decision==='approve') {
        const media=await db.get('SELECT media_type AS mediaType,media_url AS mediaUrl,publitio_file_id AS publitioFileId FROM bga_media_posts WHERE id=?',[item.id]);
        if(media&&media.mediaType==='video') await ensurePublitioPublic(media.mediaUrl,media.publitioFileId);
      }
      await db.run('UPDATE bga_media_posts SET moderation_status=?,reviewed_by=?,reviewed_at=? WHERE id=? AND moderation_status=\'pending\'',[decision==='approve'?'approved':'rejected',me.id,date(),item.id]);
      await audit(me.id,'media_'+decision,item.id,'Media moderation decision: '+decision);
      res.json({success:true,message:decision==='approve'?'Media approved and published.':'Media rejected and kept unpublished.'});
    } catch(e) { console.error('media moderation review',e); res.status(500).json({success:false,message:'Could not review media.'}); }
  });

  app.post('/api/media/upload-auth', async (req,res) => {
    try {
      const me=await user(req,res); if(!me)return;
      const type=safe(req.body.type,10);
      const title=safe(req.body.title,120);
      const description=safe(req.body.description,1000);
      const mime=safe(req.body.mimeType,60).split(';')[0].toLowerCase();
      const extMap={
        'audio/mpeg':'mp3','audio/wav':'wav','audio/x-wav':'wav',
        'audio/ogg':'ogg','audio/mp4':'m4a','video/mp4':'mp4',
        'video/webm':'webm','audio/webm':'webm'
      };
      if(!['audio','video'].includes(type)||!title)
        return res.status(400).json({success:false,message:'Provide a media type and title.'});
      if((type==='audio'&&!mime.startsWith('audio/'))||(type==='video'&&!mime.startsWith('video/'))||!extMap[mime])
        return res.status(415).json({success:false,message:'Unsupported media format. Allowed: MP3, WAV, OGG, M4A, MP4 and WebM.'});
      if(!process.env.PUBLITIO_API_KEY||!process.env.PUBLITIO_API_SECRET)
        return res.status(503).json({success:false,message:'Publitio API credentials must be configured.'});
      const token=crypto.randomUUID();
      const auth=publitioSignature();
      const now=date();
      const expiresAt=new Date(Date.now()+15*60*1000).toISOString();
      await db.run(
        'INSERT INTO bga_media_upload_intents (id,user_id,media_type,title,description,mime_type,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [token,me.id,type,title,description,mime,expiresAt,'pending',now]
      );
      res.json({
        success:true,
        data:{
          token,
          title,
          description,
          extension:extMap[mime],
          maxBytes:type==='audio'?25*1024*1024:500*1024*1024
        }
      });
    } catch(e) {
      console.error('Publitio upload preparation failed:',e.message);
      res.status(500).json({success:false,message:'Could not prepare secure media upload.'});
    }
  });

  // Stream authenticated browser uploads through this server so Publitio's
  // API signature and secret never need to be exposed to the browser.
  app.post('/api/media/upload-file', async (req,res) => {
    try {
      const me=await user(req,res); if(!me)return;
      const token=safe(req.headers['x-bga-upload-token'],80);
      if(!token)return res.status(400).json({success:false,message:'Upload session is missing.'});
      const intent=await db.get(
        "SELECT * FROM bga_media_upload_intents WHERE id=? AND user_id=? AND status='pending' AND expires_at>?",
        [token,me.id,date()]
      );
      if(!intent)return res.status(410).json({success:false,message:'Upload session expired or already used. Please start again.'});

      const contentType=String(req.headers['content-type']||'');
      if(!/^multipart\/form-data\s*;\s*boundary=/i.test(contentType))
        return res.status(415).json({success:false,message:'Upload must use multipart form data.'});

      const maxBytes=intent.media_type==='audio'?25*1024*1024:500*1024*1024;
      const declaredLength=Number(req.headers['content-length']||0);
      if(declaredLength>maxBytes+1024*1024)
        return res.status(413).json({success:false,message:'File exceeds the allowed upload size.'});

      const auth=publitioSignature();
      const uploadUrl='https://api.publit.io/v1/files/create?'+new URLSearchParams(auth).toString();
      let received=0;
      const limitedBody=req.pipe(new Transform({
        transform(chunk,encoding,callback) {
          received+=chunk.length;
          if(received>maxBytes+1024*1024) return callback(new Error('Upload exceeds the allowed size.'));
          callback(null,chunk);
        }
      }));
      const headers={
        'Content-Type':contentType,
        'Accept':'application/json'
      };
      if(declaredLength>0)headers['Content-Length']=String(declaredLength);

      const upstream=await fetch(uploadUrl,{
        method:'POST',
        headers,
        body:limitedBody,
        duplex:'half'
      });
      const raw=await upstream.text();
      let payload;
      try { payload=JSON.parse(raw); }
      catch { payload={success:false,message:'Publitio returned an unreadable response.'}; }
      return res.status(upstream.status).json(payload);
    } catch(e) {
      if(/exceeds the allowed size/i.test(String(e.message)))
        return res.status(413).json({success:false,message:'File exceeds the allowed upload size.'});
      console.error('Publitio proxied upload failed:',e.message);
      if(!res.headersSent)
        return res.status(502).json({success:false,message:'BabaGoAgain could not complete the upload to Publitio. Please try again.'});
    }
  });

  app.post('/api/media/upload-complete', async (req,res) => {
    try {
      const me=await user(req,res); if(!me)return;
      const token=safe(req.body.token,80);
      const fileId=safe(req.body.fileId,80);
      if(!token||!fileId)return res.status(400).json({success:false,message:'Upload confirmation is incomplete.'});
      const intent=await db.get(
        "SELECT * FROM bga_media_upload_intents WHERE id=? AND user_id=? AND status='pending' AND expires_at>?",
        [token,me.id,date()]
      );
      if(!intent)return res.status(410).json({success:false,message:'Upload session expired or already used. Please start again.'});
      const auth=publitioSignature();
      const verifyUrl='https://api.publit.io/v1/files/show/'+encodeURIComponent(fileId)+'?'+new URLSearchParams(auth).toString();
      const response=await fetch(verifyUrl,{method:'GET',headers:{Accept:'application/json'}});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok||payload.success!==true) {
        throw new Error('Publitio could not verify the uploaded file (HTTP '+response.status+').');
      }
      // Publitio normally returns file fields at the top level; some API responses
      // wrap them in "message". Normalize both documented response shapes.
      const asset=payload.message&&typeof payload.message==='object'
        ? {...payload,...payload.message}
        : payload;
      const extMap={
        'audio/mpeg':['mp3'],'audio/mp3':['mp3'],
        'audio/wav':['wav'],'audio/x-wav':['wav'],
        'audio/ogg':['ogg'],'audio/mp4':['m4a','mp4'],
        'video/mp4':['mp4'],'video/webm':['webm'],
        'audio/webm':['webm']
      };
      const maxBytes=intent.media_type==='audio'?25*1024*1024:500*1024*1024;
      const expectedType=String(intent.media_type||'').toLowerCase();
      const expectedExtensions=extMap[String(intent.mime_type||'').toLowerCase()]||[];
      const actualType=String(asset.type||'').toLowerCase();
      const actualExtension=String(asset.extension||'').toLowerCase().replace(/^\\./,'');
      const actualSize=Number(asset.size);
      const mediaUrl=safe(asset.url_preview||asset.url,1000);
      const validUrl=(()=>{try{
        const u=new URL(mediaUrl);
        return u.protocol==='https:'&&/(^|\.)publit\.io$/i.test(u.hostname);
      }catch{return false;}})();
      const validId=String(asset.id||'')===fileId;
      // Some Publitio file-show responses omit "type"; in that case,
      // accept only when the extension is one explicitly allowed for the
      // requested MIME type (the extension check below remains mandatory).
      const validType=actualType ? actualType===expectedType : expectedExtensions.includes(actualExtension);
      const validExtension=expectedExtensions.includes(actualExtension);
      const validSize=Number.isFinite(actualSize)&&actualSize>0&&actualSize<=maxBytes;
      console.info('Publitio verification checks:',{
        idMatch:validId,type:actualType,expectedType,extension:actualExtension,
        expectedExtensions,size:actualSize,maxBytes,urlValid:validUrl,
        responseKeys:Object.keys(asset)
      });
      if(!validId||!validType||!validExtension||!validSize||!validUrl) {
        await db.run("UPDATE bga_media_upload_intents SET status='rejected' WHERE id=?",[token]);
        return res.status(400).json({success:false,message:'Publitio received the file, but its returned media details did not match the upload. Please contact support before retrying.'});
      }
      const now=date();
      await db.transaction(async tx=>{
        // Lock and consume the upload intent before creating the media row.
        // Two simultaneous completion requests must never publish the same intent twice.
        const lockedIntent = await tx.get(
          "SELECT id FROM bga_media_upload_intents WHERE id=? AND user_id=? AND status='pending' AND expires_at>? FOR UPDATE",
          [token,me.id,date()]
        );
        if (!lockedIntent) {
          throw Object.assign(new Error('This upload session has already been completed or expired.'), { statusCode: 409 });
        }
        const consumed = await tx.run(
          "UPDATE bga_media_upload_intents SET status='completed' WHERE id=? AND user_id=? AND status='pending'",
          [token,me.id]
        );
        if (consumed.changes !== 1) {
          throw Object.assign(new Error('This upload session has already been completed or expired.'), { statusCode: 409 });
        }
        await tx.run(
          'INSERT INTO bga_media_posts (id,user_id,media_type,title,description,media_url,publitio_file_id,mime_type,bytes,moderation_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [token,me.id,intent.media_type,intent.title,intent.description,mediaUrl,fileId,intent.mime_type,Number(asset.size),'pending',now]
        );
      });
      res.status(201).json({success:true,message:'Upload complete. Your media is awaiting moderator approval.'});
    } catch(e) {
      if (e.statusCode === 409) {
        return res.status(409).json({success:false,message:e.message});
      }
      console.error('Publitio upload confirmation failed:',e.message);
      res.status(502).json({success:false,message:'The upload reached Publitio but could not be verified. Please contact support before retrying.'});
    }
  });

  // Community reporting: members can report content; moderators review reports.
  app.post('/api/community/reports', async (req,res) => {
    try {
      const me = await user(req,res); if (!me) return;
      const type = safe(req.body.targetType,20);
      const targetId = safe(req.body.targetId,100);
      const reason = safe(req.body.reason,60);
      const details = safe(req.body.details,1000);
      const reasons = ['spam','harassment','hate_or_threats','misinformation','inappropriate_content','impersonation','other'];
      if (!['post','comment','group','event'].includes(type) || !targetId || !reasons.includes(reason)) {
        return res.status(400).json({success:false,message:'Select valid content and a report reason.'});
      }
      const tables = {post:'community_posts',comment:'post_comments',group:'community_groups',event:'community_events'};
      const target = await db.get('SELECT id FROM ' + tables[type] + ' WHERE id=?',[targetId]);
      if (!target) return res.status(404).json({success:false,message:'The reported content no longer exists.'});
      if (type === 'post') {
        const own = await db.get('SELECT user_id AS userId FROM community_posts WHERE id=?',[targetId]);
        if (String(own.userId) === String(me.id)) return res.status(400).json({success:false,message:'You cannot report your own post.'});
      }
      if (type === 'comment') {
        const own = await db.get('SELECT user_id AS userId FROM post_comments WHERE id=?',[targetId]);
        if (String(own.userId) === String(me.id)) return res.status(400).json({success:false,message:'You cannot report your own comment.'});
      }
      try {
        await db.run('INSERT INTO bga_community_reports (id,reporter_id,target_type,target_id,reason,details,created_at) VALUES (?,?,?,?,?,?,?)',
          [id(),me.id,type,targetId,reason,details,date()]);
      } catch (e) {
        if (/UNIQUE constraint failed/i.test(String(e.message))) return res.status(409).json({success:false,message:'You have already reported this content.'});
        throw e;
      }
      res.status(201).json({success:true,message:'Report submitted for moderator review.'});
    } catch(e) {
      console.error('Community report submission failed:',e);
      res.status(500).json({success:false,message:'Could not submit report.'});
    }
  });

  app.get('/api/admin-center/community-reports', async (req,res) => {
    try {
      const me = await requireRole(req,res,['community_moderator']); if (!me) return;
      const rows = await db.all(`
        SELECT r.id,r.target_type AS targetType,r.target_id AS targetId,r.reason,r.details,
          r.status,r.created_at AS createdAt,r.review_note AS reviewNote,
          reporter.full_name AS reporterName
        FROM bga_community_reports r
        JOIN users reporter ON reporter.id=r.reporter_id
        WHERE r.status='pending'
        ORDER BY r.created_at ASC LIMIT 200
      `);
      res.json({success:true,data:rows});
    } catch(e) {
      console.error('Community report queue failed:',e);
      res.status(500).json({success:false,message:'Could not load reports.'});
    }
  });

  app.post('/api/admin-center/community-reports/:id/review', async (req,res) => {
    try {
      const me = await requireRole(req,res,['community_moderator']); if (!me) return;
      const decision = safe(req.body.decision,20);
      const note = safe(req.body.note,500);
      if (!['dismiss','resolve','hide'].includes(decision)) {
        return res.status(400).json({success:false,message:'Choose dismiss, resolve, or hide.'});
      }
      const report = await db.get("SELECT * FROM bga_community_reports WHERE id=? AND status='pending'",[req.params.id]);
      if (!report) return res.status(404).json({success:false,message:'Pending report not found.'});
      const now = date();
      await db.transaction(async tx => {
        await tx.run("UPDATE bga_community_reports SET status=?,reviewed_by=?,reviewed_at=?,review_note=? WHERE id=? AND status='pending'",
          [decision==='dismiss'?'dismissed':decision==='hide'?'hidden':'resolved',me.id,now,note,report.id]);
        if (decision === 'hide' && report.target_type === 'post') {
          await tx.run('DELETE FROM post_comments WHERE post_id=?',[report.target_id]);
          await tx.run('DELETE FROM community_posts WHERE id=?',[report.target_id]);
        } else if (decision === 'hide' && report.target_type === 'comment') {
          await tx.run('DELETE FROM post_comments WHERE id=?',[report.target_id]);
        } else if (decision === 'hide' && report.target_type === 'group') {
          await tx.run('DELETE FROM group_members WHERE group_id=?',[report.target_id]);
          await tx.run('DELETE FROM community_groups WHERE id=?',[report.target_id]);
        } else if (decision === 'hide' && report.target_type === 'event') {
          await tx.run('DELETE FROM event_attendees WHERE event_id=?',[report.target_id]);
          await tx.run('DELETE FROM community_events WHERE id=?',[report.target_id]);
        }
      });
      await audit(me.id,'community_report_'+decision,report.target_id,report.target_type+': '+note);
      res.json({success:true,message:decision==='hide'?'Report reviewed and content removed.':'Report reviewed.'});
    } catch(e) {
      console.error('Community report review failed:',e);
      res.status(500).json({success:false,message:'Could not review report.'});
    }
  });

  app.get('/api/admin-center/summary', async (req,res) => {try{const me=await requireRole(req,res,['profile_verification','community_moderator','media_moderator','member_support','wallet_admin']);if(!me)return;const r=await roles(me.id);const founder=r.includes('founder');const summary={roles:r,founder};if(founder||r.includes('profile_verification'))summary.pendingProfiles=Number((await db.get("SELECT COUNT(*) AS n FROM bga_profile_applications WHERE status='pending'"))?.n||0);if(founder)summary.administrators=Number((await db.get('SELECT COUNT(DISTINCT user_id) AS n FROM bga_admin_roles'))?.n||0);res.json({success:true,data:summary});}catch(e){console.error('admin summary',e);res.status(500).json({success:false,message:'Could not load administration summary.'});}});
  app.get('/api/admin-center/profile-applications', async (req,res) => {try{const me=await requireRole(req,res,['profile_verification']);if(!me)return;const rows=await db.all(`SELECT a.id,a.user_id AS userId,u.full_name AS memberName,u.email,a.category,a.display_name AS displayName,a.biography,a.evidence_url AS officialLink,a.status,a.created_at AS createdAt FROM bga_profile_applications a JOIN users u ON u.id=a.user_id WHERE a.status='pending' ORDER BY a.created_at ASC LIMIT 100`);res.json({success:true,data:rows});}catch(e){res.status(500).json({success:false,message:'Could not load applications.'});}});
  app.post('/api/admin-center/profile-applications/:id/review', async (req,res) => {try{const me=await requireRole(req,res,['profile_verification']);if(!me)return;const decision=safe(req.body.decision,20),note=safe(req.body.note,500);if(!['approve','reject'].includes(decision))return res.status(400).json({success:false,message:'Decision must be approve or reject.'});const appRow=await db.get("SELECT * FROM bga_profile_applications WHERE id=? AND status='pending'",[req.params.id]);if(!appRow)return res.status(404).json({success:false,message:'Pending application not found.'});const now=date();await db.transaction(async tx =>{await tx.run('UPDATE bga_profile_applications SET status=?,reviewed_by=?,reviewed_at=?,review_note=? WHERE id=? AND status=\'pending\'',[decision==='approve'?'approved':'rejected',me.id,now,note,appRow.id]);if(decision==='approve'){const profileId=id();await tx.run('INSERT OR REPLACE INTO bga_public_profiles (id,user_id,category,display_name,biography,evidence_url,verified,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)',[profileId,appRow.user_id,appRow.category,appRow.display_name,appRow.biography,appRow.evidence_url,now,now]);}});await audit(me.id,'profile_'+decision,appRow.user_id,note);res.json({success:true,message:decision==='approve'?'Profile approved and verified.':'Application rejected.'});}catch(e){console.error('profile review',e);res.status(500).json({success:false,message:'Could not review profile application.'});}});
  app.get('/api/admin-center/administrators', async (req,res) => {try{const me=await requireRole(req,res,[]);if(!me)return;const r=await roles(me.id);if(!r.includes('founder'))return res.status(403).json({success:false,message:'Only the founder can manage administrators.'});const rows=await db.all(`SELECT u.id,u.full_name AS name,u.email,GROUP_CONCAT(ar.role,',') AS roles FROM bga_admin_roles ar JOIN users u ON u.id=ar.user_id GROUP BY u.id ORDER BY u.full_name`);res.json({success:true,data:rows});}catch(e){res.status(500).json({success:false,message:'Could not load administrators.'});}});
  app.post('/api/admin-center/administrators', async (req,res) => {try{const me=await requireRole(req,res,[]);if(!me)return;const myRoles=await roles(me.id);if(!myRoles.includes('founder'))return res.status(403).json({success:false,message:'Only the founder can appoint administrators.'});const email=safe(req.body.email,254).toLowerCase(),role=safe(req.body.role,50);if(!email||!ADMIN_ROLES.includes(role))return res.status(400).json({success:false,message:'Provide a verified member email and a permitted administrator role.'});const target=await db.get("SELECT id FROM users WHERE lower(email)=? AND status='active' AND email_verified=1",[email]);if(!target)return res.status(404).json({success:false,message:'No active, email-verified member matches that email.'});await db.run('INSERT OR IGNORE INTO bga_admin_roles (user_id,role,granted_by,granted_at) VALUES (?,?,?,?)',[target.id,role,me.id,date()]);await audit(me.id,'admin_role_granted',target.id,role);res.status(201).json({success:true,message:'Administrator role granted.'});}catch(e){console.error('appoint admin',e);res.status(500).json({success:false,message:'Could not appoint administrator.'});}});
  app.delete('/api/admin-center/administrators/:userId/:role', async (req,res) => {try{const me=await requireRole(req,res,[]);if(!me)return;const myRoles=await roles(me.id);if(!myRoles.includes('founder'))return res.status(403).json({success:false,message:'Only the founder can remove administrator roles.'});const targetId=safe(req.params.userId,100),role=safe(req.params.role,50);if(role==='founder')return res.status(400).json({success:false,message:'Founder status cannot be removed through this endpoint.'});if(!ADMIN_ROLES.includes(role))return res.status(400).json({success:false,message:'Unknown administrator role.'});const result=await db.run('DELETE FROM bga_admin_roles WHERE user_id=? AND role=?',[targetId,role]);if(!result.changes)return res.status(404).json({success:false,message:'Administrator role not found.'});await audit(me.id,'admin_role_removed',targetId,role);res.json({success:true,message:'Administrator role removed.'});}catch(e){res.status(500).json({success:false,message:'Could not remove administrator role.'});}});
  app.get('/api/admin-center/audit', async (req,res) => {try{const me=await requireRole(req,res,[]);if(!me)return;if(!(await roles(me.id)).includes('founder'))return res.status(403).json({success:false,message:'Only the founder can view the administrator audit log.'});const rows=await db.all('SELECT a.id,a.action,a.target_id AS targetId,a.details,a.created_at AS createdAt,u.full_name AS actorName FROM bga_admin_audit a JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100');res.json({success:true,data:rows});}catch(e){res.status(500).json({success:false,message:'Could not load audit log.'});}});

  // A safe configuration diagnostic: never returns secret values.
  app.get('/api/security/status', async (req,res) => {try{const me=await user(req,res);if(!me)return;const r=await roles(me.id);if(!r.includes('founder'))return res.status(403).json({success:false,message:'Founder access required.'});res.json({success:true,data:{sessionSecretConfigured:Boolean(process.env.SESSION_SECRET&&process.env.SESSION_SECRET.length>=32&&process.env.SESSION_SECRET!=='CHANGE_THIS_SESSION_SECRET_BEFORE_PUBLIC_DEPLOYMENT'),walletEncryptionKeyConfigured:Boolean(process.env.WALLET_ENCRYPTION_KEY&&process.env.WALLET_ENCRYPTION_KEY.trim().length>=32),founderEmailConfigured:Boolean(process.env.BGA_FOUNDER_EMAIL),opayPayoutsEnabled:process.env.OPAY_PAYOUT_ENABLED==='true',opayMerchantConfigured:Boolean(process.env.OPAY_MERCHANT_ID),opayPrivateKeyConfigured:Boolean(process.env.OPAY_PRIVATE_KEY),opayUsesHttps:Boolean(/^https:\/\//i.test(process.env.OPAY_BASE_URL||'')),productionCookieSecure:process.env.COOKIE_SECURE==='true'}});}catch(e){res.status(500).json({success:false,message:'Could not inspect security configuration.'});}});

  // Defer schema creation until core MySQL tables (including users) exist.
  return async function initializeFeatures() {
    await ensureSchema();
    await bootstrapFounder();
  };
}

module.exports = { install, CATEGORIES, ADMIN_ROLES };
