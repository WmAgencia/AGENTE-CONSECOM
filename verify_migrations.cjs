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
    throw new Error(
      'Missing DB credentials. Set DATABASE_URL or SUPABASE_URL + SUPABASE_DB_PASSWORD.',
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
  const client = new Client({ ...buildConfig(), connectionTimeoutMillis: 10000 });
  await client.connect();

  const checks = [
    { name: 'tabela leads', q: "SELECT to_regclass('public.leads') IS NOT NULL AS ok" },
    { name: 'tabela lead_status_history', q: "SELECT to_regclass('public.lead_status_history') IS NOT NULL AS ok" },
    { name: 'tabela campaigns', q: "SELECT to_regclass('public.campaigns') IS NOT NULL AS ok" },
    { name: 'tabela queue_messages', q: "SELECT to_regclass('public.queue_messages') IS NOT NULL AS ok" },
    { name: 'tabela send_runs', q: "SELECT to_regclass('public.send_runs') IS NOT NULL AS ok" },
    { name: 'tabela consecom_conversations', q: "SELECT to_regclass('public.consecom_conversations') IS NOT NULL AS ok" },
    { name: 'tabela lead_contacts', q: "SELECT to_regclass('public.lead_contacts') IS NOT NULL AS ok" },
    { name: 'v3: tabela capture_sessions', q: "SELECT to_regclass('public.capture_sessions') IS NOT NULL AS ok" },
    { name: 'v3: tabela agent_settings', q: "SELECT to_regclass('public.agent_settings') IS NOT NULL AS ok" },
    { name: 'v3: tabela agent_learning', q: "SELECT to_regclass('public.agent_learning') IS NOT NULL AS ok" },
    { name: 'v3: leads.session_id', q: "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='session_id') AS ok" },
    { name: 'v3: leads.no_interest_until', q: "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='no_interest_until') AS ok" },
    { name: 'v3: campaigns.status', q: "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='campaigns' AND column_name='status') AS ok" },
    { name: 'v4: tabela whatsapp_connections', q: "SELECT to_regclass('public.whatsapp_connections') IS NOT NULL AS ok" },
    { name: 'v4: tabela notification_groups', q: "SELECT to_regclass('public.notification_groups') IS NOT NULL AS ok" },
    { name: 'v4: tabela notification_settings', q: "SELECT to_regclass('public.notification_settings') IS NOT NULL AS ok" },
    { name: 'RPC consecom_marcar_reuniao', q: "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname='consecom_marcar_reuniao') AS ok" },
    { name: 'RPC consecom_agent_outcome', q: "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname='consecom_agent_outcome') AS ok" },
    { name: 'RPC consecom_excluir_leads', q: "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname='consecom_excluir_leads') AS ok" },
    { name: 'RPC consecom_cleanup_no_interest', q: "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname='consecom_cleanup_no_interest') AS ok" },
    { name: 'function set_updated_at', q: "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname='set_updated_at') AS ok" },
    { name: 'trigger leads_updated_at', q: "SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='leads_updated_at') AS ok" },
    { name: 'policy leads_anon_delete removida', q: "SELECT NOT EXISTS(SELECT 1 FROM pg_policies WHERE policyname='leads_anon_delete') AS ok" },
    { name: 'v10: leads.call_reason', q: "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='call_reason') AS ok" },
    { name: 'v10: leads.call_moved_at', q: "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='call_moved_at') AS ok" },
    { name: 'v10: send_runs.fail_reason', q: "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='send_runs' AND column_name='fail_reason') AS ok" },
  ];

  let ok = 0, fail = 0;
  for (const c of checks) {
    try {
      const r = await client.query(c.q);
      const isOk = r.rows[0].ok === true;
      console.log(`${isOk ? 'OK  ' : 'FAIL'}  ${c.name}`);
      if (isOk) ok++; else fail++;
    } catch (e) {
      console.log(`FAIL  ${c.name}  (${e.message.substring(0, 60)})`);
      fail++;
    }
  }

  // Status enum check
  try {
    const r = await client.query(`
      SELECT con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname='leads' AND con.contype='c'
        AND pg_get_constraintdef(con.oid) LIKE '%status%'
    `);
    const def = r.rows[0]?.def || '';
    const expected = ['novo','na_fila','enviado','conversando','sem_interesse','remarketing','reuniao_marcada','reuniao_cancelada','fechado','nao_fechado','para_ligacao'];
    const allPresent = expected.every(s => def.includes(s));
    console.log(`${allPresent ? 'OK  ' : 'FAIL'}  status enum expandido (11 valores)`);
    if (allPresent) ok++; else fail++;
  } catch (e) {
    console.log(`FAIL  status enum expandido (${e.message.substring(0, 60)})`);
    fail++;
  }

  console.log(`\n=== ${ok} OK / ${fail} FAIL ===`);
  await client.end();
  process.exit(fail === 0 ? 0 : 1);
})();
