-- Métricas do Careca (painel do dono em metricas.html).
-- Tudo vive no esquema `careca`, que a API do Supabase não expõe: o painel só lê através de
-- public.careca_painel(), que confirma que quem pede está em careca.admins.
-- O projeto Supabase é partilhado com o sistema de reservas; nada aqui toca no esquema public além da função.

create schema if not exists careca;
revoke all on schema careca from public, anon, authenticated;

create table careca.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  criado_em timestamptz not null default now()
);

create table careca.planos (
  id text primary key,
  nome text not null,
  preco_mensal_eur numeric(10,2) not null check (preco_mensal_eur >= 0),
  ativo boolean not null default true
);

create table careca.restaurantes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  nif text,
  cidade text,
  criado_em timestamptz not null default now(),
  demo boolean not null default false
);

create table careca.subscricoes (
  id uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references careca.restaurantes(id) on delete cascade,
  plano_id text not null references careca.planos(id),
  estado text not null check (estado in ('experiencia','ativa','em_atraso','cancelada')),
  inicio date not null default current_date,
  fim date,
  voucher_codigo text,
  demo boolean not null default false
);
create index on careca.subscricoes (restaurante_id);

create table careca.pagamentos (
  id uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references careca.restaurantes(id) on delete cascade,
  subscricao_id uuid references careca.subscricoes(id) on delete set null,
  valor_eur numeric(10,2) not null,
  estado text not null check (estado in ('pago','pendente','falhado','reembolsado')),
  metodo text,
  criado_em timestamptz not null default now(),
  demo boolean not null default false
);
create index on careca.pagamentos (criado_em desc);

create table careca.vouchers (
  codigo text primary key,
  descricao text,
  desconto_pct numeric(5,2) check (desconto_pct between 0 and 100),
  desconto_eur numeric(10,2) check (desconto_eur >= 0),
  max_usos int,
  usos int not null default 0,
  valido_ate date,
  ativo boolean not null default true,
  demo boolean not null default false
);

-- Preços do Gemini (USD por 1 milhão de tokens). Uma linha nova por mudança de preço.
create table careca.gemini_precos (
  modelo text not null,
  valido_desde date not null,
  entrada_usd_m numeric(10,4) not null,
  saida_usd_m numeric(10,4) not null,
  primary key (modelo, valido_desde)
);

-- Uma linha por pedido ao Gemini (cada leitura de fatura que não foi lida localmente).
create table careca.gemini_uso (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  restaurante_id uuid references careca.restaurantes(id) on delete set null,
  modelo text not null,
  tokens_entrada int not null default 0,  -- usageMetadata.promptTokenCount
  tokens_saida int not null default 0,    -- candidatesTokenCount + thoughtsTokenCount (o raciocínio paga como saída)
  custo_usd numeric(12,6),                -- calculado no insert com o preço em vigor nesse dia
  resultado text not null check (resultado in ('ok','erro','sobrecarga')),
  duracao_ms int,
  demo boolean not null default false
);
create index on careca.gemini_uso (criado_em desc);

create function careca.gemini_custo() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.custo_usd is null then
    select (new.tokens_entrada * p.entrada_usd_m + new.tokens_saida * p.saida_usd_m) / 1e6
      into new.custo_usd
      from careca.gemini_precos p
     where p.modelo = new.modelo and p.valido_desde <= new.criado_em::date
     order by p.valido_desde desc limit 1;
  end if;
  return new;
end $$;
create trigger gemini_custo before insert on careca.gemini_uso for each row execute function careca.gemini_custo();

-- Limites e orçamento que o painel mostra. Os limites de pedidos por minuto/dia reais estão no AI Studio.
create table careca.gemini_limites (
  chave text primary key,
  nome text not null,
  valor numeric,
  unidade text,
  nota text
);

alter table careca.admins enable row level security;
alter table careca.planos enable row level security;
alter table careca.restaurantes enable row level security;
alter table careca.subscricoes enable row level security;
alter table careca.pagamentos enable row level security;
alter table careca.vouchers enable row level security;
alter table careca.gemini_precos enable row level security;
alter table careca.gemini_uso enable row level security;
alter table careca.gemini_limites enable row level security;
revoke all on all tables in schema careca from public, anon, authenticated;

insert into careca.planos (id, nome, preco_mensal_eur) values
  ('base', 'Base (1 loja)', 49), ('pro', 'Pro (multi-espaço)', 119), ('enterprise', 'Enterprise', 279);

-- Fonte: ai.google.dev/pricing, nível pago Standard, consultado a 2026-11-26.
insert into careca.gemini_precos values
  ('gemini-3.8-flash', '2026-01-01', 0.75, 3.75),
  ('gemini-3.8-flash', '2027-01-01', 1.50, 7.50),
  ('gemini-3.5-flash-lite', '2026-01-01', 0.30, 2.50);

insert into careca.gemini_limites values
  ('orcamento_mensal_usd', 'Orçamento mensal (alerta no painel)', 10, 'USD', 'Defina aqui o seu teto. Não trava a API: o limite real define-se no Google Cloud Billing.'),
  ('tamanho_pedido_mb', 'Tamanho máximo por pedido', 20, 'MB', 'Limite da API para ficheiros enviados em linha.'),
  ('timeout_s', 'Tempo máximo de espera no backoffice', 120, 's', 'Definido no admin.html.'),
  ('tentativas', 'Tentativas em sobrecarga (429/500/503)', 4, 'pedidos', 'Espera 2, 4 e 8 s e depois passa para gemini-3.5-flash-lite.');

