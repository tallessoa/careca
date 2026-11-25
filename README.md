# careca
`index.html` é a landing page e `admin.html` o backoffice. Os cálculos financeiros do backoffice estão em `calculos.js`, que tem de ser publicado junto do `admin.html`.

## Testes

```
npm test
```

Requer Node 18 ou mais recente. Não há dependências para instalar.

## Dados

Tudo fica guardado no `localStorage` do browser. Use **Exportar cópia** / **Importar cópia** (barra lateral) para guardar ou mudar de computador.

## Leitura de faturas (Google Gemini)

Em **Definições** (barra lateral), indique o NIF do restaurante e uma chave da API Gemini (aistudio.google.com). Depois use **Ler fatura com Gemini** em Compras & Faturas.

A chave fica apenas no `localStorage` deste browser e não entra na cópia exportada. Como o pedido sai do browser, quem usar o computador consegue ver a chave. Ao passar para online, a chamada ao Gemini deve passar a ser feita no servidor.
