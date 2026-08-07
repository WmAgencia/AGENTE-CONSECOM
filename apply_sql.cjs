const { Client } = require('pg');
const fs = require('fs');
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const SQL_FILE = process.argv[2] || './supabase-CONSOLIDADO.sql';

// Reads DATABASE_URL from env (preferred) or SUPABASE_* + SUPABASE_DB_PASSWORD.
function buildConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
  }
  const url = process.env.SUPABASE_URL || '';
  const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const password =
    process.env.SUPABASE_DB_PASSWORD ||
    process.env.POSTGRES_PASSWORD ||
    process.env.DB_PASSWORD;
  if (!ref || !password) {
    throw new Error(
      'Missing DB credentials. Set DATABASE_URL (full postgres:// URL) or ' +
        'SUPABASE_URL + SUPABASE_DB_PASSWORD.',
    );
  }
  return {
    host: `db.${ref}.supabase.co`,
    port: 5432,
    user: 'postgres',
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  };
}

(async () => {
  if (!fs.existsSync(SQL_FILE)) {
    console.error(`File not found: ${SQL_FILE}`);
    process.exit(1);
  }
  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  console.log(`File: ${SQL_FILE} (${sql.length} chars)`);

  const client = new Client({ ...buildConfig(), connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    console.log('Connected.');
    console.log('Executing...');
    await client.query(sql);
    console.log('OK - SQL executed successfully.');
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
