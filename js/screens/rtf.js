// ── 정렬 상태 (렌더 간 유지) ──────────────────────────────────────────────────
var rtfSortState = {
  "rtfBusinessMatrix": { colKey: null, dir: "asc" },
  "rtfPlantMatrix":    { colKey: null, dir: "asc" },
  "rtfTypeMatrix":     { colKey: null, dir: "asc" },
};
var _rtfItems = []; // 정렬 재빌드용 캐시

// ── RTF 계산 ─────────────────────────────────────────────────────────────────
function itemTypeGroup(item) {
  const type = cleanOptional(item.itemType);
  if (type.includes("상품") || String(item.itemCode ?? "").startsWith("7")) return "상품";
  if (type.includes("완제품") || String(item.itemCode ?? "").startsWith("9")) return "완제품";
  return STATUS.UNKNOWN;
}

function higherSeverity(a, b) {
  return STATUS_RANK[a] <= STATUS_RANK[b] ? a : b;
}

function hasMasterGap(item) {
  if (item.typeGroup === "상품")   return item.businessUnit === NEED_MASTER || item.itemGroup === NEED_MASTER;
  if (item.typeGroup === "완제품") return item.plant === NEED_MASTER || item.itemGroup === NEED_MASTER;
  return true;
}

function computeRtfItems() {
  const planRows      = state.mappedData.plan_monthly;
  const inventoryRows = state.mappedData.inventory_base;
  const masterRows    = state.mappedData.item_master;
  const costMap = new Map(), baseQtyMap = new Map(), inventorySet = new Set();
  const masterMap = new Map(), planLookup = new Map(), metaMap = new Map();

  inventoryRows.forEach((row) => {
    const code = cleanOptional(row.itemCode);
    if (!code) return;
    inventorySet.add(code);
    const cost = cleanNumber(row.standardCost), baseQty = cleanNumber(row.baseQty);
    if (cost !== null && cost > 0 && !costMap.has(code)) costMap.set(code, cost);
    baseQtyMap.set(code, (baseQtyMap.get(code) ?? 0) + (baseQty ?? 0));
  });
  masterRows.forEach((row) => {
    const code = cleanOptional(row.itemCode);
    if (code && !masterMap.has(code)) masterMap.set(code, row);
  });
  planRows.forEach((row) => {
    const code = cleanOptional(row.itemCode), month = cleanOptional(row.month);
    if (!code || !month) return;
    planLookup.set(`${code}|${month}`, row);
    if (!metaMap.has(code))
      metaMap.set(code, { itemCode: code, itemName: cleanText(row.itemName, code), plant: cleanOptional(row.plant), itemType: cleanOptional(row.itemType) });
  });

  return [...metaMap.values()].map((meta) => {
    const master = masterMap.get(meta.itemCode), standardCost = costMap.get(meta.itemCode) ?? null;
    const item = { ...meta,
      plant: cleanText(meta.plant, NEED_MASTER), businessUnit: cleanText(master?.businessUnit, NEED_MASTER),
      itemGroup: cleanText(master?.itemGroup, NEED_MASTER), standardCost,
      hasCost: standardCost !== null && standardCost > 0,
      hasInventory: inventorySet.has(meta.itemCode), baseQty: baseQtyMap.get(meta.itemCode) ?? null,
    };
    item.typeGroup = itemTypeGroup(item);
    let runningQty = item.baseQty;
    const masterGap = hasMasterGap(item);

    item.monthlyStatus = getRtfMonths().map((month) => {
      const plan = planLookup.get(`${item.itemCode}|${month}`);
      const salesQty = cleanNumber(plan?.salesQty), supplyQty = cleanNumber(plan?.supplyQty);
      const noSalesPlan = !plan || salesQty === null || salesQty <= 0;
      const salesAmount = salesQty !== null && salesQty > 0 && item.hasCost ? salesQty * item.standardCost : null;
      let endingQty = null, endingAmount = null, rtfQty = null, rtfAmount = null;
      let shortageQty = null, shortageAmount = null, lostSalesAmount = null, inventoryDays = null;
      let status = STATUS.UNKNOWN, reason = "";

      if (runningQty === null)      { reason = NEED_DATA; }
      else if (masterGap)           { reason = NEED_MASTER; }
      else if (noSalesPlan) {
        reason = NO_PLAN;
        if (supplyQty !== null) { runningQty += supplyQty; endingQty = runningQty; }
        rtfQty = 0; rtfAmount = item.hasCost ? 0 : null;
        endingAmount = item.hasCost && endingQty !== null ? Math.max(0, endingQty) * item.standardCost : null;
      } else if (supplyQty === null) { reason = NEED_DATA; }
      else {
        runningQty  = runningQty + supplyQty - salesQty;
        endingQty   = runningQty;
        shortageQty = endingQty < 0 ? Math.abs(endingQty) : 0;
        rtfQty      = Math.max(0, salesQty - shortageQty);
        rtfAmount   = item.hasCost ? rtfQty * item.standardCost : null;
        shortageAmount = shortageQty > 0 && item.hasCost ? shortageQty * item.standardCost : null;
        lostSalesAmount = shortageAmount;
        endingAmount    = item.hasCost ? Math.max(0, endingQty) * item.standardCost : null;
        inventoryDays   = salesQty > 0 && endingQty >= 0 ? (endingQty / salesQty) * 30 : null;
        if (shortageQty > 0)           status = STATUS.SHORTAGE;
        else if (endingQty < salesQty) status = STATUS.WARN;
        else                           status = STATUS.OK;
      }
      return { month, salesQty, supplyQty, rtfQty, rtfAmount, endingQty, endingAmount, shortageQty, shortageAmount, lostSalesAmount, inventoryDays, salesAmount, status, reason, noSalesPlan };
    });
    return item;
  }).filter((item) => item.typeGroup === "상품" || item.typeGroup === "완제품");
}

