'use strict';

const crypto = require('crypto');

function createReferralService(db) {
  let schemaPromise;

  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.ready();

        await db.run(`
          CREATE TABLE IF NOT EXISTS bga_referral_codes (
            user_id VARCHAR(191) NOT NULL PRIMARY KEY,
            referral_code VARCHAR(32) NOT NULL UNIQUE,
            created_at VARCHAR(40) NOT NULL,
            CONSTRAINT fk_bga_referral_code_user
              FOREIGN KEY (user_id) REFERENCES users(id)
              ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await db.run(`
          CREATE TABLE IF NOT EXISTS bga_referral_relationships (
            user_id VARCHAR(191) NOT NULL PRIMARY KEY,
            sponsor_id VARCHAR(191) NOT NULL,
            matrix_parent_id VARCHAR(191) NOT NULL,
            position VARCHAR(5) NOT NULL,
            depth INT UNSIGNED NOT NULL,
            created_at VARCHAR(40) NOT NULL,
            UNIQUE KEY uq_bga_matrix_slot (matrix_parent_id, position),
            KEY idx_bga_sponsor (sponsor_id),
            KEY idx_bga_matrix_parent (matrix_parent_id),
            CONSTRAINT fk_bga_ref_user
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_bga_ref_sponsor
              FOREIGN KEY (sponsor_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_bga_ref_parent
              FOREIGN KEY (matrix_parent_id) REFERENCES users(id) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await db.run(`
          CREATE TABLE IF NOT EXISTS bga_referral_matrix_lock (
            id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
            touched_at VARCHAR(40) NOT NULL
          ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await db.run(
          'INSERT IGNORE INTO bga_referral_matrix_lock (id, touched_at) VALUES (1, ?)',
          [new Date().toISOString()]
        );
      })().catch(error => {
        schemaPromise = null;
        throw error;
      });
    }

    await schemaPromise;
  }

  function normalizeCode(value) {
    return String(value || '').trim().toUpperCase().slice(0, 32);
  }

  async function createUniqueCode(tx, userId, now) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = crypto.randomBytes(6).toString('hex').toUpperCase();

      try {
        await tx.run(
          `INSERT INTO bga_referral_codes
           (user_id, referral_code, created_at)
           VALUES (?, ?, ?)`,
          [userId, code, now]
        );

        return code;
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' && attempt < 7) continue;
        throw error;
      }
    }

    throw new Error('Could not generate a unique referral code.');
  }

  async function placeMember(tx, userId, sponsorId, now) {
    const rows = await tx.all(`
      SELECT user_id, matrix_parent_id, position, depth
      FROM bga_referral_relationships
    `);

    // Build direct-child and depth indexes once.
    const children = new Map();
    const depths = new Map();

    for (const row of rows) {
      const memberId = String(row.user_id);
      const parentId = String(row.matrix_parent_id);
      const position = String(row.position).toLowerCase();

      depths.set(memberId, Number(row.depth));

      if (!children.has(parentId)) {
        children.set(parentId, new Map());
      }

      children.get(parentId).set(position, memberId);
    }

    // Breadth-first search, always left before right.
    const queue = [String(sponsorId)];
    const visited = new Set(queue);

    for (let head = 0; head < queue.length; head++) {
      const parentId = queue[head];
      const occupied = children.get(parentId) || new Map();

      let position = null;

      if (!occupied.has('left')) {
        position = 'left';
      } else if (!occupied.has('right')) {
        position = 'right';
      }

      if (position) {
        await tx.run(
          `INSERT INTO bga_referral_relationships
           (user_id, sponsor_id, matrix_parent_id, position, depth, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            userId,
            sponsorId,
            parentId,
            position,
            (depths.get(parentId) || 0) + 1,
            now
          ]
        );

        return {
          matrixParentId: parentId,
          position
        };
      }

      // Both slots are occupied: enqueue left child, then right child.
      for (const side of ['left', 'right']) {
        const childId = occupied.get(side);

        if (childId && !visited.has(childId)) {
          visited.add(childId);
          queue.push(childId);
        }
      }
    }

    throw new Error('Could not find an available referral matrix position.');
  }

  async function registerMember(tx, userId, suppliedCode, allowRoot = false) {
    await tx.get(
      'SELECT id FROM bga_referral_matrix_lock WHERE id=1 FOR UPDATE'
    );

    const now = new Date().toISOString();
    const code = normalizeCode(suppliedCode);
    if (!code && !allowRoot) {
      const error = new Error('A referral code is required to register.');
      error.code = 'REFERRAL_CODE_REQUIRED';
      throw error;
    }

    let sponsorId = null;
    let placement = null;

    if (code) {
      const sponsor = await tx.get(
        `SELECT c.user_id
         FROM bga_referral_codes c
         JOIN users u ON u.id=c.user_id
         WHERE c.referral_code=?
           AND u.status='active'
           AND u.email_verified=1`,
        [code]
      );

      if (!sponsor) {
        const error = new Error('The referral code is invalid or belongs to an unverified account.');
        error.code = 'INVALID_REFERRAL_CODE';
        throw error;
      }

      sponsorId = String(sponsor.user_id);
      placement = await placeMember(tx, userId, sponsorId, now);
    }

    const referralCode = await createUniqueCode(tx, userId, now);

    return {
      referralCode,
      sponsorId,
      matrixParentId: placement ? placement.matrixParentId : null,
      position: placement ? placement.position : null
    };
  }

  async function getOrCreateMemberCode(userId) {
    await ensureSchema();

    return db.transaction(async tx => {
      // Serialize code creation with registration and backfill.
      await tx.get(
        'SELECT id FROM bga_referral_matrix_lock WHERE id=1 FOR UPDATE'
      );

      const member = await tx.get(`
        SELECT id
        FROM users
        WHERE id=?
          AND status='active'
          AND email_verified=1
        LIMIT 1
      `, [String(userId)]);

      if (!member) {
        throw new Error('Only active, verified members can have referral codes.');
      }

      const existing = await tx.get(
        'SELECT referral_code FROM bga_referral_codes WHERE user_id=?',
        [String(userId)]
      );

      if (existing) return existing.referral_code;

      return createUniqueCode(
        tx,
        String(userId),
        new Date().toISOString()
      );
    });
  }

  async function backfillVerifiedMembers() {
    await ensureSchema();

    return db.transaction(async tx => {
      // Serialize code generation with normal member registration.
      await tx.get(
        'SELECT id FROM bga_referral_matrix_lock WHERE id=1 FOR UPDATE'
      );

      const members = await tx.all(`
        SELECT u.id
        FROM users u
        LEFT JOIN bga_referral_codes c ON c.user_id=u.id
        WHERE u.status='active'
          AND u.email_verified=1
          AND c.user_id IS NULL
      `);

      let created = 0;

      for (const member of members) {
        await createUniqueCode(
          tx,
          String(member.id),
          new Date().toISOString()
        );
        created++;
      }

      return { checked: members.length, created };
    });
  }

  return {
    ensureSchema,
    registerMember,
    getOrCreateMemberCode,
    backfillVerifiedMembers
  };
}

module.exports = { createReferralService };
