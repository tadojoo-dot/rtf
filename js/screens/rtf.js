// ── 정렬 상태 (렌더 간 유지) ──────────────────────────────────────────────────
var _rtfBaseItemMap = new Map(); // "itemCode|plantCode" → item (현재 계획 기준, 비교용)
var rtfSortState = {
  "rtfBusinessMatrix": { colKey: "판매계획", dir: "desc" },
  "rtfPlantMatrix":    { colKey: "판매계획", dir: "desc" },
  "rtfTypeMatrix":     { colKey: "판매계획", dir: "desc" },
};
var _rtfItems = []; // 정렬 재빌드용 캐시

// ── 컬럼 공통 메타 ────────────────────────────────────────────────────────────
var GRID_COL_WIDTH = 82;
var NAME_COL_WIDTH = 220;
var RTF_SECTION_OPTIONS = [
  { mode:"business", label:"사업부별", title:"01. 사업부별", sectionId:"rtfBusinessMatrix" },
  { mode:"plant",    label:"플랜트별", title:"02. 플랜트별", sectionId:"rtfPlantMatrix" },
  { mode:"type",     label:"유형별",   title:"03. 유형별",   sectionId:"rtfTypeMatrix" },
];
var PLANT_NAME_MAP = {
  "1210": "향남",
  "1220": "나보타",
  "1230": "오송",
  "1240": "횡성",
};
var METRIC_WIDTHS = {
  "판매계획":GRID_COL_WIDTH, "RTF":GRID_COL_WIDTH, "Shortage":GRID_COL_WIDTH,
  "매출":GRID_COL_WIDTH, "매출차질예상":GRID_COL_WIDTH, "기말재고":GRID_COL_WIDTH, "재고일수":GRID_COL_WIDTH,
};
// 모드 무관 표시명 override (내부 키 → 화면 표시명)
var METRIC_DISPLAY = { "Shortage":"부족" };
// 축소 모드 약칭
var METRIC_DISPLAY_SHORT = { "판매계획":"판매", "Shortage":"부족" };

// ── BOM 전개 기준 생산 가능수량 맵 ──────────────────────────────────────────────
// BOM 완료 시: 자재별(material) 가용수량 ÷ 소요계수 → 완제품 max 생산 가능수량
// 복수 자재 중 가장 제약이 심한 병목 자재 기준(min)
function buildBomMaxProducibleMap(adjOverrides) {
  if (state.bomStatus !== "done" || !state.bomResult || !state.bomResult.items) return null;

  // 조정값 있을 때 원래 입고수량 맵 구축 (delta 계산용)
  var origSupplyMap = null;
  if (adjOverrides && Object.keys(adjOverrides).length > 0) {
    origSupplyMap = new Map();
    state.mappedData.plan_monthly.forEach(function(r) {
      var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant) || "", month = cleanOptional(r.month);
      if (!code || !month) return;
      var k = code + "|" + plant + "|" + month;
      origSupplyMap.set(k, (origSupplyMap.get(k) || 0) + (cleanNumber(r.supplyQty) || 0));
    });
  }

  const map = new Map(); // key: "itemCode|plant|month" → 생산 가능수량 (병목 기준)
  state.bomResult.items.forEach((bi) => {
    if (!bi.monthlyData || !bi.parentItems) return;

    bi.monthlyData.forEach((md, j) => {
      if (!md || md.availableQty === null) return; // 판단불가 자재 → skip

      // 조정값 반영 가용수량 (자재+월 기준, 모든 부모에 공통 적용)
      let availableQty = md.availableQty;
      if (origSupplyMap && adjOverrides) {
        const adjKey = bi.componentCode + "|" + (bi.plant || "") + "|" + md.month;
        if (adjKey in adjOverrides) {
          const orig = origSupplyMap.get(adjKey) || 0;
          availableQty = availableQty + (adjOverrides[adjKey] - orig);
        }
      }
      availableQty = Math.max(0, availableQty);

      // 소요량 내림차순 정렬 → 소요 많은 완제품부터 우선 차감 (waterfall)
      const parents = bi.parentItems
        .map((pi) => {
          if (!pi.monthly) return null;
          const mData = pi.monthly[j];
          if (!mData) return null;
          const prodQty = mData.prodQty || 0;
          const reqQty  = mData.reqQty  || 0;
          if (prodQty === 0 || reqQty === 0) return null;
          return { pi, prodQty, reqQty, coeff: reqQty / prodQty, month: mData.month };
        })
        .filter(Boolean)
        .sort((a, b) => b.reqQty - a.reqQty);

      let remaining = availableQty;
      parents.forEach(({ pi, reqQty, coeff, month }) => {
        const allocated = Math.min(reqQty, remaining);
        remaining       = Math.max(0, remaining - allocated);
        const maxProd   = coeff > 0 ? allocated / coeff : Infinity;
        const key       = `${pi.code}|${pi.plant}|${month}`;
        const cur       = map.get(key);
        // 복수 자재 중 가장 낮은 값(병목)을 유지
        if (cur === undefined || maxProd < cur) map.set(key, Math.max(0, maxProd));
      });
    });
  });
  return map;
}

// 대체 BOM 존재 완제품 키 집합 (BOM_RAW 직접 조회 — BOM 전개 완료 불필요)
function buildAltBomSet() {
  const set = new Set();
  (state.mappedData.bom_components || []).forEach(function(r) {
    if (!r.rootItemCode || !r.rootItemCode.startsWith("9")) return;
    const alt = cleanOptional(r.alternativeBom);
    if (alt !== "" && alt !== "1") set.add(r.rootItemCode + "|" + cleanOptional(r.plant || ""));
  });
  return set;
}

// 공용자재 경합 경고 대상 완제품 키 집합 (isShared=true이고 부족 발생한 자재의 부모 완제품)
function buildSharedAlertSet() {
  if (state.bomStatus !== "done" || !state.bomResult) return new Set();
  const set = new Set();
  (state.bomResult.items || []).forEach(function(bi) {
    if (!bi.isShared || !bi.hasAnyShortage) return;
    (bi.parentItems || []).forEach(function(pi) {
      set.add(pi.code + "|" + pi.plant);
    });
  });
  return set;
}

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

function itemPlantKey(code, plant) {
  return `${cleanOptional(code)}|${cleanOptional(plant)}`;
}

function monthDays(month) {
  const [year, mon] = String(month).split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(mon)) return 30;
  return new Date(year, mon, 0).getDate();
}

function amountWithCost(qty, item) {
  return Number.isFinite(qty) && item.hasCost ? qty * item.standardCost : null;
}

function displayPlantName(plantCode) {
  const code = cleanOptional(plantCode);
  return PLANT_NAME_MAP[code] || code || NEED_MASTER;
}

