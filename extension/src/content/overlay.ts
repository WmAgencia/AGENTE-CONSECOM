export const indexHtml = `
<div id="consecom-inner">
  <div id="consecom-header">
    <div class="logo">C</div>
    <div>
      <div class="title">Consecom</div>
      <div class="sub">Captura de leads</div>
    </div>
    <div class="actions">
      <button id="consecom-refresh" title="Atualizar">⟳</button>
      <button id="consecom-config" title="Configurações">⚙</button>
      <button id="consecom-close" title="Fechar">✕</button>
    </div>
  </div>
  <div id="consecom-stats">
    <span class="pill"><b id="consecom-count">0</b> empresas</span>
    <span class="pill"><b id="consecom-sel-count">0</b> selecionadas</span>
  </div>
  <div id="consecom-select-row">
    <label>
      <input type="checkbox" id="consecom-select-all">
      Selecionar todas
    </label>
  </div>
  <div id="consecom-list"></div>
  <div id="consecom-config-form">
    <label for="inp-url">URL do projeto Supabase</label>
    <input id="inp-url" placeholder="https://xxxx.supabase.co" spellcheck="false">
    <label for="inp-key">Chave anon (publishable)</label>
    <input id="inp-key" placeholder="eyJhbGci..." spellcheck="false">
    <button id="consecom-save-config">Salvar configuração</button>
    <div class="status" id="cfg-status"></div>
  </div>
  <div id="consecom-footer">
    <button id="consecom-import">Importar selecionados</button>
    <span id="consecom-import-status"></span>
  </div>
</div>
`