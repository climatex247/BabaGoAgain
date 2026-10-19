'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../database');
const geo = require('nigeria-inec-geo');

async function main() {
  const databasePath = process.env.BGA_DATABASE_PATH ||
    path.join(__dirname, '..', 'babagoagain.sqlite');

  if (!fs.existsSync(databasePath)) {
    throw new Error(
      'Existing database not found. Refusing to create or import into a new database.'
    );
  }

  await db.ready();

  if (!fs.existsSync(databasePath)) {
    throw new Error('Database initialization did not produce the expected database file.');
  }

  const backupPath = databasePath + '.before-locations-' +
    new Date().toISOString().replace(/[:.]/g, '-');

  fs.copyFileSync(databasePath, backupPath);
  console.log('Database backup:', backupPath);

  const states = geo.states();
  const lgas = geo.lgas();
  const wards = geo.wards();
  const pollingUnits = geo.pollingUnits();

  const expected = {
    states: 37,
    lgas: 774,
    wards: 8809,
    pollingUnits: 176846
  };

  const actual = {
    states: states.length,
    lgas: lgas.length,
    wards: wards.length,
    pollingUnits: pollingUnits.length
  };

  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `Unexpected ${key} count: ${actual[key]}; expected ${expected[key]}`
      );
    }
  }

  await db.transaction(async tx => {
    tx.run(`
      CREATE TABLE IF NOT EXISTS location_states (
        portal_id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL
      )
    `);

    tx.run(`
      CREATE TABLE IF NOT EXISTS location_lgas (
        portal_id TEXT PRIMARY KEY,
        state_portal_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        state_code TEXT NOT NULL,
        state_name TEXT NOT NULL,
        FOREIGN KEY(state_portal_id)
          REFERENCES location_states(portal_id)
      )
    `);

    tx.run(`
      CREATE TABLE IF NOT EXISTS location_wards (
        portal_id TEXT PRIMARY KEY,
        lga_portal_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        state_portal_id TEXT NOT NULL,
        state_code TEXT NOT NULL,
        state_name TEXT NOT NULL,
        lga_code TEXT NOT NULL,
        lga_name TEXT NOT NULL,
        FOREIGN KEY(lga_portal_id)
          REFERENCES location_lgas(portal_id)
      )
    `);

    tx.run(`
      CREATE TABLE IF NOT EXISTS location_polling_units (
        portal_id TEXT PRIMARY KEY,
        state_code TEXT NOT NULL,
        state_name TEXT NOT NULL,
        lga_code TEXT NOT NULL,
        lga_name TEXT NOT NULL,
        ward_code TEXT NOT NULL,
        ward_name TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        full_code TEXT NOT NULL UNIQUE
      )
    `);

    tx.run('DELETE FROM location_polling_units');
    tx.run('DELETE FROM location_wards');
    tx.run('DELETE FROM location_lgas');
    tx.run('DELETE FROM location_states');

    const insertState = `
      INSERT INTO location_states (portal_id, code, name)
      VALUES (?, ?, ?)
    `;
    for (const s of states) {
      tx.run(insertState, [s.portal_id, s.code, s.name]);
    }

    const insertLga = `
      INSERT INTO location_lgas
        (portal_id, state_portal_id, code, name, state_code, state_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    for (const x of lgas) {
      tx.run(insertLga, [
        x.portal_id, x.state_portal_id, x.code, x.name,
        x.state_code, x.state_name
      ]);
    }

    const insertWard = `
      INSERT INTO location_wards
        (portal_id, lga_portal_id, code, name, state_portal_id,
         state_code, state_name, lga_code, lga_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    for (const w of wards) {
      tx.run(insertWard, [
        w.portal_id, w.lga_portal_id, w.code, w.name,
        w.state_portal_id, w.state_code, w.state_name,
        w.lga_code, w.lga_name
      ]);
    }

    const insertUnit = `
      INSERT INTO location_polling_units
        (portal_id, state_code, state_name, lga_code, lga_name,
         ward_code, ward_name, code, name, location, full_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    for (const p of pollingUnits) {
      tx.run(insertUnit, [
        p.portal_id, p.state_code, p.state_name,
        p.lga_code, p.lga_name, p.ward_code, p.ward_name,
        p.code, p.name, p.location || '', p.full_code
      ]);
    }

    tx.run(`
      CREATE INDEX IF NOT EXISTS idx_location_lgas_state
      ON location_lgas(state_portal_id, name)
    `);
    tx.run(`
      CREATE INDEX IF NOT EXISTS idx_location_wards_lga
      ON location_wards(lga_portal_id, name)
    `);
    tx.run(`
      CREATE INDEX IF NOT EXISTS idx_location_units_codes
      ON location_polling_units(state_code, lga_code, ward_code, name)
    `);
  });

  const counts = {};
  for (const [table, key] of [
    ['location_states', 'states'],
    ['location_lgas', 'lgas'],
    ['location_wards', 'wards'],
    ['location_polling_units', 'pollingUnits']
  ]) {
    const row = await db.get(`SELECT COUNT(*) AS count FROM ${table}`);
    counts[key] = Number(row.count);
    if (counts[key] !== expected[key]) {
      throw new Error(
        `${table} verification failed: ${counts[key]} instead of ${expected[key]}`
      );
    }
  }

  console.log('\nLocation import verified:');
  console.log(JSON.stringify(counts, null, 2));
  console.log('Existing application tables were not intentionally changed.');
}

main().catch(error => {
  console.error('Location import failed:', error.stack || error);
  process.exitCode = 1;
});
