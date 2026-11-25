// Cálculos financeiros do backoffice (custos, margens, BCG, inventário).
// Script clássico: usa os globais appState, RESTAURANT e STORE_KEYS definidos no admin.html.
// Testes: node --test

// ====================================================================
// 3. HELPERS MULTI-ESTABELECIMENTO (STOCK & CMP POR LOJA)
// ====================================================================
function getIngredient(id) {
    return appState.ingredients.find(i => i.id === id);
}

function getSupplier(id) {
    return appState.suppliers.find(s => s.id === id);
}

function getRecipe(id) {
    return appState.recipes.find(r => r.id === id);
}

function getIngMetricsForStore(ing, storeId = appState.activeStore) {
    if (!ing) return { stockTheoretical: 0, stockCounted: 0, minStock: 0, cmp: 0, lastCost: 0, prevCost: 0 };
    return ing.byStore[RESTAURANT];
}

function getSubRecipeCountForStore(sub) {
    return sub?.countedByStore?.[RESTAURANT] || 0;
}

function getRecipeSold30d(recipe, storeId = appState.activeStore) {
    const cutoff = Date.now() - 30 * 86400000;
    const stores = STORE_KEYS;
    const opening = Date.parse(appState.openingVolumeDate) >= cutoff
        ? stores.reduce((sum, k) => sum + (recipe.soldByStore?.[k] || 0), 0) : 0;
    return opening + appState.salesLog.reduce((sum, tx) => {
        if (!stores.includes(tx.store) || !(Date.parse(tx.date) >= cutoff)) return sum;
        return sum + (tx.recipeIds || []).filter(id => id === recipe.id).length * tx.qty;
    }, 0);
}

// ====================================================================
// 4. MOTOR DE CÁLCULO RECURSIVO (DAG) & MATRIZ BCG DINÂMICA
// ====================================================================
function convertToBaseQty(qty, fromUnit, targetBaseUnit) {
    const f = {kg:1000,g:1,L:1000,cl:10,ml:1,un:1};
    const groups = [['kg','g'],['L','ml','cl'],['un']];
    if (!groups.some(g=>g.includes(fromUnit) && g.includes(targetBaseUnit))) return NaN;
    return Number(qty)*f[fromUnit]/f[targetBaseUnit];
}

function calculateRecipeCost(recipe, prices = null, visited = new Set(), storeId = appState.activeStore) {
    if (!recipe || visited.has(recipe.id)) {
        return { batchCost: 0, unitCost: 0, totalRecipeCost: 0 };
    }
    const nextVisited = new Set(visited);
    nextVisited.add(recipe.id);

    let itemsCost = 0;

    (recipe.items || []).forEach(item => {
        if (item.type === 'ingredient') {
            const ing = getIngredient(item.refId);
            if (!ing) return;
            const ingMetrics = getIngMetricsForStore(ing, storeId);
            const baseNetQty = convertToBaseQty(item.netQty, item.unit || ing.baseUnit, ing.baseUnit);
            const yieldFactor = Math.max(0.05, Math.min(1, Number(ing.yieldFactor) || 1));
            const grossQty = baseNetQty / yieldFactor;
            const unitPrice = prices?.get(ing.id) ?? ingMetrics.cmp;
            itemsCost += grossQty * unitPrice;
        } else if (item.type === 'sub_recipe') {
            const subRec = getRecipe(item.refId);
            if (!subRec) return;
            const subCalc = calculateRecipeCost(subRec, prices, nextVisited, storeId);
            const baseNetQty = convertToBaseQty(item.netQty, item.unit || subRec.yieldUnit, subRec.yieldUnit);
            const lineCost = baseNetQty * subCalc.unitCost;
            itemsCost += lineCost;
        }
    });

    const batchCost = itemsCost + (Number(recipe.extraFixedCost) || 0);
    const yieldQty = Math.max(0.001, Number(recipe.yieldQuantity) || 1);
    const cookingLoss = Math.max(0, Math.min(0.95, (Number(recipe.cookingLossPct) || 0) / 100));
    const netYield = Math.max(0.001, yieldQty * (1 - cookingLoss));
    const unitCost = batchCost / netYield;

    return {batchCost,unitCost,totalRecipeCost:unitCost};
}