// ── 집계 ─────────────────────────────────────────────────────────────────────
function sumNullable(values) {
  let total = 0, hasValue = false;
  values.forEach((v) => { if (Number.isFinite(v)) { total += v; hasValue = true; } });
  return hasValue ? total : null;
}

function aggregateMonth(items, monthIndex) {
  const rows = items.map((i) => i.monthlyStatus[monthIndex]);
  const status = rows.reduce((w, r) => higherSeverity(w, r.status), STATUS.OK);
  const hasNoPlan = rows.every((r) => r.noSalesPlan);
  return {
    status: hasNoPlan ? STATUS.UNKNOWN : status,
    salesQty:        sumNullable(rows.map((r) => r.salesQty)),
    rtfQty:          sumNullable(rows.map((r) => r.rtfQty)),
    shortageQty:     sumNullable(rows.map((r) => r.shortageQty)),
    salesAmount:     sumNullable(rows.map((r) => r.salesAmount)),
    rtfAmount:       sumNullable(rows.map((r) => r.rtfAmount)),
    shortageAmount:  sumNullable(rows.map((r) => r.shortageAmount)),
    lostSalesAmount: sumNullable(rows.map((r) => r.lostSalesAmount)),
    endingAmount:    sumNullable(rows.map((r) => r.endingAmount)),
    endingQty:       sumNullable(rows.map((r) => r.endingQty)),
    inventoryDays:   null,
    hasNoPlan,
  };
}

// ── 계층 구조 ─────────────────────────────────────────────────────────────────
function makeNode(id, parentId, level, kind, label, items, cols = {}) {
  return { id, parentId, level, kind, label, items, cols };
}
function sortKo(arr) { return [...arr].sort((a, b) => String(a).localeCompare(String(b), "ko-KR")); }
function uniq(items, key) { return sortKo([...new Set(items.map((i) => i[key]))]); }