function computeRtfItems(bomMapArg, allTypes) {
  const _bomMap = (bomMapArg !== undefined) ? bomMapArg : buildBomMaxProducibleMap(); // BOM 완료 시 자재 제약 맵, 미완료 시 null
  const planRows      = state.mappedData.plan_monthly;
  const inventoryRows = state.mappedData.inventory_base;
  const masterRows    = state.mappedData.item_master;
  const costMap = new Map(), baseQtyMap = new Map(), inventorySet = new Set();
  const masterMap = new Map(), planLookup = new Map(), metaMap = new Map();

  inventoryRows.forEach((row) => {
    const code = cleanOptional(row.itemCode);
    const plant = cleanOptional(row.plant);
    if (!code || !plant) return;
    const key = itemPlantKey(code, plant);
    inventorySet.add(key);
    const cost = cleanNumber(row.standardCost), baseQty = cleanNumber(row.baseQty);
    if (cost !== null && cost > 0 && !costMap.has(key)) costMap.set(key, cost);
    baseQtyMap.set(key, (baseQtyMap.get(key) ?? 0) + (baseQty ?? 0));
  });
  masterRows.forEach((row) => {
    const code = cleanOptional(row.itemCode);
    if (code && !masterMap.has(code)) masterMap.set(code, row);
  });
  planRows.forEach((row) => {
    const code = cleanOptional(row.itemCode), plant = cleanOptional(row.plant), month = cleanOptional(row.month);
    if (!code || !plant || !month) return;
    const key = itemPlantKey(code, plant);
    const planKey = `${key}|${month}`;
    const current = planLookup.get(planKey);
    if (current) {
      current.salesQty = (cleanNumber(current.salesQty) ?? 0) + (cleanNumber(row.salesQty) ?? 0);
      current.supplyQty = (cleanNumber(current.supplyQty) ?? 0) + (cleanNumber(row.supplyQty) ?? 0);
    } else {
      planLookup.set(planKey, { ...row });
    }
    if (!metaMap.has(key))
      metaMap.set(key, { itemCode: code, itemName: cleanText(row.itemName, code), plant, itemType: cleanOptional(row.itemType) });
  });

  const sharedAlertSet = buildSharedAlertSet();
  const altBomSet      = buildAltBomSet();
  return [...metaMap.values()].map((meta) => {
    const key = itemPlantKey(meta.itemCode, meta.plant);
    const master = masterMap.get(meta.itemCode), standardCost = costMap.get(key) ?? null;
    const item = { ...meta,
      plantCode: cleanText(meta.plant, NEED_MASTER), plant: displayPlantName(meta.plant), businessUnit: cleanText(master?.businessUnit, NEED_MASTER),
      itemGroup: cleanText(master?.itemGroup, NEED_MASTER), standardCost,
      hasCost: standardCost !== null && standardCost > 0,
      hasInventory: inventorySet.has(key), baseQty: inventorySet.has(key) ? (baseQtyMap.get(key) ?? 0) : null,
      hasSharedAlert:  sharedAlertSet.has(key),
      hasAltBomAlert:  altBomSet.has(key),
    };
    item.typeGroup = itemTypeGroup(item);
    let openingQty = item.baseQty;
    const masterGap = hasMasterGap(item);
    const isFinished = item.typeGroup === "완제품";

    item.monthlyStatus = getRtfMonths().map((month) => {
      const plan = planLookup.get(`${key}|${month}`);
      const hasPlanRow = Boolean(plan);
      const salesQty = hasPlanRow ? (cleanNumber(plan.salesQty) ?? 0) : null;
      const supplyQty = hasPlanRow ? (cleanNumber(plan.supplyQty) ?? 0) : null;
      const noSalesPlan = hasPlanRow && salesQty === 0;
      const salesPlanAmount = amountWithCost(salesQty, item);
      let endingQty = null, endingAmount = null, rtfQty = null, rtfAmount = null;
      let shortageQty = null, shortageAmount = null, lostSalesAmount = null, inventoryDays = null;
      let salesAmount = null, status = STATUS.UNKNOWN, reason = "";
      let bomConstrained = false, planShortageQty = null;

      if (!item.hasInventory || openingQty === null) { reason = NEED_DATA; }
      else if (!hasPlanRow)                          { reason = NEED_DATA; openingQty = null; }
      else if (masterGap)                            { reason = NEED_MASTER; }
      else {
        // BOM 전개 완료 시 완제품은 자재 제약 생산 가능수량으로 공급 조정
        let effectiveSupply = supplyQty;
        if (isFinished && _bomMap) {
          const maxProd = _bomMap.get(`${meta.itemCode}|${meta.plant}|${month}`);
          if (maxProd !== undefined) {
            effectiveSupply = Math.min(supplyQty, maxProd);
            bomConstrained = effectiveSupply < supplyQty;
          }
        }
        planShortageQty = Math.max(salesQty - (openingQty + supplyQty), 0); // 계획 기준 원래값
        const availableQty = openingQty + effectiveSupply;
        rtfQty = Math.min(salesQty, availableQty);
        shortageQty = Math.max(salesQty - availableQty, 0);
        endingQty = Math.max(availableQty - salesQty, 0);
        rtfAmount = amountWithCost(rtfQty, item);
        shortageAmount = shortageQty > 0 ? amountWithCost(shortageQty, item) : 0;
        endingAmount = amountWithCost(endingQty, item);
        inventoryDays = salesQty > 0 ? endingQty / (salesQty / monthDays(month)) : null;
        status = shortageQty > 0 ? STATUS.SHORTAGE : STATUS.OK;
        openingQty = endingQty;
        reason = noSalesPlan ? NO_PLAN : "";
      }
      return { month, salesQty, supplyQty, rtfQty, rtfAmount, endingQty, endingAmount, shortageQty, shortageAmount, lostSalesAmount, inventoryDays, salesAmount, salesPlanAmount, status, reason, noSalesPlan, bomConstrained, planShortageQty };
    });
    return item;
  }).filter((item) => allTypes || item.typeGroup === "상품" || item.typeGroup === "완제품");
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
  const salesQty = sumNullable(rows.map((r) => r.salesQty));
  const endingQty = sumNullable(rows.map((r) => r.endingQty));
  const month = rows[0]?.month;
  const inventoryDays = Number.isFinite(salesQty) && salesQty > 0 && Number.isFinite(endingQty)
    ? endingQty / (salesQty / monthDays(month))
    : null;
  return {
    status: hasNoPlan ? STATUS.UNKNOWN : status,
    salesQty,
    rtfQty:          sumNullable(rows.map((r) => r.rtfQty)),
    shortageQty:     sumNullable(rows.map((r) => r.shortageQty)),
    salesAmount:     sumNullable(rows.map((r) => r.salesAmount)),
    salesPlanAmount: sumNullable(rows.map((r) => r.salesPlanAmount)),
    rtfAmount:       sumNullable(rows.map((r) => r.rtfAmount)),
    shortageAmount:  sumNullable(rows.map((r) => r.shortageAmount)),
    lostSalesAmount: sumNullable(rows.map((r) => r.lostSalesAmount)),
    endingAmount:    sumNullable(rows.map((r) => r.endingAmount)),
    endingQty,
    inventoryDays,
    hasNoPlan,
  };
}

