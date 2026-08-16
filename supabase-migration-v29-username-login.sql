-- =============================================================
-- VYNTRA �?" Migration v29 (Login por nome de usuário)
-- Idempotente.
--
-- 1. Adiciona a coluna `username` em app_users (único, case-insensitive).
-- 2. Define o username 'wesleytune' para a conta MASTER wmagenciasuporte@gmail.com.
-- 3. Função set_username: permite ao usuário logado escolher/atualizar o
--    próprio nome de usuário (valida formato e unicidade).
-- =============================================================

alter table public.app_users add column if not exists username text;

create unique index if not exists app_users_username_key
  on public.app_users (lower(username)) where username is not null;

update public.app_users
  set username = 'wesleytune'
  where email = 'wmagenciasuporte@gmail.com'
    and username is null;

-- Permite ao usuário autenticado definir/atualizar o próprio username.
create or replace function public.set_username(p_username text)
returns public.app_users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_user public.app_users;
  v_clean text;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;
  v_clean := nullif(lower(btrim(p_username)), '');
  if v_clean is null then
    raise exception 'username_required';
  end if;
  if v_clean !~ '^[a-z0-9._-]{3,30}$' then
    raise exception 'username_invalid';
  end if;
  if exists (
    select 1 from public.app_users
    where id <> v_uid
      and lower(username) = v_clean
  ) then
    raise exception 'username_taken';
  end if;

  update public.app_users
    set username = v_clean,
        updated_at = now()
    where id = v_uid
    returning * into v_user;

  if v_user is null then
    raise exception 'user_not_found';
  end if;

  return v_user;
end;
$$;

revoke all on function public.set_username(text) from public;
grant execute on function public.set_username(text) to authenticated;

NOTIFY pgrst, 'reload schema';
