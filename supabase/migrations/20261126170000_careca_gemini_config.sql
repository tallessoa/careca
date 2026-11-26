-- Configuração do Gemini no superadmin (metricas.html). A chave fica só aqui; o admin.html lê faturas
-- através da Edge Function careca-ocr, que usa esta chave e regista cada pedido em careca.gemini_uso.

create table careca.config (
  id boolean primary key default true check (id),  -- uma única linha
  gemini_chave text,
  gemini_modelo text not null default 'gemini-3.8-flash',
  atualizado_em timestamptz not null default now()
);
insert into careca.config default values;
alter table careca.config enable row level security;
revoke all on careca.config from public, anon, authenticated;

-- Escolha do Talles: o uso do Gemini não conta como dado real para fechar o acesso admin/admin.
create or replace function careca.so_demo() returns boolean language sql stable set search_path = '' as $$
  select not exists (select 1 from careca.restaurantes where not demo)
     and not exists (select 1 from careca.subscricoes where not demo)
     and not exists (select 1 from careca.pagamentos where not demo)
     and not exists (select 1 from careca.vouchers where not demo)
$$;

-- Leitura para o painel: nunca devolve a chave, só os 4 últimos caracteres.
create function public.careca_gemini_config() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare admin boolean := exists (select 1 from careca.admins where user_id = auth.uid());
begin
  if not (admin or careca.so_demo()) then raise exception 'Sem acesso' using errcode = '42501'; end if;
  return (select jsonb_build_object(
    'modelo', c.gemini_modelo,
    'chave_fim', case when c.gemini_chave is null then null else right(c.gemini_chave, 4) end,
    'atualizado_em', c.atualizado_em,
    'orcamento_usd', (select valor from careca.gemini_limites where chave = 'orcamento_mensal_usd'),
    'modelos', (select jsonb_agg(distinct modelo) from careca.gemini_precos),
    'pode_editar', admin)
  from careca.config c);
end $$;
revoke all on function public.careca_gemini_config() from public;
grant execute on function public.careca_gemini_config() to anon, authenticated;

-- Gravar: só a conta administradora (não o admin/admin). Chave vazia mantém a atual.
create function public.careca_gemini_config_guardar(p_chave text, p_modelo text, p_orcamento_usd numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from careca.admins where user_id = auth.uid()) then
    raise exception 'Só a conta de administrador pode alterar a configuração' using errcode = '42501';
  end if;
  if not exists (select 1 from careca.gemini_precos where modelo = p_modelo) then
    raise exception 'Modelo sem preço registado: %', p_modelo;
  end if;
  if p_orcamento_usd is null or p_orcamento_usd < 0 then raise exception 'Orçamento inválido'; end if;
  update careca.config set
    gemini_chave = coalesce(nullif(trim(p_chave), ''), gemini_chave),
    gemini_modelo = p_modelo,
    atualizado_em = now();
  update careca.gemini_limites set valor = p_orcamento_usd where chave = 'orcamento_mensal_usd';
end $$;
revoke all on function public.careca_gemini_config_guardar(text, text, numeric) from public, anon;
grant execute on function public.careca_gemini_config_guardar(text, text, numeric) to authenticated;

-- Só para a Edge Function (service_role): chave, modelo a usar e gasto real do mês.
create function public.careca_gemini_preparar(p_modelo text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m text;
begin
  select coalesce(nullif(p_modelo, ''), gemini_modelo) into m from careca.config;
  if not exists (select 1 from careca.gemini_precos where modelo = m) then
    raise exception 'Modelo não permitido: %', m;
  end if;
  return (select jsonb_build_object(
    'chave', c.gemini_chave,
    'modelo', m,
    'orcamento_usd', (select valor from careca.gemini_limites where chave = 'orcamento_mensal_usd'),
    'gasto_mes_usd', (select coalesce(sum(custo_usd), 0) from careca.gemini_uso
                       where not demo and criado_em >= date_trunc('month', now())))
  from careca.config c);
end $$;

create function public.careca_gemini_registar(p_modelo text, p_entrada int, p_saida int, p_resultado text, p_duracao_ms int) returns void
language sql security definer set search_path = '' as $$
  insert into careca.gemini_uso (modelo, tokens_entrada, tokens_saida, resultado, duracao_ms)
  values (p_modelo, p_entrada, p_saida, p_resultado, p_duracao_ms);
$$;

revoke all on function public.careca_gemini_preparar(text) from public, anon, authenticated;
revoke all on function public.careca_gemini_registar(text, int, int, text, int) from public, anon, authenticated;
grant execute on function public.careca_gemini_preparar(text) to service_role;
grant execute on function public.careca_gemini_registar(text, int, int, text, int) to service_role;
