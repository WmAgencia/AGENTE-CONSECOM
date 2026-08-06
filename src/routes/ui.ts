/**
 * Browser chat test page (GET /).
 *
 * A self-contained HTML app so the operator can open the public Railway URL
 * in a browser and converse with the agent over the REAL POST /api/chat.
 *
 * - Field for the message, Send button, loading + error states.
 * - Renders user + agent messages.
 * - Keeps a conversationId (localStorage) and lets the user clear it.
 * - Requires the operator to paste AGENT_API_KEY (stored only in the browser,
 *   never shipped in the page source). The key is sent per-request as
 *   `Authorization: Bearer <AGENT_API_KEY>`.
 */
import type { FastifyInstance } from 'fastify';

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Samira Agent - Chat de Teste</title>
<style>
  :root { --bg:#0f172a; --panel:#1e293b; --border:#334155; --accent:#6366f1; --user:#334155; --agent:#1f2937; --text:#e2e8f0; --muted:#94a3b8; --err:#f87171; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }
  header { padding:14px 18px; border-bottom:1px solid var(--border); background:var(--panel); display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; flex:1; }
  .badge { font-size:11px; color:var(--muted); background:var(--bg); padding:3px 8px; border-radius:999px; border:1px solid var(--border); }
  .settings { padding:12px 18px; border-bottom:1px solid var(--border); background:var(--panel); display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .settings label { font-size:12px; color:var(--muted); }
  input[type=password], input[type=text] { background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:7px 10px; font-size:13px; min-width:220px; }
  input:focus { outline:none; border-color:var(--accent); }
  button { background:var(--accent); color:#fff; border:none; border-radius:8px; padding:8px 14px; font-size:13px; cursor:pointer; }
  button.secondary { background:var(--border); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  #cid { background:transparent; border:1px dashed var(--border); color:var(--muted); font-size:11px; font-family:monospace; min-width:180px; }
  #chat { flex:1; overflow-y:auto; padding:18px; display:flex; flex-direction:column; gap:12px; }
  .msg { max-width:75%; padding:10px 14px; border-radius:14px; font-size:14px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
  .msg.user { align-self:flex-end; background:var(--accent); }
  .msg.agent { align-self:flex-start; background:var(--agent); border:1px solid var(--border); }
  .msg .meta { display:block; font-size:10px; color:var(--muted); margin-top:4px; }
  .banner { display:none; align-self:stretch; background:rgba(248,113,113,.12); border:1px solid var(--err); color:var(--err); padding:10px 14px; border-radius:10px; font-size:13px; }
  .banner.visible { display:block; }
  #composer { border-top:1px solid var(--border); background:var(--panel); padding:14px 18px; display:flex; gap:10px; }
  #message { flex:1; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:10px; padding:12px 14px; font-size:14px; resize:vertical; }
  #status { font-size:11px; color:var(--muted); align-self:center; white-space:nowrap; }
  .spinner { display:inline-block; width:12px; height:12px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin .7s linear infinite; vertical-align:middle; margin-right:6px; }
  @keyframes spin { to{ transform:rotate(360deg);} }
  .empty { color:var(--muted); text-align:center; margin-top:40px; font-size:14px; }
</style>
</head>
<body>
<header>
  <h1>Samira Agent - Chat de Teste</h1>
  <span class="badge" id="modelBadge">modelo: --</span>
</header>

<div class="settings">
  <label for="apiKey">AGENT_API_KEY</label>
  <input type="password" id="apiKey" placeholder="Cole a API key (fica só no navegador)" autocomplete="off" />
  <label for="cid">conversationId</label>
  <input type="text" id="cid" />
  <button id="newConv" class="secondary" type="button">Nova conversa</button>
  <button id="clearLog" class="secondary" type="button">Limpar tela</button>
</div>

<div id="chat">
  <div class="empty" id="empty">Comece uma nova conversa com o agente.</div>
</div>

<div id="composer">
  <textarea id="message" rows="1" placeholder="Digite sua mensagem... (Enter envia)" title="Enviar"></textarea>
  <button id="send" type="button">Enviar</button>
  <span id="status"></span>
</div>

<script>
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const chat = $('chat'), empty = $('empty'), statusEl = $('status');
  let conversationId = localStorage.getItem('samira.cid') || genId();
  let apiKey = localStorage.getItem('samira.apikey') || '';
  let busy = false;

  function genId() {
    return 'samira-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function saveCid() { localStorage.setItem('samira.cid', conversationId); }
  function saveKey() { localStorage.setItem('samira.apikey', apiKey); }

  function renderCid() {
    $('cid').value = conversationId;
    saveCid();
    $('apiKey').value = apiKey;
  }

  function setStatus(html) { statusEl.innerHTML = html; statusEl.style.display = ''; }
  function setLoading(on) {
    busy = on;
    $('send').disabled = on;
    setStatus(on ? '<span class="spinner"></span>Gerando resposta...' : 'Pronto');
  }

  function addMsg(role, text, meta) {
    empty.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const body = document.createElement('span');
    body.textContent = text;
    div.appendChild(body);
    if (meta) {
      const m = document.createElement('span');
      m.className = 'meta';
      m.textContent = meta;
      div.appendChild(m);
    }
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function showBanner(msg, autoHide) {
    let banner = chat.querySelector('.banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'banner';
      chat.appendChild(banner);
    }
    banner.textContent = msg;
    banner.classList.add('visible');
    if (autoHide) setTimeout(() => banner.classList.remove('visible'), 6000);
  }

  async function send() {
    const text = $('message').value.trim();
    if (!text || busy) return;
    if (!apiKey) {
      showBanner('Configure a AGENT_API_KEY no campo acima e pressione Enter.', true);
      $('apiKey').focus();
      return;
    }
    addMsg('user', text);
    $('message').value = '';
    autosize();
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({ conversationId: conversationId, message: text }),
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* non-json */ }
      if (!res.ok) {
        throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
      }
      $('modelBadge').textContent = 'modelo: ' + (data.model || '--');
      addMsg('agent', data.response, 'latência ' + data.latencyMs + 'ms');
    } catch (err) {
      showBanner('Erro: ' + (err && err.message ? err.message : String(err)), true);
    } finally {
      setLoading(false);
    }
  }

  function clearChat() {
    chat.querySelectorAll('.msg, .banner').forEach((n) => n.remove());
    empty.style.display = '';
    $('send').disabled = false;
    setStatus('Pronto');
  }

  function autosize() {
    const t = $('message');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 160) + 'px';
  }

  $('send').addEventListener('click', send);
  $('message').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('message').addEventListener('input', autosize);
  $('newConv').addEventListener('click', () => {
    conversationId = genId();
    renderCid();
    $('modelBadge').textContent = 'modelo: --';
    clearChat();
  });
  $('clearLog').addEventListener('click', clearChat);
  $('apiKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      apiKey = $('apiKey').value.trim();
      saveKey();
      showBanner('API key salva no navegador.', true);
    }
  });

  renderCid();
  setStatus('Pronto');
})();
</script>
</body>
</html>
`;

export function registerUiRoutes(app: FastifyInstance): void {
  app.get(
    '/',
    { config: { rateLimit: false } },
    async (_req, reply) => {
      return reply
        .type('text/html; charset=utf-8')
        .send(PAGE);
    },
  );
}