function buildHierarchy(items, mode) {
  const nodes = [];
  if (mode === "business") {
    nodes.push(makeNode("business|__total__", "", -1, "total", "사업부 총합계", items, { div:"", bu:"", plant:"", type:"", group:"", code:"" }));
    uniq(items, "businessUnit").forEach((bu) => {
      const buItems = items.filter((i) => i.businessUnit === bu), buId = `b|${bu}`;
      nodes.push(makeNode(buId, "", 0, "group", `${bu} 계`, buItems, { div:"사업부", bu, plant:"", type:"", group:"", code:"" }));
      uniq(buItems, "typeGroup").forEach((type) => {
        const typeItems = buItems.filter((i) => i.typeGroup === type), typeId = `${buId}|${type}`;
        nodes.push(makeNode(typeId, buId, 1, "group", `${type} 계`, typeItems, { div:"유형", bu, plant:"", type, group:"", code:"" }));
        uniq(typeItems, "itemGroup").forEach((group) => {
          const groupItems = typeItems.filter((i) => i.itemGroup === group), groupId = `${typeId}|${group}`;
          nodes.push(makeNode(groupId, typeId, 2, "itemGroup", `${group} 계`, groupItems, { div:"품목군", bu, plant:"", type, group, code:"" }));
          groupItems.forEach((item) => nodes.push(makeNode(`${groupId}|${item.itemCode}`, groupId, 3, "item", item.itemName, [item],
            { div:"자재", bu:item.businessUnit, plant:item.plant, type:item.typeGroup, group:item.itemGroup, code:item.itemCode })));
        });
      });
    });
  } else if (mode === "plant") {
    nodes.push(makeNode("plant|__total__", "", -1, "total", "플랜트 총합계", items, { div:"", bu:"", plant:"", type:"", group:"", code:"" }));
    uniq(items, "plant").forEach((plant) => {
      const plantItems = items.filter((i) => i.plant === plant), plantId = `p|${plant}`;
      nodes.push(makeNode(plantId, "", 0, "group", `${plant} 계`, plantItems, { div:"플랜트", bu:"", plant, type:"", group:"", code:"" }));
      uniq(plantItems, "typeGroup").forEach((type) => {
        const typeItems = plantItems.filter((i) => i.typeGroup === type), typeId = `${plantId}|${type}`;
        nodes.push(makeNode(typeId, plantId, 1, "group", `${type} 계`, typeItems, { div:"유형", bu:"", plant, type, group:"", code:"" }));
        uniq(typeItems, "itemGroup").forEach((group) => {
          const groupItems = typeItems.filter((i) => i.itemGroup === group), groupId = `${typeId}|${group}`;
          nodes.push(makeNode(groupId, typeId, 2, "itemGroup", `${group} 계`, groupItems, { div:"품목군", bu:"", plant, type, group, code:"" }));
          groupItems.forEach((item) => nodes.push(makeNode(`${groupId}|${item.itemCode}`, groupId, 3, "item", item.itemName, [item],
            { div:"자재", bu:item.businessUnit, plant:item.plant, type:item.typeGroup, group:item.itemGroup, code:item.itemCode })));
        });
      });
    });
  } else {
    nodes.push(makeNode("type|__total__", "", -1, "total", "유형별 총합계", items, { div:"", bu:"", plant:"", type:"", group:"", code:"" }));
    uniq(items, "typeGroup").forEach((type) => {
      const typeItems = items.filter((i) => i.typeGroup === type), typeId = `t|${type}`;
      nodes.push(makeNode(typeId, "", 0, "group", `${type} 계`, typeItems, { div:"유형", bu:"", plant:"", type, group:"", code:"" }));
      uniq(typeItems, "businessUnit").forEach((bu) => {
        const buItems = typeItems.filter((i) => i.businessUnit === bu), buId = `${typeId}|${bu}`;
        nodes.push(makeNode(buId, typeId, 1, "group", `${bu} 계`, buItems, { div:"사업부", bu, plant:"", type, group:"", code:"" }));
        uniq(buItems, "plant").forEach((plant) => {
          const plantItems = buItems.filter((i) => i.plant === plant), plantId = `${buId}|${plant}`;
          nodes.push(makeNode(plantId, buId, 2, "group", `${plant} 계`, plantItems, { div:"플랜트", bu, plant, type, group:"", code:"" }));
          uniq(plantItems, "itemGroup").forEach((group) => {
            const groupItems = plantItems.filter((i) => i.itemGroup === group), groupId = `${plantId}|${group}`;
            nodes.push(makeNode(groupId, plantId, 3, "itemGroup", `${group} 계`, groupItems, { div:"품목군", bu, plant, type, group, code:"" }));
            groupItems.forEach((item) => nodes.push(makeNode(`${groupId}|${item.itemCode}`, groupId, 4, "item", item.itemName, [item],
              { div:"자재", bu:item.businessUnit, plant:item.plant, type:item.typeGroup, group:item.itemGroup, code:item.itemCode })));
          });
        });
      });
    });
  }
  return nodes;
}

