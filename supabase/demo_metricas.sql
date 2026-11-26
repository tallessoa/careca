-- Dados de DEMONSTRAÇÃO para o painel de métricas (todas as linhas com demo = true).
-- Apagar quando a app começar a enviar dados reais:
--   delete from careca.gemini_uso where demo; delete from careca.pagamentos where demo;
--   delete from careca.subscricoes where demo; delete from careca.restaurantes where demo; delete from careca.vouchers where demo;
select setseed(0.42);

insert into careca.restaurantes (nome, nif, cidade, criado_em, demo) values
  ('[DEMO] Tasca do Bairro', '500000001', 'Lisboa', now() - interval '150 days', true),
  ('[DEMO] O Marisqueiro', '500000002', 'Cascais', now() - interval '130 days', true),
  ('[DEMO] Pizzaria Forno Velho', '500000003', 'Porto', now() - interval '110 days', true),
  ('[DEMO] Grupo Sabores (3 lojas)', '500000004', 'Lisboa', now() - interval '95 days', true),
  ('[DEMO] Café Central', '500000005', 'Coimbra', now() - interval '70 days', true),
  ('[DEMO] Sushi Ribeira', '500000006', 'Porto', now() - interval '45 days', true),
  ('[DEMO] Churrasqueira Alegre', '500000007', 'Braga', now() - interval '20 days', true),
  ('[DEMO] Bistrô da Sé', '500000008', 'Lisboa', now() - interval '6 days', true);

insert into careca.vouchers (codigo, descricao, desconto_pct, desconto_eur, max_usos, usos, valido_ate, ativo, demo) values
  ('LANCAMENTO50', '50% nos 3 primeiros meses', 50, null, 20, 3, current_date + 35, true, true),
  ('FEIRA-HORECA', '1 mês grátis (feira)', 100, null, 50, 1, current_date + 90, true, true),
  ('AMIGO20', '20 € de desconto por indicação', null, 20, null, 2, null, true, true),
  ('BETA2026', 'Clientes beta', 30, null, 10, 10, current_date - 15, false, true);

insert into careca.subscricoes (restaurante_id, plano_id, estado, inicio, voucher_codigo, demo)
select r.id, v.plano, v.estado, (r.criado_em + interval '14 days')::date, v.voucher, true
from careca.restaurantes r join (values
  ('[DEMO] Tasca do Bairro', 'base', 'ativa', 'BETA2026'),
  ('[DEMO] O Marisqueiro', 'pro', 'ativa', null),
  ('[DEMO] Pizzaria Forno Velho', 'base', 'em_atraso', null),
  ('[DEMO] Grupo Sabores (3 lojas)', 'enterprise', 'ativa', 'LANCAMENTO50'),
  ('[DEMO] Café Central', 'base', 'cancelada', null),
  ('[DEMO] Sushi Ribeira', 'pro', 'ativa', 'AMIGO20'),
  ('[DEMO] Churrasqueira Alegre', 'base', 'experiencia', 'FEIRA-HORECA'),
  ('[DEMO] Bistrô da Sé', 'pro', 'experiencia', null)
) v(nome, plano, estado, voucher) on v.nome = r.nome;

-- Uma mensalidade por mês desde o início da subscrição; os 2 últimos estados variam.
insert into careca.pagamentos (restaurante_id, subscricao_id, valor_eur, estado, metodo, criado_em, demo)
select s.restaurante_id, s.id, p.preco_mensal_eur,
  case when s.estado = 'em_atraso' and m.d > now() - interval '35 days' then 'falhado'
       when s.estado = 'cancelada' and m.d > now() - interval '35 days' then 'reembolsado'
       when m.d > now() - interval '3 days' then 'pendente'
       else 'pago' end,
  (array['MB Way','Cartão','Débito direto'])[1 + floor(random() * 3)::int], m.d, true
from careca.subscricoes s join careca.planos p on p.id = s.plano_id
cross join lateral generate_series(s.inicio::timestamptz, now(), interval '1 month') m(d)
where s.demo and s.estado <> 'experiencia';

-- Leituras de faturas no Gemini nos últimos 75 dias (mais uso nos dias úteis).
insert into careca.gemini_uso (criado_em, restaurante_id, modelo, tokens_entrada, tokens_saida, resultado, duracao_ms, demo)
select d + (random() * interval '10 hours') + interval '9 hours', r.id,
  case when random() < 0.08 then 'gemini-3.5-flash-lite' else 'gemini-3.8-flash' end,
  1800 + floor(random() * 2600)::int, 900 + floor(random() * 3200)::int,
  case when random() < 0.04 then 'erro' when random() < 0.05 then 'sobrecarga' else 'ok' end,
  6000 + floor(random() * 30000)::int, true
from generate_series(current_date - 75, current_date, interval '1 day') d
cross join careca.restaurantes r
cross join generate_series(1, 4) n
-- `+ n * 0` impede o Postgres de avaliar random() uma só vez por dia.
where r.demo and r.criado_em < d and random() + n * 0 < case when extract(isodow from d) < 6 then 0.6 else 0.2 end;
