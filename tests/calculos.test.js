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
        id, name: id, recipeType: 'final_product', yieldQuantity: 1, yieldUnit: 'un', cookingLossPct: 0, extraFixedCost: 0,
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
