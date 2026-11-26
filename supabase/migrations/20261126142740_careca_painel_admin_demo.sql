-- Login admin/admin do metricas.html: quem não tem conta só recebe o painel enquanto
-- não existir nenhum dado real (todas as linhas com demo = true). O primeiro dado real fecha este acesso.
create or replace function careca.so_demo() returns boolean language sql stable set search_path = '' as $$
  select not exists (select 1 from careca.restaurantes where not demo)
     and not exists (select 1 from careca.subscricoes where not demo)
     and not exists (select 1 from careca.pagamentos where not demo)
     and not exists (select 1 from careca.vouchers where not demo)
     and not exists (select 1 from careca.gemini_uso where not demo)
$$;

create or replace function public.careca_painel() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  mes date := date_trunc('month', now())::date;
  r jsonb;
begin
  if not (exists (select 1 from careca.admins where user_id = auth.uid()) or careca.so_demo()) then
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

revoke all on function public.careca_painel() from public;
grant execute on function public.careca_painel() to anon, authenticated;
