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
// Tabela local de unidades: [grandeza, quantas unidades base]. Não depende de servidor.
// Peso em kg, volume em L, contagem em un.
const UNIT_TABLE = {
    kg: ['kg', 1], kgs: ['kg', 1], quilo: ['kg', 1], quilos: ['kg', 1], g: ['kg', 0.001], gr: ['kg', 0.001], grs: ['kg', 0.001], grama: ['kg', 0.001], gramas: ['kg', 0.001], mg: ['kg', 0.000001],
    l: ['L', 1], lt: ['L', 1], lts: ['L', 1], litro: ['L', 1], litros: ['L', 1], dl: ['L', 0.1], cl: ['L', 0.01], ml: ['L', 0.001],
    un: ['un', 1], uni: ['un', 1], und: ['un', 1], unid: ['un', 1], u: ['un', 1], uds: ['un', 1], pc: ['un', 1], 'pç': ['un', 1], unidades: ['un', 1],
    dz: ['un', 12], 'dúzia': ['un', 12], 'dúzias': ['un', 12], duzia: ['un', 12], duzias: ['un', 12], 'meia dúzia': ['un', 6], 'meia duzia': ['un', 6]
};
function unitInfo(unit) { return UNIT_TABLE[String(unit ?? '').trim().toLowerCase().replace(/\.$/, '')] || null; }

// Converte entre unidades da mesma grandeza (1 kg = 1000 g, 1 L = 1000 ml, 1 dz = 12 un). NaN se forem de grandezas diferentes.
function convertToBaseQty(qty, fromUnit, targetBaseUnit) {
    const a = unitInfo(fromUnit), b = unitInfo(targetBaseUnit);
    if (!a || !b || a[0] !== b[0]) return NaN;
    return Number(qty) * a[1] / b[1];
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

    // Sala é o canal base, sem taxa. Os restantes vêm da configuração (appState.salesChannels); os preços antigos de Takeaway/Uber continuam a valer.
    const legacy = { takeaway: recipe.pvpTakeawayGross, uber: recipe.pvpUberGross };
    const channels = [
        { key: 'sala', name: 'Sala (Dine-in)', pvpGross: Number(recipe.pvpSalaGross) || 0, commissionPct: 0, packaging: 0.00 },
        ...salesChannels().map(ch => ({ key: ch.id, name: ch.name, pvpGross: Number(recipe.channelPrices?.[ch.id] ?? legacy[ch.id]) || 0, commissionPct: Number(ch.feePct) || 0, packaging: Number(ch.packaging) || 0 }))
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

const DEFAULT_SALES_CHANNELS = [
    { id: 'takeaway', name: 'Takeaway', feePct: 0, packaging: 0.45 },
    { id: 'uber', name: 'Uber Eats (Delivery)', feePct: 30, packaging: 0.65 }
];
function salesChannels() {
    return appState.salesChannels ?? DEFAULT_SALES_CHANNELS;
}

// PVP sugerido de um canal: PVP Sala + a taxa (%) do canal calculada sobre o PVP Sala. Arredonda ao cêntimo.
function channelPriceFromSala(salaGross, feePct) {
    return Math.round((Number(salaGross) || 0) * (1 + (Number(feePct) || 0) / 100) * 100) / 100;
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
    // Nome que o fornecedor já usou numa fatura aprovada («Ovos 15dz Classe L» → Ovos).
    const byName = norm(description).trim() && appState.ingredients.find(i => Object.values(i.supplierNames || {}).some(n => norm(n).trim() === norm(description).trim()));
    if (byName) return byName;
    const words = new Set(norm(description).split(/\s+/).filter(w => w.length > 2));
    let best = null, score = 0;
    for (const ing of appState.ingredients) {
        const n = norm(ing.name).split(/\s+/).filter(w => w.length > 2 && words.has(w)).length;
        if (n > score) { best = ing; score = n; }
    }
    return best;
}

const INVOICE_BASE_UNITS = { kg: ['kg', 1], kgs: ['kg', 1], g: ['kg', 0.001], gr: ['kg', 0.001], grs: ['kg', 0.001], l: ['L', 1], lt: ['L', 1], lts: ['L', 1], litro: ['L', 1], litros: ['L', 1], ml: ['L', 0.001], cl: ['L', 0.01] };

// Tamanho de uma embalagem escrito na descrição: "Saco 20 kg", "Caixa 6 x 0,75 L", "Pacote 100 folhas". null se não houver.
function packSize(text) {
    const t = String(text ?? '').toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
    const unitRe = '(kgs?|grs?|g|lts?|litros?|l|ml|cl)(?![a-zà-ú])';
    let m = t.match(new RegExp('(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*' + unitRe));
    if (m) { const [unit, f] = INVOICE_BASE_UNITS[m[3]]; return { unit, qty: +(m[1] * m[2] * f).toFixed(6) }; }
    m = t.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*' + unitRe));
    if (m) { const [unit, f] = INVOICE_BASE_UNITS[m[2]]; return { unit, qty: +(m[1] * f).toFixed(6) }; }
    // Dúzias: «Caixa 15 dz» = 180 ovos.
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:dz|dúzias?|duzias?)(?![a-zà-ú])/);
    if (m) return { unit: 'un', qty: Math.round(m[1] * 12) };
    m = t.match(/(\d+)\s*(folhas|unidades|unid|uds|un|pcs|peças|pç|ovos|doses|rolos|saquetas|cápsulas)(?![a-zà-ú])/);
    return m ? { unit: 'un', qty: Number(m[1]) } : null;
}