// ── 정렬 ─────────────────────────────────────────────────────────────────────
function compareForSort(a, b, dir) {
  const aN = a === null || a === undefined || a === "" || !Number.isFinite(a) && typeof a !== "string";
  const bN = b === null || b === undefined || b === "" || !Number.isFinite(b) && typeof b !== "string";
  if (aN && bN) return 0;
  if (aN)  return 1;
  if (bN)  return -1;
  const cmp = (typeof a === "number" && typeof b === "number") ? a - b : String(a).localeCompare(String(b), "ko-KR");
  return dir === "asc" ? cmp : -cmp;
}

function getSortValue(node, colKey) {
  const textCols = { bu: "bu", plant: "plant", type: "type", group: "group", code: "code", name: null };
  if (colKey in textCols) return colKey === "name" ? node.label : (node.cols[colKey] || "");
  if (colKey === "base")  return sumNullable(node.items.map((i) => i.baseQty));
  const metricFn = {
    "판매계획":      (a) => a.salesQty,
    "RTF":          (a) => a.rtfQty,
    "Shortage":     (a) => a.shortageQty,
    "매출":         (a) => a.salesAmount,
    "매출차질예상": (a) => a.lostSalesAmount,
    "기말재고":     (a) => state.rtfDisplayMode === "amount" ? a.endingAmount : a.endingQty,
    "재고일수":     (a) => a.inventoryDays,
  };
  if (metricFn[colKey]) return sumNullable(getRtfMonths().map((_, i) => metricFn[colKey](aggregateMonth(node.items, i))));
  return null;
}

function sortHierarchyNodes(nodes, sectionId) {
  const s = rtfSortState[sectionId];
  if (!s || !s.colKey) return nodes;
  const totalNode = nodes[0]; // kind === "total", always first
  const rest      = nodes.slice(1);
  // Group level-0 nodes with their descendants (rest is ordered: l0, then all desc)
  const groups = [];
  let cur = null;
  rest.forEach((n) => {
    if (n.level === 0) { if (cur) groups.push(cur); cur = [n]; }
    else if (cur)      { cur.push(n); }
  });
  if (cur) groups.push(cur);
  groups.sort((a, b) => compareForSort(getSortValue(a[0], s.colKey), getSortValue(b[0], s.colKey), s.dir));
  return [totalNode, ...groups.flat()];
}

// ── 총합계 검증 ───────────────────────────────────────────────────────────────
function checkTotalsMatch(items) {
  if (!items.length) return null;
  // 3섹션 모두 동일 items 집계 → 항상 일치
  return sumNullable(getRtfMonths().map((_, i) => aggregateMonth(items, i).salesQty)) !== null ? true : null;
}

