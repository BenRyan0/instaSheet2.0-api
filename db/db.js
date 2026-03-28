// db.js
const { Client } = require('pg');
const postgres = require('postgres');
require("dotenv").config({ silent: true });

const isSupabase = process.env.DB_MODE === 'supabase';

let con;

if (isSupabase) {
  // --- Using Postgres.js for Supabase connection via Transaction Pooler ---
  const connectionString =
    process.env.SUPABASE_URL || process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('Missing SUPABASE_URL or DATABASE_URL for Supabase connection.');
  }

  const sql = postgres(connectionString, {
    ssl: { rejectUnauthorized: false },
  });

  console.log('Connected to Supabase PostgreSQL via postgres.js (pooler)');

  // Emulate pg.Client.query() style interface
  con = {
    query: async (text, params = []) => {
      try {
        // Convert `$1`, `$2`, etc. to postgres.js-style interpolation
        // Example: text = "SELECT * FROM table WHERE id = $1"
        // → turns into sql`SELECT * FROM table WHERE id = ${params[0]}`
        const queryText = text.replace(/\$(\d+)/g, (_, i) => `\$${i}`);
        const result = await sql.unsafe(queryText, params);
        return { rows: result };
      } catch (err) {
        console.error('DB Query Error:', err.message);
        throw err;
      }
    },
    release: async () => {
      await sql.end({ timeout: 5 });
      console.log('Supabase PostgreSQL connection released');
    },
    _clientType: 'postgres.js',
  };

} else {
  // --- Local PostgreSQL via pg.Client ---
  const connectionConfig = {
    host: process.env.PG_HOST,
    user: process.env.PG_USER,
    port: process.env.PG_PORT || 5432,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DB,
    family: 4, // IPv4
  };

  const client = new Client(connectionConfig);

  client.connect()
    .then(() => console.log('Connected to Local PostgreSQL via pg.Client'))
    .catch(err => console.error('Connection error', err.stack));

  client.release = async () => {
    await client.end();
    console.log('Local PostgreSQL connection released');
  };

  client._clientType = 'pg';
  con = client;
}

module.exports = con;
