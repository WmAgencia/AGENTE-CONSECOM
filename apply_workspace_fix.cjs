const { Client } = require('pg');
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

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
    throw new Error('Missing DB credentials.');
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
  const client = new Client({ ...buildConfig(), connectionTimeoutMillis: 10000 });
  await client.connect();

  // workspace_id e user_id viraram TEXT para aceitar slugs alem de UUIDs.
  const migrations = [
    `ALTER TABLE public.whatsapp_connections ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::TEXT`,
    `ALTER TABLE public.whatsapp_connections ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT`,
    `DROP INDEX IF EXISTS whatsapp_conn_user_idx`,
    `CREATE INDEX IF NOT EXISTS whatsapp_conn_workspace_idx ON public.whatsapp_connections(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS whatsapp_conn_user_idx ON public.whatsapp_connections(user_id)`,
    // capture_sessions e lead_contacts tambem referenciam user_id — relaxar para compat.
    `ALTER TABLE public.lead_contacts ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT`,
    `DROP INDEX IF EXISTS lead_contacts_user_idx`,
    `CREATE INDEX IF NOT EXISTS lead_contacts_user_idx ON public.lead_contacts(user_id)`,
    `ALTER TABLE public.capture_sessions ADD COLUMN IF NOT EXISTS user_id TEXT`,
    `CREATE INDEX IF NOT EXISTS capture_sessions_user_idx ON public.capture_sessions(user_id)`,
  ];

  for (const sql of migrations) {
    try {
      await client.query(sql);
      console.log('OK:', sql.substring(0, 60));
    } catch (e) {
      console.log('ERR:', sql.substring(0, 60), '-', e.message);
    }
  }

  await client.end();
})();
