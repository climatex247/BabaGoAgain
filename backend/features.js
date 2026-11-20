'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
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
  const { db, authenticatedUser, frontendPath, referrals, cloudinary } = ctx;
  const mediaDir = path.join(frontendPath, 'uploads', 'media');
  let schemaPromise;

  async function ensureSchema() {
    if (!schemaPromise) schemaPromise = (async () => {
      await db.ready();
      const statements = [
        `CREATE TABLE IF NOT EXISTS bga_conversations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS bga_conversation_members (conversation_id TEXT NOT NULL REFERENCES bga_conversations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at TEXT NOT NULL, PRIMARY KEY(conversation_id,user_id))`,
        `CREATE TABLE IF NOT EXISTS bga_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES bga_conversations(id) ON DELETE CASCADE, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at TEXT NOT NULL, read_at TEXT)`,
        `CREATE INDEX IF NOT EXISTS idx_bga_messages_conversation ON bga_messages(conversation_id,created_at)`,
        `CREATE TABLE IF NOT EXISTS bga_profile_applications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, category TEXT NOT NULL, display_name TEXT NOT NULL, biography TEXT NOT NULL, evidence_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, review_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(user_id))`,
        `CREATE TABLE IF NOT EXISTS bga_public_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, category TEXT NOT NULL, display_name TEXT NOT NULL, biography TEXT NOT NULL, evidence_url TEXT NOT NULL DEFAULT '', verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS bga_follows (follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, profile_id TEXT NOT NULL REFERENCES bga_public_profiles(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(follower_id,profile_id))`,
        `CREATE TABLE IF NOT EXISTS bga_media_posts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, media_type TEXT NOT NULL CHECK(media_type IN ('audio','video')), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', media_url TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL, moderation_status VARCHAR(20) NOT NULL DEFAULT 'pending', reviewed_by TEXT, reviewed_at TEXT, created_at TEXT NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS idx_bga_media_created ON bga_media_posts(media_type,created_at)`,
        `CREATE TABLE IF NOT EXISTS bga_admin_roles (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, granted_by TEXT REFERENCES users(id), granted_at TEXT NOT NULL, PRIMARY KEY(user_id,role))`,
        `CREATE TABLE IF NOT EXISTS bga_admin_audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, target_id TEXT, details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS bga_community_reports (
          id TEXT PRIMARY KEY,
          reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL CHECK(target_type IN ('post','comment','group','event')),
          target_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dismissed','resolved','hidden')),
          reviewed_by TEXT REFERENCES users(id),
          reviewed_at TEXT,
          review_note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          UNIQUE(reporter_id,target_type,target_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_bga_reports_queue ON bga_community_reports(status,created_at)`
      ];
      for (const sql of statements) {
        // Secondary indexes are optional; skip them during initialization.
        if (/^CREATE INDEX IF NOT EXISTS/i.test(sql)) continue;
        await db.run(sql);
      }
      // Add moderation fields after creating the table (safe for old and new databases).
      try { await db.run("ALTER TABLE bga_media_posts ADD COLUMN moderation_status VARCHAR(20) NOT NULL DEFAULT 'pending'"); } catch (e) { if (!/duplicate|exists|1060|SQLITE_ERROR/i.test(String(e.message))) throw e; }
      try { await db.run("ALTER TABLE bga_media_posts ADD COLUMN reviewed_by TEXT"); } catch (e) { if (!/duplicate|exists|1060|SQLITE_ERROR/i.test(String(e.message))) throw e; }
      try { await db.run("ALTER TABLE bga_media_posts ADD COLUMN reviewed_at TEXT"); } catch (e) { if (!/duplicate|exists|1060|SQLITE_ERROR/i.test(String(e.message))) throw e; }

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
    try { const me=await user(req,res);if(!me)return; const membership=await db.get('SELECT 1 AS ok FROM bga_conversation_members WHERE conversation_id=? AND user_id=?',[req.params.id,me.id]);if(!membership)return res.status(404).json({success:false,message:'Conversation not found.'}); await db.run('UPDATE bga_messages SET read_at=? WHERE conversation_id=? AND sender_id<>? AND read_at IS NULL',[date(),req.params.id,me.id]); const rows=await db.all(`SELECT m.id,m.body,m.created_at AS createdAt,m.sender_id AS senderId,m.read_at AS readAt,u.full_name AS senderName FROM bga_messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? ORDER BY m.created_at ASC LIMIT 300`,[req.params.id]);res.json({success:true,data:rows}); }
    catch(e){console.error('message read',e);res.status(500).json({success:false,message:'Could not load messages.'});}
  });
  app.post('/api/messages/conversations/:id', async (req,res) => {
    try { const me=await user(req,res);if(!me)return;const body=safe(req.body.body,4000);if(!body)return res.status(400).json({success:false,message:'Message cannot be empty.'});const membership=await db.get('SELECT 1 AS ok FROM bga_conversation_members WHERE conversation_id=? AND user_id=?',[req.params.id,me.id]);if(!membership)return res.status(404).json({success:false,message:'Conversation not found.'});const msg=id(),now=date();await db.transaction(async tx =>{await tx.run('INSERT INTO bga_messages (id,conversation_id,sender_id,body,created_at) VALUES (?,?,?,?,?)',[msg,req.params.id,me.id,body,now]);await tx.run('UPDATE bga_conversations SET updated_at=? WHERE id=?',[now,req.params.id]);});try{await db.run("CREATE TABLE IF NOT EXISTS bga_notifications (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'general',title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',link TEXT NOT NULL DEFAULT '/notifications',is_read INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,read_at TEXT)");const recipients=await db.all('SELECT user_id AS userId FROM bga_conversation_members WHERE conversation_id=? AND user_id<>?',[req.params.id,me.id]);for(const recipient of recipients){await db.run('INSERT INTO bga_notifications (id,user_id,type,title,body,link,is_read,created_at) VALUES (?,?,?,?,?,?,0,?)',[id(),recipient.userId,'message','New message from '+safe(me.full_name,100),body.slice(0,300),'/messages',now]);}}catch(notificationError){console.error('message notification',notificationError);}res.status(201).json({success:true,data:{id:msg,body,createdAt:now,senderId:me.id,senderName:me.full_name}}); }
    catch(e){console.error('message send',e);res.status(500).json({success:false,message:'Could not send message.'});}
  });


  // Baba Go Again notification centre
  const ensureNotificationTable = async () => db.run(`
    CREATE TABLE IF NOT EXISTS bga_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'general',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '/notifications',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      read_at TEXT
    )
  `);

  app.get('/notifications', (req,res) =>
    res.sendFile(path.join(frontendPath,'notifications.html'))
  );

  app.get('/api/notifications', async (req,res) => {
    try {
      const me = await user(req,res);
      if (!me) return;
      await ensureNotificationTable();
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
      await ensureNotificationTable();
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
      await ensureNotificationTable();
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
      await ensureNotificationTable();
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
      await ensureNotificationTable();
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

  app.get('/api/media', async (req,res) => {try{await ensureSchema();const type=safe(req.query.type,10);if(type&&!['audio','video'].includes(type))return res.status(400).json({success:false,message:'Media type must be audio or video.'});const rows=await db.all(`SELECT m.id,m.media_type AS mediaType,m.title,m.description,m.media_url AS mediaUrl,m.mime_type AS mimeType,m.bytes,m.created_at AS createdAt,u.full_name AS authorName FROM bga_media_posts m JOIN users u ON u.id=m.user_id WHERE m.moderation_status='approved' ${type?'AND m.media_type=?':''} ORDER BY m.created_at DESC LIMIT 100`,type?[type]:[]);res.json({success:true,data:rows});}catch(e){console.error('media list',e);res.status(500).json({success:false,message:'Could not load media.'});}});

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
      await db.run('UPDATE bga_media_posts SET moderation_status=?,reviewed_by=?,reviewed_at=? WHERE id=? AND moderation_status=\'pending\'',[decision==='approve'?'approved':'rejected',me.id,date(),item.id]);
      await audit(me.id,'media_'+decision,item.id,'Media moderation decision: '+decision);
      res.json({success:true,message:decision==='approve'?'Media approved and published.':'Media rejected and kept unpublished.'});
    } catch(e) { console.error('media moderation review',e); res.status(500).json({success:false,message:'Could not review media.'}); }
  });

  app.post('/api/media/upload', async (req,res,next) => {
    try {
      const me=await user(req,res);
      if(!me)return;
      req.bgaMediaUser=me;
      next();
    } catch(e) {
      res.status(500).json({success:false,message:'Could not authorize upload.'});
    }
  }, async (req,res) => {
    const me=req.bgaMediaUser;
    if(!me)return;

    const type=safe(req.query.type,10);
    const title=safe(req.headers['x-media-title'],120);
    const description=safe(req.headers['x-media-description'],1000);
    const mime=safe(req.headers['content-type'],60).split(';')[0].toLowerCase();

    if(!['audio','video'].includes(type)||!title)
      return res.status(400).json({success:false,message:'Provide type=audio or type=video and X-Media-Title header.'});

    if(type==='audio'&&!mime.startsWith('audio/'))
      return res.status(400).json({success:false,message:'Audio uploads must use an audio content type.'});

    if(type==='video'&&!mime.startsWith('video/'))
      return res.status(400).json({success:false,message:'Video uploads must use a video content type.'});

    const extMap={
      'audio/mpeg':'.mp3',
      'audio/wav':'.wav',
      'audio/x-wav':'.wav',
      'audio/ogg':'.ogg',
      'audio/mp4':'.m4a',
      'video/mp4':'.mp4',
      'video/webm':'.webm',
      'audio/webm':'.webm'
    };

    const ext=extMap[mime];
    if(!ext)
      return res.status(415).json({success:false,message:'Unsupported media format. Allowed: MP3, WAV, OGG, M4A, MP4 and WebM.'});

    const length=Number(req.headers['content-length']||0);
    if(length>MAX_MEDIA_BYTES)
      return res.status(413).json({success:false,message:'Media exceeds the 500 MB upload limit.'});

    const cloudConfig=cloudinary.config();
    if(!cloudConfig.cloud_name || !cloudConfig.api_key || !cloudConfig.api_secret)
      return res.status(503).json({success:false,message:'Cloud media storage is not configured. Please contact support.'});

    let bytes=0;
    let prefix=Buffer.alloc(0);
    let failed=false;

    const validator=new Transform({
      transform(chunk,encoding,callback) {
        bytes+=chunk.length;

        if(bytes>MAX_MEDIA_BYTES) {
          failed=true;
          return callback(Object.assign(
            new Error('Media exceeds the 500 MB upload limit.'),
            {statusCode:413}
          ));
        }

        if(prefix.length<32)
          prefix=Buffer.concat([prefix,chunk.subarray(0,32-prefix.length)]);

        callback(null,chunk);
      },

      flush(callback) {
        let ok=false;

        if(mime==='audio/mpeg')
          ok=(prefix.length>3&&prefix.subarray(0,3).toString()==='ID3')||
             (prefix.length>1&&prefix[0]===0xff&&(prefix[1]&0xe0)===0xe0);
        else if(mime==='audio/wav'||mime==='audio/x-wav')
          ok=prefix.length>12&&prefix.subarray(0,4).toString()==='RIFF'&&prefix.subarray(8,12).toString()==='WAVE';
        else if(mime==='audio/ogg')
          ok=prefix.length>4&&prefix.subarray(0,4).toString()==='OggS';
        else if(mime==='audio/mp4'||mime==='video/mp4')
          ok=prefix.length>12&&prefix.subarray(4,8).toString()==='ftyp';
        else if(mime==='video/webm'||mime==='audio/webm')
          ok=prefix.length>4&&prefix.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));

        if(!ok)
          return callback(Object.assign(
            new Error('Unsupported media format or file signature.'),
            {statusCode:415}
          ));

        callback();
      }
    });

    const mediaId=id();
    let uploaded=null;

    try {
      const uploadResult=new Promise((resolve,reject) => {
        const uploadStream=cloudinary.uploader.upload_chunked_stream({
          resource_type:'video',
          folder:'baba-go-again/media',
          public_id:mediaId,
          chunk_size:6000000,
          overwrite:false
        },(error,result) => {
          if(error)return reject(error);
          if(result && result.done===false)return;
          if(result)return resolve(result);
          reject(new Error('Cloudinary did not return an upload result.'));
        });

        pipeline(req,validator,uploadStream).catch(reject);
      });

      uploaded=await uploadResult;

      if(!uploaded.secure_url||!uploaded.public_id)
        throw new Error('Cloudinary upload did not return a media URL.');

      const now=date();
      const url=uploaded.secure_url;

      try {
        await db.run(
          'INSERT INTO bga_media_posts (id,user_id,media_type,title,description,media_url,mime_type,bytes,moderation_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [mediaId,me.id,type,title,description,url,mime,bytes,'pending',now]
        );
      } catch(e) {
        await cloudinary.uploader.destroy(uploaded.public_id,{resource_type:'video'}).catch(()=>{});
        throw e;
      }

      return res.status(201).json({
        success:true,
        data:{
          id:mediaId,
          mediaType:type,
          title,
          description,
          mediaUrl:url,
          mimeType:mime,
          bytes,
          createdAt:now,
          moderationStatus:'pending'
        }
      });

    } catch(e) {
      if(res.headersSent)return;

      const status=e.statusCode||(failed?413:502);

      if(status>=500)
        console.error('Cloudinary media upload failed:',e.message);

      return res.status(status).json({
        success:false,
        message:status===413
          ?'Media exceeds the 500 MB upload limit.'
          :status===415
            ?e.message
            :'Media upload failed. Please check your connection and Cloudinary storage settings, then retry.'
      });
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

  // Ensure migrations are attempted during boot; each endpoint also awaits the same promise.
  ensureSchema().then(bootstrapFounder).catch(e => console.error('Baba Go Again feature schema initialization failed:', e.message));
}

module.exports = { install, CATEGORIES, ADMIN_ROLES };
