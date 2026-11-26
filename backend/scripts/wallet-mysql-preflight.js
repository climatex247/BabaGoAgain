'use strict';

// Read-only production-schema preflight. This script never creates or alters tables.
const db = require('../database-mysql');

const requiredColumns = {
  wallet_transactions: [
    'id', 'user_id', 'type', 'amount_kobo', 'reference', 'description',
    'related_payout_id', 'created_by', 'created_at'
  ],
  wallet_payouts: [
    'id', 'user_id', 'amount_kobo', 'recipient_type', 'recipient_name',
    'recipient_data_encrypted', 'status', 'opay_reference', 'opay_order_no',
    'failure_reason', 'requested_at', 'updated_at', 'processed_by'
  ],
  volunteer_applications: [
    'id', 'user_id', 'interests', 'availability', 'state', 'created_at'
  ]
};

const requiredIndexes = [
  { table: 'wallet_transactions', columns: ['reference'], unique: true },
  { table: 'wallet_transactions', columns: ['user_id', 'created_at'], unique: false },
  { table: 'wallet_payouts', columns: ['opay_reference'], unique: true },
  { table: 'wallet_payouts', columns: ['user_id', 'requested_at'], unique: false },
  { table: 'wallet_payouts', columns: ['status', 'requested_at'], unique: false },
  { table: 'volunteer_applications', columns: ['user_id'], unique: true }
];

function sameColumns(actual, expected) {
  return actual.length === expected.length &&
    actual.every((column, index) => column === expected[index]);
}

async function main() {
  const failures = [];
  try {
    await db.ready();

    const [tables] = await db.pool.query(
      'SELECT TABLE_NAME, ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()'
    );
    const tableMap = new Map(tables.map(row => [row.TABLE_NAME, row]));

    for (const table of Object.keys(requiredColumns)) {
      const found = tableMap.get(table);
      if (!found) {
        failures.push('Missing required table: ' + table);
        continue;
      }
      if (String(found.ENGINE).toUpperCase() !== 'INNODB') {
        failures.push(table + ' must use InnoDB (found ' + found.ENGINE + ')');
      }

      const [columns] = await db.pool.query(
        'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]
      );
      const present = new Set(columns.map(row => row.COLUMN_NAME));
      const missing = requiredColumns[table].filter(column => !present.has(column));
      if (missing.length) failures.push(table + ' missing columns: ' + missing.join(', '));
    }

    const [indexRows] = await db.pool.query(
      'SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME ' +
      'FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ' +
      'ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX'
    );
    const indexes = new Map();
    for (const row of indexRows) {
      const key = row.TABLE_NAME + '.' + row.INDEX_NAME;
      if (!indexes.has(key)) indexes.set(key, { table: row.TABLE_NAME, unique: Number(row.NON_UNIQUE) === 0, columns: [] });
      indexes.get(key).columns.push(row.COLUMN_NAME);
    }

    for (const expected of requiredIndexes) {
      const found = [...indexes.values()].some(index =>
        index.table === expected.table &&
        index.unique === expected.unique &&
        sameColumns(index.columns, expected.columns)
      );
      if (!found) {
        failures.push(
          'Missing ' + (expected.unique ? 'UNIQUE ' : '') +
          'index on ' + expected.table + '(' + expected.columns.join(', ') + ')'
        );
      }
    }

    if (failures.length) {
      console.error('[WALLET PREFLIGHT] FAILED');
      for (const failure of failures) console.error('- ' + failure);
      process.exitCode = 1;
    } else {
      console.log('[WALLET PREFLIGHT] PASSED: wallet and volunteer tables, required columns, InnoDB engines, and indexes verified.');
    }
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error('[WALLET PREFLIGHT] FAILED:', error.message);
  process.exitCode = 1;
});
