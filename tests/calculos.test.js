// Testes dos cálculos financeiros do backoffice (calculos.js). Correr com: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'calculos.js'), 'utf8');

// Carrega calculos.js com o mesmo contexto global que tem no admin.html.
function load(state) {
    const ctx = vm.createContext({ appState: state, RESTAURANT: 'chiado', STORE_KEYS: ['chiado'] });
    vm.runInContext(code, ctx);
    return ctx;
}

const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} esperado ${expected}, obtido ${actual}`);

function ing(id, baseUnit, yieldFactor, cmp, extra = {}) {
    return { id, name: id, baseUnit, yieldFactor, byStore: { chiado: { stockTheoretical: 0, stockCounted: 0, minStock: 0, cmp, ...extra } } };
}

function recipe(id, items, extra = {}) {
    return {
        // Fichas de teste com preços escritos à mão; o modo global tem testes próprios.
        id, name: id, recipeType: 'final_product', priceMode: 'manual', yieldQuantity: 1, yieldUnit: 'un', cookingLossPct: 0, extraFixedCost: 0,
        vatRate: 13, pvpSalaGross: 0, pvpTakeawayGross: 0, pvpUberGross: 0, soldByStore: { chiado: 0 }, items, ...extra
    };
}

const line = (type, refId, netQty, unit) => ({ type, refId, netQty, unit });

// Excerto dos dados de demonstração (Bowl de Salmão Braseado e o salmão marinado).
function bowlState() {
    return {
        activeStore: 'chiado',
        ingredients: [ing('ing_salmao', 'kg', 0.82, 12.35), ing('ing_arroz', 'kg', 1, 3.2), ing('ing_abacate', 'kg', 0.75, 5.4)],
        recipes: [
            recipe('rec_sub_salmao', [line('ingredient', 'ing_salmao', 1, 'kg')], { recipeType: 'sub_recipe', yieldUnit: 'kg', extraFixedCost: 0.65 }),
            recipe('rec_bowl', [
                line('sub_recipe', 'rec_sub_salmao', 180, 'g'),
                line('ingredient', 'ing_arroz', 0.14, 'kg'),
                line('ingredient', 'ing_abacate', 65, 'g')
            ], { extraFixedCost: 0.34, pvpSalaGross: 17.5, pvpTakeawayGross: 16.9, pvpUberGross: 19.9 })
        ],
        subRecipesInventory: [], salesLog: [], wasteLogs: [], storeFinancials: {}, openingVolumeDate: new Date().toISOString()
    };
}

test('convertToBaseQty converte dentro do mesmo grupo de unidades', () => {
    const c = load(bowlState());
    near(c.convertToBaseQty(180, 'g', 'kg'), 0.18);
    near(c.convertToBaseQty(1.5, 'kg', 'g'), 1500);
    near(c.convertToBaseQty(4, 'cl', 'L'), 0.04);
    near(c.convertToBaseQty(0.75, 'L', 'ml'), 750);
    near(c.convertToBaseQty(3, 'un', 'un'), 3);
    assert.ok(Number.isNaN(c.convertToBaseQty(1, 'kg', 'L')));
    assert.ok(Number.isNaN(c.convertToBaseQty(1, 'un', 'g')));
});

test('custo de ficha aplica o rendimento do ingrediente e o custo fixo extra', () => {
    const c = load(bowlState());
    const sub = c.calculateRecipeCost(c.getRecipe('rec_sub_salmao'));
    near(sub.unitCost, 12.35 / 0.82 + 0.65);
});

test('custo de ficha soma sub-receitas em cascata, com conversão de unidades', () => {
    const c = load(bowlState());
    const salmaoKg = 12.35 / 0.82 + 0.65;
    const expected = 0.18 * salmaoKg + 0.14 * 3.2 + (0.065 / 0.75) * 5.4 + 0.34;
    near(c.calculateRecipeCost(c.getRecipe('rec_bowl')).unitCost, expected);
});

test('a perda de confeção reduz o rendimento e sobe o custo unitário', () => {
    const s = bowlState();
    s.recipes.push(recipe('rec_sopa', [line('ingredient', 'ing_arroz', 2, 'kg')], { yieldQuantity: 10, cookingLossPct: 20, extraFixedCost: 1.6 }));
    const c = load(s);
    const r = c.calculateRecipeCost(c.getRecipe('rec_sopa'));
    near(r.batchCost, 2 * 3.2 + 1.6);
    near(r.unitCost, (2 * 3.2 + 1.6) / 8);
});

test('a simulação de preços substitui o CMP só dos ingredientes indicados', () => {
    const c = load(bowlState());
    const base = c.calculateRecipeCost(c.getRecipe('rec_bowl')).unitCost;
    const prices = new Map([['ing_salmao', 14.35]]);
    const sim = c.calculateRecipeCost(c.getRecipe('rec_bowl'), prices).unitCost;
    near(sim - base, 0.18 * (2 / 0.82));
});

test('dependências circulares não bloqueiam o cálculo e são recusadas na validação', () => {
    const s = bowlState();
    s.recipes.push(
        recipe('rec_a', [line('sub_recipe', 'rec_b', 1, 'un')], { recipeType: 'sub_recipe' }),
        recipe('rec_b', [line('sub_recipe', 'rec_a', 1, 'un'), line('ingredient', 'ing_arroz', 1, 'kg')], { recipeType: 'sub_recipe' })
    );
    const c = load(s);
    assert.ok(Number.isFinite(c.calculateRecipeCost(c.getRecipe('rec_a')).unitCost));
    assert.equal(c.validateRecipe(c.getRecipe('rec_a'), 'rec_a'), 'Dependência circular entre fichas.');
});

test('validateRecipe recusa unidades incompatíveis e artigos em falta', () => {
    const s = bowlState();
    s.recipes.push(
        recipe('rec_mau', [line('ingredient', 'ing_arroz', 1, 'L')]),
        recipe('rec_orfa', [line('ingredient', 'ing_inexistente', 1, 'kg')])
    );
    const c = load(s);
    assert.equal(c.validateRecipe(c.getRecipe('rec_bowl'), 'rec_bowl'), '');
    assert.equal(c.validateRecipe(c.getRecipe('rec_mau'), 'rec_mau'), 'Unidade incompatível com ing_arroz');
    assert.equal(c.validateRecipe(c.getRecipe('rec_orfa'), 'rec_orfa'), 'Referência de artigo em falta.');
});

test('margens por canal: PVP sem IVA, embalagem e comissão Uber de 30%', () => {
    const c = load(bowlState());
    const rec = c.getRecipe('rec_bowl');
    const cost = c.calculateRecipeCost(rec).unitCost;
    const [sala, takeaway, uber] = c.getChannelMetrics(rec);

    near(sala.pvpNet, 17.5 / 1.13);
    near(sala.marginEur, 17.5 / 1.13 - cost);
    near(sala.foodCostPct, cost / (17.5 / 1.13) * 100);

    near(takeaway.totalCost, cost + 0.45);
    near(takeaway.marginEur, 16.9 / 1.13 - cost - 0.45);

    near(uber.commEur, 19.9 / 1.13 * 0.3);
    near(uber.marginEur, 19.9 / 1.13 * 0.7 - cost - 0.65);
});

test('margens por canal: PVP a zero não divide por zero', () => {
    const c = load(bowlState());
    const [sala] = c.getChannelMetrics(c.getRecipe('rec_sub_salmao'));
    assert.equal(sala.foodCostPct, 0);
    assert.equal(sala.marginPct, 0);
});

test('Matriz BCG classifica por margem e volume face à média da carta', () => {
    const s = bowlState();
    s.ingredients.push(ing('ing_zero', 'un', 1, 0));
    const prato = (id, pvp, vendidos) => recipe(id, [line('ingredient', 'ing_zero', 1, 'un')], { pvpSalaGross: pvp, soldByStore: { chiado: vendidos } });
    s.recipes = [prato('estrela', 22.6, 100), prato('vaca', 11.3, 100), prato('enigma', 22.6, 10), prato('cao', 11.3, 10)];
    const c = load(s);
    const { classified, avgMargin, avgVolume } = c.computeDynamicBcg();
    near(avgMargin, 15);
    near(avgVolume, 55);
    assert.deepEqual(Object.fromEntries(classified.map(x => [x.recipe.id, x.quadrant])),
        { estrela: 'star', vaca: 'cash_cow', enigma: 'question_mark', cao: 'dog' });
});

test('vendas a 30 dias somam o volume inicial e o registo de vendas recente', () => {
    const s = bowlState();
    const dias = n => new Date(Date.now() - n * 86400000).toISOString();
    s.recipes[1].soldByStore = { chiado: 50 };
    s.salesLog = [
        { store: 'chiado', date: dias(1), recipeIds: ['rec_bowl'], qty: 3 },
        { store: 'chiado', date: dias(2), recipeIds: ['rec_bowl', 'rec_bowl'], qty: 2 },
        { store: 'chiado', date: dias(40), recipeIds: ['rec_bowl'], qty: 100 },
        { store: 'outra', date: dias(1), recipeIds: ['rec_bowl'], qty: 100 }
    ];
    let c = load(s);
    assert.equal(c.getRecipeSold30d(c.getRecipe('rec_bowl')), 50 + 3 + 4);

    s.openingVolumeDate = dias(31);
    c = load(s);
    assert.equal(c.getRecipeSold30d(c.getRecipe('rec_bowl')), 3 + 4);
});

test('variação de inventário compara a contagem (com preparados) com o stock teórico', () => {
    const s = bowlState();
    s.ingredients = [
        ing('ing_salmao', 'kg', 0.82, 12.35, { stockTheoretical: 9.5, stockCounted: 9.3, countBasis: 9.5, countCost: 12.35, preparedCount: 0.9 / 0.82 }),
        ing('ing_gin', 'L', 1, 22.85, { stockTheoretical: 7, stockCounted: 4.2 })
    ];
    const c = load(s);
    const { rows, totalVarianceEur } = c.calculateInventoryVariance();
    const salmao = (9.3 + 0.9 / 0.82 - 9.5) * 12.35;
    const gin = (4.2 - 7) * 22.85;
    near(rows[0].varianceEur, salmao);
    near(rows[1].varianceEur, gin);
    near(totalVarianceEur, salmao + gin);
});

test('demonstração de resultados: EBITDA desconta salários, delivery, fixos e quebras', () => {
    const s = bowlState();
    const monthly = [0, 0, 0, 0, 0, 0].map(() => ({ rev: 1000, cogs: 300 }));
    s.storeFinancials = { chiado: { revenue: 6000, cogs: 1800, payroll: 1500, deliveryFees: 200, fixedCosts: 900, monthly } };
    s.wasteLogs = [{ store: 'chiado', cost: 40 }, { store: 'outra', cost: 999 }];
    const f = load(s).getAggregatedFinancials();
    near(f.grossMargin, 4200);
    near(f.foodCostPct, 30);
    near(f.primeCostPct, 55);
    near(f.wasteCost, 40);
    near(f.ebitda, 4200 - 1500 - 200 - 900 - 40);
    near(f.monthly[5].rev, 1000);

    s.storeFinancials.chiado = { revenue: 0, cogs: 0, payroll: 0, deliveryFees: 0, fixedCosts: 0, monthly };
    const vazio = load(s).getAggregatedFinancials();
    assert.equal(vazio.foodCostPct, 0);
    assert.equal(vazio.ebitdaPct, 0);
});

test('Custo Médio Ponderado após compra', () => {
    const c = load(bowlState());
    near(c.weightedAverageCost(10, 12, 10, 14), 13);
    near(c.weightedAverageCost(0, 12, 5, 14), 14);
    near(c.weightedAverageCost(-2, 12, 5, 14), 14);
});

test('supplierPriceTrend: índice médio dos insumos do fornecedor', () => {
    const ctx = load({ ingredients: [
        { id: 'a', supplierId: 's', priceHistory: [10, 11] },
        { id: 'b', supplierId: 's', priceHistory: [4, 4, 5] },
        { id: 'c', supplierId: 'x', priceHistory: [1, 9] }
    ] });
    const t = ctx.supplierPriceTrend('s');
    // a alinha à direita com b: a = [100, 100, 110], b = [100, 100, 125] → último ponto 117,5
    near(t.history[2], 117.5);
    near(t.inflationPct, 17.5);
    near(ctx.supplierPriceTrend('nenhum').inflationPct, 0);
});

test('suggestedPvpGross: custo 3 €, meta 30%, IVA 13% → 11,30 €', () => {
    const ctx = load({});
    near(ctx.suggestedPvpGross(3, 30, 13), 11.3);
    assert.equal(ctx.suggestedPvpGross(3, 0, 13), 0);
});

test('periodPurchases: guias e faturas sem guia, menos notas de crédito, sem serviços', () => {
    const inv = (docType, date, lines, extra = {}) => ({ store: 'chiado', status: 'Aprovada', docType, date, lines, net: 0, ...extra });
    const ctx = load({ invoices: [
        inv('Guia de Remessa', '2026-11-02', [{ qty: 2, price: 10 }]),
        inv('Fatura', '2026-11-03', [{ qty: 2, price: 10 }], { receiptRef: 'GR 1' }),
        inv('Fatura', '2026-11-04', [{ qty: 1, price: 5 }, { service: true, qty: 1, price: 100 }]),
        inv('Nota de Crédito', '2026-11-05', [{ qty: 1, price: 4 }]),
        inv('Fatura', '2026-10-30', [{ qty: 1, price: 999 }]),
        { store: 'chiado', status: 'Aprovada', docType: 'Fatura', date: '2026-11-01', net: 7 }
    ] });
    near(ctx.periodPurchases('2026-11'), 20 + 5 - 4 + 7);
});

test('periodRealCogs: inicial + compras − final', () => {
    const r = load({}).periodRealCogs(1000, 500, 600, 3000, 800);
    near(r.realCogs, 900);
    near(r.gapEur, 100);
    near(r.realPct, 30);
});

test('recipeAllergens: junta alergénios das sub-receitas sem repetir', () => {
    const ctx = load({
        ingredients: [{ id: 'a', allergens: ['Peixe'] }, { id: 'b', allergens: ['Leite', 'Peixe'] }, { id: 'c' }],
        recipes: [
            { id: 'sub', items: [{ type: 'ingredient', refId: 'b' }] },
            { id: 'prato', items: [{ type: 'ingredient', refId: 'a' }, { type: 'sub_recipe', refId: 'sub' }, { type: 'ingredient', refId: 'c' }] }
        ]
    });
    assert.deepEqual([...ctx.recipeAllergens(ctx.getRecipe('prato'))], ['Leite', 'Peixe']);
});

test('bestSupplierPrice: escolhe o preço mais baixo', () => {
    const ctx = load({});
    assert.equal(ctx.bestSupplierPrice({ supplierPrices: { x: { price: 5 }, y: { price: 4 } } }).supplierId, 'y');
    assert.equal(ctx.bestSupplierPrice({}), null);
});

test('normalizeNif: tira prefixo PT e espaços', () => {
    const ctx = load({});
    assert.equal(ctx.normalizeNif('PT 509 412 883'), '509412883');
    assert.equal(ctx.normalizeNif(null), '');
});

test('matchIngredient: SKU primeiro, depois palavras em comum', () => {
    const ctx = load({ ingredients: [{ id: 'a', sku: 'PEIX-001', name: 'Lombo de Salmão Fresco' }, { id: 'b', sku: 'PEIX-014', name: 'Polvo Nacional Limpo' }] });
    assert.equal(ctx.matchIngredient('qualquer', 'peix-014').id, 'b');
    assert.equal(ctx.matchIngredient('SALMAO FRESCO NORUEGA LOMBO').id, 'a');
    assert.equal(ctx.matchIngredient('Detergente'), null);
});

test('invoiceLineToBase: 500 g a 6 €/kg → 0,5 kg a 6 €', () => {
    const ctx = load({});
    const r = ctx.invoiceLineToBase({ qty: 500, unit: 'g', unit_price_net: 0.006 }, { baseUnit: 'kg' });
    near(r.qty, 0.5);
    near(r.price, 6);
    assert.equal(ctx.invoiceLineToBase({ qty: 2, unit: 'cx', unit_price_net: 5 }, { baseUnit: 'kg' }), null);
});

test('contrastLimits: corta 1% em cada ponta; imagem lisa fica igual', () => {
    const ctx = load({});
    const h = new Array(256).fill(0);
    h[0] = 1; h[60] = 49; h[200] = 49; h[255] = 1;
    assert.deepEqual([...ctx.contrastLimits(h)], [60, 200]);
    const flat = new Array(256).fill(0); flat[128] = 10;
    assert.deepEqual([...ctx.contrastLimits(flat)], [0, 255]);
});

test('validNif: dígito de controlo', () => {
    const ctx = load({});
    assert.equal(ctx.validNif('PT 509 412 882'), true);
    assert.equal(ctx.validNif('509412883'), false);
    assert.equal(ctx.validNif('012345678'), false);
});

test('parsePtNumber: vírgula decimal, milhares e ponto decimal', () => {
    const ctx = load({});
    assert.equal(ctx.parsePtNumber('1.234,56'), 1234.56);
    assert.equal(ctx.parsePtNumber('12.80'), 12.8);
    assert.equal(ctx.parsePtNumber('1.500'), 1500);
    assert.equal(ctx.parsePtNumber('23%'), 23);
    assert.ok(Number.isNaN(ctx.parsePtNumber('kg')));
});

const pdfRows = [
    'Pescados Atlântico, Lda.', 'Rua do Porto 12, Matosinhos NIF: 509 412 882', 'FATURA FT A2026/1842 Data: 24-11-2026', 'ATCUD: JFX3K9-1842',
    'Cliente: Restaurante Chiado NIF 516234870', 'Ref Descrição Qtd Un Preço Desc IVA Total',
    'SAL01 Lombo de Salmão Fresco 25,000 kg 12,80 0,00 6% 320,00', 'POL02 Polvo cozido 10 kg 16,50 10% 6% 148,50', 'TR Transporte 1 un 5,00 23% 5,00',
    'Total Ilíquido 473,50', 'Total IVA 29,26', 'Total (EUR) 502,76'
];

test('parseInvoiceText: lê cabeçalho, linhas (com desconto) e valida o total', () => {
    const ctx = load({});
    const r = ctx.parseInvoiceText(pdfRows, '516234870');
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.ex.supplier_nif, '509412882');
    assert.equal(r.ex.customer_nif, '516234870');
    assert.equal(r.ex.invoice_number, 'FT A2026/1842');
    assert.equal(r.ex.date, '2026-11-24');
    assert.equal(r.ex.atcud, 'JFX3K9-1842');
    assert.equal(r.ex.lines.length, 3);
    near(r.ex.lines[1].unit_price_net, 14.85);
    assert.equal(r.ex.lines[2].vat_rate, 23);
    assert.deepEqual({ ...r.ex.totals }, { net: 473.5, vat: 29.26, gross: 502.76 });
});

test('parseInvoiceText: recusa quando o total impresso não bate ou falta o NIF', () => {
    const ctx = load({});
    assert.equal(ctx.parseInvoiceText(pdfRows.map(r => r.replace('502,76', '510,00')), '516234870').ok, false);
    assert.equal(ctx.parseInvoiceText(pdfRows.map(r => r.replace('509 412 882', '509 412 883')), '516234870').ok, false);
    assert.equal(ctx.parseInvoiceText(['Documento digitalizado'], '').ok, false);
});

test('reverseWeightedAverageCost: desfaz a entrada; se era todo o stock mantém o CMP', () => {
    const ctx = load({});
    const after = ctx.weightedAverageCost(10, 5, 10, 7); // 6
    near(ctx.reverseWeightedAverageCost(20, after, 10, 7), 5);
    near(ctx.reverseWeightedAverageCost(10, 7, 10, 7), 7);
});

test('stockCheckList: validade passada, a terminar e artigo parado', () => {
    const ctx = load({});
    const ings = [
        { id: 'a', byStore: { chiado: { stockTheoretical: 2, expiry: '2026-11-20' } } },
        { id: 'b', byStore: { chiado: { stockTheoretical: 2, expiry: '2026-11-27' } } },
        { id: 'c', byStore: { chiado: { stockTheoretical: 2 } } },
        { id: 'd', byStore: { chiado: { stockTheoretical: 0, expiry: '2026-01-01' } } },
        { id: 'e', byStore: { chiado: { stockTheoretical: 1 } } }
    ];
    const mv = [
        { ingredient: 'c', store: 'chiado', qty: 5, date: '2026-10-01' }, { ingredient: 'c', store: 'chiado', qty: -1, date: '2026-11-01T10:00:00Z' },
        { ingredient: 'b', store: 'chiado', qty: -1, date: '2026-11-25' }
    ];
    const r = ctx.stockCheckList(ings, mv, 'chiado', '2026-11-26', 14).map(x => x.ingId + ':' + x.kind + ':' + x.days);
    assert.deepEqual([...r], ['a:expired:6', 'b:expiring:1', 'c:idle:25']);
    assert.equal(ctx.addDaysIso('2026-11-30', 3), '2026-12-03');
});

test('invoiceLineBase / invoiceLineToBase: embalagens multiplicam pelo tamanho da descrição', () => {
    const ctx = load({});
    const line = (description, qty, unit, price) => ({ description, qty, unit, unit_price_net: price, line_total_net: qty * price });
    const arroz = line('Arroz Japonês para Sushi Grão Curto (Saco 20 kg)', 3, 'Saco', 34);
    assert.deepEqual({ ...ctx.invoiceLineBase(arroz), pack: undefined }, { unit: 'kg', qty: 60, pack: undefined });
    const r = ctx.invoiceLineToBase(arroz, { baseUnit: 'kg' });
    near(r.qty, 60); near(r.price, 1.7);
    near(ctx.invoiceLineToBase(line('Alga Nori (Pacote 100 folhas)', 4, 'Pacote', 14.5), { baseUnit: 'un' }).price, 0.145);
    near(ctx.invoiceLineToBase(line('Vinho Caixa 6 x 0,75 L', 2, 'cx', 30), { baseUnit: 'L' }).qty, 9);
    near(ctx.invoiceLineToBase(line('Gin 70cl', 3, 'garrafa', 20), { baseUnit: 'L' }).qty, 2.1);
    // Insumo contado à unidade: o peso da descrição não serve, usa a unidade da fatura.
    near(ctx.invoiceLineToBase(line('Farinha 500g', 10, 'un', 1), { baseUnit: 'un' }).qty, 10);
    near(ctx.invoiceLineToBase(line('Salmão', 2, 'kg', 13), { baseUnit: 'kg' }).price, 13);
    assert.equal(ctx.packSize('Lombo de salmão 2 lombos'), null);
});

test('cleanItemName dá um nome curto sem embalagem nem texto comercial', () => {
    const ctx = load({});
    assert.equal(ctx.cleanItemName('Molho de Soja Tradicional Fermentado (Bidão 5 L) Fermentação natural para cozinha e preparação de molhos'), 'Molho de Soja Tradicional Fermentado');
    assert.equal(ctx.cleanItemName('Farinha T65 saco 25kg'), 'Farinha T65');
    assert.equal(ctx.cleanItemName('Arroz carolino 3 x 1 kg'), 'Arroz carolino');
    assert.equal(ctx.cleanItemName('Ovos M - categoria A'), 'Ovos M');
    assert.equal(ctx.cleanItemName('Salmão fresco'), 'Salmão fresco');
    assert.equal(ctx.cleanItemName('5 kg'), '5 kg');
    assert.equal(ctx.cleanItemName(undefined), '');
});

test('splitInvoiceLine divide um kit em partes com a embalagem de cada uma', () => {
    const ctx = load({});
    const line = { description: 'Kit Pasta de Wasabi (2 × 1 kg) e Gengibre Gari (2 × 1,5 kg)', qty: 1, unit: 'un', unit_price_net: 30, line_total_net: 30, vat_rate: 23 };
    const parts = ctx.splitInvoiceLine(line);
    assert.deepEqual([...parts].map(p => p.description), ['Pasta de Wasabi (2 × 1 kg)', 'Gengibre Gari (2 × 1,5 kg)']);
    assert.deepEqual([...parts].map(p => [p.qty, p.unit, p.vat_rate, p.line_total_net]), [[1, 'un', 23, 0], [1, 'un', 23, 0]]);
    // Cada parte usa o tamanho da sua embalagem: 2 kg de wasabi e 3 kg de gengibre.
    assert.deepEqual([...parts].map(p => { const b = ctx.invoiceLineBase(p); return [b.unit, b.qty]; }), [['kg', 2], ['kg', 3]]);
    // Ao preencher os valores, o preço por kg sai de cada parte.
    parts[0].line_total_net = 18; parts[1].line_total_net = 12;
    near(ctx.invoiceLineToBase(parts[0], { baseUnit: 'kg' }).price, 9);
    near(ctx.invoiceLineToBase(parts[1], { baseUnit: 'kg' }).price, 4);
    assert.equal(ctx.splitDifference(30, [18, 12]), 0);
    assert.equal(ctx.splitDifference(30, [18, 11.99]), 0.01);
    assert.equal(ctx.splitDifference(30, [0.1, 0.2, 29.7]), 0);
    // Sem separador: duas partes iguais para o utilizador editar; vírgula dentro de parênteses não corta.
    assert.equal(ctx.splitInvoiceLine({ description: 'Sushi mix (salmão, atum)', qty: 2, unit: 'cx' }).length, 2);
    assert.equal(ctx.splitInvoiceLine({ description: 'Sushi mix (salmão, atum)', qty: 2, unit: 'cx' })[1].description, 'Sushi mix (salmão, atum)');
    assert.equal(ctx.splitInvoiceLine({ description: 'Nori + Arroz + Vinagre', qty: 1, unit: 'un' }).length, 3);
});

test('packSize / invoiceLineToBase: dúzias e embalagem do catálogo', () => {
    const ctx = load({ ingredients: [] });
    assert.deepEqual({ ...ctx.packSize('Ovos Classe M Cx 15 dz') }, { unit: 'un', qty: 180 });
    // Fatura diz 2 un a 31,80 €, mas cada «un» é uma caixa de 15 dz.
    const ovos = { description: 'OVOS CLASSE M', qty: 2, unit: 'un', unit_price_net: 31.8, line_total_net: 63.6 };
    const r = ctx.invoiceLineToBase(ovos, { baseUnit: 'un', packLabel: 'Caixa 15 dz → 180 un' });
    near(r.qty, 360); near(r.price, 63.6 / 360);
    // Sem embalagem no catálogo, fica como estava (2 un).
    near(ctx.invoiceLineToBase(ovos, { baseUnit: 'un', packLabel: '' }).qty, 2);
    // Natas: garrafa de 2 L ou caixa de 200 ml, pelo catálogo ou pela descrição.
    near(ctx.invoiceLineToBase({ description: 'NATAS CULINARIA', qty: 6, unit: 'un', line_total_net: 30 }, { baseUnit: 'L', packLabel: 'Garrafa 2 L' }).qty, 12);
    near(ctx.invoiceLineToBase({ description: 'Natas 200ml', qty: 10, unit: 'un', line_total_net: 9 }, { baseUnit: 'L', packLabel: 'Garrafa 2 L' }).qty, 2);
    // Peso na fatura ganha à embalagem do catálogo.
    near(ctx.invoiceLineToBase({ description: 'Farinha', qty: 25, unit: 'kg', line_total_net: 20 }, { baseUnit: 'kg', packLabel: 'Saco 5 kg' }).qty, 25);
});

test('lotAndExpiry: lê lote e validade da descrição', () => {
    const ctx = load({ ingredients: [] });
    assert.deepEqual({ ...ctx.lotAndExpiry('Natas 2L Lote: L2611A Val: 05/12/2026') }, { lot: 'L2611A', expiry: '2026-12-05' });
    assert.deepEqual({ ...ctx.lotAndExpiry('Ovos M lote 4471 validade 2026-12-20') }, { lot: '4471', expiry: '2026-12-20' });
    assert.deepEqual({ ...ctx.lotAndExpiry('Iogurte grego V. 3/1/27') }, { lot: '', expiry: '2027-01-03' });
    assert.deepEqual({ ...ctx.lotAndExpiry('Salmão fresco lombo') }, { lot: '', expiry: '' });
});

test('lotExpiryRisks: lote que não sai a tempo da validade', () => {
    const ctx = load({ ingredients: [] });
    const ovos = { id: 'ovos', byStore: { chiado: { stockTheoretical: 300 } } };
    const mv = [
        { store: 'chiado', ingredient: 'ovos', document: 'FT 1', qty: 360, date: '2026-11-20', lot: 'L1', expiry: '2026-11-30' },
        { store: 'chiado', ingredient: 'ovos', document: 'V1', qty: -60, date: '2026-11-24' }
    ];
    // Saíram 60 em 6 dias (10/dia); faltam 4 dias → só saem 40 dos 300.
    let r = ctx.lotExpiryRisks([ovos], mv, 'chiado', '2026-11-26');
    assert.equal(r.length, 1);
    assert.equal(r[0].lot, 'L1'); near(r[0].remaining, 300); near(r[0].projected, 40);
    // Ritmo suficiente: sem alerta.
    ovos.byStore.chiado.stockTheoretical = 30;
    mv[1].qty = -330;
    assert.equal(ctx.lotExpiryRisks([ovos], mv, 'chiado', '2026-11-26').length, 0);
    // No dia da entrega não alerta (ainda não há ritmo), salvo se a validade estiver a 2 dias.
    const novo = { id: 'natas', byStore: { chiado: { stockTheoretical: 4 } } };
    const mv2 = [{ store: 'chiado', ingredient: 'natas', document: 'FT 2', qty: 4, date: '2026-11-26', expiry: '2026-12-10' }];
    assert.equal(ctx.lotExpiryRisks([novo], mv2, 'chiado', '2026-11-26').length, 0);
    mv2[0].expiry = '2026-11-27';
    assert.equal(ctx.lotExpiryRisks([novo], mv2, 'chiado', '2026-11-26').length, 1);
    // Fatura anulada (correção) deixa de contar como lote.
    mv2.push({ store: 'chiado', ingredient: 'natas', document: 'FT 2', qty: -4, date: '2026-11-26T10:00:00Z', type: 'correcao' });
    assert.equal(ctx.lotExpiryRisks([novo], mv2, 'chiado', '2026-11-26').length, 0);
    // O stock vai primeiro para o lote mais recente: o lote antigo já saiu todo.
    const mv3 = [
        { store: 'chiado', ingredient: 'ovos', document: 'FT A', qty: 180, date: '2026-11-10', expiry: '2026-11-28' },
        { store: 'chiado', ingredient: 'ovos', document: 'FT B', qty: 180, date: '2026-11-24', expiry: '2026-12-20' },
        { store: 'chiado', ingredient: 'ovos', document: 'V', qty: -200, date: '2026-11-25' }
    ];
    ovos.byStore.chiado.stockTheoretical = 160;
    assert.equal(ctx.lotExpiryRisks([ovos], mv3, 'chiado', '2026-11-26').length, 0);
});

test('invoiceLineToBase: «OVOS 15 DZ CLASSE L» 2 × 31,80 € = 360 ovos a 0,1767 €', () => {
    const ctx = load({ ingredients: [] });
    for (const unit of ['', 'un', 'cx']) {
        const r = ctx.invoiceLineToBase({ description: 'OVOS 15 DZ CLASSE L', qty: 2, unit, unit_price_net: 31.8, line_total_net: 63.6 }, { baseUnit: 'un', packLabel: '' });
        near(r.qty, 360, unit); near(r.price, 63.6 / 360, unit);
    }
});

test('convertToBaseQty: tabela local de unidades', () => {
    const ctx = load({ ingredients: [] });
    near(ctx.convertToBaseQty(1, 'kg', 'g'), 1000);
    near(ctx.convertToBaseQty(1, 'L', 'ml'), 1000);
    near(ctx.convertToBaseQty(15, 'dz', 'un'), 180);
    near(ctx.convertToBaseQty(250, 'g', 'kg'), 0.25);
    near(ctx.convertToBaseQty(33, 'cl', 'L'), 0.33);
    assert.ok(Number.isNaN(ctx.convertToBaseQty(1, 'kg', 'L')));
    // «2 dz» sem caixa na descrição = 24 un; «2 cx» de «15 DZ» = 360 un.
    near(ctx.invoiceLineToBase({ description: 'OVOS CLASSE M', qty: 2, unit: 'dz', line_total_net: 4 }, { baseUnit: 'un' }).qty, 24);
    near(ctx.invoiceLineToBase({ description: 'OVOS 15 DZ CLASSE L', qty: 2, unit: 'dz', line_total_net: 63.6 }, { baseUnit: 'un' }).qty, 360);
});

test('nome do fornecedor: artigo curto e reconhecimento pela descrição da fatura', () => {
    const ctx = load({ ingredients: [{ id: 'ovos', name: 'Ovos', sku: '', supplierNames: { sup_am: 'Ovos 15dz Classe L' } }, { id: 'ovosm', name: 'Ovos Classe M', sku: '' }] });
    assert.equal(ctx.cleanItemName('OVOS 15 DZ CLASSE L'), 'Ovos');
    assert.equal(ctx.matchIngredient('OVOS 15DZ CLASSE L').id, 'ovos');
    assert.equal(ctx.matchIngredient('Ovos Classe M').id, 'ovosm');
});

test('channelSuggestedPvp: (custo + custos fixos) ÷ food cost, depois comissão, custos variáveis e margem extra', () => {
    const ctx = load({});
    near(ctx.channelSuggestedPvp(3, 30, 13, {}), 11.3); // Sala: 3 / 0,30 = 10 € s/ IVA
    near(ctx.channelSuggestedPvp(3, 30, 13, { feePct: 30, packaging: 0.6 }), 19.37); // 3,6 / 0,3 / 0,7 × 1,13
    near(ctx.channelSuggestedPvp(3, 30, 13, { feePct: 15, varPct: 5, packaging: 1, marginPct: 10 }), 20.72); // 4 / 0,3 / 0,8 × 1,1 × 1,13
    assert.equal(ctx.channelSuggestedPvp(0, 30, 13, {}), 0);
    assert.equal(ctx.channelSuggestedPvp(3, 30, 13, { feePct: 60, varPct: 40 }), 0);
});

test('preços por canal em modo global seguem o custo e a configuração; os escritos à mão são ignorados', () => {
    const c = load({ ...bowlState(), salesChannels: [{ id: 'uber', name: 'Uber', feePct: 30, varPct: 2, packaging: 0.65 }] });
    const rec = { ...c.getRecipe('rec_bowl'), priceMode: 'global', targetFcPct: 25, channelPrices: { uber: 99 } };
    const unit = c.calculateRecipeCost(rec).unitCost;
    const [sala, uber] = c.getChannelMetrics(rec);
    near(sala.pvpGross, c.channelSuggestedPvp(unit, 25, rec.vatRate, {}));
    assert.ok(Math.abs(sala.foodCostPct - 25) < 0.2);
    near(uber.pvpGross, c.channelSuggestedPvp(unit, 25, rec.vatRate, { feePct: 30, varPct: 2, packaging: 0.65 }));
    near(uber.commEur, uber.pvpNet * 0.32);
});

test('canais configuráveis: preço por canal, taxa como comissão, preços antigos de Uber mantêm-se', () => {
    const c = load({ ...bowlState(), salesChannels: [{ id: 'uber', name: 'Uber', feePct: 15 }, { id: 'glovo', name: 'Glovo', feePct: 20 }] });
    const rec = c.getRecipe('rec_bowl');
    rec.channelPrices = { glovo: 21 };
    const [sala, uber, glovo] = c.getChannelMetrics(rec);
    assert.equal(sala.key, 'sala');
    near(uber.pvpGross, 19.9);
    near(uber.commEur, 19.9 / 1.13 * 0.15);
    near(glovo.pvpGross, 21);
    near(glovo.commEur, 21 / 1.13 * 0.2);
});

test('orderCheck: falta, a mais, não veio, não encomendado, oferta e preço', () => {
    const { orderCheck } = load({});
    const out = orderCheck(
        [{ ing: 'a', qty: 10, price: 2 }, { ing: 'b', qty: 5, price: 1 }, { ing: 'c', qty: 3, price: 4 }, { ing: 'd', qty: 2, price: 1 }],
        [{ ing: 'a', qty: 8, price: 2.2 }, { ing: 'b', qty: 5, price: 1 }, { ing: 'b', qty: 1, price: 0, offer: true }, { ing: 'd', qty: 2, price: 1 }, { ing: 'e', qty: 1, price: 0, offer: true }, { service: true, qty: 1, price: 9 }]);
    const by = Object.fromEntries(out.map(r => [r.ing, r]));
    assert.equal(by.a.status, 'Falta'); near(by.a.diff, -2); near(by.a.priceDiff, 0.1);
    assert.equal(by.b.status, 'A mais'); assert.equal(by.b.offer, true); near(by.b.price, 1); near(by.b.priceDiff, 0);
    assert.equal(by.c.status, 'Não veio');
    assert.equal(by.d.status, 'Conforme');
    assert.equal(by.e.status, 'Não encomendado'); assert.equal(by.e.offerOnly, true);
    assert.equal(out.length, 5);
});

test('ingredientUsage segue as sub-receitas até à dose do prato', () => {
    const c = load(bowlState());
    const u = c.ingredientUsage(c.getRecipe('rec_bowl'), 'ing_salmao');
    near(u.netQty, 0.18);
    near(u.grossQty, 0.18 / 0.82);
    assert.deepEqual([...u.subRecipes], ['rec_sub_salmao']);
    const direct = c.ingredientUsage(c.getRecipe('rec_bowl'), 'ing_abacate');
    near(direct.netQty, 0.065);
    assert.equal(direct.subRecipes.length, 0);
    // custo da dose do insumo = bruto × preço, coerente com o custo da ficha
    const prices = new Map([['ing_salmao', 20]]);
    const bowl = c.getRecipe('rec_bowl');
    near(c.calculateRecipeCost(bowl, prices).unitCost - c.calculateRecipeCost(bowl).unitCost, u.grossQty * (20 - 12.35));
});

test('SKU automático: prefixo da categoria e sequencial a seguir ao maior', () => {
    const c = load({ ingredients: [] });
    assert.deepEqual(['Proteínas', 'Laticínios', 'Frescos', 'Bebidas', 'Hortícolas', 'Secos', 'Embalagens', ''].map(c.skuPrefix),
        ['PRT', 'LTC', 'FRS', 'BBD', 'HRT', 'SCS', 'EMB', 'INS']);
    assert.equal(c.nextSku('Proteínas', []), 'PRT-0001');
    assert.equal(c.nextSku('Proteínas', [{ sku: 'PRT-0007' }, { sku: 'prt-0002' }, { sku: 'LTC-0040' }, { sku: 'INS-512' }]), 'PRT-0008');
    assert.equal(c.nextSku('Carnes', [{ sku: 'PRT-0007' }], { Carnes: 'PRT' }), 'PRT-0008'); // categoria renomeada mantém a série
});

test('Contagens lidas pela IA: por código, senão pelo nome; quantidades em branco ignoradas', () => {
    const c = load({ ingredients: [] });
    const items = [{ id: 'a', code: 'PRT-0001', name: 'Salmão' }, { id: 'b', code: '', name: 'Molho de tomate' }, { id: 'c', code: 'LTC-0001', name: 'Natas' }];
    const r = c.matchCounts(items, [{ code: 'prt-0001', name: 'Salmao fresco', qty: 2.5 }, { code: '', name: 'Molho de Tomate', qty: 0 },
        { code: 'LTC-0001', name: 'Natas', qty: null }, { code: 'XYZ-9', name: 'Polvo', qty: 1 }]);
    assert.deepEqual({ ...r.values }, { a: '2,5', b: '0' });
    assert.equal(r.unmatched.length, 1);
});