// ── 정렬 아이콘 텍스트 ────────────────────────────────────────────────────────
function sortIconText(sectionId, colKey) {
  const s = rtfSortState[sectionId];
  if (!s || s.colKey !== colKey) return "⇅";
  return s.dir === "asc" ? "↑" : "↓";
}

// ── 상태 표시 ─────────────────────────────────────────────────────────────────
function statusClass(status) {
  return { 대응가능:"ok", 주의:"warn", 공급부족:"shortage", 판단불가:"unknown" }[status] ?? "unknown";
}

// ── 포맷 헬퍼 ────────────────────────────────────────────────────────────────
function getVisibleMonthColumns() {
  return state.rtfExpanded ? MONTH_COLUMNS : MONTH_COLUMNS.filter((m) => !EXTRA_COLUMNS.includes(m));
}

function formatDisplayQtyMoney(qtyValue, amountValue, noPlan = false) {
  if (noPlan) return NO_PLAN;
  if (state.rtfDisplayMode === "amount") return Number.isFinite(amountValue) ? formatMoney(amountValue) : NEED_DATA;
  return Number.isFinite(qtyValue) ? formatNumber(qtyValue) : NEED_DATA;
}

function formatEnding(row) {
  if (state.rtfDisplayMode === "amount") return Number.isFinite(row.endingAmount) ? formatMoney(row.endingAmount) : NEED_DATA;
  return Number.isFinite(row.endingQty) ? formatNumber(row.endingQty) : NEED_DATA;
}

function formatBaseForNode(node, compressed) {
  const qty = sumNullable(node.items.map((i) => i.baseQty));
  if (state.rtfDisplayMode === "qty") {
    if (!Number.isFinite(qty)) return compressed ? SHORT_TEXT[NEED_DATA] : NEED_DATA;
    return formatNumber(qty, 1);
  }
  if (node.items.some((i) => !i.hasCost || !Number.isFinite(i.baseQty)))
    return compressed ? SHORT_TEXT[NEED_DATA] : NEED_DATA;
  const amount = sumNullable(node.items.map((i) => i.baseQty * i.standardCost));
  return Number.isFinite(amount) ? formatMoney(amount) : (compressed ? SHORT_TEXT[NEED_DATA] : NEED_DATA);
}

// ── 셀 렌더 ──────────────────────────────────────────────────────────────────
function renderMetricCell(row, metric, metricIndex, compressed) {
  const mb     = metricIndex === 0 ? " rtf-month-start" : "";
  const noPlan = row.hasNoPlan || row.noSalesPlan;

  if (metric === "판매계획") {
    const raw  = formatDisplayQtyMoney(row.salesQty, row.salesAmount, noPlan);
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-cell-right${mb}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "RTF") {
    const raw  = formatDisplayQtyMoney(row.rtfQty, row.rtfAmount, noPlan);
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-rtf-cell rtf-status-text ${statusClass(row.status)} rtf-cell-right${mb}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "Shortage") {
    const isAmt = state.rtfDisplayMode === "amount";
    const hasS  = isAmt ? (Number.isFinite(row.shortageAmount) && row.shortageAmount > 0)
                        : (Number.isFinite(row.shortageQty)    && row.shortageQty    > 0);
    const raw = hasS ? (isAmt ? formatMoney(row.shortageAmount) : formatNumber(row.shortageQty)) : "-";
    return `<td class="rtf-metric-cell rtf-shortage-cell ${hasS ? "rtf-status-text shortage" : "rtf-neutral-text"} rtf-cell-right${mb}">${escapeHtml(raw)}</td>`;
  }
  if (metric === "매출")
    return `<td class="rtf-metric-cell rtf-muted-metric rtf-cell-right${mb}">${escapeHtml(Number.isFinite(row.salesAmount) ? formatMoney(row.salesAmount) : NEED_DATA)}</td>`;
  if (metric === "매출차질예상") {
    const val = Number.isFinite(row.lostSalesAmount) && row.lostSalesAmount > 0 ? formatMoney(row.lostSalesAmount) : "-";
    return `<td class="rtf-metric-cell ${val !== "-" ? "rtf-status-text shortage" : "rtf-neutral-text"} rtf-cell-right${mb}">${escapeHtml(val)}</td>`;
  }
  if (metric === "기말재고")
    return `<td class="rtf-metric-cell rtf-muted-metric rtf-cell-right${mb}">${escapeHtml(formatEnding(row))}</td>`;
  if (metric === "재고일수") {
    const val = Number.isFinite(row.inventoryDays) ? `${Math.round(row.inventoryDays)}일` : "판단불가";
    return `<td class="rtf-metric-cell rtf-muted-metric rtf-cell-right${mb}">${escapeHtml(val)}</td>`;
  }
  return `<td class="rtf-metric-cell rtf-cell-right${mb}">-</td>`;
}

