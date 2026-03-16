// db/database.js
// PostgreSQL database using pg package
// Reads DATABASE_URL from .env file

const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test connection and initialize schema
async function initDatabase() {
  const client = await pool.connect();
  
  try {
    // Create tables if they don't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS files (
        id            SERIAL PRIMARY KEY,
        file_name     TEXT    NOT NULL,
        stored_name   TEXT    NOT NULL UNIQUE,
        file_path     TEXT    NOT NULL,
        file_size     INTEGER NOT NULL,
        mime_type     TEXT    NOT NULL,
        share_token   TEXT    NOT NULL UNIQUE,
        max_views     INTEGER NOT NULL DEFAULT 1,
        current_views INTEGER NOT NULL DEFAULT 0,
        status        TEXT    NOT NULL DEFAULT 'active',
        uploader_ip   TEXT,
        created_at    TIMESTAMP DEFAULT NOW(),
        expired_at    TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_share_token ON files(share_token)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status ON files(status)
    `);

    console.log('Database tables initialized successfully');
  } finally {
    client.release();
  }
}

// Prepared statements
const stmts = {
  insertFile: async (params) => {
    const query = `
      INSERT INTO files (file_name, stored_name, file_path, file_size, mime_type,
                         share_token, max_views, uploader_ip)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const values = [
      params.file_name,
      params.stored_name,
      params.file_path,
      params.file_size,
      params.mime_type,
      params.share_token,
      params.max_views,
      params.uploader_ip
    ];
    const result = await pool.query(query, values);
    return result.rows[0];
  },

  getByToken: async (token) => {
    const query = 'SELECT * FROM files WHERE share_token = $1';
    const result = await pool.query(query, [token]);
    return result.rows[0];
  },

  incrementViews: async (token) => {
    const query = 'UPDATE files SET current_views = current_views + 1 WHERE share_token = $1';
    await pool.query(query, [token]);
  },

  expireLink: async (token) => {
    const query = "UPDATE files SET status = 'expired', expired_at = NOW() WHERE share_token = $1";
    await pool.query(query, [token]);
  },

  recordView: async (token, maxViews) => {
    await stmts.incrementViews(token);
    const row = await stmts.getByToken(token);
    if (row && row.current_views >= maxViews) {
      await stmts.expireLink(token);
    }
    return await stmts.getByToken(token);
  }
};

module.exports = { 
  pool,
  initDatabase, 
  stmts 
};
