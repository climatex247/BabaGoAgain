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

    console.log('[MYSQL INTEGRATION] Core, wallet, feature, notification, and 18 foreign-key schemas passed twice.');
  } finally {
    await db.close().catch(() => {});
  }
})().catch(error => {
  console.error('[MYSQL INTEGRATION] FAILED:', error);
  process.exitCode = 1;
});
