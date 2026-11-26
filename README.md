# careca
`index.html` é a landing page e `admin.html` o backoffice. Os cálculos financeiros do backoffice estão em `calculos.js`, que tem de ser publicado junto do `admin.html`.

## Testes

```
npm test
```

Requer Node 18 ou mais recente. Não há dependências para instalar.

## Dados

Tudo fica guardado no `localStorage` do browser. Use **Exportar cópia** / **Importar cópia** (barra lateral) para guardar ou mudar de computador.

## Leitura de faturas (OCR)

Em **Definições** (barra lateral), indique o NIF do restaurante e uma chave da API Gemini (aistudio.google.com). Depois use **Ler fatura com OCR** (o OCR usa a API Google Gemini) em Compras & Faturas.

PDFs com texto (faturas emitidas por software, não digitalizadas) são lidos primeiro no browser com pdf.js, sem gastar tokens. A leitura local só é aceite se o NIF do fornecedor for válido, houver linhas de artigos e a soma das linhas com IVA coincidir, ao cêntimo, com um total impresso no documento. Caso contrário, o ficheiro segue para o Gemini.

A chave fica apenas no `localStorage` deste browser e não entra na cópia exportada. Como o pedido sai do browser, quem usar o computador consegue ver a chave. Ao passar para online, a chamada ao Gemini deve passar a ser feita no servidor.

Uma linha com vários produtos (por exemplo, um kit) pode ser dividida na revisão com **Dividir linha**. Cada parte tem a sua descrição, quantidade, unidade, valor líquido e artigo do catálogo, e entra no stock e no CMP como uma compra própria. A fatura só pode ser aprovada quando os valores das partes somam, ao cêntimo, o valor da linha.

## Validades e artigos parados

Cada artigo do catálogo pode ter «Validade após receção (dias)». Ao receber mercadoria, a validade do stock passa a ser a data do documento mais esses dias, exceto se o lote anterior ainda estava dentro do prazo e termina antes: nesse caso mantém-se a data mais próxima. Pode corrigir a data em Inventário → Validades e artigos parados. Há alertas para validade passada, validade a terminar (2 dias) e artigos sem saídas há mais dias do que o definido em Definições (14 por omissão).
