'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const db = require('../database-mysql');
const { initializeCoreSchema } = require('../schema-mysql');

async function initializeFeatureSchema() {
  const app = express();
  const initializeFeatures = require('../features').install(app, {
    db,
    authenticatedUser: async () => null,
    frontendPath: path.resolve(__dirname, '../../frontend'),
    referrals: {}
  });
  await initializeFeatures();
}

(async () => {
  try {
    await db.ready();
    await initializeCoreSchema(db);
    await initializeFeatureSchema();

    // A second cold install exercises migration and index idempotency.
    await initializeFeatureSchema();

    const [tables] = await db.pool.query(
      "SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()"
    );
    const tableMap = new Map(tables.map(row => [row.TABLE_NAME, row.ENGINE]));
    for (const table of [
      'users','volunteer_applications','wallet_transactions','wallet_payouts',
      'bga_conversations','bga_conversation_members','bga_messages',
      'bga_notifications','bga_profile_applications','bga_public_profiles',
      'bga_follows','bga_media_posts','bga_media_upload_intents',
      'bga_admin_roles','bga_admin_audit','bga_community_reports'
    ]) {
      assert.equal(tableMap.get(table), 'InnoDB', table + ' must use InnoDB');
    }

    const expectedLengths = [
      ['bga_profile_applications','evidence_url',1000],
      ['bga_profile_applications','review_note',1000],
      ['bga_public_profiles','evidence_url',1000],
      ['bga_media_posts','description',1500],
      ['bga_media_upload_intents','description',1500],
      ['bga_community_reports','details',1000],
      ['bga_community_reports','review_note',1000]
    ];
    for (const [table,column,length] of expectedLengths) {
      const [columns] = await db.pool.query(
        'SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
        [table,column]
      );
      assert.equal(Number(columns[0]?.CHARACTER_MAXIMUM_LENGTH), length, table + '.' + column + ' must preserve its supported text length');
    }

    const [foreignKeys] = await db.pool.query(
      "SELECT TABLE_NAME,CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME " +
      "FROM information_schema.KEY_COLUMN_USAGE " +
      "WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL"
    );
    const expected = [
      'fk_bga_conv_members_conversation','fk_bga_conv_members_user',
      'fk_bga_messages_conversation','fk_bga_messages_sender',
      'fk_bga_notifications_user','fk_bga_profile_apps_user',
      'fk_bga_profile_apps_reviewer','fk_bga_public_profiles_user',
      'fk_bga_follows_follower','fk_bga_follows_profile',
      'fk_bga_media_posts_user','fk_bga_media_posts_reviewer',
      'fk_bga_media_intents_user','fk_bga_admin_roles_user',
      'fk_bga_admin_roles_grantor','fk_bga_admin_audit_actor',
      'fk_bga_reports_reporter','fk_bga_reports_reviewer'
    ];
    const actualNames = new Set(foreignKeys.map(row => row.CONSTRAINT_NAME));
    for (const name of expected) assert.ok(actualNames.has(name), 'Missing MySQL foreign key: ' + name);

    // Exercise SQLite-compatible REPLACE SQL through the production MySQL adapter.
    await db.run('CREATE TABLE IF NOT EXISTS bga_mysql_replace_adapter_test (id VARCHAR(40) PRIMARY KEY, value VARCHAR(40) NOT NULL) ENGINE=InnoDB');
    await db.run('DELETE FROM bga_mysql_replace_adapter_test');
    await db.run('INSERT INTO bga_mysql_replace_adapter_test (id,value) VALUES (?,?)', ['same-id','first']);
    await db.run('INSERT OR REPLACE INTO bga_mysql_replace_adapter_test (id,value) VALUES (?,?)', ['same-id','second']);
    const replaced = await db.get('SELECT value FROM bga_mysql_replace_adapter_test WHERE id=?', ['same-id']);
    assert.equal(replaced?.value, 'second', 'MySQL adapter must preserve SQLite INSERT OR REPLACE behavior');
    await db.run('DROP TABLE bga_mysql_replace_adapter_test');

    // Exercise the wallet ledger's critical InnoDB behaviors using disposable CI-only rows.
    const crypto = require('node:crypto');
    const testUserId = 'ci-wallet-' + crypto.randomUUID();
    const testPayoutId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.run(
      'INSERT INTO users (id,full_name,phone,email,address,state_id,state_name,lga_id,lga_name,ward_id,ward_name,roles_json,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [testUserId,'CI Wallet Test','+234' + String(Date.now()).slice(-10),testUserId + '@example.invalid','CI test address','ci-state','CI State','ci-lga','CI LGA','ci-ward','CI Ward','["Volunteer"]','not-a-real-password-hash',now,now]
    );
    try {
      await db.run(
        'INSERT INTO wallet_transactions (id,user_id,type,amount_kobo,reference,description,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(),testUserId,'volunteer_credit',10000,'CI-SEED-' + testUserId,'Disposable CI wallet seed',testUserId,now]
      );

      // Two simultaneous 7,000-kobo payout reservations must not overspend a 10,000-kobo balance.
      const reserve = () => db.transaction(async tx => {
        const locked = await tx.get('SELECT id FROM users WHERE id=? FOR UPDATE',[testUserId]);
        assert.ok(locked, 'Payout reservation must lock an existing user row');
        const row = await tx.get(
          'SELECT CAST(COALESCE(SUM(amount_kobo),0) AS CHAR) AS balance FROM wallet_transactions WHERE user_id=?',
          [testUserId]
        );
        const balance = BigInt(row.balance || '0');
        if (balance < 7000n) throw new Error('insufficient balance');
        await tx.run(
          'INSERT INTO wallet_transactions (id,user_id,type,amount_kobo,reference,description,related_payout_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [crypto.randomUUID(),testUserId,'payout_hold',-7000,'CI-HOLD-' + crypto.randomUUID(),'Disposable concurrent payout hold',null,testUserId,new Date().toISOString()]
        );
        return true;
      });
      const reservations = await Promise.allSettled([reserve(),reserve()]);
      assert.equal(reservations.filter(result => result.status === 'fulfilled').length,1,'Only one concurrent payout reservation may spend the available balance');
      assert.equal(reservations.filter(result => result.status === 'rejected').length,1,'The competing payout reservation must be rejected');
      let ledger = await db.get(
        'SELECT CAST(SUM(amount_kobo) AS CHAR) AS balance FROM wallet_transactions WHERE user_id=?',
        [testUserId]
      );
      assert.equal(String(ledger.balance),'3000','Concurrent payout holds must leave a non-negative exact balance');

      // A rejected payout is refunded once, even if the rejection handler is retried.
      await db.run(
        'INSERT INTO wallet_payouts (id,user_id,amount_kobo,recipient_type,recipient_name,recipient_data_encrypted,status,opay_reference,requested_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [testPayoutId,testUserId,7000,'opay_wallet','CI Recipient','encrypted-test-only','pending','CI-OPAY-' + testPayoutId,now,now]
      );
      const rejectAndRefund = () => db.transaction(async tx => {
        const changed = await tx.run(
          "UPDATE wallet_payouts SET status='rejected',updated_at=? WHERE id=? AND status='pending'",
          [new Date().toISOString(),testPayoutId]
        );
        if (!changed.changes) return false;
        const reference = 'PAYOUT-REFUND-' + testPayoutId;
        await tx.run(
          'INSERT INTO wallet_transactions (id,user_id,type,amount_kobo,reference,description,related_payout_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [crypto.randomUUID(),testUserId,'payout_refund',7000,reference,'Disposable CI payout refund',testPayoutId,testUserId,new Date().toISOString()]
        );
        return true;
      });
      assert.equal(await rejectAndRefund(),true,'First rejection must refund the reserved amount');
      assert.equal(await rejectAndRefund(),false,'Repeated rejection must not refund again');
      const refunds = await db.get(
        "SELECT COUNT(*) AS count,CAST(COALESCE(SUM(amount_kobo),0) AS CHAR) AS amount FROM wallet_transactions WHERE user_id=? AND type='payout_refund' AND related_payout_id=?",
        [testUserId,testPayoutId]
      );
      assert.equal(Number(refunds.count),1,'A payout may have only one refund ledger entry');
      assert.equal(String(refunds.amount),'7000','Refund must restore the exact held kobo amount');
      ledger = await db.get(
        'SELECT CAST(SUM(amount_kobo) AS CHAR) AS balance FROM wallet_transactions WHERE user_id=?',
        [testUserId]
      );
      assert.equal(String(ledger.balance),'10000','Refund must restore the original wallet balance exactly');

      // The unique reference constraint must reject duplicate credits/ledger events.
      await assert.rejects(
        db.run(
          'INSERT INTO wallet_transactions (id,user_id,type,amount_kobo,reference,description,created_at) VALUES (?,?,?,?,?,?,?)',
          [crypto.randomUUID(),testUserId,'volunteer_credit',100,'CI-SEED-' + testUserId,'Duplicate reference',now]
        ),
        /Duplicate entry|ER_DUP_ENTRY/i
      );
    } finally {
      await db.run('DELETE FROM wallet_transactions WHERE user_id=?',[testUserId]);
      await db.run('DELETE FROM wallet_payouts WHERE user_id=?',[testUserId]);
      await db.run('DELETE FROM users WHERE id=?',[testUserId]);
    }

    console.log('[MYSQL INTEGRATION] Core, wallet, feature, notification, and 18 foreign-key schemas passed twice; concurrent payout, one-time refund, exact ledger balance, and unique-reference checks passed.');
  } finally {
    await db.close().catch(() => {});
  }
})().catch(error => {
  console.error('[MYSQL INTEGRATION] FAILED:', error);
  process.exitCode = 1;
});
