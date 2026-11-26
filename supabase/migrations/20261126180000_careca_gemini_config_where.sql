-- O Supabase corre a extensão safeupdate nos pedidos da API: um UPDATE sem WHERE é recusado
-- («UPDATE requires a WHERE clause»). careca.config tem uma só linha (id = true).

create or replace function public.careca_gemini_config_guardar(p_chave text, p_modelo text, p_orcamento_usd numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from careca.admins) and not exists (select 1 from careca.admins where user_id = auth.uid()) then
    raise exception 'Só a conta de administrador pode alterar a configuração' using errcode = '42501';
  end if;
  if not exists (select 1 from careca.gemini_precos where modelo = p_modelo) then
    raise exception 'Modelo sem preço registado: %', p_modelo;
  end if;
  if p_orcamento_usd is null or p_orcamento_usd < 0 then raise exception 'Orçamento inválido'; end if;
  update careca.config set
    gemini_chave = coalesce(nullif(trim(p_chave), ''), gemini_chave),
    gemini_modelo = p_modelo,
    atualizado_em = now()
  where id;
  update careca.gemini_limites set valor = p_orcamento_usd where chave = 'orcamento_mensal_usd';
end $$;

-- O painel só lista modelos com preço (para estimar o custo). Fonte: ai.google.dev/pricing, nível pago Standard, 26/11/2026.
insert into careca.gemini_precos (modelo, valido_desde, entrada_usd_m, saida_usd_m) values
  ('gemini-3.6-flash', '2026-01-01', 0.75, 3.75),
  ('gemini-3.6-flash', '2027-01-01', 1.50, 7.50),
  ('gemini-3.1-flash-lite', '2026-01-01', 0.25, 1.50),
  ('gemini-3-flash-preview', '2026-01-01', 0.50, 3.00)
on conflict (modelo, valido_desde) do nothing;