// ── 계층 구조 ─────────────────────────────────────────────────────────────────
function makeNode(id, parentId, level, kind, label, items, cols = {}) {
  return { id, parentId, level, kind, label, items, cols };
}
function sortKo(arr) { return [...arr].sort((a, b) => String(a).localeCompare(String(b), "ko-KR")); }
function uniq(items, key) { return sortKo([...new Set(items.map((i) => i[key]))]); }
function itemNodeId(groupId, item, index) {
  return `${groupId}|${item.itemCode}|${item.plant}|${index}`;
}

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
          groupItems.forEach((item, itemIndex) => nodes.push(makeNode(itemNodeId(groupId, item, itemIndex), groupId, 3, "item", item.itemName, [item],
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
          groupItems.forEach((item, itemIndex) => nodes.push(makeNode(itemNodeId(groupId, item, itemIndex), groupId, 3, "item", item.itemName, [item],
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
            groupItems.forEach((item, itemIndex) => nodes.push(makeNode(itemNodeId(groupId, item, itemIndex), groupId, 4, "item", item.itemName, [item],
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

// ── 좌측 컬럼 정의 (섹션·확대 여부별 동적 생성) ─────────────────────────────────
function getLeftColDefs(mode) {
  const compressed = !state.rtfExpanded;
  const firstKey   = { "business":"bu", "plant":"plant", "type":"type" }[mode];
  const firstLabel = { "business":"사업부", "plant":"플랜트", "type":"유형" }[mode];
  let defs;

  if (compressed) {
    // 기본: 발표용 — 핵심 컬럼만
    defs = [
      { key: firstKey, label: firstLabel, width: GRID_COL_WIDTH, align: "center", isFirst: true },
      { key: "base",   label: "기초재고", width: GRID_COL_WIDTH, align: "right",  isBase: true, isLast: true },
    ];
  } else {
    // 확대: 분석용 — 섹션별 상세 컬럼
    let mid = [];
    if (mode === "business" || mode === "plant") {
      mid = [
        { key: "type",  label: "유형",   width: GRID_COL_WIDTH, align: "center" },
        { key: "group", label: "품목군", width: GRID_COL_WIDTH, align: "left", isToggle: true },
      ];
    } else { // type
      mid = [
        { key: "bu",    label: "사업부", width: GRID_COL_WIDTH, align: "center" },
        { key: "plant", label: "플랜트", width: GRID_COL_WIDTH, align: "center" },
        { key: "group", label: "품목군", width: GRID_COL_WIDTH, align: "left", isToggle: true },
      ];
    }
    defs = [
      { key: firstKey, label: firstLabel, width: GRID_COL_WIDTH, align: "center", isFirst: true },
      ...mid,
      { key: "code",   label: "자재코드", width: GRID_COL_WIDTH, align: "center" },
      { key: "name",   label: "자재명",   width: NAME_COL_WIDTH, align: "left",  isName: true },
      { key: "base",   label: "기초재고", width: GRID_COL_WIDTH, align: "right", isBase: true, isLast: true },
    ];
  }
  // 누적 sticky left 좌표 계산
  let left = 0;
  return defs.map(d => { const r = { ...d, left }; left += d.width; return r; });
}

function getTableMinWidth(leftColDefs) {
  const leftW   = leftColDefs.reduce((s, c) => s + c.width, 0);
  const mCols   = getVisibleMonthColumns();
  const metricW = getRtfMonths().length * mCols.reduce((s, m) => s + (METRIC_WIDTHS[m] || 75), 0);
  return leftW + metricW;
}

// ── 상태 표시 ─────────────────────────────────────────────────────────────────
function statusClass(status) {
  return { 대응가능:"ok", 주의:"warn", 공급부족:"shortage", 판단불가:"unknown" }[status] ?? "unknown";
}

function activeRtfSection() {
  return RTF_SECTION_OPTIONS.find((option) => option.mode === state.rtfSectionMode) || RTF_SECTION_OPTIONS[0];
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
    return formatNumber(qty);
  }
  if (node.items.some((i) => !i.hasCost || !Number.isFinite(i.baseQty)))
    return compressed ? SHORT_TEXT[NEED_DATA] : NEED_DATA;
  const amount = sumNullable(node.items.map((i) => i.baseQty * i.standardCost));
  return Number.isFinite(amount) ? formatMoney(amount) : (compressed ? SHORT_TEXT[NEED_DATA] : NEED_DATA);
}

// ── 드릴다운 컨텍스트 빌더 ───────────────────────────────────────────────────
function buildCellDrillCtx(node, item, month, monthRow) {
  const isAmt = state.rtfDisplayMode === "amount";
  const hasS  = isAmt ? (Number.isFinite(monthRow.shortageAmount) && monthRow.shortageAmount > 0)
                      : (Number.isFinite(monthRow.shortageQty)    && monthRow.shortageQty    > 0);
  if (!hasS) return null;

  if (node.kind === "item" && item) {
    return {
      month, isAggregate: false,
      itemCode: item.itemCode, itemName: item.itemName,
      itemGroup: item.itemGroup, typeGroup: item.typeGroup,
      businessUnit: item.businessUnit,
      plant: item.plantCode, plantDisplay: item.plant,
      shortageQty: monthRow.shortageQty, shortageAmount: monthRow.shortageAmount,
    };
  }
  return {
    month, isAggregate: true,
    label: node.label,
    businessUnit: node.cols.bu || null, typeGroup: node.cols.type || null,
    itemGroup: node.cols.group || null, plantDisplay: node.cols.plant || null,
    itemCodes: node.items.map(function(i) { return i.itemCode; }),
    shortageQty: monthRow.shortageQty, shortageAmount: monthRow.shortageAmount,
  };
}

// ── 셀 렌더 ──────────────────────────────────────────────────────────────────
function renderMetricCell(row, metric, metricIndex, compressed, drillCtx, adjInfo) {
  const mb     = metricIndex === 0 ? " rtf-month-start" : "";

  if (metric === "판매계획") {
    const raw  = formatDisplayQtyMoney(row.salesQty, row.salesPlanAmount, false);
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-cell-right${mb}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "RTF") {
    const raw  = formatDisplayQtyMoney(row.rtfQty, row.rtfAmount, false);
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-rtf-cell rtf-status-text ${statusClass(row.status)} rtf-cell-right${mb}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "Shortage") {
    const isAmt = state.rtfDisplayMode === "amount";
    const hasS  = isAmt ? (Number.isFinite(row.shortageAmount) && row.shortageAmount > 0)
                        : (Number.isFinite(row.shortageQty)    && row.shortageQty    > 0);
    const raw = hasS ? (isAmt ? formatMoney(row.shortageAmount) : formatNumber(row.shortageQty)) : "-";
    // BOM 제약 셀: 계획 기준보다 부족이 증가한 경우 별도 표시
    const bomBadge = hasS && row.bomConstrained ? `<span class="rtf-bom-constrained-dot" title="BOM 자재 제약으로 부족 증가">▲</span>` : "";
    // tooltip: BOM 제약 시 계획 기준 원래 부족도 표시
    const tooltip = hasS && row.bomConstrained
      ? `BOM 제약 부족: ${raw} (계획 기준: ${Number.isFinite(row.planShortageQty) ? formatNumber(row.planShortageQty) : "-"}) | 공급원인 보기 →`
      : hasS && drillCtx ? "공급원인 보기 →" : "";
    // 조정후 개선 배지
    var adjBadge = "";
    var adjCellCls = "";
    if (adjInfo && Number.isFinite(adjInfo.baseSh) && Number.isFinite(adjInfo.adjSh)) {
      const delta = adjInfo.adjSh - adjInfo.baseSh; // 음수 = 개선
      if (delta < -0.5) {
        adjBadge = `<span class="rtf-adj-badge rtf-adj-improved" title="조정 전 ${escapeHtml(formatNumber(Math.round(adjInfo.baseSh)))} → 조정 후 ${escapeHtml(formatNumber(Math.round(adjInfo.adjSh)))}">▼${escapeHtml(formatNumber(Math.round(-delta)))}</span>`;
        adjCellCls = " rtf-adj-cell-improved";
      }
    }
    if (hasS && drillCtx) {
      const drill = escapeHtml(JSON.stringify(drillCtx));
      return `<td class="rtf-metric-cell rtf-shortage-cell rtf-status-text shortage rtf-cell-right${mb}${adjCellCls} rtf-drillable${row.bomConstrained ? " rtf-bom-constrained" : ""}" data-cst-drill="${drill}" title="${escapeHtml(tooltip)}">${escapeHtml(raw)}${bomBadge}${adjBadge}</td>`;
    }
    return `<td class="rtf-metric-cell rtf-shortage-cell ${hasS ? "rtf-status-text shortage" : "rtf-neutral-text"} rtf-cell-right${mb}${adjCellCls}">${hasS ? escapeHtml(raw) + bomBadge + adjBadge : escapeHtml(raw)}</td>`;
  }
  if (metric === "매출") {
    const raw = Number.isFinite(row.salesAmount) ? formatMoney(row.salesAmount) : NEED_DATA;
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-muted-metric rtf-cell-right${mb}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "매출차질예상") {
    const raw = Number.isFinite(row.lostSalesAmount) ? formatMoney(row.lostSalesAmount) : NEED_DATA;
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-muted-metric rtf-cell-right${mb}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
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
function visibleLeftValue(node, col, mode) {
  if (col.isBase || col.isName || node.kind === "total") return null;
  if (mode === "business") {
    if (col.key === "bu") return node.level === 0 ? node.cols.bu : "";
    if (col.key === "type") return node.level === 1 ? node.cols.type : "";
    if (col.key === "group") return node.level === 2 ? node.cols.group : "";
  } else if (mode === "plant") {
    if (col.key === "plant") return node.level === 0 ? node.cols.plant : "";
    if (col.key === "type") return node.level === 1 ? node.cols.type : "";
    if (col.key === "group") return node.level === 2 ? node.cols.group : "";
  } else {
    if (col.key === "type") return node.level === 0 ? node.cols.type : "";
    if (col.key === "bu") return node.level === 1 ? node.cols.bu : "";
    if (col.key === "plant") return node.level === 2 ? node.cols.plant : "";
    if (col.key === "group") return node.level === 3 ? node.cols.group : "";
  }
  if (col.key === "code") return node.kind === "item" ? node.cols.code : "";
  return node.cols[col.key] || "";
}

function displayNodeLabel(node) {
  if (node.kind === "total") return "총합계";
  return String(node.label ?? "").replace(/\s*계$/, "");
}

function mergeKeyForColumn(node, col, mode) {
  if (node.kind === "total" || col.isBase || col.isName || col.key === "code") return "";
  const value = node.cols[col.key] || "";
  if (!value) return "";
  if (mode === "business") {
    if (col.key === "bu") return `bu|${node.cols.bu}`;
    if (col.key === "type") return `bu|${node.cols.bu}|type|${node.cols.type}`;
    if (col.key === "group") return `bu|${node.cols.bu}|type|${node.cols.type}|group|${node.cols.group}`;
  } else if (mode === "plant") {
    if (col.key === "plant") return `plant|${node.cols.plant}`;
    if (col.key === "type") return `plant|${node.cols.plant}|type|${node.cols.type}`;
    if (col.key === "group") return `plant|${node.cols.plant}|type|${node.cols.type}|group|${node.cols.group}`;
  } else {
    if (col.key === "type") return `type|${node.cols.type}`;
    if (col.key === "bu") return `type|${node.cols.type}|bu|${node.cols.bu}`;
    if (col.key === "plant") return `type|${node.cols.type}|bu|${node.cols.bu}|plant|${node.cols.plant}`;
    if (col.key === "group") return `type|${node.cols.type}|bu|${node.cols.bu}|plant|${node.cols.plant}|group|${node.cols.group}`;
  }
  return "";
}

function isVisibleRtfNode(node, compressed) {
  if (node.kind === "total") return true;
  if (compressed) return node.level === 0;
  return !(node.kind === "item" && !state.expandedItemGroups.has(node.parentId));
}

function getRowspanMap(nodes, leftColDefs, compressed, mode) {
  const spans = new Map();
  const skip = new Set();
  if (compressed) return { spans, skip };
  const visibleNodes = nodes.filter((node) => isVisibleRtfNode(node, compressed));
  leftColDefs.forEach((col) => {
    if (col.isBase || col.isName || col.key === "code") return;
    for (let index = 0; index < visibleNodes.length; index += 1) {
      const node = visibleNodes[index];
      const key = mergeKeyForColumn(node, col, mode);
      if (!key) continue;
      let span = 1;
      for (let cursor = index + 1; cursor < visibleNodes.length; cursor += 1) {
        const next = visibleNodes[cursor];
        if (mergeKeyForColumn(next, col, mode) !== key) break;
        span += 1;
      }
      if (span > 1) {
        spans.set(`${node.id}|${col.key}`, span);
        for (let offset = 1; offset < span; offset += 1) skip.add(`${visibleNodes[index + offset].id}|${col.key}`);
      }
      index += span - 1;
    }
  });
  return { spans, skip };
}

function renderHierarchyRow(node, leftColDefs, compressed, mode, rowspanMap) {
  const isTotal     = node.kind === "total";
  const isItem      = node.kind === "item";
  const isItemGroup = node.kind === "itemGroup";
  const item        = isItem ? node.items[0] : null;
  const isHidden    = isTotal ? false : (compressed ? node.level > 0 : (isItem && !state.expandedItemGroups.has(node.parentId)));
  const monthCols   = getVisibleMonthColumns();
  const cells = getRtfMonths().map((month, mIdx) => {
    const monthRow  = isItem ? item.monthlyStatus[mIdx] : aggregateMonth(node.items, mIdx);
    const drillCtx  = buildCellDrillCtx(node, isItem ? item : null, month, monthRow);
    // 조정후 모드: 현재 계획 대비 비교 데이터
    var adjInfo = null;
    if (state.rtfViewMode === "adjusted" && _rtfBaseItemMap.size > 0) {
      var baseItems = node.items.map(function(ni) {
        return _rtfBaseItemMap.get(ni.itemCode + "|" + ni.plantCode);
      }).filter(Boolean);
      if (baseItems.length > 0) {
        var baseAgg = aggregateMonth(baseItems, mIdx);
        adjInfo = { baseSh: baseAgg.shortageQty, adjSh: monthRow.shortageQty };
      }
    }
    return monthCols.map((metric, colIdx) => renderMetricCell(monthRow, metric, colIdx, compressed, drillCtx, adjInfo)).join("");
  }).join("");

  const leftCells = [];
  for (let colIndex = 0; colIndex < leftColDefs.length; colIndex += 1) {
    const col = leftColDefs[colIndex];
    const cellKey = `${node.id}|${col.key}`;
    if (rowspanMap?.skip.has(cellKey)) continue;
    let value;
    if (col.isBase) {
      value = formatBaseForNode(node, compressed);
    } else if (col.isName) {
      value = displayNodeLabel(node);
    } else {
      const explicitValue = visibleLeftValue(node, col, mode);
      const raw = explicitValue === null ? (node.cols[col.key] || "") : explicitValue;
      value = (isTotal && col.isFirst && !raw) ? displayNodeLabel(node) : raw; // 총합계 행 fallback
    }
    const toggleBtn = (col.isToggle && isItemGroup && !compressed)
      ? `<button type="button" class="rtf-item-toggle" data-node-id="${escapeHtml(node.id)}">${state.expandedItemGroups.has(node.id) ? "-" : "+"}</button>`
      : "";
    const alignCls  = col.align === "left" ? "rtf-cell-left" : col.align === "right" ? "rtf-cell-right" : "rtf-cell-center";
    const extraCls  = col.isName ? " rtf-col-name" : col.isLast ? " rtf-col-last-sticky" : "";
    const titleAttr = col.isName ? ` title="${escapeHtml(node.label)}"` : "";
    const rowspan = rowspanMap?.spans.has(cellKey) ? ` rowspan="${rowspanMap.spans.get(cellKey)}"` : "";
    const mergeCls = rowspan ? " rtf-rowspan-cell" : "";
    const isTotalLabelCell = isTotal && colIndex === 0;
    const codeIndex = leftColDefs.findIndex((entry) => entry.key === "code");
    const nameIndex = leftColDefs.findIndex((entry) => entry.isName);
    const isSubtotalLabelCell = !isItem && !isTotal && !compressed && colIndex === codeIndex && nameIndex === codeIndex + 1;
    if (isTotalLabelCell) {
      const baseIndex = leftColDefs.findIndex((entry) => entry.isBase);
      const spanCount = baseIndex > 0 ? baseIndex : 1;
      const spanWidth = leftColDefs.slice(0, spanCount).reduce((sum, entry) => sum + entry.width, 0);
      leftCells.push(`<td class="rtf-sticky rtf-cell-left rtf-merged-label" style="left:0;width:${spanWidth}px;" colspan="${spanCount}">${escapeHtml(displayNodeLabel(node))}</td>`);
      colIndex += spanCount - 1;
      continue;
    }
    if (isSubtotalLabelCell) {
      const spanWidth = leftColDefs[colIndex].width + leftColDefs[nameIndex].width;
      leftCells.push(`<td class="rtf-sticky rtf-cell-center rtf-col-name rtf-merged-label rtf-empty-merged-label" style="left:${col.left}px;width:${spanWidth}px;" colspan="2" aria-label="${escapeHtml(displayNodeLabel(node))}"></td>`);
      colIndex = nameIndex;
      continue;
    }
    const sharedBadge = col.isName && isItem && item && item.hasSharedAlert
      ? `<span class="rtf-shared-alert-badge" title="공용자재 경합 — 소요량 우선차감 적용">⚠공용</span>`
      : "";
    const altBomBadge = col.isName && isItem && item && item.hasAltBomAlert
      ? `<span class="rtf-altbom-badge" title="대체 BOM 존재 — 공급 부족 시 대체 BOM 전환 검토 가능">대체BOM</span>`
      : "";
    leftCells.push(`<td class="rtf-sticky ${alignCls}${extraCls}${mergeCls}" style="left:${col.left}px;width:${col.width}px;"${titleAttr}${rowspan}>${toggleBtn}${escapeHtml(value)}${sharedBadge}${altBomBadge}</td>`);
  }

  const kindCls = isTotal ? "is-total" : (isItem ? "is-item" : "is-group");
  return `<tr class="rtf-h-row level-${node.level} ${kindCls}" data-node-id="${escapeHtml(node.id)}" data-parent-id="${escapeHtml(node.parentId)}"${isHidden ? " hidden" : ""}>
    ${leftCells.join("")}${cells}
  </tr>`;
}

// ── 섹션 렌더 ────────────────────────────────────────────────────────────────
function renderMatrixSection(title, mode, items, sectionId) {
  const compressed  = !state.rtfExpanded;
  const leftColDefs = getLeftColDefs(mode);
  const months      = getRtfMonths();
  const monthCols   = getVisibleMonthColumns();
  const minWidth    = getTableMinWidth(leftColDefs);
  const colCount    = leftColDefs.length + months.length * monthCols.length;
  const nodes       = sortHierarchyNodes(buildHierarchy(items, mode), sectionId);
  const rowspanMap = getRowspanMap(nodes, leftColDefs, compressed, mode);
  const body        = nodes.length
    ? nodes.map(n => renderHierarchyRow(n, leftColDefs, compressed, mode, rowspanMap)).join("")
    : `<tr><td colspan="${colCount}" class="rtf-empty">데이터 없음</td></tr>`;

  // colgroup: 좌측(inline width) + 월별 지표
  const colgroup = [
    ...leftColDefs.map(c => `<col style="width:${c.width}px;">`),
    ...months.flatMap(() => monthCols.map(m => `<col style="width:${METRIC_WIDTHS[m] || 75}px;">`)),
  ].join("");

  // 정렬 th 헬퍼 (아이콘 절대 배치 → 텍스트 중앙 정렬 유지)
  function mkSortTh(label, colKey, extraCls, rowspan, stickyStyle) {
    const active = rtfSortState[sectionId]?.colKey === colKey;
    const rs     = rowspan ? ` rowspan="${rowspan}"` : "";
    const style  = stickyStyle ? ` style="${stickyStyle}"` : "";
    return `<th class="rtf-th-sortable${extraCls ? " " + extraCls : ""}" data-sort-col="${escapeHtml(colKey)}" data-sort-section="${escapeHtml(sectionId)}"${rs}${style}>${escapeHtml(label)}<span class="rtf-sort-icon${active ? " is-active" : ""}">${sortIconText(sectionId, colKey)}</span></th>`;
  }

  // 좌측 고정 헤더 (rowspan=2, 위치·폭은 inline style)
  const leftHeaders = leftColDefs.map(col => {
    const alignCls  = col.align === "left" ? "rtf-cell-left" : col.align === "right" ? "rtf-cell-right" : "";
    const extraCls  = col.isName ? " rtf-col-name" : col.isLast ? " rtf-col-last-sticky" : "";
    const cls       = `rtf-sticky${alignCls ? " " + alignCls : ""}${extraCls}`;
    return mkSortTh(col.label, col.key, cls, 2, `left:${col.left}px;width:${col.width}px;`);
  }).join("");

  // 월 그룹 헤더 (colspan = 하위 컬럼 수)
  const monthHeader = months.map((m, mi) =>
    `<th class="rtf-month-head${mi > 0 ? " rtf-month-start" : ""}" colspan="${monthCols.length}">${escapeHtml(monthLabel(m))}</th>`
  ).join("");

  // 월 하위 지표 헤더 (기본: 판매/RTF/부족 표시명)
  const metricHeader = months.flatMap(() =>
    monthCols.map((m, ci) => {
      const active   = rtfSortState[sectionId]?.colKey === m;
      const dispName = compressed ? (METRIC_DISPLAY_SHORT[m] || m) : (METRIC_DISPLAY[m] || m);
      const isKey    = ["RTF","Shortage"].includes(m);
      const cls      = `rtf-th-sortable rtf-sub-head${isKey ? " rtf-key-sub" : ""}${ci === 0 ? " rtf-month-start" : ""}`;
      return `<th class="${cls}" data-sort-col="${escapeHtml(m)}" data-sort-section="${escapeHtml(sectionId)}">${escapeHtml(dispName)}<span class="rtf-sort-icon${active ? " is-active" : ""}">${sortIconText(sectionId, m)}</span></th>`;
    })
  ).join("");

  return `<section id="${escapeHtml(sectionId)}" class="rtf-card rtf-block rtf-matrix-block">
    <div class="rtf-sec-title">${escapeHtml(title)}</div>
    <div class="rtf-h-scroll">
      <table class="rtf-h-matrix-table${compressed ? " is-compressed" : ""}" style="min-width:${minWidth}px;${compressed ? "width:100%;" : ""}">
        <colgroup>${colgroup}</colgroup>
        <thead>
          <tr>${leftHeaders}${monthHeader}</tr>
          <tr>${metricHeader}</tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

// ── 조정내역 패널 ─────────────────────────────────────────────────────────────
function renderRtfAdjPanel() {
  var simAdj = state.matSimAdj || {};
  var keys = Object.keys(simAdj);
  if (keys.length === 0) return "";

  // 자재명 조회용 맵
  var nameMap = new Map();
  if (state.bomResult && state.bomResult.items) {
    state.bomResult.items.forEach(function(bi) {
      if (bi.componentCode && bi.componentName) nameMap.set(bi.componentCode, bi.componentName);
    });
  }

  // 원래 입고수량 맵
  var origSupplyMap = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant) || "", month = cleanOptional(r.month);
    if (!code || !month) return;
    var k = code + "|" + plant + "|" + month;
    origSupplyMap.set(k, (origSupplyMap.get(k) || 0) + (cleanNumber(r.supplyQty) || 0));
  });

  var rows = keys.map(function(k) {
    var parts = k.split("|");
    var compCode = parts[0], plant = parts[1] || "", month = parts[2] || "";
    var adjQty = simAdj[k];
    var origQty = origSupplyMap.get(k) || 0;
    var delta = adjQty - origQty;
    var deltaDisp = (delta >= 0 ? "+" : "") + formatNumber(Math.round(delta));
    var deltaCls = delta >= 0 ? "rtf-adj-pos" : "rtf-adj-neg";
    var name = nameMap.get(compCode) || "";
    return "<tr>" +
      "<td>" + escapeHtml(compCode) + "</td>" +
      "<td>" + escapeHtml(name) + "</td>" +
      "<td style=\"text-align:center\">" + escapeHtml(monthLabel(month) || month) + "</td>" +
      "<td style=\"text-align:right\">" + escapeHtml(formatNumber(Math.round(origQty))) + "</td>" +
      "<td style=\"text-align:right\">" + escapeHtml(formatNumber(Math.round(adjQty))) + "</td>" +
      "<td style=\"text-align:right\" class=\"" + deltaCls + "\">" + escapeHtml(deltaDisp) + "</td>" +
      "</tr>";
  }).join("");

  return "<div class=\"rtf-adj-panel\">" +
    "<div class=\"rtf-adj-panel-title\" id=\"rtfAdjPanelToggle\">" +
    "<span>조정내역 (" + keys.length + "건)</span><span id=\"rtfAdjPanelArrow\">▼</span></div>" +
    "<div class=\"rtf-adj-panel-body\" id=\"rtfAdjPanelBody\">" +
    "<table class=\"rtf-adj-table\"><thead><tr>" +
    "<th>자재코드</th><th>자재명</th><th>월</th><th>원래입고</th><th>조정후</th><th>변동</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table>" +
    "</div></div>";
}

// ── 하단 재고금액·재고일수 요약 바 ───────────────────────────────────────────
function renderRtfInventoryBar(items, baseItemsForDelta) {
  var months = getRtfMonths();
  if (!items || items.length === 0) return "";

  var hasDelta = !!baseItemsForDelta;
  var baseItems = hasDelta ? baseItemsForDelta : null;

  var amtRow = "", daysRow = "", amtDeltaRow = "", daysDeltaRow = "";

  months.forEach(function(month, mi) {
    var agg = aggregateMonth(items, mi);
    var amtVal = Number.isFinite(agg.endingAmount) ? formatMoney(agg.endingAmount) : "-";
    var daysVal = Number.isFinite(agg.inventoryDays) ? Math.round(agg.inventoryDays) + "일" : "-";
    amtRow  += "<td>" + escapeHtml(amtVal)  + "</td>";
    daysRow += "<td>" + escapeHtml(daysVal) + "</td>";

    if (hasDelta && baseItems) {
      var baseAgg = aggregateMonth(baseItems, mi);
      // 재고금액 delta
      if (Number.isFinite(agg.endingAmount) && Number.isFinite(baseAgg.endingAmount)) {
        var amtDelta = agg.endingAmount - baseAgg.endingAmount;
        var amtSign = amtDelta >= 0 ? "+" : "";
        var amtCls = amtDelta >= 0 ? "rtf-inv-delta-pos" : "rtf-inv-delta-neg";
        amtDeltaRow += "<td class=\"" + amtCls + "\">" + escapeHtml(amtSign + formatMoney(amtDelta)) + "</td>";
      } else {
        amtDeltaRow += "<td>-</td>";
      }
      // 재고일수 delta
      if (Number.isFinite(agg.inventoryDays) && Number.isFinite(baseAgg.inventoryDays)) {
        var daysDelta = agg.inventoryDays - baseAgg.inventoryDays;
        var daysSign = daysDelta >= 0 ? "+" : "";
        var daysCls = daysDelta >= 0 ? "rtf-inv-delta-pos" : "rtf-inv-delta-neg";
        daysDeltaRow += "<td class=\"" + daysCls + "\">" + escapeHtml(daysSign + Math.round(daysDelta) + "일") + "</td>";
      } else {
        daysDeltaRow += "<td>-</td>";
      }
    }
  });

  var monthHeaders = months.map(function(m) {
    return "<th>" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");

  var deltaRows = hasDelta ? (
    "<tr class=\"rtf-inv-delta-row\"><td class=\"rtf-inv-label\">재고금액 변동</td>" + amtDeltaRow + "</tr>" +
    "<tr class=\"rtf-inv-delta-row\"><td class=\"rtf-inv-label\">재고일수 변동</td>" + daysDeltaRow + "</tr>"
  ) : "";

  return "<div class=\"rtf-inv-bar rtf-card\" style=\"padding:14px 18px;margin-top:10px;\">" +
    "<div class=\"rtf-inv-bar-title\">월별 재고금액 · 재고일수</div>" +
    "<div><table class=\"rtf-inv-table\">" +
    "<thead><tr><th class=\"rtf-inv-row-label\"></th>" + monthHeaders + "</tr></thead>" +
    "<tbody>" +
    "<tr><td class=\"rtf-inv-label\">재고금액</td>" + amtRow  + "</tr>" +
    "<tr><td class=\"rtf-inv-label\">재고일수</td>" + daysRow + "</tr>" +
    deltaRows +
    "</tbody></table></div></div>";
}

// ── RTF 화면 ─────────────────────────────────────────────────────────────────
function renderRtf() {
  // 1. 현재 계획 기준 items (항상 계산)
  const baseItems = computeRtfItems();
  _rtfBaseItemMap.clear();
  baseItems.forEach(function(item) { _rtfBaseItemMap.set(item.itemCode + "|" + item.plantCode, item); });

  // 2. 조정후 items (matSimAdj 있을 때만)
  const hasAdj = Object.keys(state.matSimAdj || {}).length > 0;
  const adjItems = hasAdj ? computeRtfItems(buildBomMaxProducibleMap(state.matSimAdj)) : null;
  if (!hasAdj && state.rtfViewMode === "adjusted") state.rtfViewMode = "current";

  // 3. 화면에 표시할 items
  const items = (state.rtfViewMode === "adjusted" && adjItems) ? adjItems : baseItems;
  _rtfItems = items;

  if (!state.mappedData.plan_monthly.length) {
    return `<div class="rtf-screen"><section class="rtf-card rtf-top"><div class="rtf-nodata">데이터 연결 필요<br>데이터점검 화면에서 RAW 파일을 선택해 주세요.</div></section></div>`;
  }

  const months = getRtfMonths();
  const match  = checkTotalsMatch(items);
  const verifyHtml = match === null ? "" :
    match ? `<span class="rtf-verify-ok">총합계 일치</span>` : `<span class="rtf-verify-err">총합계 불일치 확인 필요</span>`;
  const firstMonth = aggregateMonth(items, 0);
  const firstShortage = state.rtfDisplayMode === "amount" ? firstMonth.shortageAmount : firstMonth.shortageQty;
  const summaryUnit = state.rtfDisplayMode === "amount" ? "" : "개";
  const summaryLine = `${monthLabel(months[0])} 총 판매계획 <b>${escapeHtml(formatDisplayQtyMoney(firstMonth.salesQty, firstMonth.salesPlanAmount))}${summaryUnit}</b>, RTF <b>${escapeHtml(formatDisplayQtyMoney(firstMonth.rtfQty, firstMonth.rtfAmount))}${summaryUnit}</b>. ${Number.isFinite(firstShortage) && firstShortage > 0 ? `<span class="rtf-alert-text">Shortage ${escapeHtml(state.rtfDisplayMode === "amount" ? formatMoney(firstShortage) : formatNumber(firstShortage) + summaryUnit)}</span>` : `<span class="rtf-ok-text">Shortage 없음</span>`}`;

  // 4. 전후 토글 UI (항상 표시, 조정 없으면 "조정 후" 비활성)
  const adjCount = Object.keys(state.matSimAdj || {}).length;
  const toggleHtml = `<div class="rtf-view-toggle" aria-label="RTF 보기 기준">
    <button type="button" class="rtf-view-btn ${state.rtfViewMode === "current" ? "active" : ""}" data-rtf-view="current">현재 계획</button>
    <button type="button" class="rtf-view-btn ${state.rtfViewMode === "adjusted" ? "active" : ""}${!hasAdj ? " disabled" : ""}" data-rtf-view="adjusted"${!hasAdj ? ' disabled title="공급원인 화면에서 자재 입고계획을 조정한 후 사용 가능합니다"' : ""}>조정 후${hasAdj ? ` ●${adjCount}건` : ""}</button>
  </div>`;

  // 5. 조정내역 패널
  const adjPanelHtml = hasAdj ? renderRtfAdjPanel() : "";

  // 6. 인포바 데이터 계산
  const shortageCount = items.filter(function(item) {
    return item.monthlyStatus.some(function(m) { return m.status === STATUS.SHORTAGE; });
  }).length;
  const unknownCount = items.filter(function(item) {
    return !item.monthlyStatus.some(function(m) { return m.status === STATUS.SHORTAGE; }) &&
      item.monthlyStatus.some(function(m) { return m.status === STATUS.UNKNOWN; });
  }).length;

  const statusBadge = shortageCount > 0
    ? `<span class="rtf-ib-badge rtf-ib-shortage">공급부족 ${shortageCount}건</span>`
    : `<span class="rtf-ib-badge rtf-ib-ok">공급부족 없음</span>`;
  const unknownBadge = unknownCount > 0
    ? `<span class="rtf-ib-badge rtf-ib-unknown">판단불가 ${unknownCount}건</span>`
    : "";
  const bomBadge = state.bomStatus === "done"
    ? `<span class="rtf-ib-badge rtf-ib-bom">${(state.bomResult && state.bomResult.stats && state.bomResult.stats.indeterminate > 0) ? `BOM반영 · 판단불가 ${state.bomResult.stats.indeterminate}건` : "BOM 반영"}</span>`
    : `<span class="rtf-ib-badge rtf-ib-bom-off">BOM 미반영</span>`;

  const infobarHtml = `<div class="rtf-infobar">
    <div class="rtf-ib-left">
      ${statusBadge}${unknownBadge}
      <span class="rtf-ib-sep">|</span>
      <span class="rtf-ib-meta">기준월: ${escapeHtml(months[0])} &nbsp;·&nbsp; 대상기간: ${escapeHtml(months.map(monthLabel).join(" ~ "))} &nbsp;·&nbsp; 표시: ${state.rtfDisplayMode === "qty" ? "수량" : "금액"}</span>
      <span class="rtf-ib-sep">|</span>
      ${bomBadge}
      ${verifyHtml}
    </div>
    <div class="rtf-ib-right">${toggleHtml}</div>
  </div>`;

  // 7. 서브탭 + 패널
  if (!state.rtfSubTab) state.rtfSubTab = "matrix";

  const activeSection = activeRtfSection();
  const sectionTabs = state.rtfExpanded ? RTF_SECTION_OPTIONS.map((option) =>
    `<button type="button" class="rtf-section-tab ${activeSection.mode === option.mode ? "active" : ""}" data-rtf-section="${escapeHtml(option.mode)}">${escapeHtml(option.label)}</button>`
  ).join("") : "";
  const sectionHtml = state.rtfExpanded
    ? renderMatrixSection(activeSection.title, activeSection.mode, items, activeSection.sectionId)
    : RTF_SECTION_OPTIONS.map((option) => renderMatrixSection(option.title, option.mode, items, option.sectionId)).join("");

  const isMatrix = state.rtfSubTab === "matrix";
  const panelHtml = isMatrix
    ? sectionHtml
    : `<div class="rtf-inv-panel">${renderRtfInventoryBar(items, state.rtfViewMode === "adjusted" ? baseItems : null)}</div>`;

  return `<div class="rtf-screen rtf-excel-layout">
    ${infobarHtml}
    <div class="rtf-toolbar">
      <div class="rtf-subtabs">
        <button type="button" class="rtf-subtab ${isMatrix ? "active" : ""}" data-rtf-subtab="matrix">RTF 매트릭스</button>
        <button type="button" class="rtf-subtab ${!isMatrix ? "active" : ""}" data-rtf-subtab="inventory">재고현황</button>
      </div>
      ${isMatrix && state.rtfExpanded ? `<div class="rtf-section-tabs" aria-label="RTF 보기 기준">${sectionTabs}</div>` : ""}
      ${isMatrix ? `
      <div class="rtf-mode-group" aria-label="표시 단위">
        <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "qty" ? "active" : ""}" data-rtf-mode="qty">수량</button>
        <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "amount" ? "active" : ""}" data-rtf-mode="amount">금액</button>
      </div>
      <button type="button" id="rtfExpandToggle" class="rtf-extra-toggle ${state.rtfExpanded ? "active" : ""}">${state.rtfExpanded ? "축소" : "확대"}</button>
      <button type="button" id="rtfGoConstraintBtn" class="rtf-go-constraint-btn">공급원인 분석 →</button>
      <span class="rtf-toolbar-hint">${state.rtfExpanded ? "분석용 상세 · 보기 기준 탭 선택" : "발표용 기본 · 사업부/플랜트/유형 전체 표시"}</span>
      ` : ""}
    </div>
    ${adjPanelHtml}
    ${panelHtml}
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

  document.querySelectorAll("[data-rtf-section]").forEach((btn) => btn.addEventListener("click", () => {
    if (state.rtfSectionMode === btn.dataset.rtfSection) return;
    state.rtfSectionMode = btn.dataset.rtfSection;
    state.expandedItemGroups.clear();
    render("rtf");
  }));

  document.querySelectorAll(".rtf-item-toggle").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const nodeId = btn.dataset.nodeId, wasExp = state.expandedItemGroups.has(nodeId);
    if (wasExp) state.expandedItemGroups.delete(nodeId);
    else        state.expandedItemGroups.add(nodeId);
    render("rtf");
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

  // 서브탭
  document.querySelectorAll("[data-rtf-subtab]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (state.rtfSubTab === btn.dataset.rtfSubtab) return;
      state.rtfSubTab = btn.dataset.rtfSubtab;
      render("rtf");
    });
  });

  // 전후 토글
  document.querySelectorAll("[data-rtf-view]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (state.rtfViewMode === btn.dataset.rtfView) return;
      state.rtfViewMode = btn.dataset.rtfView;
      render("rtf");
    });
  });

  // 조정내역 접이식
  document.querySelector("#rtfAdjPanelToggle")?.addEventListener("click", function() {
    var body = document.querySelector("#rtfAdjPanelBody");
    var arrow = document.querySelector("#rtfAdjPanelArrow");
    if (!body) return;
    body.hidden = !body.hidden;
    if (arrow) arrow.textContent = body.hidden ? "▶" : "▼";
  });

  document.querySelector("#rtfGoConstraintBtn")?.addEventListener("click", () => {
    state.cstDrilldown = null;
    state.constraintFilter = "shortage";
    state.constraintSearch = "";
    render("constraint");
  });

  document.querySelectorAll("[data-cst-drill]").forEach((td) => {
    td.addEventListener("click", (e) => {
      e.stopPropagation();
      let ctx;
      try { ctx = JSON.parse(td.getAttribute("data-cst-drill")); } catch(err) { return; }
      state.cstDrilldown = ctx;
      state.constraintFilter = "all";
      state.constraintSearch = "";
      render("constraint");
    });
  });
}