create function public.careca_painel() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  mes date := date_trunc('month', now())::date;
  r jsonb;
begin
  if not exists (select 1 from careca.admins where user_id = auth.uid()) then
    raise exception 'Sem acesso' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'gerado_em', now(),
    'tem_demo', exists (select 1 from careca.restaurantes where demo) or exists (select 1 from careca.gemini_uso where demo),
    'resumo', jsonb_build_object(
      'restaurantes', (select count(*) from careca.restaurantes),
      'novos_mes', (select count(*) from careca.restaurantes where criado_em >= mes),
      'ativas', (select count(*) from careca.subscricoes where estado = 'ativa'),
      'experiencia', (select count(*) from careca.subscricoes where estado = 'experiencia'),
      'em_atraso', (select count(*) from careca.subscricoes where estado = 'em_atraso'),
      'mrr_eur', (select coalesce(sum(p.preco_mensal_eur), 0) from careca.subscricoes s join careca.planos p on p.id = s.plano_id where s.estado in ('ativa','em_atraso')),
      'recebido_mes_eur', (select coalesce(sum(valor_eur), 0) from careca.pagamentos where estado = 'pago' and criado_em >= mes),
      'pendentes', (select count(*) from careca.pagamentos where estado = 'pendente'),
      'falhados_mes', (select count(*) from careca.pagamentos where estado = 'falhado' and criado_em >= mes)
    ),
    'planos', (select coalesce(jsonb_agg(x order by x->>'preco'), '[]') from (
      select jsonb_build_object('id', p.id, 'nome', p.nome, 'preco', p.preco_mensal_eur,
        'ativas', count(s.*) filter (where s.estado in ('ativa','em_atraso')),
        'experiencia', count(s.*) filter (where s.estado = 'experiencia')) x
      from careca.planos p left join careca.subscricoes s on s.plano_id = p.id group by p.id) t),
    'receita_mensal', (select coalesce(jsonb_agg(jsonb_build_object('mes', m, 'eur', eur) order by m), '[]') from (
      select to_char(date_trunc('month', criado_em), 'YYYY-MM') m, sum(valor_eur) eur
      from careca.pagamentos where estado = 'pago' and criado_em >= mes - interval '5 months' group by 1) t),
    'pagamentos', (select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('data', p.criado_em, 'restaurante', r.nome, 'valor', p.valor_eur, 'estado', p.estado, 'metodo', p.metodo, 'demo', p.demo) x
      from careca.pagamentos p join careca.restaurantes r on r.id = p.restaurante_id order by p.criado_em desc limit 15) t),
    'restaurantes', (select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('nome', r.nome, 'cidade', r.cidade, 'criado_em', r.criado_em, 'plano', pl.nome, 'estado', s.estado, 'demo', r.demo,
        'gemini_mes_usd', (select coalesce(sum(custo_usd), 0) from careca.gemini_uso g where g.restaurante_id = r.id and g.criado_em >= mes)) x
      from careca.restaurantes r
      left join lateral (select * from careca.subscricoes s where s.restaurante_id = r.id order by s.inicio desc limit 1) s on true
      left join careca.planos pl on pl.id = s.plano_id
      order by r.criado_em desc) t),
    'vouchers', (select coalesce(jsonb_agg(to_jsonb(v) order by v.ativo desc, v.codigo), '[]') from careca.vouchers v),
    'gemini', jsonb_build_object(
      'mes', (select jsonb_build_object('pedidos', count(*), 'erros', count(*) filter (where resultado <> 'ok'),
                'tokens_entrada', coalesce(sum(tokens_entrada), 0), 'tokens_saida', coalesce(sum(tokens_saida), 0),
                'custo_usd', coalesce(sum(custo_usd), 0), 'duracao_media_ms', round(avg(duracao_ms)))
              from careca.gemini_uso where criado_em >= mes),
      'mes_anterior_usd', (select coalesce(sum(custo_usd), 0) from careca.gemini_uso where criado_em >= mes - interval '1 month' and criado_em < mes),
      'total_usd', (select coalesce(sum(custo_usd), 0) from careca.gemini_uso),
      'por_dia', (select coalesce(jsonb_agg(jsonb_build_object('dia', d, 'pedidos', n, 'usd', usd) order by d), '[]') from (
        select gs::date d, count(g.id) n, coalesce(sum(g.custo_usd), 0) usd
        from generate_series(current_date - 29, current_date, interval '1 day') gs
        left join careca.gemini_uso g on g.criado_em::date = gs::date group by 1) t),
      'por_modelo', (select coalesce(jsonb_agg(jsonb_build_object('modelo', modelo, 'pedidos', n, 'usd', usd)), '[]') from (
        select modelo, count(*) n, sum(custo_usd) usd from careca.gemini_uso where criado_em >= mes group by 1) t),
      'precos', (select jsonb_agg(to_jsonb(p) order by p.modelo, p.valido_desde) from careca.gemini_precos p),
      'limites', (select jsonb_agg(to_jsonb(l) order by l.chave) from careca.gemini_limites l)
    )
  ) into r;
  return r;
end $$;

revoke all on function public.careca_painel() from public, anon;
grant execute on function public.careca_painel() to authenticated;