// Nome curto para um artigo novo a partir da descrição da fatura: corta na embalagem, no tamanho ou no texto comercial.
// «Molho de Soja Tradicional Fermentado (Bidão 5 L) Fermentação natural…» → «Molho de Soja Tradicional Fermentado».
function cleanItemName(text) {
    const full = String(text ?? '').replace(/\s+/g, ' ').trim();
    let name = full.split(/\s*(?:[(\[;,|]|\s[-–—]\s|\d+(?:[.,]\d+)?\s*[x×]?\s*\d*(?:[.,]\d+)?\s*(?:kgs?|grs?|g|lts?|litros?|l|ml|cl|un|uds?|dz|dúzias?|duzias?)(?![a-zà-ú]))/i)[0];
    name = name.replace(/(\s+(?:saco|sacos|caixa|cx|pack|bidão|garrafa|lata|frasco|emb\.?|embalagem|de|com))+$/i, '').trim();
    if (!name) name = full;
    if (name.length > 60) name = name.slice(0, 60).replace(/\s+\S*$/, '');
    // Faturas em maiúsculas («OVOS») ficam «Ovos» no catálogo.
    if (name === name.toUpperCase() && /[A-ZÀ-Ú]/.test(name)) name = name.charAt(0) + name.slice(1).toLowerCase();
    return name;
}

// Divide uma linha com vários produtos («Kit Pasta de Wasabi (2 × 1 kg) e Gengibre Gari (2 × 1,5 kg)») em partes.
// Corta em « e », «+», «;» ou «,» fora de parênteses; sem separador dá duas partes iguais para editar.
// Os valores ficam a zero: o utilizador indica quanto custou cada parte.
function splitInvoiceLine(line) {
    const text = String(line.description ?? '');
    const pieces = [];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '[') depth++;
        else if ((c === ')' || c === ']') && depth > 0) depth--;
        else if (depth === 0) {
            const sep = /[+;,]/.test(c) ? 1 : / e /i.test(text.slice(i, i + 3)) ? 3 : 0;
            if (sep) { pieces.push(text.slice(start, i)); start = i + sep; i += sep - 1; }
        }
    }
    pieces.push(text.slice(start));
    const names = pieces.map(t => t.trim()).filter(Boolean);
    // «Kit»/«Pack» descreve o conjunto, não o produto da primeira parte.
    const parts = names.length >= 2 ? names.map(n => n.replace(/^(kit|pack|conjunto|lote)\s+(de\s+)?/i, '')) : [text.trim(), text.trim()];
    return parts.map(description => ({ description, qty: Number(line.qty) || 1, unit: line.unit || 'un', unit_price_net: 0, line_total_net: 0, vat_rate: line.vat_rate, sku: '' }));
}

