'use strict';

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '.env.mysql')
});

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  database: process.env.MYSQL_DATABASE,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  ssl: {
    ca: fs.readFileSync(process.env.MYSQL_CA_PATH || path.join(__dirname, 'mysql-ca.pem'), 'utf8'),
    rejectUnauthorized: true
  },
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 20000,
  queueLimit: 0,
  charset: 'utf8mb4'
});


function convertSql(sql) {
  sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO');
  sql = sql.replace(/\s+COLLATE\s+NOCASE\b/gi, '');
  sql = sql.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s+TEXT\s+PRIMARY\s+KEY\b/gi, '$1 VARCHAR(191) PRIMARY KEY');
  sql = sql.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s+TEXT\s+(NOT\s+NULL\s+)?DEFAULT\s+('(?:[^']|'')*'|[0-9]+)/gi, (_, col, notNull = '', def) => `${col} VARCHAR(191) ${notNull}${notNull ? '' : ''}DEFAULT ${def}`);

  return sql;
}

async function ready() {
  const [rows] = await pool.query('SELECT 1 AS ready');
  if (Number(rows[0].ready) !== 1) {
    throw new Error('MySQL readiness check failed');
  }
}

async function run(sql, parameters = []) {
  const [result] = await pool.execute(convertSql(sql), parameters);
  return {
    changes: result.affectedRows ?? 0,
    lastInsertRowid: result.insertId ?? null,
    insertId: result.insertId ?? null
  };
}

async function get(sql, parameters = []) {
  const [rows] = await pool.execute(convertSql(sql), parameters);
  return rows[0] || null;
}

async function all(sql, parameters = []) {
  const [rows] = await pool.execute(convertSql(sql), parameters);
  return rows;
}

async function transaction(callback) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const tx = {
      run: async (sql, parameters = []) => {
        const [result] = await connection.execute(convertSql(sql), parameters);
        return {
          changes: result.affectedRows ?? 0,
          lastInsertRowid: result.insertId ?? null,
          insertId: result.insertId ?? null
        };
      },
      get: async (sql, parameters = []) => {
        const [rows] = await connection.execute(convertSql(sql), parameters);
        return rows[0] || null;
      },
      all: async (sql, parameters = []) => {
        const [rows] = await connection.execute(convertSql(sql), parameters);
        return rows;
      }
    };

    const result = await callback(tx);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function close() {
  await pool.end();
}

module.exports = { ready, run, get, all, transaction, close, pool };
