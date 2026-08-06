# Consecom — Extensão Chrome

Extrai empresas do Google Maps e importa como leads para o painel Consecom
(Supabase).

## Instalar (modo desenvolvedor)

1. Rode `npm install` e depois `npm run build` na pasta `extension/`.
2. Abra `chrome://extensions`.
3. Ative o **modo de desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e escolha a pasta `extension/dist/`.

## Usar

1. Clique no ícone da extensão para **configurar** a URL do projeto Supabase e a
   **chave anon (publishable)**. (Também dá para configurar no painel flutuante.)
2. Abra o Google Maps e faça uma busca (ex.: "clínicas odontológicas em Sorocaba").
3. Role a lista para carregar mais resultados.
4. No painel flutuante (canto superior direito), selecione as empresas
   individualmente ou marque **Selecionar todas**.
5. Clique em **Importar selecionados**.

Os leads entram na tabela `public.leads` (status `novo`) e aparecem no painel.
Empresas já importadas (mesmo `place_id`) são atualizadas, não duplicadas
(`upsert`).

## Estrutura

- `src/content/` — script que roda no Google Maps: escaneia a lista e injeta o
  painel flutuante de seleção/importação.
- `src/popup/` — popup de configuração (URL + chave anon).
- `src/background/` — service worker (reações a cliques/eventos).
- `src/shared/` — client Supabase e lógica de importação compartilhada.
- `scripts/make-icons.mjs` — gera os ícones PNG sem dependências.