// Diferença, em euros arredondados ao cêntimo, entre o total da linha e a soma das partes (0 = bate certo).
function splitDifference(lineTotal, partTotals) {
    return Math.round((Number(lineTotal) - partTotals.reduce((s, t) => s + (Number(t) || 0), 0)) * 100) / 100;
}

// Quantidade total de uma linha em unidade base (kg, L ou un). Peso e volume convertem-se diretamente;
// embalagens (saco, caixa, pacote…) multiplicam a quantidade pelo tamanho escrito na descrição: 3 sacos de 20 kg = 60 kg.
function invoiceLineBase(line) {
    const u = String(line.unit ?? '').trim().toLowerCase().replace('.', '');
    const qty = Number(line.qty);
    if (INVOICE_BASE_UNITS[u]) return { unit: INVOICE_BASE_UNITS[u][0], qty: qty * INVOICE_BASE_UNITS[u][1] };
    const pack = packSize(line.description);
    if (pack) return { unit: pack.unit, qty: qty * pack.qty, pack };
    // «2 dz» sem caixa na descrição são 24 ovos.
    const info = unitInfo(u);
    return info && info[0] === 'un' ? { unit: 'un', qty: qty * info[1] } : { unit: 'un', qty };
}

// Converte uma linha lida (qtd na unidade da fatura) para a unidade base do insumo. Devolve null se as unidades não forem compatíveis.
// Tenta primeiro com o tamanho da embalagem; se não servir para o insumo (ex.: insumo contado à unidade), usa a unidade da fatura.
// Sem tamanho na descrição, usa a embalagem do artigo no catálogo («Caixa 15 dz», «Garrafa 2 L»): 2 un a 31,80 € = 2 caixas = 360 ovos.
function invoiceLineToBase(line, ing) {
    const units = { kg: 'kg', kgs: 'kg', g: 'g', gr: 'g', l: 'L', lt: 'L', litro: 'L', litros: 'L', cl: 'cl', ml: 'ml', un: 'un', uni: 'un', und: 'un', unid: 'un', u: 'un', uds: 'un' };
    const total = Number(line.line_total_net) || Number(line.qty) * Number(line.unit_price_net);
    const raw = units[String(line.unit ?? '').trim().toLowerCase().replace('.', '')];
    const lineBase = invoiceLineBase(line);
    const catalogPack = !lineBase.pack && !INVOICE_BASE_UNITS[String(line.unit ?? '').trim().toLowerCase().replace('.', '')] && packSize(ing.packLabel);
    for (const b of [catalogPack && { unit: catalogPack.unit, qty: Number(line.qty) * catalogPack.qty }, lineBase, raw && { unit: raw, qty: Number(line.qty) }]) {
        const qty = b ? convertToBaseQty(b.qty, b.unit, ing.baseUnit) : NaN;
        if (Number.isFinite(qty) && qty > 0) return { qty, price: total / qty };
    }
    return null;
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

// NIF português válido (9 dígitos, dígito de controlo módulo 11).
function validNif(nif) {
    const d = normalizeNif(nif);
    if (!/^[1-9]\d{8}$/.test(d)) return false;
    const r = 11 - [...d.slice(0, 8)].reduce((s, c, i) => s + c * (9 - i), 0) % 11;
    return (r >= 10 ? 0 : r) === Number(d[8]);
}

// Número escrito à portuguesa ("1.234,56", "12,5") ou com ponto decimal ("12.80"). NaN se não for número.
function parsePtNumber(token) {
    let t = String(token).replace(/[€%]/g, '').trim();
    if (!/^-?\d[\d.,]*$/.test(t)) return NaN;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    return Number(t);
}

const PT_VAT_RATES = [0, 4, 5, 6, 9, 12, 13, 16, 18, 22, 23];
const INVOICE_UNITS = /^(kg|kgs|g|gr|grs|l|lt|lts|ml|cl|un|uni|und|unid|u|uds|cx|emb|dz|pc|pç|pack|kit)\.?$/i;

// Uma linha de artigo: "descrição … qtd [un] preço [desc%] [iva%] total". null se os números não fizerem qtd × preço = total.
function parseInvoiceTextLine(row) {
    const tokens = row.trim().split(/\s+/);
    const tail = [];
    let unit = '';
    while (tokens.length) {
        const t = tokens[tokens.length - 1];
        if (t === '€' || t === 'EUR') { tokens.pop(); continue; }
        if (INVOICE_UNITS.test(t)) { unit ||= t.replace('.', '').toLowerCase(); tokens.pop(); continue; }
        const n = parsePtNumber(t);
        if (Number.isNaN(n)) break;
        tail.unshift({ n, pct: t.includes('%') });
        tokens.pop();
    }
    const description = tokens.join(' ');
    if (tail.length < 3 || !/[a-zà-ú]{2}/i.test(description) || /^(sub)?total|^iva\b|^taxa|^incid|^base|^desconto|^saldo|^valor/i.test(description)) return null;
    const near = (a, b) => Math.abs(a - b) <= 0.011;
    for (let k = tail.length - 1; k >= 2; k--) {
        const total = tail[k].n;
        for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
            if (tail[i].pct || tail[j].pct) continue;
            const qty = tail[i].n, price = tail[j].n;
            let discount = null;
            if (!near(qty * price, total)) {
                discount = tail.findIndex((d, x) => x > j && x < k && d.n > 0 && d.n < 100 && near(qty * price * (1 - d.n / 100), total));
                if (discount < 0) continue;
            }
            const rest = tail.filter((_, x) => x !== i && x !== j && x !== k && x !== discount);
            const vat = rest.find(v => v.pct && PT_VAT_RATES.includes(v.n)) || [...rest].reverse().find(v => PT_VAT_RATES.includes(v.n));
            if (!vat || qty <= 0) continue;
            return { description, qty, unit: unit || 'un', unit_price_net: total / qty, line_total_net: total, vat_rate: vat.n };
        }
    }
    return null;
}

