-- Dados do backoffice (admin.html) no Supabase, esquema `careca`, em vez do localStorage.
-- Uma linha por área do estado (suppliers, ingredients, recipes, invoices, …) com o conteúdo em jsonb,
-- e uma versão por restaurante para detetar alterações feitas noutro browser.
-- O esquema não está exposto na API: o admin.html só lê e grava pelas funções public.careca_backoffice_*,
-- que confirmam utilizador e palavra-passe em careca.backoffice_acesso.
-- Nada aqui toca nas tabelas do sistema de reservas (esquema public).

create table if not exists careca.backoffice_acesso (
  utilizador text primary key,
  senha_hash text not null,
  criado_em timestamptz not null default now()
);
-- shortcut: admin/admin igual ao login atual do admin.html; trocar a palavra-passe aqui (ou passar a Supabase Auth) antes de dados reais sensíveis.
insert into careca.backoffice_acesso (utilizador, senha_hash) values ('admin', extensions.crypt('admin', extensions.gen_salt('bf'))) on conflict do nothing;

create table if not exists careca.backoffice_versao (
  restaurante text primary key,
  versao bigint not null default 0,
  atualizado_em timestamptz not null default now()
);

create table if not exists careca.backoffice_dados (
  restaurante text not null references careca.backoffice_versao(restaurante) on delete cascade,
  chave text not null,
  dados jsonb not null,
  atualizado_em timestamptz not null default now(),
  primary key (restaurante, chave)
);

alter table careca.backoffice_acesso enable row level security;
alter table careca.backoffice_versao enable row level security;
alter table careca.backoffice_dados enable row level security;

create or replace function careca.backoffice_valida(p_utilizador text, p_senha text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from careca.backoffice_acesso a
                 where a.utilizador = p_utilizador and a.senha_hash = extensions.crypt(p_senha, a.senha_hash)) then
    raise exception 'Utilizador ou palavra-passe incorretos.' using errcode = '28P01';
  end if;
end $$;
revoke all on function careca.backoffice_valida(text, text) from public, anon, authenticated;

-- Devolve {versao, partes: {chave: dados}}; versao 0 e partes {} quando ainda não há nada guardado.
create or replace function public.careca_backoffice_ler(p_utilizador text, p_senha text, p_restaurante text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform careca.backoffice_valida(p_utilizador, p_senha);
  return jsonb_build_object(
    'versao', coalesce((select v.versao from careca.backoffice_versao v where v.restaurante = p_restaurante), 0),
    'partes', coalesce((select jsonb_object_agg(d.chave, d.dados) from careca.backoffice_dados d where d.restaurante = p_restaurante), '{}'::jsonb));
end $$;

-- Grava só as áreas alteradas. Recusa (errcode 40001) se outro browser gravou depois de p_versao_base.
create or replace function public.careca_backoffice_gravar(p_utilizador text, p_senha text, p_restaurante text,
                                                          p_versao_base bigint, p_partes jsonb, p_apagar text[] default '{}')
returns bigint language plpgsql security definer set search_path = '' as $$
declare nova bigint;
begin
  perform careca.backoffice_valida(p_utilizador, p_senha);
  if jsonb_typeof(p_partes) <> 'object' then raise exception 'p_partes tem de ser um objeto'; end if;
  insert into careca.backoffice_versao (restaurante) values (p_restaurante) on conflict do nothing;
  update careca.backoffice_versao v set versao = v.versao + 1, atualizado_em = now()
   where v.restaurante = p_restaurante and v.versao = p_versao_base
   returning v.versao into nova;
  if nova is null then
    raise exception 'Os dados foram alterados noutro browser.' using errcode = '40001';
  end if;
  insert into careca.backoffice_dados (restaurante, chave, dados)
  select p_restaurante, e.key, e.value from jsonb_each(p_partes) e
  on conflict (restaurante, chave) do update set dados = excluded.dados, atualizado_em = now();
  delete from careca.backoffice_dados d where d.restaurante = p_restaurante and d.chave = any(p_apagar);
  return nova;
end $$;

revoke all on function public.careca_backoffice_ler(text, text, text) from public;
revoke all on function public.careca_backoffice_gravar(text, text, text, bigint, jsonb, text[]) from public;
grant execute on function public.careca_backoffice_ler(text, text, text) to anon, authenticated;
grant execute on function public.careca_backoffice_gravar(text, text, text, bigint, jsonb, text[]) to anon, authenticated;