function getChannelMetrics(recipe, prices = null, storeId = appState.activeStore) {
    const costObj = calculateRecipeCost(recipe, prices, new Set(), storeId);
    const baseCost = costObj.totalRecipeCost;
    const vatDiv = 1 + Number(recipe.vatRate ?? 13) / 100;

    const channels = [
        { key: 'sala', name: 'Sala (Dine-in)', pvpGross: Number(recipe.pvpSalaGross) || 0, commissionPct: 0, packaging: 0.00 },
        { key: 'takeaway', name: 'Takeaway', pvpGross: Number(recipe.pvpTakeawayGross) || 0, commissionPct: 0, packaging: 0.45 },
        { key: 'uber', name: 'Uber Eats (Delivery)', pvpGross: Number(recipe.pvpUberGross) || 0, commissionPct: 30, packaging: 0.65 }
    ];

    return channels.map(ch => {
        const pvpNet = ch.pvpGross / vatDiv;
        const totalCost = baseCost + ch.packaging;
        const commEur = pvpNet * (ch.commissionPct / 100);
        const marginEur = pvpNet - totalCost - commEur;
        const foodCostPct = pvpNet > 0 ? (totalCost / pvpNet) * 100 : 0;
        const marginPct = pvpNet > 0 ? (marginEur / pvpNet) * 100 : 0;
        return { ...ch, pvpNet, totalCost, commEur, marginEur, foodCostPct, marginPct };
    });
}

// Matriz BCG Dinâmica: classifica cada prato comparando Margem Bruta (€) e Volume 30d face à média atual da carta
function computeDynamicBcg(storeId = appState.activeStore) {
    const finals = appState.recipes.filter(r => r.recipeType === 'final_product');
    const evaluated = finals.map(r => {
        const override = null;
        const sala = getChannelMetrics(r, override, storeId)[0];
        const sold30d = getRecipeSold30d(r, storeId);
        return { recipe: r, sala, sold30d, marginEur: sala.marginEur };
    });

    const count = Math.max(1, evaluated.length);
    const avgMargin = evaluated.reduce((acc, x) => acc + x.marginEur, 0) / count;
    const avgVolume = evaluated.reduce((acc, x) => acc + x.sold30d, 0) / count;

    const classified = evaluated.map(item => {
        let quadrant = 'dog';
        if (item.marginEur >= avgMargin && item.sold30d >= avgVolume) quadrant = 'star';
        else if (item.marginEur < avgMargin && item.sold30d >= avgVolume) quadrant = 'cash_cow';
        else if (item.marginEur >= avgMargin && item.sold30d < avgVolume) quadrant = 'question_mark';
        return { ...item, quadrant };
    });

    return { classified, avgMargin, avgVolume };
}

function calculateInventoryVariance(storeId = appState.activeStore) {
    let totalVarianceEur = 0;
    const rows = appState.ingredients.map(ing => {
        const m = getIngMetricsForStore(ing, storeId);
        let fromSubRecipesBase = 0;
        appState.subRecipesInventory.forEach(sub => {
            if (sub.parentIngredientId === ing.id) {
                const subQty = getSubRecipeCountForStore(sub, storeId);
                fromSubRecipesBase += (subQty / ing.yieldFactor);
            }
        });

        fromSubRecipesBase = m.preparedCount ?? fromSubRecipesBase;
        const totalCounted = m.stockCounted + fromSubRecipesBase;
        const varianceQty = totalCounted - (m.countBasis ?? m.stockTheoretical);
        const varianceEur = varianceQty * (m.countCost ?? m.cmp);
        totalVarianceEur += varianceEur;

        return {
            ...ing,
            stockTheoretical: m.countBasis ?? m.stockTheoretical,
            stockCounted: m.stockCounted,
            minStock: m.minStock,
            cmp: m.countCost ?? m.cmp,
            fromSubRecipesBase,
            totalCounted,
            varianceQty,
            varianceEur
        };
    });

    return { rows, totalVarianceEur };
}

