const { Client } = require('pg');
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

(async () => {
  const password = process.env.SUPABASE_DB_PASSWORD || process.env.POSTGRES_PASSWORD;
  const url = process.env.SUPABASE_URL || '';
  const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  const client = new Client({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    user: 'postgres',
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  await client.connect();

  const sqls = [
    // whatsapp_connections: drop FK and change user_id to TEXT
    `ALTER TABLE public.whatsapp_connections DROP CONSTRAINT IF EXISTS whatsapp_connections_user_id_fkey`,
    `ALTER TABLE public.whatsapp_connections ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT`,
    // lead_contacts: drop policy and FK, change to TEXT, recreate policy
    `DROP POLICY IF EXISTS lc_read ON public.lead_contacts`,
    `DROP POLICY IF EXISTS lc_insert ON public.lead_contacts`,
    `DROP POLICY IF EXISTS lc_delete ON public.lead_contacts`,
    `ALTER TABLE public.lead_contacts DROP CONSTRAINT IF EXISTS lead_contacts_user_id_fkey`,
    `ALTER TABLE public.lead_contacts ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT`,
    `CREATE POLICY lc_read ON public.lead_contacts FOR SELECT USING (auth.role() = 'authenticated' AND user_id = auth.uid()::text)`,
    `CREATE POLICY lc_insert ON public.lead_contacts FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND user_id = auth.uid()::text)`,
    `CREATE POLICY lc_delete ON public.lead_contacts FOR DELETE USING (auth.role() = 'authenticated' AND user_id = auth.uid()::text)`,
  ];

  for (const sql of sqls) {
    try {
      await client.query(sql);
      console.log('OK:', sql.substring(0, 70));
    } catch (e) {
      console.log('ERR:', sql.substring(0, 70), '-', e.message.substring(0, 60));
    }
  }

  await client.end();
})();