// Lê uma fatura a partir das linhas de texto de um PDF. Só devolve ok quando o NIF do fornecedor é válido,
// há pelo menos uma linha e a soma das linhas + IVA coincide (ao cêntimo) com um total impresso no documento.
function parseInvoiceText(rows, ownNif = '') {
    const text = rows.join('\n');
    const nifsIn = list => [...new Set(list.flatMap(r => [...r.matchAll(/(?:PT\s?)?(\d{3}\s?\d{3}\s?\d{3})(?!\d)/g)].map(m => normalizeNif(m[1]))))].filter(validNif);
    const labelled = nifsIn(rows.filter(r => /NIF|NIPC|contrib|VAT|N\.?\s?I\.?\s?F/i.test(r)));
    const nifs = labelled.length ? labelled : nifsIn(rows);
    const own = normalizeNif(ownNif);
    const supplierNif = nifs.find(n => n !== own) || '';
    const customerNif = own && nifs.includes(own) ? own : nifs.find(n => n !== supplierNif) || '';
    const num = text.match(/\b(FT|FR|FS|FA|NC|ND|GR|GT)\s*([A-Z0-9][\w.-]*)\s*\/\s*(\d+)\b/);
    const docType = !num ? 'Fatura' : num[1] === 'NC' ? 'Nota de Crédito' : /^G/.test(num[1]) ? 'Guia de Remessa' : 'Fatura';
    const dateOf = r => { const m = r.match(/\b(\d{4})-(\d{2})-(\d{2})\b/) || r.match(/\b(\d{2})[-/.](\d{2})[-/.](\d{4})\b/); return !m ? '' : m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`; };
    const date = rows.filter(r => /data/i.test(r)).map(dateOf).find(Boolean) || rows.map(dateOf).find(Boolean) || '';
    const lines = rows.map(parseInvoiceTextLine).filter(Boolean);
    const round2 = v => Math.round(v * 100) / 100;
    const net = round2(lines.reduce((s, l) => s + l.line_total_net, 0));
    const byRate = {};
    lines.forEach(l => { byRate[l.vat_rate] = (byRate[l.vat_rate] || 0) + l.line_total_net; });
    const vat = round2(Object.entries(byRate).reduce((s, [rate, base]) => s + round2(base * rate / 100), 0));
    const gross = round2(net + vat);
    const printedTotals = rows.filter(r => /total|pagar/i.test(r)).flatMap(r => r.split(/\s+/).map(parsePtNumber)).filter(n => !Number.isNaN(n));
    const ex = {
        doc_type: docType, invoice_number: num ? `${num[1]} ${num[2]}/${num[3]}` : '', atcud: (text.match(/ATCUD\s*:?\s*([A-Z0-9]+-\d+)/i) || [])[1] || '',
        date, supplier_name: rows.map(r => r.trim()).find(r => /[a-zà-ú]{3}/i.test(r) && !/fatura|factura|original|duplicado|p[aá]gina|guia|nota de/i.test(r)) || '',
        supplier_nif: supplierNif, customer_nif: customerNif, lines, totals: { net, vat, gross }
    };
    const reason = !validNif(supplierNif) ? 'sem NIF de fornecedor válido' : !lines.length ? 'sem linhas de artigos reconhecidas'
        : !printedTotals.some(n => Math.abs(n - gross) <= 0.01) ? `a soma das linhas com IVA (${gross.toFixed(2)}) não aparece como total no documento` : '';
    return { ok: !reason, reason, ex };
}

// CMP antes de uma entrada (para anular ou corrigir uma compra). Se a entrada era todo o stock, não há como recuar: mantém o CMP.
function reverseWeightedAverageCost(stockQty, cmp, qty, price) {
    const rest = stockQty - qty;
    if (rest <= 1e-9) return cmp;
    const before = (stockQty * cmp - qty * price) / rest;
    return Number.isFinite(before) && before >= 0 ? before : cmp;
}

// Data ISO (AAAA-MM-DD) mais n dias.
function addDaysIso(date, n) {
    const d = new Date(String(date).slice(0, 10) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

// Dias inteiros entre duas datas (b − a).
function daysBetween(a, b) {
    return Math.round((Date.parse(String(b).slice(0, 10)) - Date.parse(String(a).slice(0, 10))) / 86400000);
}

// Artigos com stock a verificar: validade passada, validade a terminar (≤ 2 dias) ou parados (sem saídas há idleDays dias).
// Parado conta desde a última saída; se nunca saiu, desde a última entrada. Sem movimentos não há como saber: não alerta.
function stockCheckList(ingredients, movements, store, today, idleDays = 14) {
    const out = [];
    for (const ing of ingredients) {
        const m = ing.byStore?.[store];
        if (!m || !(m.stockTheoretical > 0)) continue;
        if (m.expiry) {
            const left = daysBetween(today, m.expiry);
            if (left < 0) out.push({ ingId: ing.id, kind: 'expired', days: -left });
            else if (left <= 2) out.push({ ingId: ing.id, kind: 'expiring', days: left });
        }
        const own = movements.filter(mv => mv.ingredient === ing.id && mv.store === store && mv.date && mv.type !== 'correcao');
        const last = list => list.reduce((d, mv) => (mv.date > d ? mv.date : d), '');
        const since = last(own.filter(mv => mv.qty < 0)) || last(own.filter(mv => mv.qty > 0));
        const idle = since ? daysBetween(since, today) : 0;
        if (since && idle >= idleDays) out.push({ ingId: ing.id, kind: 'idle', days: idle });
    }
    return out;
}

// Lote e validade escritos numa linha de fatura («Lote: L2611 Val: 05/12/2026»). Campos vazios quando não existem.
function lotAndExpiry(text) {
    const t = String(text ?? '');
    const lot = (t.match(/\blote?\s*(?:n\.?º|nº|no\.?|#)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/.]*\d[A-Z0-9\-\/]*)/i) || [])[1] || '';
    const m = t.match(/\b(?:val(?:idade)?|v\.|exp(?:ira)?|consumir até|cons\.? até|dlc|dluo)\.?\s*[:.]?\s*(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4}))/i);
    let expiry = '';
    if (m) {
        const [y, mo, d] = m[1] ? [m[1], m[2], m[3]] : [m[6].length === 2 ? '20' + m[6] : m[6], m[5], m[4]];
        expiry = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (Number.isNaN(Date.parse(expiry))) expiry = '';
    }
    return { lot: lot.replace(/[.\/-]+$/, ''), expiry };
}

// Lotes com validade que não vão sair a tempo. O stock atual é atribuído aos lotes mais recentes (sai primeiro o mais antigo);
// o ritmo de saída é o consumo desde a entrada do lote. Alerta se o que resta do lote não sair até à validade a esse ritmo,
// ou se a validade já passou. Só avalia lotes com pelo menos 2 dias ou a 2 dias (ou menos) do fim, para não alertar no dia da entrega.
function lotExpiryRisks(ingredients, movements, store, today) {
    const out = [];
    for (const ing of ingredients) {
        let stock = ing.byStore?.[store]?.stockTheoretical || 0;
        if (!(stock > 0)) continue;
        const own = movements.filter(mv => mv.ingredient === ing.id && mv.store === store && mv.date);
        const lots = new Map();
        for (const mv of own) {
            const entry = mv.qty > 0 && mv.type !== 'correcao';
            if (!entry && mv.type !== 'correcao') continue;
            const lot = lots.get(mv.document) || { qty: 0, date: '' };
            lot.qty += mv.qty;
            if (entry && String(mv.date) >= lot.date) Object.assign(lot, { date: String(mv.date).slice(0, 10), expiry: mv.expiry, lot: mv.lot, received: mv.qty });
            lots.set(mv.document, lot);
        }
        const ordered = [...lots.entries()].filter(([, l]) => l.qty > 1e-9 && l.date).sort((a, b) => b[1].date.localeCompare(a[1].date));
        for (const [document, l] of ordered) {
            const remaining = Math.min(l.qty, stock);
            stock -= remaining;
            if (!(remaining > 1e-9) || !l.expiry) continue;
            const daysLeft = daysBetween(today, l.expiry), since = daysBetween(l.date, today);
            if (since < 2 && daysLeft > 2) continue;
            const outflow = -own.filter(mv => mv.qty < 0 && mv.type !== 'correcao' && String(mv.date).slice(0, 10) >= l.date).reduce((s, mv) => s + mv.qty, 0);
            const rate = outflow / Math.max(1, since);
            const projected = rate * Math.max(0, daysLeft);
            // Os lotes mais antigos (o stock que sobra depois deste) saem primeiro.
            if (daysLeft < 0 || remaining + stock > projected + 1e-9) out.push({ ingId: ing.id, document, lot: l.lot || '', date: l.date, expiry: l.expiry, remaining, received: l.received, projected, daysLeft });
        }
    }
    return out;
}

// Conferência da encomenda com o que veio na fatura: por artigo, pedido vs. recebido, preço e oferta.
// orderLines/received: [{ ing, qty, price, offer? }] em unidades base. Devolve uma linha por artigo com o estado.
function orderCheck(orderLines, received) {
    const rows = new Map();
    const row = ing => rows.get(ing) || rows.set(ing, { ing, ordered: 0, orderedValue: 0, received: 0, value: 0, offer: false, charged: false }).get(ing);
    for (const l of orderLines) { const r = row(l.ing); r.ordered += l.qty; r.orderedValue += l.qty * l.price; }
    for (const l of received) {
        if (l.service) continue;
        const r = row(l.ing);
        r.received += l.qty; r.value += l.qty * l.price;
        if (l.offer) r.offer = true; else r.charged = true;
    }
    return [...rows.values()].map(r => {
        const orderedPrice = r.ordered ? r.orderedValue / r.ordered : 0, chargedQty = received.filter(l => l.ing === r.ing && !l.offer && !l.service).reduce((n, l) => n + l.qty, 0);
        const price = chargedQty ? r.value / chargedQty : 0, diff = r.received - r.ordered, eps = 1e-9;
        const status = !r.ordered ? 'Não encomendado' : !r.received ? 'Não veio' : diff < -eps ? 'Falta' : diff > eps ? 'A mais' : 'Conforme';
        return { ing: r.ing, ordered: r.ordered, received: r.received, orderedPrice, price, offer: r.offer, offerOnly: r.offer && !r.charged, diff, status,
            priceDiff: r.charged && r.ordered && orderedPrice > 0 ? price / orderedPrice - 1 : 0 };
    });
}