function getAggregatedFinancials() {
    const keys = STORE_KEYS;
    const agg = {
        revenue: 0, cogs: 0, payroll: 0, deliveryFees: 0, fixedCosts: 0,
        monthly: appState.storeFinancials[keys[0]].monthly.map(pt => ({ m: pt.m, rev: 0, cogs: 0 }))
    };
    const period = appState.storeFinancials[keys[0]].period;

    keys.forEach(k => {
        const sf = appState.storeFinancials[k];
        agg.revenue += sf.revenue;
        agg.cogs += sf.cogs;
        agg.payroll += sf.payroll;
        agg.deliveryFees += sf.deliveryFees;
        agg.fixedCosts += sf.fixedCosts;
        sf.monthly.forEach((pt, idx) => {
            agg.monthly[idx].rev += pt.rev;
            agg.monthly[idx].cogs += pt.cogs;
        });
    });

    const grossMargin = agg.revenue - agg.cogs;
    const grossMarginPct = agg.revenue > 0 ? (grossMargin / agg.revenue) * 100 : 0;
    const foodCostPct = agg.revenue > 0 ? (agg.cogs / agg.revenue) * 100 : 0;
    const primeCost = agg.cogs + agg.payroll;
    const primeCostPct = agg.revenue > 0 ? (primeCost / agg.revenue) * 100 : 0;
    const wasteCost = appState.wasteLogs.filter(w=>keys.includes(w.store) && (!w.period || !period || w.period === period)).reduce((sum,w)=>sum+w.cost,0);
    const ebitda = grossMargin - agg.payroll - agg.deliveryFees - agg.fixedCosts - wasteCost;
    const ebitdaPct = agg.revenue > 0 ? (ebitda / agg.revenue) * 100 : 0;

    return { ...agg, wasteCost, grossMargin, grossMarginPct, foodCostPct, primeCost, primeCostPct, ebitda, ebitdaPct };
}

function validateRecipe(recipe,id,ancestors=new Set()) {
    if (ancestors.has(id)) return 'Dependência circular entre fichas.';
    const path = new Set(ancestors).add(id);
    for (const line of recipe.items) {
        const sub = line.type === 'sub_recipe';
        const target = sub ? getRecipe(line.refId) : getIngredient(line.refId);
        if (!target) return 'Referência de artigo em falta.';
        const base = sub ? target.yieldUnit : target.baseUnit;
        const groups = [['kg','g'],['L','cl','ml'],['un']];
        if (!groups.some(g=>g.includes(base) && g.includes(line.unit))) return 'Unidade incompatível com '+target.name;
        if (sub) {const issue = validateRecipe(target,target.id,path); if (issue) return issue;}
    }
    return '';
}

// Custo Médio Ponderado após uma entrada de stock. Com stock nulo ou negativo, o CMP passa a ser o preço da compra.
function weightedAverageCost(oldQty, oldCmp, qty, price) {
    return oldQty > 0 ? (oldQty*oldCmp + qty*price)/(oldQty+qty) : price;
}

// Índice de preços de um fornecedor: média das últimas 6 compras de cada insumo, normalizada ao primeiro ponto (100).
// A inflação é a variação desse índice entre o primeiro e o último ponto.
function supplierPriceTrend(supplierId) {
    const series = appState.ingredients
        .filter(i => i.supplierId === supplierId && i.priceHistory?.length && i.priceHistory[Math.max(0, i.priceHistory.length - 6)] > 0)
        .map(i => i.priceHistory.slice(-6));
    if (!series.length) return { inflationPct: 0, history: [100, 100] };
    const len = Math.max(...series.map(s => s.length));
    const history = Array.from({ length: len }, (_, k) => {
        const pts = series.map(s => 100 * s[Math.max(0, k - (len - s.length))] / s[0]);
        return pts.reduce((a, b) => a + b, 0) / pts.length;
    });
    return { inflationPct: history[history.length - 1] - 100, history: history.length > 1 ? history : [history[0], history[0]] };
}

// PVP com IVA que deixa o custo do prato na meta de food cost (sobre o preço sem IVA).
function suggestedPvpGross(unitCost, targetFcPct, vatRate) {
    if (!(targetFcPct > 0) || !(unitCost > 0)) return 0;
    return unitCost / (targetFcPct / 100) * (1 + Number(vatRate ?? 13) / 100);
}

// Valor do stock do restaurante. counted=true usa a última contagem física (matéria-prima + preparações contadas);
// caso contrário usa o stock teórico. Inclui as preparações produzidas em stock, ao custo unitário atual.
function stockValue(counted = false) {
    const raw = appState.ingredients.reduce((sum, ing) => {
        const m = getIngMetricsForStore(ing);
        const qty = counted ? m.stockCounted + (m.preparedCount || 0) : m.stockTheoretical;
        return sum + qty * (counted ? (m.countCost ?? m.cmp) : m.cmp);
    }, 0);
    const preps = appState.recipes.reduce((sum, r) => sum + (r.prepStock?.[RESTAURANT] || 0) * calculateRecipeCost(r).unitCost, 0);
    return raw + preps;
}

