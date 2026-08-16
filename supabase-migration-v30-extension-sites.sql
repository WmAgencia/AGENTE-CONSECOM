-- v30: Configuração de sites ativos para a extensão Vyntra.
-- Linha única global controlada pelo painel Master. A extensão lê via rota
-- pública e esmaece/desativa os sites desligados.

create table if not exists public.extension_settings (
  id integer primary key default 1,
  maps_enabled boolean not null default true,
  webmotors_enabled boolean not null default true,
  wepsy_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.extension_settings (id, maps_enabled, webmotors_enabled, wepsy_enabled)
values (1, true, true, true)
on conflict (id) do nothing;

alter table public.extension_settings enable row level security;
