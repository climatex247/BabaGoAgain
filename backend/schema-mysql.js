'use strict';

// Safe, additive MySQL schema bootstrap for core member accounts and auth tokens.
// Existing member rows are never dropped, truncated, or rewritten.
async function initializeCoreSchema(db) {
  await db.ready();

  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      phone VARCHAR(32) NOT NULL,
      email VARCHAR(254) NOT NULL,
      preferred_language VARCHAR(60) NOT NULL DEFAULT 'English',
      address VARCHAR(500) NOT NULL,
      state_id VARCHAR(64) NOT NULL,
      state_name VARCHAR(120) NOT NULL,
      lga_id VARCHAR(64) NOT NULL,
      lga_name VARCHAR(120) NOT NULL,
      ward_id VARCHAR(64) NOT NULL,
      ward_name VARCHAR(120) NOT NULL,
      polling_unit_id VARCHAR(64) NULL,
      roles_json LONGTEXT NOT NULL,
      other_role VARCHAR(120) NULL,
      password_hash VARCHAR(255) NOT NULL,
      session_version INT NOT NULL DEFAULT 0,
      email_verified TINYINT(1) NOT NULL DEFAULT 0,
      status VARCHAR(40) NOT NULL DEFAULT 'pending_verification',
      accepted_terms TINYINT(1) NOT NULL DEFAULT 0,
      accepted_privacy TINYINT(1) NOT NULL DEFAULT 0,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      UNIQUE KEY uq_users_email (email),
      UNIQUE KEY uq_users_phone (phone),
      KEY idx_users_created_at (created_at),
      KEY idx_users_status_verified (status, email_verified)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const requiredUserColumns = [
    'id','full_name','phone','email','preferred_language','address',
    'state_id','state_name','lga_id','lga_name','ward_id','ward_name',
    'polling_unit_id','roles_json','other_role','password_hash',
    'email_verified','status','accepted_terms','accepted_privacy',
    'created_at','updated_at'
  ];
  const [userColumns] = await db.pool.query(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    ['users']
  );
  const existingUserColumns = new Set(userColumns.map(row => row.COLUMN_NAME));
  const missingUserColumns = requiredUserColumns.filter(column => !existingUserColumns.has(column));
  if (missingUserColumns.length) {
    throw new Error('Existing users table is missing required columns: ' + missingUserColumns.join(', ') + '. No member data was changed.');
  }
  if (!existingUserColumns.has('session_version')) {
    await db.run('ALTER TABLE users ADD COLUMN session_version INT NOT NULL DEFAULT 0');
  }

  await db.run(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token_hash CHAR(64) NOT NULL PRIMARY KEY,
      user_id VARCHAR(191) NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      KEY idx_verification_user (user_id),
      KEY idx_verification_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash CHAR(64) NOT NULL PRIMARY KEY,
      user_id VARCHAR(191) NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      KEY idx_reset_user (user_id),
      KEY idx_reset_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  for (const table of ['email_verification_tokens', 'password_reset_tokens']) {
    const [columns] = await db.pool.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table]
    );
    const found = new Set(columns.map(row => row.COLUMN_NAME));
    const missing = ['token_hash','user_id','expires_at','created_at'].filter(column => !found.has(column));
    if (missing.length) {
      throw new Error('Existing ' + table + ' table is missing required columns: ' + missing.join(', ') + '. No token data was changed.');
    }
  }

  // Additive wallet schema bootstrap. Existing tables and wallet records are untouched.
  await db.run(`
    CREATE TABLE IF NOT EXISTS volunteer_applications (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      user_id VARCHAR(191) NOT NULL,
      interests TEXT NOT NULL,
      availability VARCHAR(4000) NOT NULL DEFAULT '',
      state VARCHAR(4000) NOT NULL DEFAULT 'pending',
      created_at VARCHAR(40) NOT NULL,
      UNIQUE KEY uq_volunteer_applications_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      user_id VARCHAR(191) NOT NULL,
      type VARCHAR(40) NOT NULL,
      amount_kobo BIGINT NOT NULL,
      reference VARCHAR(191) NOT NULL,
      description VARCHAR(4000) NOT NULL DEFAULT '',
      related_payout_id VARCHAR(191) NULL,
      created_by VARCHAR(191) NULL,
      created_at VARCHAR(40) NOT NULL,
      UNIQUE KEY uq_wallet_transactions_reference (reference),
      KEY idx_wallet_transactions_user_created (user_id, created_at),
      CONSTRAINT chk_wallet_transactions_type CHECK (type IN ('volunteer_credit','payout_hold','payout_refund','admin_adjustment')),
      CONSTRAINT chk_wallet_transactions_amount CHECK (amount_kobo <> 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS wallet_payouts (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      user_id VARCHAR(191) NOT NULL,
      amount_kobo BIGINT NOT NULL,
      recipient_type VARCHAR(40) NOT NULL,
      recipient_name VARCHAR(191) NOT NULL,
      recipient_data_encrypted TEXT NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      opay_reference VARCHAR(191) NOT NULL,
      opay_order_no VARCHAR(191) NULL,
      failure_reason TEXT NULL,
      requested_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      processed_by VARCHAR(191) NULL,
      UNIQUE KEY uq_wallet_payouts_opay_reference (opay_reference),
      KEY idx_wallet_payouts_status_requested (status, requested_at),
      KEY idx_wallet_payouts_user_requested (user_id, requested_at),
      CONSTRAINT chk_wallet_payouts_amount CHECK (amount_kobo > 0),
      CONSTRAINT chk_wallet_payouts_recipient CHECK (recipient_type IN ('opay_wallet','bank')),
      CONSTRAINT chk_wallet_payouts_status CHECK (status IN ('pending','processing','completed','failed','rejected'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('[DATABASE] Core member, authentication, volunteer and wallet tables verified.');
}

module.exports = { initializeCoreSchema };