// Compras que deram entrada em stock no período (AAAA-MM): guias, faturas sem guia e notas de crédito (a abater).
// Linhas de serviço não contam para o CMV.
function periodPurchases(period) {
    return appState.invoices.filter(inv => inv.store === RESTAURANT && inv.status === 'Aprovada' && !inv.receiptRef && String(inv.date).startsWith(period))
        .reduce((sum, inv) => {
            const sign = inv.docType === 'Nota de Crédito' ? -1 : 1;
            if (!inv.lines?.length) return sum + inv.net;
            return sum + sign * inv.lines.filter(l => !l.service).reduce((n, l) => n + l.qty * l.price, 0);
        }, 0);
}

// CMV real = stock inicial + compras − stock final (contado). Compara com o CMV teórico das vendas.
function periodRealCogs(opening, purchases, closing, revenue, theoretical) {
    const realCogs = opening + purchases - closing;
    const pct = v => revenue > 0 ? v / revenue * 100 : 0;
    return { opening, purchases, closing, realCogs, theoretical, gapEur: realCogs - theoretical, realPct: pct(realCogs), theoPct: pct(theoretical) };
}

// Alergénios de uma ficha, incluindo os das sub-receitas.
function recipeAllergens(recipe, visited = new Set()) {
    if (!recipe || visited.has(recipe.id)) return [];
    visited.add(recipe.id);
    const found = new Set();
    for (const item of recipe.items || []) {
        const list = item.type === 'sub_recipe' ? recipeAllergens(getRecipe(item.refId), visited) : (getIngredient(item.refId)?.allergens || []);
        list.forEach(a => found.add(a));
    }
    return [...found].sort((a, b) => a.localeCompare(b, 'pt'));
}

// Fornecedor com o preço mais baixo conhecido para um insumo (ou null).
function bestSupplierPrice(ing) {
    const quotes = Object.entries(ing?.supplierPrices || {}).filter(([, q]) => q.price > 0);
    if (!quotes.length) return null;
    const [supplierId, q] = quotes.reduce((best, cur) => cur[1].price < best[1].price ? cur : best);
    return { supplierId, ...q };
}

// NIF só com dígitos; aceita prefixo PT e espaços.
function normalizeNif(nif) {
    return String(nif ?? '').toUpperCase().replace(/^PT/, '').replace(/\D/g, '');
}

// Insumo mais provável para a descrição de uma linha de fatura (SKU exato, ou mais palavras em comum). null se nada coincidir.
function matchIngredient(description, sku = '') {
    const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ');
    const bySku = sku && appState.ingredients.find(i => norm(i.sku).trim() === norm(sku).trim());
    if (bySku) return bySku;
    const words = new Set(norm(description).split(/\s+/).filter(w => w.length > 2));
    let best = null, score = 0;
    for (const ing of appState.ingredients) {
        const n = norm(ing.name).split(/\s+/).filter(w => w.length > 2 && words.has(w)).length;
        if (n > score) { best = ing; score = n; }
    }
    return best;
}

// Converte uma linha lida (qtd na unidade da fatura) para a unidade base do insumo. Devolve null se as unidades não forem compatíveis.
function invoiceLineToBase(line, ing) {
    const units = { kg: 'kg', kgs: 'kg', g: 'g', gr: 'g', l: 'L', lt: 'L', litro: 'L', litros: 'L', cl: 'cl', ml: 'ml', un: 'un', uni: 'un', und: 'un', unid: 'un', u: 'un', uds: 'un' };
    const unit = units[String(line.unit ?? '').trim().toLowerCase().replace('.', '')];
    const qty = unit ? convertToBaseQty(line.qty, unit, ing.baseUnit) : NaN;
    const total = Number(line.line_total_net) || Number(line.qty) * Number(line.unit_price_net);
    return Number.isFinite(qty) && qty > 0 ? { qty, price: total / qty } : null;
}

// Limites para esticar o contraste: ignora 1% dos píxeis mais escuros e mais claros (histograma de 256 tons).
function contrastLimits(histogram, clip = 0.01) {
    const total = histogram.reduce((a, b) => a + b, 0);
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += histogram[lo]) <= total * clip) lo++;
    acc = 0;
    while (hi > 0 && (acc += histogram[hi]) <= total * clip) hi--;
    return hi > lo ? [lo, hi] : [0, 255];
}