// ── 행 렌더 ──────────────────────────────────────────────────────────────────
function renderHierarchyRow(node) {
  const isTotal     = node.kind === "total";
  const isItem      = node.kind === "item";
  const isItemGroup = node.kind === "itemGroup";
  const item        = isItem ? node.items[0] : null;
  const { div, bu, plant, type, group, code } = node.cols;
  const compressed  = !state.rtfExpanded;
  const baseQty     = formatBaseForNode(node, compressed);
  const isHidden    = isTotal ? false : (compressed ? node.level > 0 : (isItem && !state.expandedItemGroups.has(node.parentId)));
  const monthCols   = getVisibleMonthColumns();
  const cells = getRtfMonths().map((_, mIdx) => {
    const monthRow = isItem ? item.monthlyStatus[mIdx] : aggregateMonth(node.items, mIdx);
    return monthCols.map((metric, colIdx) => renderMetricCell(monthRow, metric, colIdx, compressed)).join("");
  }).join("");
  const toggleBtn = isItemGroup && state.rtfExpanded
    ? `<button type="button" class="rtf-item-toggle" data-node-id="${escapeHtml(node.id)}">${state.expandedItemGroups.has(node.id) ? "-" : "+"}</button>`
    : "";
  const kindCls = isTotal ? "is-total" : (isItem ? "is-item" : "is-group");
  return `<tr class="rtf-h-row level-${node.level} ${kindCls}" data-node-id="${escapeHtml(node.id)}" data-parent-id="${escapeHtml(node.parentId)}"${isHidden ? " hidden" : ""}>
    <td class="rtf-sticky rtf-col-div rtf-cell-center">${toggleBtn}${div ? `<span class="rtf-div-label">${escapeHtml(div)}</span>` : ""}</td>
    <td class="rtf-sticky rtf-col-bu rtf-cell-center">${escapeHtml(bu)}</td>
    <td class="rtf-sticky rtf-col-plant rtf-cell-center">${escapeHtml(plant)}</td>
    <td class="rtf-sticky rtf-col-type rtf-cell-center">${escapeHtml(type)}</td>
    <td class="rtf-sticky rtf-col-group rtf-cell-left">${escapeHtml(group)}</td>
    <td class="rtf-sticky rtf-col-code rtf-cell-center">${escapeHtml(code)}</td>
    <td class="rtf-sticky rtf-col-name rtf-cell-left" title="${escapeHtml(node.label)}">${escapeHtml(node.label)}</td>
    <td class="rtf-sticky rtf-col-base rtf-cell-right">${escapeHtml(baseQty)}</td>
    ${cells}
  </tr>`;
}

