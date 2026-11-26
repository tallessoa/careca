# careca
`index.html` é a landing page e `admin.html` o backoffice. Os cálculos financeiros do backoffice estão em `calculos.js`, que tem de ser publicado junto do `admin.html`.

## Testes

```
npm test
```

Requer Node 18 ou mais recente. Não há dependências para instalar.

## Dados

Os dados do backoffice (fornecedores, artigos, fichas técnicas, faturas, vendas, quebras, alertas, definições…) ficam no Supabase, no esquema `careca` (`supabase/migrations/20261126160000_careca_backoffice.sql`): uma linha por área em `careca.backoffice_dados`, com uma versão em `careca.backoffice_versao`. O `admin.html` só lhes chega pelas funções `public.careca_backoffice_ler` e `public.careca_backoffice_gravar`, que confirmam utilizador e palavra-passe em `careca.backoffice_acesso` (por omissão admin/admin). Para mudar a palavra-passe: `update careca.backoffice_acesso set senha_hash = extensions.crypt('nova', extensions.gen_salt('bf')) where utilizador = 'admin';`

O browser guarda uma cópia no `localStorage` e envia para o Supabase só as áreas que mudaram. Na primeira entrada, se o Supabase estiver vazio, os dados que já estavam no browser são enviados. Se outro browser gravou entretanto, a página recarrega com a versão do Supabase. As preferências de ecrã ficam só no browser. **Exportar cópia** / **Importar cópia** continuam a funcionar (a cópia importada é enviada para o Supabase).

## Leitura de faturas (OCR)

Em **Definições** (barra lateral), indique o NIF do restaurante. Depois use **Ler fatura com OCR** (o OCR usa a API Google Gemini) em Compras & Faturas.

PDFs com texto (faturas emitidas por software, não digitalizadas) são lidos primeiro no browser com pdf.js, sem gastar tokens. A leitura local só é aceite se o NIF do fornecedor for válido, houver linhas de artigos e a soma das linhas com IVA coincidir, ao cêntimo, com um total impresso no documento. Caso contrário, o ficheiro segue para o Gemini.

A chave e o modelo do Gemini configuram-se no painel de métricas (`metricas.html`), não no backoffice. O backoffice envia o pedido à Edge Function `careca-ocr` (`supabase/functions/`), que junta a chave guardada em `careca.config`, chama a Google, regista tokens e custo em `careca.gemini_uso` e devolve a resposta tal e qual. A função recusa pedidos quando o gasto real do mês atinge o orçamento definido no painel. Como o backoffice ainda não tem login no servidor, qualquer pessoa com o endereço da função pode gastar até esse orçamento.

Uma linha com vários produtos (por exemplo, um kit) pode ser dividida na revisão com **Dividir linha**. Cada parte tem a sua descrição, quantidade, unidade, valor líquido e artigo do catálogo, e entra no stock e no CMP como uma compra própria. A fatura só pode ser aprovada quando os valores das partes somam, ao cêntimo, o valor da linha.

## Validades e artigos parados

Cada artigo do catálogo pode ter «Validade após receção (dias)». Ao receber mercadoria, a validade do stock passa a ser a data do documento mais esses dias, exceto se o lote anterior ainda estava dentro do prazo e termina antes: nesse caso mantém-se a data mais próxima. Pode corrigir a data em Inventário → Validades e artigos parados. Há alertas para validade passada, validade a terminar (2 dias) e artigos sem saídas há mais dias do que o definido em Definições (14 por omissão).

## Painel de métricas (dono)

`metricas.html` mostra restaurantes, subscrições e planos, pagamentos, vouchers e o gasto estimado com o Gemini. Abre em `/metricas.html` (por exemplo https://kareca.netlify.app/metricas.html) e pede login com a conta Supabase do administrador. Enquanto todos os dados forem de demonstração, também aceita `admin` / `admin`; o primeiro restaurante, subscrição, pagamento ou voucher real (`demo = false`) fecha esse acesso (o uso do Gemini não conta) e passa a ser preciso a conta Supabase. Com admin/admin vê-se a configuração do Gemini, mas só a conta Supabase a pode alterar.

Os dados vivem no Supabase, no esquema `careca` (ver `supabase/migrations/`). Esse esquema não está exposto na API: o painel só lê através da função `public.careca_painel()`, que recusa quem não estiver em `careca.admins`. Para dar acesso a outra conta: `insert into careca.admins (user_id) select id from auth.users where email = '...';`

Por enquanto as tabelas têm dados de demonstração (`supabase/demo_metricas.sql`, linhas com `demo = true` e nomes «[DEMO]»), porque a app ainda não envia dados. O custo do Gemini é uma estimativa: cada pedido grava os tokens de `usageMetadata` e um trigger calcula o custo com `careca.gemini_precos`. O valor faturado exato só se vê no Google Cloud Billing; os limites de pedidos por minuto/dia, no AI Studio. Quando a Google mudar preços, acrescente uma linha a `careca.gemini_precos` com a nova data.