// ── 섹션 렌더 ────────────────────────────────────────────────────────────────
function renderMatrixSection(title, mode, items, sectionId) {
  const months   = getRtfMonths();
  const monthCols = getVisibleMonthColumns();
  const COL_W    = { "판매계획":75,"RTF":75,"Shortage":80,"매출":75,"매출차질예상":90,"기말재고":75,"재고일수":75 };
  const metricCols = months.flatMap(() => monthCols.map((m) => `<col style="width:${COL_W[m]||75}px;min-width:${COL_W[m]||75}px;">`)).join("");
  const colCount   = 8 + months.length * monthCols.length;
  const nodes      = sortHierarchyNodes(buildHierarchy(items, mode), sectionId);
  const body       = nodes.length
    ? nodes.map((n) => renderHierarchyRow(n)).join("")
    : `<tr><td colspan="${colCount}" class="rtf-empty">데이터 없음</td></tr>`;

  // 정렬 가능한 헤더 th 생성 헬퍼
  function sortTh(label, colKey, cls, rowspan) {
    const icon = `<span class="rtf-sort-icon">${sortIconText(sectionId, colKey)}</span>`;
    const rs   = rowspan ? ` rowspan="${rowspan}"` : "";
    return `<th class="${cls}" data-sort-col="${escapeHtml(colKey)}" data-sort-section="${escapeHtml(sectionId)}"${rs}>${escapeHtml(label)} ${icon}</th>`;
  }

  const monthHeader  = months.map((m) =>
    `<th class="rtf-month-head rtf-cell-center" colspan="${monthCols.length}">${escapeHtml(monthLabel(m))}</th>`).join("");
  const metricHeader = months.map(() =>
    monthCols.map((m, i) => {
      const cls = `rtf-sub-head rtf-cell-center${["RTF","Shortage"].includes(m) ? " rtf-key-sub" : ""}${i === 0 ? " rtf-month-start" : ""}`;
      return `<th class="${cls}" data-sort-col="${escapeHtml(m)}" data-sort-section="${escapeHtml(sectionId)}">${escapeHtml(m)} <span class="rtf-sort-icon">${sortIconText(sectionId, m)}</span></th>`;
    }).join("")
  ).join("");

  return `<section id="${escapeHtml(sectionId)}" class="rtf-card rtf-block rtf-matrix-block">
    <div class="rtf-sec-title">${escapeHtml(title)}</div>
    <div class="rtf-h-scroll">
      <table class="rtf-h-matrix-table ${state.rtfExpanded ? "is-expanded" : "is-collapsed"}">
        <colgroup>
          <col class="rtf-col-div"><col class="rtf-col-bu"><col class="rtf-col-plant"><col class="rtf-col-type">
          <col class="rtf-col-group"><col class="rtf-col-code"><col class="rtf-col-name"><col class="rtf-col-base">
          ${metricCols}
        </colgroup>
        <thead>
          <tr>
            ${sortTh("구분",    "div",   "rtf-sticky rtf-col-div   rtf-cell-center rtf-th-sortable", 2)}
            ${sortTh("사업부",  "bu",    "rtf-sticky rtf-col-bu    rtf-cell-center rtf-th-sortable", 2)}
            ${sortTh("플랜트",  "plant", "rtf-sticky rtf-col-plant rtf-cell-center rtf-th-sortable", 2)}
            ${sortTh("유형",    "type",  "rtf-sticky rtf-col-type  rtf-cell-center rtf-th-sortable", 2)}
            ${sortTh("품목군",  "group", "rtf-sticky rtf-col-group rtf-cell-left   rtf-th-sortable", 2)}
            ${sortTh("자재코드","code",  "rtf-sticky rtf-col-code  rtf-cell-center rtf-th-sortable", 2)}
            ${sortTh("자재명",  "name",  "rtf-sticky rtf-col-name  rtf-cell-left   rtf-th-sortable", 2)}
            ${sortTh("기초재고","base",  "rtf-sticky rtf-col-base  rtf-cell-right  rtf-th-sortable", 2)}
            ${monthHeader}
          </tr>
          <tr>${metricHeader}</tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

// ── RTF 화면 ─────────────────────────────────────────────────────────────────
function renderRtf() {
  _rtfItems = computeRtfItems();
  const items  = _rtfItems;
  if (!state.mappedData.plan_monthly.length) {
    return `<div class="rtf-screen"><section class="rtf-card rtf-top"><h2 class="rtf-title">RTF 월별 대응 현황</h2><div class="rtf-nodata">데이터 연결 필요<br>데이터점검 화면에서 RAW 파일을 선택해 주세요.</div></section></div>`;
  }
  const months = getRtfMonths();
  const match  = checkTotalsMatch(items);
  const verifyHtml = match === null ? "" :
    match ? `<span class="rtf-verify-ok">총합계 일치</span>` : `<span class="rtf-verify-err">총합계 불일치 확인 필요</span>`;

  return `<div class="rtf-screen rtf-excel-layout">
    <section class="rtf-card rtf-top">
      <h2 class="rtf-title">RTF 월별 대응 현황</h2>
      <div class="rtf-meta">
        기준월: ${escapeHtml(months[0])} | 대상기간: ${escapeHtml(months.map(monthLabel).join(" ~ "))} | 표시: ${state.rtfDisplayMode === "qty" ? "수량" : "금액"}
        ${verifyHtml}
      </div>
      <div class="rtf-insight">RTF 컬럼은 판매계획 대비 공급 가능 수량(또는 금액)입니다. Shortage 발생 시 붉은색으로 표시됩니다.</div>
    </section>
    <div class="rtf-toolbar">
      <div class="rtf-mode-group" aria-label="표시 단위">
        <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "qty" ? "active" : ""}" data-rtf-mode="qty">수량</button>
        <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "amount" ? "active" : ""}" data-rtf-mode="amount">금액</button>
      </div>
      <button type="button" id="rtfExpandToggle" class="rtf-extra-toggle ${state.rtfExpanded ? "active" : ""}">${state.rtfExpanded ? "축소" : "확대"}</button>
      <span class="rtf-toolbar-hint">${state.rtfExpanded ? "품목군까지 표시 · + 버튼으로 자재 상세" : "계 행 + 판매계획 / RTF / Shortage"}</span>
    </div>
    ${renderMatrixSection("01. 사업부별", "business", items, "rtfBusinessMatrix")}
    ${renderMatrixSection("02. 플랜트별", "plant",    items, "rtfPlantMatrix")}
    ${renderMatrixSection("03. 유형별",   "type",     items, "rtfTypeMatrix")}
  </div>`;
}

// ── RTF 이벤트 바인딩 ─────────────────────────────────────────────────────────
function bindRtf() {
  document.querySelector("#rtfExpandToggle")?.addEventListener("click", () => {
    state.rtfExpanded = !state.rtfExpanded;
    state.expandedItemGroups.clear();
    render("rtf");
  });

  document.querySelectorAll("[data-rtf-mode]").forEach((btn) => btn.addEventListener("click", () => {
    if (state.rtfDisplayMode === btn.dataset.rtfMode) return;
    state.rtfDisplayMode = btn.dataset.rtfMode;
    render("rtf");
  }));

  document.querySelectorAll(".rtf-item-toggle").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const nodeId = btn.dataset.nodeId, wasExp = state.expandedItemGroups.has(nodeId);
    if (wasExp) { state.expandedItemGroups.delete(nodeId); btn.textContent = "+"; }
    else        { state.expandedItemGroups.add(nodeId);    btn.textContent = "-"; }
    document.querySelectorAll(`tr[data-parent-id="${CSS.escape(nodeId)}"]`).forEach((r) => { r.hidden = wasExp; });
  }));

  document.querySelectorAll("[data-sort-col][data-sort-section]").forEach((th) => {
    th.addEventListener("click", () => {
      const colKey = th.dataset.sortCol, sectionId = th.dataset.sortSection;
      const s = rtfSortState[sectionId];
      s.dir    = s.colKey === colKey ? (s.dir === "asc" ? "desc" : "asc") : "asc";
      s.colKey = colKey;
      render("rtf");
    });
  });
}
