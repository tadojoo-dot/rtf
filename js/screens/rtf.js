// ── 정렬 상태 (렌더 간 유지) ──────────────────────────────────────────────────
var _rtfBaseItemMap = new Map(); // "itemCode|plantCode" → item (현재 계획 기준, 비교용)
var rtfSortState = {
  // colKey 비움 → sortHierarchyNodes 기본 분기(당월 판매금액·표시모드별 내림차순)가 작동
  "rtfBusinessMatrix": { colKey: "", dir: "desc" },
  "rtfPlantMatrix":    { colKey: "", dir: "desc" },
  "rtfTypeMatrix":     { colKey: "", dir: "desc" },
};
var _rtfItems = []; // 정렬 재빌드용 캐시

// ── 컬럼 공통 메타 ────────────────────────────────────────────────────────────
var GRID_COL_WIDTH = 90;
var NAME_COL_WIDTH = 230;
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
var _bomMaxProducibleCache = null; // adj 없는 기본 맵 캐시 (BOM 재전개 시 무효화)

// ── 완제품 생산계획 조정(fgProdAdj) 헬퍼 ─────────────────────────────────────
// state.fgProdAdj: "code|plant|month" → 조정 생산수량 (늘리기만, 원계획 이상)
function hasFgProdAdj() {
  return !!(state.fgProdAdj && Object.keys(state.fgProdAdj).length > 0);
}
// 조정 후 시나리오용 공급 override 통합 (상품 입고 + 완제품 생산, extra는 감축 등 최우선)
function rtfSupplyAdjAll(extra) {
  var m = Object.assign({}, state.goodsSupplyAdj || {}, state.fgProdAdj || {});
  return extra ? Object.assign(m, extra) : m;
}
// 생산계획 조정 반영 BOM 전개 (조정 없으면 원본 스냅샷 그대로 — 베이스라인 불변)
var _bomResAdjCache = null, _bomResAdjSig = "", _bomResAdjBase = null;
function getBomResultAdj(fgAdj) {
  var adj = fgAdj || state.fgProdAdj;
  if (!adj || !Object.keys(adj).length) return state.bomResult;
  if (typeof computeBomExpansion !== "function") return state.bomResult;
  var sig = JSON.stringify(adj);
  if (_bomResAdjCache && _bomResAdjSig === sig && _bomResAdjBase === state.bomResult) return _bomResAdjCache;
  _bomResAdjCache = computeBomExpansion(undefined, adj);
  _bomResAdjSig   = sig;
  _bomResAdjBase  = state.bomResult;
  return _bomResAdjCache;
}

function buildBomMaxProducibleMap(adjOverrides, fgAdj) {
  if (state.bomStatus !== "done" || !state.bomResult || !state.bomResult.items) return null;

  // adj 없는 기본 호출은 캐시 사용 (탭 이동 시마다 재계산 방지)
  var hasAdj = adjOverrides && Object.keys(adjOverrides).length > 0;
  var hasFg  = fgAdj && Object.keys(fgAdj).length > 0;
  if (!hasAdj && !hasFg && _bomMaxProducibleCache) return _bomMaxProducibleCache;
  // 생산계획 조정 시 소요가 재전개된 스냅샷 기준으로 자재 캡 산출
  var bomRes = hasFg ? getBomResultAdj(fgAdj) : state.bomResult;
  if (!bomRes || !bomRes.items) return null;

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
  // 조정 시: 자재별 월간 잔여량 이월 (Pull In 후 남은 자재 → 다음 달로 누적)
  const extraCarryMap = new Map(); // matKey → 이전 달에서 넘어온 추가 잔여량

  bomRes.items.forEach((bi) => {
    if (!bi.monthlyData || !bi.parentItems) return;
    const matKey = bi.componentCode + "|" + (bi.plant || "");

    bi.monthlyData.forEach((md, j) => {
      if (!md || md.availableQty === null) return; // 판단불가 자재 → skip

      const origAvailableQty = Math.max(0, md.availableQty);

      // 조정값 반영 가용수량: 원래값 + 이전 달 추가 잔여 + 이번 달 조정 delta
      let availableQty = origAvailableQty;
      if (adjOverrides) {
        availableQty += (extraCarryMap.get(matKey) || 0);
        if (origSupplyMap) {
          const adjKey = matKey + "|" + md.month;
          if (adjKey in adjOverrides) {
            const orig = origSupplyMap.get(adjKey) || 0;
            availableQty += (adjOverrides[adjKey] - orig);
          }
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

      // 원래 시나리오 잔여량 (carry 계산용 — map 업데이트 안 함)
      let origRemaining = origAvailableQty;
      if (adjOverrides) {
        parents.forEach(({ reqQty }) => {
          origRemaining = Math.max(0, origRemaining - Math.min(reqQty, origRemaining));
        });
      }

      // 조정 후 waterfall → map 업데이트
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

      // 다음 달로 넘길 추가 잔여량 = 조정 후 잔여 - 원래 잔여
      if (adjOverrides) {
        extraCarryMap.set(matKey, Math.max(0, remaining - origRemaining));
      }
    });
  });

  if (!hasAdj && !hasFg) _bomMaxProducibleCache = map; // adj 없는 결과 캐시 저장
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

// ── 판가(매출단가) 맵 ─────────────────────────────────────────────────────────
// 매출_RAW: 품목별 순매출액(공시) 합계 ÷ 총수량(PA) 합계 = 판가 (반품·복수행 자동 처리).
// 월 구분이 없는 단일 집계 파일 → 품목별 고정 단가. itemCode 기준 매칭.
var _salesPriceCache = null;
function buildSalesPriceMap() {
  if (_salesPriceCache) return _salesPriceCache;
  const agg = new Map(); // itemCode → { net, pa }
  (state.mappedData.sales_actual || []).forEach(function(r) {
    const code = cleanOptional(r.itemCode);
    if (!code) return;
    const e = agg.get(code) || { net: 0, pa: 0 };
    e.net += (cleanNumber(r.netSales) || 0);
    e.pa  += (cleanNumber(r.paQty)   || 0);
    agg.set(code, e);
  });
  const map = new Map();
  agg.forEach(function(v, code) {
    if (Math.abs(v.pa) < 0.001) return;   // 수량 0 → 판가 산출 불가
    const price = v.net / v.pa;
    if (price > 0) map.set(code, price);  // 순매출·수량이 같은 부호여야 양의 판가
  });
  _salesPriceCache = map;
  return map;
}

// 기초재고 미연결 품목의 표준원가 대체용: 매출_RAW 단위당원가(수량가중평균), itemCode 기준.
var _salesCostCache = null;
function buildSalesCostMap() {
  if (_salesCostCache) return _salesCostCache;
  const agg = new Map(); // itemCode → { costQty, qty }
  (state.mappedData.sales_actual || []).forEach(function(r) {
    const code = cleanOptional(r.itemCode);
    const qty  = cleanNumber(r.paQty);
    const unitCost = cleanNumber(r.unitCost);
    if (!code || !Number.isFinite(qty) || Math.abs(qty) < 0.001 || !Number.isFinite(unitCost) || unitCost <= 0) return;
    const e = agg.get(code) || { costQty: 0, qty: 0 };
    e.costQty += unitCost * qty;
    e.qty     += qty;
    agg.set(code, e);
  });
  const map = new Map();
  agg.forEach(function(v, code) {
    if (Math.abs(v.qty) < 0.001) return;
    const cost = v.costQty / v.qty;
    if (cost > 0) map.set(code, cost);
  });
  _salesCostCache = map;
  return map;
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

// 매출(판가 기준) 금액 = 수량 × 판가. 판가 없으면 null.
function amountWithPrice(qty, item) {
  return Number.isFinite(qty) && item.hasRevenue ? qty * item.unitPrice : null;
}

function displayPlantName(plantCode) {
  const code = cleanOptional(plantCode);
  return PLANT_NAME_MAP[code] || code || NEED_MASTER;
}

// 캐시: 인자 없이 호출(기본 케이스)할 때만 재사용
var _rtfItemsCache = null;
var _rtfItemsCacheKey = "";
var _rtfItemsBomCache = null; // BOM 완료 후 computeRtfItems(bomMap) 결과 캐시
var _rtfItemsBomRef   = null; // 캐시에 사용된 bomMap 레퍼런스 (object identity 비교)

function _getRtfCacheKey() {
  return state.mappedData.plan_monthly.length + "|" +
         state.mappedData.inventory_base.length + "|" +
         state.mappedData.item_master.length + "|" +
         state.mappedData.sales_actual.length;
}

function invalidateRtfCache() {
  _rtfItemsCache = null; _rtfItemsCacheKey = "";
  _rtfItemsBomCache = null; _rtfItemsBomRef = null;
  _bomResAdjCache = null; _bomResAdjSig = ""; _bomResAdjBase = null;
  _scenMemo = null; _scenMemoEpoch = -1; _scenMemoSig = null;
  _salesPriceCache = null;
  _actualsAnchorCache = null; _actualsAnchorComputed = false;
  _actualsMetaCache = null;
  _nabotaInvCache = null;
  _nabotaFactorsCache = undefined;
  if (typeof invalidateRtfMonthsCache === "function") invalidateRtfMonthsCache();
}

function computeRtfItems(bomMapArg, allTypes, goodsAdj) {
  if (typeof excCount === "function") excCount("computeRtfItems(calls)");
  const _bomMap = (bomMapArg !== undefined) ? bomMapArg : buildBomMaxProducibleMap();
  // 상품 공급(입고) 조정 override — 있으면 캐시 우회(베이스라인 오염 방지)
  const _goodsAdj = (goodsAdj && Object.keys(goodsAdj).length) ? goodsAdj : null;

  if (!allTypes && !_goodsAdj) {
    if (!_bomMap) {
      // BOM 미완료: 기존 캐시 (데이터 크기 기반)
      var ck = _getRtfCacheKey();
      if (_rtfItemsCache && ck === _rtfItemsCacheKey) return _rtfItemsCache;
    } else if (_bomMap === _rtfItemsBomRef && _rtfItemsBomCache) {
      // BOM 완료: 동일 bomMap 레퍼런스면 캐시 반환 (탭 이동 시 재계산 방지)
      return _rtfItemsBomCache;
    }
  }
  if (typeof excCount === "function") excCount("computeRtfItems(MISS-full계산)");
  // BOM 완료 시 자재 제약 맵, 미완료 시 null
  const planRows      = state.mappedData.plan_monthly;
  const inventoryRows = state.mappedData.inventory_base;
  const masterRows    = state.mappedData.item_master;
  const costMap = new Map(), baseQtyMap = new Map(), baseAmtMap = new Map(), inventorySet = new Set();
  const masterMap = new Map(), planLookup = new Map(), metaMap = new Map();

  // 완제품 플랜트간 재고이전 대응: 코드 단위 기초재고 합산 맵(플랜트 무관)
  // — 오송 생산·판매인데 재고는 향남에 있는 케이스(9300770 등)에서 가용을 정확히 인식.
  const codeBaseQtyMap = new Map(), codeBaseAmtMap = new Map();
  inventoryRows.forEach((row) => {
    const code = cleanOptional(row.itemCode);
    const plant = cleanOptional(row.plant);
    if (!code || !plant) return;
    const key = itemPlantKey(code, plant);
    inventorySet.add(key);
    const cost = cleanNumber(row.standardCost), baseQty = cleanNumber(row.baseQty), baseAmt = cleanNumber(row.baseAmount);
    if (cost !== null && !costMap.has(key)) costMap.set(key, cost);
    baseQtyMap.set(key, (baseQtyMap.get(key) ?? 0) + (baseQty ?? 0));
    baseAmtMap.set(key, (baseAmtMap.get(key) ?? 0) + (baseAmt ?? 0));
    codeBaseQtyMap.set(code, (codeBaseQtyMap.get(code) ?? 0) + (baseQty ?? 0));
    codeBaseAmtMap.set(code, (codeBaseAmtMap.get(code) ?? 0) + (baseAmt ?? 0));
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

  // 코드별 계획(생산) 플랜트 수 — 완제품 코드단위 재고합산 시 다중 생산플랜트 이중계상 방지용
  const codePlanPlants = new Map();
  metaMap.forEach((m) => {
    if (!codePlanPlants.has(m.itemCode)) codePlanPlants.set(m.itemCode, new Set());
    codePlanPlants.get(m.itemCode).add(m.plant);
  });

  const sharedAlertSet = buildSharedAlertSet();
  const altBomSet      = buildAltBomSet();
  const priceMap       = buildSalesPriceMap();
  const salesCostMap   = buildSalesCostMap();
  const result = [...metaMap.values()].map((meta) => {
    const key = itemPlantKey(meta.itemCode, meta.plant);
    const master = masterMap.get(meta.itemCode);
    let standardCost = costMap.get(key) ?? null;
    // 기초재고 표준원가 미연결(0) 또는 재고 자체 미연결 시 매출_RAW 단위당원가로 대체
    if (standardCost === null || standardCost === 0) {
      const salesCost = salesCostMap.get(meta.itemCode);
      if (salesCost) standardCost = salesCost;
    }
    const unitPrice = priceMap.get(meta.itemCode) ?? null;
    // 재고 raw에 매칭 자체가 없으면 "미확인"이 아니라 "재고없음"(0)으로 확정 처리 — 판매계획 등 후속 계산이 막히지 않게 함
    // 완제품(9코드)이고 생산 플랜트가 1개면 코드단위 합산재고 사용(플랜트간 재고이전 대응). 다중 생산플랜트는 이중계상 방지 위해 플랜트별 유지.
    const _isFgSinglePlant = String(meta.itemCode).startsWith("9") && (codePlanPlants.get(meta.itemCode)?.size ?? 1) === 1;
    const baseQtyVal = _isFgSinglePlant ? (codeBaseQtyMap.get(meta.itemCode) ?? 0) : (baseQtyMap.get(key) ?? 0);
    const baseAmtVal = _isFgSinglePlant ? (codeBaseAmtMap.get(meta.itemCode) ?? 0) : (baseAmtMap.get(key) ?? 0);
    // 장부단가: 기초금액/기초수량 (재고평가 기준) → 없으면 표준원가
    const unitInvValue = (baseAmtVal && baseQtyVal) ? (baseAmtVal / baseQtyVal) : standardCost;
    const item = { ...meta,
      plantCode: cleanText(meta.plant, NEED_MASTER), plant: displayPlantName(meta.plant), businessUnit: cleanText(master?.businessUnit, NEED_MASTER),
      itemGroup: cleanText(master?.itemGroup, NEED_MASTER), standardCost, unitPrice, baseAmount: baseAmtVal, unitInvValue,
      hasCost: standardCost !== null,
      hasRevenue: unitPrice !== null && unitPrice > 0,
      hasInventory: inventorySet.has(key), baseQty: baseQtyVal,
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
      let supplyQty = hasPlanRow ? (cleanNumber(plan.supplyQty) ?? 0) : null;
      // 상품 입고(공급) 조정 override 반영 (조정 후 시나리오)
      if (hasPlanRow && _goodsAdj) {
        const gk = `${meta.itemCode}|${meta.plant}|${month}`;
        if (gk in _goodsAdj) supplyQty = _goodsAdj[gk];
      }
      const noSalesPlan = hasPlanRow && salesQty === 0;
      const salesPlanAmount = amountWithCost(salesQty, item);
      const salesRevenue    = amountWithPrice(salesQty, item); // 판매계획 매출(판가)
      let endingQty = null, endingAmount = null, endingRevenue = null, rtfQty = null, rtfAmount = null;
      let shortageQty = null, shortageAmount = null, lostSalesAmount = null, inventoryDays = null;
      let rtfRevenue = null, shortageRevenue = null;
      let salesAmount = null, status = STATUS.UNKNOWN, reason = "";
      let bomConstrained = false, planShortageQty = null;

      if (openingQty === null)      { reason = NEED_DATA; }
      else if (!hasPlanRow)         { reason = NEED_DATA; openingQty = null; }
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
        endingRevenue = amountWithPrice(endingQty, item);
        // 매출(판가) 기준 값 — 판매/RTF/매출차질 컬럼용
        rtfRevenue      = amountWithPrice(rtfQty, item);
        shortageRevenue = shortageQty > 0 ? amountWithPrice(shortageQty, item) : (item.hasRevenue ? 0 : null);
        salesAmount     = salesRevenue;      // "매출" 전용 컬럼 = 판매계획 × 판가
        lostSalesAmount = shortageRevenue;   // "매출차질예상" 컬럼 = 부족 × 판가
        inventoryDays = salesQty > 0 ? endingQty / (salesQty / monthDays(month)) : null;
        status = shortageQty > 0 ? STATUS.SHORTAGE : STATUS.OK;
        openingQty = endingQty;
        reason = noSalesPlan ? NO_PLAN : "";
      }
      return { month, salesQty, supplyQty, rtfQty, rtfAmount, endingQty, endingAmount, endingRevenue, shortageQty, shortageAmount, lostSalesAmount, inventoryDays, salesAmount, salesPlanAmount, salesRevenue, rtfRevenue, shortageRevenue, status, reason, noSalesPlan, bomConstrained, planShortageQty };
    });
    return item;
  }).filter((item) => allTypes || item.typeGroup === "상품" || item.typeGroup === "완제품");

  if (!allTypes && !_goodsAdj) {
    if (!_bomMap) {
      _rtfItemsCache    = result;
      _rtfItemsCacheKey = _getRtfCacheKey();
    } else {
      _rtfItemsBomRef   = _bomMap;
      _rtfItemsBomCache = result;
    }
  }
  return result;
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
    salesRevenue:    sumNullable(rows.map((r) => r.salesRevenue)),
    rtfAmount:       sumNullable(rows.map((r) => r.rtfAmount)),
    rtfRevenue:      sumNullable(rows.map((r) => r.rtfRevenue)),
    shortageAmount:  sumNullable(rows.map((r) => r.shortageAmount)),
    shortageRevenue: sumNullable(rows.map((r) => r.shortageRevenue)),
    lostSalesAmount: sumNullable(rows.map((r) => r.lostSalesAmount)),
    endingAmount:    sumNullable(rows.map((r) => r.endingAmount)),
    endingRevenue:   sumNullable(rows.map((r) => r.endingRevenue)),
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

// 품목군(및 하위 품목) 정렬용 — 판매계획(전체 기간 합계) 내림차순
// 당월(rtfMonths[0]) 판매계획 매출(판가 기준) — 품목군/품목 정렬 기준
function itemSalesTotal(item) {
  const ms0 = item.monthlyStatus && item.monthlyStatus[0];
  return ms0 && Number.isFinite(ms0.salesRevenue) ? ms0.salesRevenue : 0;
}
function uniqByPlanDesc(items, key) {
  const totals = new Map();
  items.forEach((i) => { const k = i[key]; totals.set(k, (totals.get(k) || 0) + itemSalesTotal(i)); });
  return uniq(items, key).sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0));
}
function sortItemsByPlanDesc(items) {
  return items.slice().sort((a, b) => itemSalesTotal(b) - itemSalesTotal(a));
}
function itemNodeId(groupId, item, index) {
  return `${groupId}|${item.itemCode}|${item.plant}|${index}`;
}

function buildHierarchy(items, mode) {
  const nodes = [];
  if (mode === "business") {
    nodes.push(makeNode("business|__total__", "", -1, "total", "사업부 총합계", items, { div:"", bu:"", plant:"", type:"", group:"", code:"" }));
    uniqByPlanDesc(items, "businessUnit").forEach((bu) => {
      const buItems = items.filter((i) => i.businessUnit === bu), buId = `b|${bu}`;
      nodes.push(makeNode(buId, "", 0, "group", `${bu} 계`, buItems, { div:"사업부", bu, plant:"", type:"", group:"", code:"" }));
      uniqByPlanDesc(buItems, "typeGroup").forEach((type) => {
        const typeItems = buItems.filter((i) => i.typeGroup === type), typeId = `${buId}|${type}`;
        nodes.push(makeNode(typeId, buId, 1, "group", `${type} 계`, typeItems, { div:"유형", bu, plant:"", type, group:"", code:"" }));
        uniqByPlanDesc(typeItems, "itemGroup").forEach((group) => {
          const groupItems = sortItemsByPlanDesc(typeItems.filter((i) => i.itemGroup === group)), groupId = `${typeId}|${group}`;
          nodes.push(makeNode(groupId, typeId, 2, "itemGroup", `${group} 계`, groupItems, { div:"품목군", bu, plant:"", type, group, code:"" }));
          groupItems.forEach((item, itemIndex) => nodes.push(makeNode(itemNodeId(groupId, item, itemIndex), groupId, 3, "item", item.itemName, [item],
            { div:"자재", bu:item.businessUnit, plant:item.plant, type:item.typeGroup, group:item.itemGroup, code:item.itemCode })));
        });
      });
    });
  } else if (mode === "plant") {
    nodes.push(makeNode("plant|__total__", "", -1, "total", "플랜트 총합계", items, { div:"", bu:"", plant:"", type:"", group:"", code:"" }));
    uniqByPlanDesc(items, "plant").forEach((plant) => {
      const plantItems = items.filter((i) => i.plant === plant), plantId = `p|${plant}`;
      nodes.push(makeNode(plantId, "", 0, "group", `${plant} 계`, plantItems, { div:"플랜트", bu:"", plant, type:"", group:"", code:"" }));
      uniqByPlanDesc(plantItems, "typeGroup").forEach((type) => {
        const typeItems = plantItems.filter((i) => i.typeGroup === type), typeId = `${plantId}|${type}`;
        nodes.push(makeNode(typeId, plantId, 1, "group", `${type} 계`, typeItems, { div:"유형", bu:"", plant, type, group:"", code:"" }));
        uniqByPlanDesc(typeItems, "itemGroup").forEach((group) => {
          const groupItems = sortItemsByPlanDesc(typeItems.filter((i) => i.itemGroup === group)), groupId = `${typeId}|${group}`;
          nodes.push(makeNode(groupId, typeId, 2, "itemGroup", `${group} 계`, groupItems, { div:"품목군", bu:"", plant, type, group, code:"" }));
          groupItems.forEach((item, itemIndex) => nodes.push(makeNode(itemNodeId(groupId, item, itemIndex), groupId, 3, "item", item.itemName, [item],
            { div:"자재", bu:item.businessUnit, plant:item.plant, type:item.typeGroup, group:item.itemGroup, code:item.itemCode })));
        });
      });
    });
  } else {
    nodes.push(makeNode("type|__total__", "", -1, "total", "유형별 총합계", items, { div:"", bu:"", plant:"", type:"", group:"", code:"" }));
    uniqByPlanDesc(items, "typeGroup").forEach((type) => {
      const typeItems = items.filter((i) => i.typeGroup === type), typeId = `t|${type}`;
      nodes.push(makeNode(typeId, "", 0, "group", `${type} 계`, typeItems, { div:"유형", bu:"", plant:"", type, group:"", code:"" }));
      uniqByPlanDesc(typeItems, "businessUnit").forEach((bu) => {
        const buItems = typeItems.filter((i) => i.businessUnit === bu), buId = `${typeId}|${bu}`;
        nodes.push(makeNode(buId, typeId, 1, "group", `${bu} 계`, buItems, { div:"사업부", bu, plant:"", type, group:"", code:"" }));
        uniqByPlanDesc(buItems, "plant").forEach((plant) => {
          const plantItems = buItems.filter((i) => i.plant === plant), plantId = `${buId}|${plant}`;
          nodes.push(makeNode(plantId, buId, 2, "group", `${plant} 계`, plantItems, { div:"플랜트", bu, plant, type, group:"", code:"" }));
          uniqByPlanDesc(plantItems, "itemGroup").forEach((group) => {
            const groupItems = sortItemsByPlanDesc(plantItems.filter((i) => i.itemGroup === group)), groupId = `${plantId}|${group}`;
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
    "기말재고":     (a) => state.rtfDisplayMode === "amount" ? a.endingAmount : state.rtfDisplayMode === "revenue" ? a.endingRevenue : a.endingQty,
    "재고일수":     (a) => a.inventoryDays,
  };
  if (colKey === "재고일수") {
    // 일수는 월별 합산이 의미 없음(비율 지표) → 값 있는 달의 평균으로 정렬
    const vals = getRtfMonths().map((_, i) => metricFn[colKey](aggregateMonth(node.items, i))).filter(Number.isFinite);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  }
  if (metricFn[colKey]) return sumNullable(getRtfMonths().map((_, i) => metricFn[colKey](aggregateMonth(node.items, i))));
  return null;
}

// 계층 전 레벨(사업부→유형→품목군→품목)을 각자의 부모 안에서 재귀 정렬
function sortHierarchyNodes(nodes, sectionId) {
  const s = rtfSortState[sectionId];
  const totalNode = nodes[0]; // kind === "total", always first
  const byParent = new Map();
  nodes.slice(1).forEach((n) => {
    const arr = byParent.get(n.parentId) || [];
    arr.push(n);
    byParent.set(n.parentId, arr);
  });
  // 기본 정렬(컬럼 미선택): 당월(첫 전망월=7월) 판매계획 금액 내림차순 — 표시 모드별(매출/원가/수량)
  const dm = state.rtfDisplayMode;
  const defaultVal = (n) => {
    const a = aggregateMonth(n.items, 0);
    return dm === "revenue" ? a.salesRevenue : dm === "amount" ? a.salesPlanAmount : a.salesQty;
  };
  const cmp = (s && s.colKey)
    ? (a, b) => compareForSort(getSortValue(a, s.colKey), getSortValue(b, s.colKey), s.dir)
    : (a, b) => compareForSort(defaultVal(a), defaultVal(b), "desc");
  function walk(parentId) {
    const children = (byParent.get(parentId) || []).slice().sort(cmp);
    const out = [];
    children.forEach((n) => { out.push(n); out.push(...walk(n.id)); });
    return out;
  }
  return [totalNode, ...walk("")];
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
      { key: firstKey, label: firstLabel, width: 130, align: "center", isFirst: true },
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
      { key: firstKey, label: firstLabel, width: 130, align: "center", isFirst: true },
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

// 매트릭스 셀 축약 포맷 (좁은 셀 잘림 방지) — 금액: 100억↑ 정수·미만 소수1 / 수량: 만 단위
function fmtMoneyC(won) {
  if (!Number.isFinite(won)) return NEED_DATA;
  var eok = won / 1e8;
  return eok.toLocaleString("ko-KR", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + "억";
}
function fmtQtyC(qty) {
  if (!Number.isFinite(qty)) return NEED_DATA;
  if (Math.abs(qty) >= 10000)
    return (qty / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 1, minimumFractionDigits: 0 }) + "만";
  return formatNumber(qty);
}

// 표시 모드: qty(수량) / amount(원가=×표준원가) / revenue(매출=×판가)
function formatDisplayQtyMoney(qtyValue, costValue, revenueValue, noPlan = false) {
  if (noPlan) return NO_PLAN;
  if (state.rtfDisplayMode === "amount")  return Number.isFinite(costValue)    ? fmtMoneyC(costValue)    : NEED_DATA;
  if (state.rtfDisplayMode === "revenue") return Number.isFinite(revenueValue) ? fmtMoneyC(revenueValue) : NEED_DATA;
  return Number.isFinite(qtyValue) ? fmtQtyC(qtyValue) : NEED_DATA;
}

// 기말재고: 원가모드=표준원가, 매출모드=판가 환산
function formatEnding(row) {
  if (state.rtfDisplayMode === "qty")      return Number.isFinite(row.endingQty) ? fmtQtyC(row.endingQty) : NEED_DATA;
  if (state.rtfDisplayMode === "revenue")  return Number.isFinite(row.endingRevenue) ? fmtMoneyC(row.endingRevenue) : NEED_DATA;
  return Number.isFinite(row.endingAmount) ? fmtMoneyC(row.endingAmount) : NEED_DATA;
}

function formatBaseForNode(node, compressed) {
  // 단일 품목 행인데 재고 raw에 매칭 자체가 없으면(0으로 확정 처리됐지만) "재고없음"으로 명시
  if (node.items.length === 1 && !node.items[0].hasInventory) return "재고없음";
  const qty = sumNullable(node.items.map((i) => i.baseQty));
  if (state.rtfDisplayMode === "qty") {
    if (!Number.isFinite(qty)) return compressed ? SHORT_TEXT[NEED_DATA] : NEED_DATA;
    return fmtQtyC(qty);
  }
  const useRevenue = state.rtfDisplayMode === "revenue";
  // 품목 하나가 미연결이어도 전체를 막지 않고, 연결된 품목만 합산(수량모드와 동일 원칙)
  const amount = sumNullable(node.items.map((i) => {
    const hasUnit = useRevenue ? i.hasRevenue : i.hasCost;
    const unit    = useRevenue ? i.unitPrice  : i.standardCost;
    return (hasUnit && Number.isFinite(i.baseQty)) ? i.baseQty * unit : null;
  }));
  return Number.isFinite(amount) ? fmtMoneyC(amount) : (compressed ? SHORT_TEXT[NEED_DATA] : NEED_DATA);
}

// ── 드릴다운 컨텍스트 빌더 ───────────────────────────────────────────────────
function buildCellDrillCtx(node, item, month, monthRow) {
  // 부족 존재 여부는 표시 모드와 무관하게 수량 기준으로 판정 (원가 미연결이어도 드릴 가능)
  const hasS = Number.isFinite(monthRow.shortageQty) && monthRow.shortageQty > 0;
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
function noteCls(val) {
  return (val === NEED_DATA || val === SHORT_TEXT[NEED_DATA] || val === "재고없음") ? " rtf-cell-note-sm" : "";
}
function renderMetricCell(row, metric, metricIndex, compressed, drillCtx, adjInfo) {
  const mb     = metricIndex === 0 ? " rtf-month-start" : "";

  if (metric === "판매계획") {
    const raw  = formatDisplayQtyMoney(row.salesQty, row.salesPlanAmount, row.salesRevenue, false);
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-cell-right${mb}${noteCls(disp)}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "RTF") {
    const raw  = formatDisplayQtyMoney(row.rtfQty, row.rtfAmount, row.rtfRevenue, false);
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-rtf-cell rtf-cell-right${mb}${noteCls(disp)}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "Shortage") {
    const mode  = state.rtfDisplayMode;
    const shVal = mode === "amount" ? row.shortageAmount : mode === "revenue" ? row.shortageRevenue : row.shortageQty;
    const hasS  = Number.isFinite(shVal) && shVal > 0;
    const raw = hasS ? (mode === "qty" ? fmtQtyC(shVal) : fmtMoneyC(shVal)) : "-";
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
      const isMoney = mode === "amount" || mode === "revenue";
      const fmtC = isMoney ? fmtMoneyC : fmtQtyC; // 매출/원가=억(소수1), 수량=만/정수
      const thresh = isMoney ? 5e6 : 0.5;         // 매출·원가: 0.05억, 수량: 0.5개
      if (delta < -thresh) {
        adjBadge = `<span class="rtf-adj-badge rtf-adj-improved" title="조정 전 ${escapeHtml(fmtC(adjInfo.baseSh))} → 조정 후 ${escapeHtml(fmtC(adjInfo.adjSh))}">▼${escapeHtml(fmtC(-delta))}</span>`;
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
    const raw = Number.isFinite(row.salesAmount) ? fmtMoneyC(row.salesAmount) : NEED_DATA;
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-muted-metric rtf-cell-right${mb}${noteCls(disp)}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "매출차질예상") {
    const raw = Number.isFinite(row.lostSalesAmount) ? fmtMoneyC(row.lostSalesAmount) : NEED_DATA;
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-muted-metric rtf-cell-right${mb}${noteCls(disp)}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "기말재고") {
    const val = formatEnding(row);
    return `<td class="rtf-metric-cell rtf-muted-metric rtf-cell-right${mb}${noteCls(val)}">${escapeHtml(val)}</td>`;
  }
  if (metric === "재고일수") {
    const val = Number.isFinite(row.inventoryDays) ? `${Math.round(row.inventoryDays)}일` : NEED_DATA;
    return `<td class="rtf-metric-cell rtf-muted-metric rtf-cell-right${mb}${noteCls(val)}">${escapeHtml(val)}</td>`;
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
        var _pickSh = function(a) {
          return state.rtfDisplayMode === "amount" ? a.shortageAmount
               : state.rtfDisplayMode === "revenue" ? a.shortageRevenue : a.shortageQty;
        };
        adjInfo = { baseSh: _pickSh(baseAgg), adjSh: _pickSh(monthRow) };
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
    const isNoteVal = col.isBase && (value === NEED_DATA || value === SHORT_TEXT[NEED_DATA] || value === "재고없음");
    const extraCls  = (col.isName ? " rtf-col-name" : col.isLast ? " rtf-col-last-sticky" : col.isFirst ? " rtf-col-firstlabel" : "") + (isNoteVal ? " rtf-cell-note-sm" : "");
    const titleAttr = (col.isName || col.isFirst) ? ` title="${escapeHtml(node.label)}"` : "";
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
    "<span>조정내역 (" + keys.length + "건)</span><span id=\"rtfAdjPanelArrow\">▶</span></div>" +
    "<div class=\"rtf-adj-panel-body\" id=\"rtfAdjPanelBody\" hidden>" +
    "<table class=\"rtf-adj-table\"><thead><tr>" +
    "<th>자재코드</th><th>자재명</th><th>월</th><th>원래입고</th><th>조정후</th><th>변동</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table>" +
    "</div></div>";
}

// ── 하단 재고금액·재고일수 요약 바 ───────────────────────────────────────────
// ── 전체재고 앵커 (결산 최신 실적월 총재고·월출고, 원 단위) ────────────────────
// 결산 actuals_monthly(plant="전체") 유형별 행 합계 = 회사 전체재고 (대표 인식 숫자와 일치)
var _actualsAnchorCache = null;
var _actualsAnchorComputed = false;
function getActualsAnchor() {
  if (_actualsAnchorComputed) return _actualsAnchorCache;
  _actualsAnchorComputed = true;
  var rows = (state.mappedData.actuals_monthly || []).filter(function(r) { return r.plant === "전체"; });
  var byMonth = {};
  rows.forEach(function(r) {
    if (!byMonth[r.month]) byMonth[r.month] = { inv: 0, out: 0, outFgSp: 0, outWip: 0 };
    var b = byMonth[r.month];
    if (Number.isFinite(r.invAmt))   b.inv += r.invAmt;
    if (Number.isFinite(r.salesAmt)) {
      b.out += r.salesAmt;
      if (r.type === "완제품" || r.type === "상품") b.outFgSp += r.salesAmt;
      if (r.type === "재공품")                      b.outWip  += r.salesAmt;
    }
  });
  var ms = Object.keys(byMonth).filter(function(m) { return byMonth[m].inv !== 0; }).sort();
  if (!ms.length) { _actualsAnchorCache = null; return null; }
  var last = ms[ms.length - 1];
  // 앵커 연도 YTD 출고 누계 (관리기준 누적 분모의 실적 구간)
  var year = last.slice(0, 4);
  var cumOut = 0, ytdFgSp = 0, ytdWip = 0;
  ms.forEach(function(m) {
    if (m.slice(0, 4) !== year || m > last) return;
    cumOut += byMonth[m].out; ytdFgSp += byMonth[m].outFgSp; ytdWip += byMonth[m].outWip;
  });
  // 결산 값은 억 단위 → 원으로 환산
  _actualsAnchorCache = {
    month:         last,
    totalInvWon:   byMonth[last].inv * 1e8,
    monthlyOutWon: byMonth[last].out * 1e8,
    cumOutAllWon:  cumOut  * 1e8, // 전체출고 YTD (전 유형)
    ytdOutFgSpWon: ytdFgSp * 1e8, // 완제품+상품 출고 YTD
    ytdOutWipWon:  ytdWip  * 1e8, // 재공품 출고 YTD (BOM 추정 불가분 → 보정용)
  };
  return _actualsAnchorCache;
}

// 원부자재 롤포워드 델타(원) — 앵커(기초, 완제품 공급계획 BOM전개 소요 vs 자재 자체 입고계획)
// 대비, BOM연결+재고연결+단위OK인 "usable" 자재만 반영. 소요 0(불용재고·계획누락)인 자재는
// 소비·입고 둘 다 0이라 델타도 0 — 앵커 고정과 결과가 같아 왜곡 없음(그래서 커버리지 밖이어도 안전).
// 렌더 경계(_renderEpoch) 메모이즈 — 3단(원래/RTF조정후/감축후) 시나리오가 월별로 반복 조회해도
// (fgAdj,matAdj) 조합별로 한 렌더당 1회만 calcMatFlowRows 계산.
var _matRollDeltaMemo = new Map(), _matRollDeltaMemoEpoch = -1;
function computeMatRollforwardDeltas(months, fgAdj, matAdj) {
  if (typeof calcMatFlowRows !== "function") return null;
  if (_matRollDeltaMemoEpoch !== _renderEpoch) { _matRollDeltaMemo.clear(); _matRollDeltaMemoEpoch = _renderEpoch; }
  var sig = (fgAdj ? JSON.stringify(fgAdj) : "") + "||" + (matAdj ? JSON.stringify(matAdj) : "");
  if (_matRollDeltaMemo.has(sig)) return _matRollDeltaMemo.get(sig);
  var rows = calcMatFlowRows(fgAdj || null, matAdj || null);
  var result = null;
  if (rows) {
    result = months.map(function(_, mi) {
      var d = 0;
      rows.forEach(function(r) {
        if (!Number.isFinite(r.flow.unitVal)) return;
        d += (Math.max(0, r.ending[mi]) - Math.max(0, r.flow.baseQty)) * r.flow.unitVal;
      });
      return d;
    });
  }
  _matRollDeltaMemo.set(sig, result);
  return result;
}

// 전체재고(월) = 결산 총재고 앵커 + 완제품·상품 재고 변동분(장부단가, opening 대비)
//              + 미착품·평가충당금 전망 변동 (결산 시트에 값 있으면, 없으면 앵커월 유지)
//              + 원부자재 롤포워드 변동(usable 자재만, matScenario={fg,mat} 없으면 무조정=원래계획)
function totalInvAmountWon(items, mi, anchor, matScenario) {
  var delta = 0;
  items.forEach(function(it) {
    if (it.typeGroup !== "완제품" && it.typeGroup !== "상품") return;
    var ms = it.monthlyStatus[mi];
    if (!ms || !Number.isFinite(ms.endingQty)) return;
    var uv = it.unitInvValue;
    if (!Number.isFinite(uv)) return;
    var base = Number.isFinite(it.baseQty) ? it.baseQty : 0;
    delta += (ms.endingQty - base) * uv;
  });
  var meta = getActualsMeta();
  var am = meta[anchor.month], mm = meta[getRtfMonths()[mi]];
  if (am && mm) {
    if (Number.isFinite(mm.michakInv) && Number.isFinite(am.michakInv))
      delta += (mm.michakInv - am.michakInv) * 1e8;
    if (Number.isFinite(mm.allowanceInv) && Number.isFinite(am.allowanceInv))
      delta += (mm.allowanceInv - am.allowanceInv) * 1e8;
  }
  // 나보타(비점검) 재고 변동 — 앵커월 값은 이미 결산 총재고에 포함 → 델타만 반영(이중계상 없음)
  var nb = getNabotaInv();
  var nbA = nb[anchor.month], nbC = nb[getRtfMonths()[mi]];
  if (nbA && nbC && Number.isFinite(nbA.invAmt) && Number.isFinite(nbC.invAmt))
    delta += (nbC.invAmt - nbA.invAmt) * 1e8;
  var matDeltas = computeMatRollforwardDeltas(getRtfMonths(), matScenario && matScenario.fg, matScenario && matScenario.mat);
  if (matDeltas && Number.isFinite(matDeltas[mi])) delta += matDeltas[mi];
  return anchor.totalInvWon + delta;
}

// ── 나보타(비점검) 월별 집계 — 총재고 델타·각주용 ─────────────────────────────
var _nabotaInvCache = null;
function getNabotaInv() {
  if (_nabotaInvCache) return _nabotaInvCache;
  var map = {};
  (state.mappedData.nabota_monthly || []).forEach(function(r) { map[r.month] = r; });
  _nabotaInvCache = map;
  return map;
}
// 앵커월(최신 실적) 기준 나보타 각주 문구 — 총재고 KPI 하단(전체재고일 때만)
function nabotaKpiNote() {
  var anchor = getActualsAnchor();
  if (!anchor) return "";
  var nb = getNabotaInv(), cur = nb[anchor.month];
  if (!cur || !Number.isFinite(cur.invAmt)) return "";
  var pm = anchor.month, py = +pm.slice(0, 4), pmo = +pm.slice(5, 7) - 1;
  if (pmo < 1) { pmo = 12; py--; }
  var prev = nb[py + "-" + String(pmo).padStart(2, "0")];
  var mom = (prev && Number.isFinite(prev.invAmt)) ? cur.invAmt - prev.invAmt : null;
  var momTxt = (mom === null) ? "" :
    " (전월 " + (mom >= 0 ? "+" : "−") + Math.abs(Math.round(mom)) + "억)";
  return "<div class='rtf-nabota-note' style='margin-top:5px;font-size:12.5px;color:#6b7280;'>" +
    "※ 나보타 재고 약 " + Math.round(cur.invAmt) + "억" + momTxt +
    " · 별도 관리·비점검 (총재고에 포함)</div>";
}

// 나보타 환산 계수 — 매출_RAW 나보타(1220) 평균 판가·원가율 (매출액→수량·원가 역산용)
var _nabotaFactorsCache; // undefined=미계산, null=산출불가
function getNabotaSalesFactors() {
  if (_nabotaFactorsCache !== undefined) return _nabotaFactorsCache;
  var net = 0, qty = 0, cost = 0;
  (state.mappedData.sales_actual || []).forEach(function(r) {
    var p = String(r.plant == null ? "" : r.plant);
    if (p !== "1220" && p.indexOf("나보타") < 0) return;
    if (Number.isFinite(r.netSales)) net += r.netSales;
    if (Number.isFinite(r.paQty))    qty += r.paQty;
    if (Number.isFinite(r.costAmt))  cost += r.costAmt;
  });
  _nabotaFactorsCache = (net > 0 && qty > 0)
    ? { price: net / qty, costRatio: cost > 0 ? cost / net : 0.15 } // 판가(원/개), 원가율
    : null;
  return _nabotaFactorsCache;
}

// 나보타(비점검) 합성 매트릭스 행 — RTF판정 매트릭스에만 주입(총계 합산·행 표시).
// PSI 그대로: 공급계획=입고금액(제품만) · 기말재고=재고금액(제품만) — 나보타_RAW 실측(원가 기준).
// 판매계획(매출모드)은 나보타_RAW "매출액" 행(사용자 직접 입력, 미래월 포함)을 그대로 반영 — 원가 역산 아님.
// (예전엔 매출_RAW 유래 salesAmt를 썼다가 출고 시점과 안 맞아 폐기했으나, 지금은 나보타_RAW 자체에 사용자가 매출액을 직접 기입함 — 그 값을 신뢰)
// 매출액 결측월(과거 1~2월 등)만 "실측 원가율"로 원가→매출 환산 근사. 재고(기초·기말) 매출환산도 결측 시 동일 근사.
function buildNabotaMatrixItem(months) {
  var nb = getNabotaInv();
  if (!Object.keys(nb).length) return null;
  var f = getNabotaSalesFactors(); // 판가(f.price) — 수량 환산 앵커로만 사용
  // 실측 제품 원가율 = Σ출고금액(제품만) / Σ매출액 (있는 달만 집계) — 매출_RAW 원가율보다 정확한 실측 대체값
  var sumOut = 0, sumSales = 0;
  Object.keys(nb).forEach(function(m) {
    var r = nb[m];
    if (Number.isFinite(r.outProdAmt) && Number.isFinite(r.salesAmt) && r.salesAmt > 0) {
      sumOut += r.outProdAmt; sumSales += r.salesAmt;
    }
  });
  var realCostRatio = sumSales > 0 ? sumOut / sumSales : (f ? f.costRatio : null);
  var avgUnitCost = (f && f.price > 0 && Number.isFinite(realCostRatio)) ? f.price * realCostRatio : null;

  // 기초재고 = 첫 RTF월 직전월(없으면 첫월) 나보타 재고금액(제품만, 실측)
  var m0 = months[0], py = +m0.slice(0, 4), pmo = +m0.slice(5, 7) - 1;
  if (pmo < 1) { pmo = 12; py--; }
  var openM = py + "-" + String(pmo).padStart(2, "0");
  var openWon = (nb[openM] && Number.isFinite(nb[openM].invProdAmt)) ? nb[openM].invProdAmt * 1e8
              : (nb[m0] && Number.isFinite(nb[m0].invProdAmt) ? nb[m0].invProdAmt * 1e8 : null);
  // baseQty를 openWon÷avgUnitCost로 잡으면 baseQty×avgUnitCost=openWon(실측 기초금액)이 원가모드에서 정확히 재현됨
  var baseQty = (avgUnitCost && Number.isFinite(openWon)) ? openWon / avgUnitCost : null;
  var ms = months.map(function(m) {
    var r = nb[m] || {};
    var cost   = Number.isFinite(r.outProdAmt)   ? r.outProdAmt * 1e8   : null; // 판매계획·RTF(원가) = 출고금액(제품만)
    var supply = Number.isFinite(r.intakeProdAmt) ? r.intakeProdAmt * 1e8 : null; // 공급계획 = 입고금액(제품만)
    var endWon = Number.isFinite(r.invProdAmt)    ? r.invProdAmt * 1e8    : null; // 기말재고(원가) = 재고금액(제품만)
    var revenue    = Number.isFinite(r.salesAmt) ? r.salesAmt * 1e8 // 판매계획(매출) = 나보타_RAW 매출액 행 직접 반영
                   : (Number.isFinite(cost) && realCostRatio > 0) ? cost / realCostRatio : null; // 결측월만 원가 환산 근사
    var endRev     = (Number.isFinite(endWon) && realCostRatio > 0) ? endWon / realCostRatio : null;
    var qty        = (Number.isFinite(cost)   && avgUnitCost > 0)  ? cost   / avgUnitCost   : null; // 수량 근사
    var supplyQty  = (Number.isFinite(supply) && avgUnitCost > 0)  ? supply / avgUnitCost   : null;
    return {
      month: m, salesQty: qty, supplyQty: supplyQty,
      rtfQty: qty, rtfAmount: cost, rtfRevenue: revenue,
      endingQty: null, endingAmount: endWon, endingRevenue: endRev,
      shortageQty: 0, shortageAmount: 0, shortageRevenue: 0, lostSalesAmount: 0,
      inventoryDays: null,
      salesAmount: revenue, salesPlanAmount: cost, salesRevenue: revenue,
      status: STATUS.OK, reason: "", noSalesPlan: false, bomConstrained: false, planShortageQty: 0,
      isNabota: true,
    };
  });
  return {
    itemCode: "나보타", itemName: "나보타",
    plantCode: "1220", plant: "나보타", businessUnit: "나보타",
    itemType: "완제품", typeGroup: "완제품", itemGroup: "나보타",
    baseQty: baseQty, standardCost: avgUnitCost, unitPrice: (f && f.price > 0) ? f.price : null,
    hasCost: Number.isFinite(baseQty) && Number.isFinite(avgUnitCost),
    hasInventory: true, hasRevenue: !!(f && f.price > 0),
    isNabota: true, monthlyStatus: ms,
  };
}

// ── 판매 총계(나보타 비점검 포함) 스트립 — RTF 매트릭스 상단 (B안) ─────────────
// 매출·원가 모드: 점검 판매총계 + 나보타 완결블록. 수량 모드: 나보타 제외(각주).
// 나보타는 판매계획이 없어 매트릭스엔 안 들어감 → 총계만 별도 명시(이중계상 없음).
function renderNabotaSalesStrip(items, months) {
  var nb = getNabotaInv();
  if (!Object.keys(nb).length) return "";
  var dm = state.rtfDisplayMode;
  if (dm === "qty") {
    return "<div class='rtf-nabota-strip' style='margin:10px 0;padding:8px 12px;border-left:3px solid #94a3b8;background:rgba(148,163,184,.09);font-size:13px;color:#475569;border-radius:4px;'>" +
      "<b>판매 총계(수량)</b> — 나보타(비점검)는 수량 데이터가 없어 <b>제외</b>됩니다. 매출·원가 기준에서만 통으로 반영." +
      "</div>";
  }
  function nbVal(m) {
    var r = nb[m]; if (!r) return null;
    var v = (dm === "revenue") ? r.salesAmt : r.outProdAmt;
    return Number.isFinite(v) ? v * 1e8 : null;
  }
  if (!months.some(function(m) { return Number.isFinite(nbVal(m)); })) return "";
  var modeLabel = (dm === "revenue") ? "매출" : "원가";
  var cells = months.map(function(m, mi) {
    var agg = aggregateMonth(items, mi);
    var base = (dm === "revenue") ? agg.salesRevenue : agg.salesPlanAmount;
    if (!Number.isFinite(base)) base = 0;
    var nbv = nbVal(m);
    var total = base + (Number.isFinite(nbv) ? nbv : 0);
    return "<span style='display:inline-block;margin-right:16px;white-space:nowrap;'>" +
      escapeHtml(monthLabel(m)) + " <b style='color:#0f172a;'>" + escapeHtml(formatMoney(total)) + "</b></span>";
  }).join("");
  var agg0 = aggregateMonth(items, 0);
  var base0 = (dm === "revenue") ? agg0.salesRevenue : agg0.salesPlanAmount;
  var nb0 = nbVal(months[0]);
  var note = (Number.isFinite(base0) && Number.isFinite(nb0))
    ? "└ " + escapeHtml(monthLabel(months[0])) + " = 점검 " + escapeHtml(formatMoney(base0)) +
      " + 나보타 " + escapeHtml(formatMoney(nb0)) + " · 나보타는 RTF 대응 완료로 통 반영(비점검)"
    : "";
  return "<div class='rtf-nabota-strip' style='margin:10px 0;padding:9px 13px;border-left:3px solid #2563eb;background:rgba(37,99,235,.06);border-radius:4px;overflow-x:auto;'>" +
    "<div style='font-size:12.5px;color:#2563eb;font-weight:700;margin-bottom:4px;'>판매 총계 (나보타 비점검 포함) · " + modeLabel + " 기준</div>" +
    "<div style='font-size:14px;color:#0f172a;'>" + cells + "</div>" +
    (note ? "<div style='font-size:12px;color:#64748b;margin-top:4px;'>" + note + "</div>" : "") +
    "</div>";
}

// ── 결산 메타 (매출원가 누적 + 미착품·평가충당금 전망, 억 단위) ────────────────
var _actualsMetaCache = null;
function getActualsMeta() {
  if (_actualsMetaCache) return _actualsMetaCache;
  var map = {};
  (state.mappedData.actuals_meta || []).forEach(function(r) { map[r.month] = r; });
  _actualsMetaCache = map;
  return map;
}

// 월별 매출원가 추정 (원) = 완제품·상품 충족판매수량(rtfQty) × 장부단가
// RTF 증량·상품입고 조정 시 rtfQty가 변해 매출원가 누적(분모)에도 자동 반영됨
var _cogsMemo = new WeakMap(); // items 배열별 월 캐시 (같은 렌더 내 반복 호출 절약)
function estMonthCogsWon(items, mi) {
  var arr = _cogsMemo.get(items);
  if (!arr) { arr = []; _cogsMemo.set(items, arr); }
  if (arr[mi] !== undefined) return arr[mi];
  var sum = 0;
  items.forEach(function(it) {
    if (it.typeGroup !== "완제품" && it.typeGroup !== "상품") return;
    var ms = it.monthlyStatus[mi];
    if (!ms) return;
    var qty = Number.isFinite(ms.rtfQty) ? ms.rtfQty
            : (Number.isFinite(ms.salesQty) ? ms.salesQty : null);
    if (!Number.isFinite(qty) || !Number.isFinite(it.unitInvValue)) return;
    sum += qty * it.unitInvValue;
  });
  arr[mi] = sum;
  return sum;
}

// 월별 전체출고 추정 (원) — 관리기준 누적 분모용
// · BOM 전개 완료: 제상품 출고 + 자재류(원료·자재·반제품) 실적 월평균 × BOM 단계투입 월별 패턴
//                  + 재공품 실적 월평균
//   (BOM 단가는 기초재고 기반이라 재고 0 자재가 누락 → 절대값 대신 월별 패턴만 쓰고
//    스케일은 결산 실적 YTD 월평균에 앵커)
// · BOM 전개 전:   제상품 출고 × 실적 비율(전체출고 YTD ÷ 제상품출고 YTD) 폴백
function estMonthMgmtOutWon(items, mi, anchor) {
  var fgSp = estMonthCogsWon(items, mi);
  var stageMap = (typeof BOM_STATUS !== "undefined" && state.bomStatus === BOM_STATUS.DONE &&
                  state.bomResult && state.bomResult.stageOutByMonth) ? state.bomResult.stageOutByMonth : null;
  var anchorMonths = Number(anchor.month.slice(5, 7)); // 앵커 연도 경과 월수
  var matYtdWon = anchor.cumOutAllWon - anchor.ytdOutFgSpWon - anchor.ytdOutWipWon; // 자재류 출고 YTD
  if (stageMap && anchorMonths > 0 && matYtdWon > 0) {
    var months = getRtfMonths();
    var sum = 0, cnt = 0;
    months.forEach(function(m2) {
      var v = stageMap[m2];
      if (Number.isFinite(v) && v > 0) { sum += v; cnt++; }
    });
    if (sum > 0) {
      var stageAvg  = sum / cnt;
      var matAvgWon = matYtdWon / anchorMonths;
      var wipAvgWon = anchor.ytdOutWipWon / anchorMonths;
      var stage     = stageMap[months[mi]] || 0;
      return fgSp + matAvgWon * (stage / stageAvg) + wipAvgWon;
    }
  }
  var rs = anchor.ytdOutFgSpWon > 0 ? anchor.cumOutAllWon / anchor.ytdOutFgSpWon : 1;
  return fgSp * rs;
}

// ── 재고일수(공시기준) = 재고금액 × 경과일수(월수×30) ÷ 매출원가(누적) ─────────
// · 재고금액: 전체재고(결산 앵커+완제품·상품 변동) + 미착품·평가충당금 전망 반영
//   (전망값이 결산 시트에 없으면 앵커월 값 유지)
// · 매출원가(누적): 결산 실적월까지는 결산값, 이후는 월별 추정 매출원가를 누적
//   (연도가 바뀌면 누적 리셋 — 회계연도 기준)
// · 검증: 26.5월 = 2,531억 × 150일 ÷ 2,943.4억 = 129.0일 (결산 정답지 일치)
function rtfDisclosureDays(items, mi, matScenario) {
  var anchor = getActualsAnchor();
  if (!anchor) return null;
  var meta = getActualsMeta();
  var anchorMeta = meta[anchor.month];
  if (!anchorMeta || !Number.isFinite(anchorMeta.cumCogs)) return null;

  var months = getRtfMonths();
  var m = months[mi];

  // 분자: 재고금액 (미착품·평가충당금 전망·원부자재 롤포워드는 totalInvAmountWon에서 공통 반영)
  var amt = totalInvAmountWon(items, mi, anchor, matScenario);

  // 분모: 매출원가(누적, 원)
  var mYear = m.slice(0, 4);
  var cum = (mYear === anchor.month.slice(0, 4)) ? anchorMeta.cumCogs * 1e8 : 0;
  for (var k = 0; k <= mi; k++) {
    var km = months[k];
    if (km <= anchor.month) continue;       // 실적월은 결산 누적에 이미 포함
    if (km.slice(0, 4) !== mYear) continue; // 누적은 해당 연도 내에서만
    cum += estMonthCogsWon(items, k);
  }
  if (!(cum > 0)) return null;

  var elapsed = Number(m.slice(5, 7)) * 30; // 경과일수 = 월수 × 30
  return amt * elapsed / cum;
}

// ── 3시나리오 계산 (현재 → RTF조정후 → 감축후) — 과잉감축 배너·3단 띠 공용 ────
// 렌더 경계 메모이즈 — computeScenarioItemSets는 한 렌더 안에서 배너·AI진단 등 여러 곳이
// 같은 상태로 반복 호출한다(각 호출 = RTF 전체 재계산). 렌더 토큰이 같으면 결과 재사용.
// 상태는 조정 핸들러가 바꾼 뒤 반드시 render()를 호출하므로(토큰 증가) 낡은 값이 나올 수 없다.
var _renderEpoch = 0;
var _scenMemo = null, _scenMemoEpoch = -1, _scenMemoSig = null;
function bumpRenderEpoch() { _renderEpoch++; }

// 시나리오 입력 서명 — 조정 4종의 내용이 같으면 렌더(탭 전환)가 바뀌어도 재계산 불필요.
// 원천 데이터 교체·BOM 재전개는 invalidateRtfCache가 _scenMemo를 직접 비우므로 서명에 불포함.
function _scenInputSig() {
  return JSON.stringify([state.matSimAdj || {}, state.goodsSupplyAdj || {},
    state.fgProdAdj || {}, state.excessAdj || {}]) + "|" + (state.bomStatus || "");
}

function computeScenarioItemSets() {
  if (_scenMemo && _scenMemoEpoch === _renderEpoch) return _scenMemo;
  var _sig = _scenInputSig();
  if (_scenMemo && _scenMemoSig === _sig) { _scenMemoEpoch = _renderEpoch; return _scenMemo; }
  var hasRtfAdj = Object.keys(state.matSimAdj || {}).length > 0 ||
                  Object.keys(state.goodsSupplyAdj || {}).length > 0 ||
                  hasFgProdAdj();
  var hasExcess = Object.keys(state.excessAdj || {}).length > 0;
  var bomDone   = typeof BOM_STATUS !== "undefined" && state.bomStatus === BOM_STATUS.DONE &&
                  typeof buildBomMaxProducibleMap === "function";
  var baseBom   = bomDone ? buildBomMaxProducibleMap({}) : null;
  var adjBom    = (bomDone && (Object.keys(state.matSimAdj || {}).length > 0 || hasFgProdAdj()))
    ? buildBomMaxProducibleMap(state.matSimAdj, state.fgProdAdj) : baseBom;
  var base   = computeRtfItems(baseBom);
  var rtfAdj = hasRtfAdj ? computeRtfItems(adjBom, false, rtfSupplyAdjAll()) : base;
  // 감축후 = RTF조정 위에 감축 공급 override (같은 키는 감축이 우선)
  var finalItems = hasExcess
    ? computeRtfItems(adjBom, false, rtfSupplyAdjAll(state.excessAdj || {}))
    : rtfAdj;
  _scenMemo = { base: base, rtfAdj: rtfAdj, final: finalItems, hasRtfAdj: hasRtfAdj, hasExcess: hasExcess };
  _scenMemoEpoch = _renderEpoch;
  _scenMemoSig   = _sig;
  return _scenMemo;
}

// ── 3단 헤드라인(현재→RTF조정후→감축후) — 회의안건 상단 띠 공용 계산 ─────────
// 원부자재는 3단 전부 실제 롤포워드(완제품 공급계획 BOM전개 소요 vs 자재 자체 입고계획) 반영
// — totalInvAmountWon이 matScenario로 처리.
// rtf/fin은 해당 조정이 없으면 null → 화면에서 "확정 전" 대기 카드로 점진 공개
//
// basis: 기준월을 고른다.
//   "first" → 전망 첫 달(7월). 조정이 가장 먼저 닿는 달이라 효과가 즉시 보인다.
//   "last" / 생략 → 연말(12월, 없으면 마지막 계획월). 연간 목표 대비 결산용.
// 화면마다 다른 달을 쓰면 "왜 숫자가 다르냐"가 되므로, 쓰는 쪽에서 명시적으로 넘긴다.
function computeHeadlineTriple(basis) {
  var months = getRtfMonths();
  if (!months.length) return null;
  var mi;
  if (basis === "first") {
    mi = 0;
  } else {
    mi = months.length - 1;
    for (var i = months.length - 1; i >= 0; i--) {
      if (months[i].slice(5, 7) === "12") { mi = i; break; }
    }
  }
  var sc = computeScenarioItemSets();
  // 자재 시나리오: 원래=무조정 / RTF조정후=matSimAdj·fgProdAdj / 감축후=+excessAdj·matExcessAdj(우선)
  var matScenRtf   = { fg: state.fgProdAdj, mat: state.matSimAdj };
  var matScenFinal = {
    fg:  Object.assign({}, state.fgProdAdj  || {}, state.excessAdj     || {}),
    mat: Object.assign({}, state.matSimAdj  || {}, state.matExcessAdj  || {}),
  };

  // 품절 품목 수 = 계획 구간 내 한 달이라도 공급부족인 품목
  function shortCount(items) {
    var n = 0;
    items.forEach(function(it) {
      var arr = it.monthlyStatus || [];
      for (var k = 0; k < arr.length; k++) {
        if (arr[k] && arr[k].status === STATUS.SHORTAGE) { n++; return; }
      }
    });
    return n;
  }
  function pack(items, matScen) {
    var inv  = rtfHeadlineInv(items, mi, matScen);
    var disc = rtfDisclosureDays(items, mi, matScen);
    return {
      amt:      inv.amount,
      mgmt:     Number.isFinite(inv.days) ? inv.days : null,
      disc:     Number.isFinite(disc)     ? disc     : null,
      shortCnt: shortCount(items),
    };
  }

  var base   = pack(sc.base, null);
  var rtf    = sc.hasRtfAdj ? pack(sc.rtfAdj, matScenRtf) : null;
  var hasCut = sc.hasExcess || Object.keys(state.matExcessAdj || {}).length > 0;
  var fin    = hasCut ? pack(sc.final, matScenFinal) : null;
  return { month: months[mi], base: base, rtf: rtf, fin: fin };
}

// ── 3시나리오 KPI 배너 — 값은 최종(감축후), delta는 (RTF +x · 감축 -y) 분해 ────
function renderScenarioKpiBanner() {
  var sc = computeScenarioItemSets();
  var months = getRtfMonths();

  // 재고 관점: 감소 = 좋음(초록), 증가 = 나쁨(빨강)
  function chip(delta, isAmt, label) {
    if (delta === null) return "";
    var rounded = isAmt ? Math.round(delta / 1e8) : Math.round(delta);
    if (rounded === 0) return "";
    var cls  = delta < 0 ? "cst-kpi-delta dn" : "cst-kpi-delta up";
    var sign = delta >= 0 ? "+" : "";
    var txt  = isAmt ? sign + formatMoney(delta) : sign + Math.round(delta) + "일";
    return "<span class='" + cls + "'>(" + escapeHtml(label) + " " + escapeHtml(txt) + ")</span>";
  }
  function d(a, b) { return (Number.isFinite(a) && Number.isFinite(b)) ? a - b : null; }

  // 자재 시나리오: 원래=무조정 / RTF조정후=matSimAdj·fgProdAdj / 감축후=+excessAdj·matExcessAdj(우선)
  var matScenRtf   = { fg: state.fgProdAdj, mat: state.matSimAdj };
  var matScenFinal = {
    fg:  Object.assign({}, state.fgProdAdj  || {}, state.excessAdj     || {}),
    mat: Object.assign({}, state.matSimAdj  || {}, state.matExcessAdj  || {}),
  };
  var hasCut = sc.hasExcess || Object.keys(state.matExcessAdj || {}).length > 0;

  var data = months.map(function(month, mi) {
    var b = rtfHeadlineInv(sc.base, mi, null);
    var r = sc.hasRtfAdj ? rtfHeadlineInv(sc.rtfAdj, mi, matScenRtf) : b;
    var fItems = sc.hasExcess ? sc.final : sc.rtfAdj; // FG 조정은 hasExcess일 때만 final 사용(기존 로직 유지)
    var f  = rtfHeadlineInv(fItems, mi, matScenFinal); // 자재 시나리오는 항상 최종(감축 포함) 반영
    var bd = rtfDisclosureDays(sc.base, mi, null);
    var rd = sc.hasRtfAdj ? rtfDisclosureDays(sc.rtfAdj, mi, matScenRtf) : bd;
    var fd = rtfDisclosureDays(fItems, mi, matScenFinal);
    return {
      month: month,
      amt:  f.amount, amtRtf:  sc.hasRtfAdj ? d(r.amount, b.amount) : null, amtExc:  hasCut ? d(f.amount, r.amount) : null,
      mgmt: f.days,   mgmtRtf: sc.hasRtfAdj ? d(r.days, b.days)     : null, mgmtExc: hasCut ? d(f.days, r.days)     : null,
      disc: fd,       discRtf: sc.hasRtfAdj ? d(rd, bd)             : null, discExc: hasCut ? d(fd, rd)             : null,
    };
  });

  var headerRow = "<tr><th class='rtf-kpi-lbl-hd'></th>" +
    months.map(function(m) { return "<th class='rtf-kpi-month-hd'>" + escapeHtml(monthLabel(m)) + "</th>"; }).join("") + "</tr>";

  // delta 칩 세로 배치: RTF 윗줄, 감축 아랫줄
  function chipStack(c1, c2) {
    var h = "";
    if (c1) h += "<div class='scn-chip-line'>" + c1 + "</div>";
    if (c2) h += "<div class='scn-chip-line'>" + c2 + "</div>";
    return h;
  }

  var _isTotal = getActualsAnchor() != null;
  var amtRow = "<tr class='rtf-kpi-r-amt'><td class='rtf-kpi-row-lbl'>" + (_isTotal ? "전체재고" : "재고금액") + "</td>" +
    data.map(function(x) {
      return "<td class='rtf-kpi-val'><span class='rtf-kpi-main'>" +
        escapeHtml(Number.isFinite(x.amt) ? formatMoney(x.amt) : "—") + "</span>" +
        chipStack(chip(x.amtRtf, true, "RTF"), chip(x.amtExc, true, "감축")) + "</td>";
    }).join("") + "</tr>";

  var hasDisc = data.some(function(x) { return Number.isFinite(x.disc); });
  var discRow = hasDisc ? "<tr class='rtf-kpi-r-days'><td class='rtf-kpi-row-lbl'>재고일수(공시기준)</td>" +
    data.map(function(x) {
      return "<td class='rtf-kpi-val'><span class='rtf-kpi-main'>" +
        escapeHtml(Number.isFinite(x.disc) ? Math.round(x.disc) + "일" : "—") + "</span>" +
        chipStack(chip(x.discRtf, false, "RTF"), chip(x.discExc, false, "감축")) + "</td>";
    }).join("") + "</tr>" : "";

  var mgmtRow = "<tr class='rtf-kpi-r-days'><td class='rtf-kpi-row-lbl'>" + (hasDisc || _isTotal ? "재고일수(관리기준)" : "재고일수") + "</td>" +
    data.map(function(x) {
      return "<td class='rtf-kpi-val'><span class='rtf-kpi-main'>" +
        escapeHtml(Number.isFinite(x.mgmt) ? Math.round(x.mgmt) + "일" : "—") + "</span>" +
        chipStack(chip(x.mgmtRtf, false, "RTF"), chip(x.mgmtExc, false, "감축")) + "</td>";
    }).join("") + "</tr>";

  return "<div class='rtf-kpi-wrap' style='margin-bottom:12px;'>" +
    "<table class='rtf-kpi-table'>" +
    "<thead>" + headerRow + "</thead>" +
    "<tbody>" + amtRow + discRow + mgmtRow + "</tbody>" +
    "</table>" + (_isTotal ? nabotaKpiNote() : "") + "</div>";
}

// 헤드라인 재고: 결산 연결 시 전체재고, 미연결 시 완제품·상품(기존)로 폴백
// 재고일수(관리기준) = 재고금액 × 경과일수(월수×30) ÷ 전체출고 누적
//   실적월까지는 결산 전체출고 YTD, 이후는 estMonthMgmtOutWon 월별 추정 누적
//   (연도 바뀌면 누적 리셋 — 공시기준과 동일 사상)
function rtfHeadlineInv(items, mi, matScenario) {
  var anchor = getActualsAnchor();
  if (anchor) {
    var amt = totalInvAmountWon(items, mi, anchor, matScenario);
    var days = null;
    // 판매계획 없는 달(예측 구간 밖)은 분모 추정 불가 → 일수 미표시
    var hasPlan = false;
    for (var i2 = 0; i2 < items.length; i2++) {
      var msx = items[i2].monthlyStatus[mi];
      if (msx && msx.salesQty !== null) { hasPlan = true; break; }
    }
    if (hasPlan) {
      var months = getRtfMonths();
      var m = months[mi], mYear = m.slice(0, 4);
      var cum = (mYear === anchor.month.slice(0, 4)) ? anchor.cumOutAllWon : 0;
      for (var k = 0; k <= mi; k++) {
        var km = months[k];
        if (km <= anchor.month) continue;       // 실적월은 결산 누적에 이미 포함
        if (km.slice(0, 4) !== mYear) continue; // 누적은 해당 연도 내에서만
        cum += estMonthMgmtOutWon(items, k, anchor);
      }
      if (cum > 0)                        days = amt * (Number(m.slice(5, 7)) * 30) / cum;
      else if (anchor.monthlyOutWon > 0)  days = amt * 30 / anchor.monthlyOutWon; // 폴백(구방식)
    }
    return { amount: amt, days: days, isTotal: true };
  }
  var agg = aggregateMonth(items, mi);
  return { amount: agg.endingAmount, days: agg.inventoryDays, isTotal: false };
}

// [사용처 없음 — 정의만 남아 있던 죽은 코드] 2026-07 확인.
// 아래 renderRtfMonthCards가 실제 화면이며, 그쪽은 공유 배너로 통일했다.
function renderRtfInventoryBar_deprecated(items, baseItemsForDelta) {
  var months = getRtfMonths();
  if (!items || items.length === 0) return "";

  var hasDelta = !!baseItemsForDelta;
  var baseItems = hasDelta ? baseItemsForDelta : null;

  var amtRow = "", daysRow = "", amtDeltaRow = "", daysDeltaRow = "";

  months.forEach(function(month, mi) {
    var inv = rtfHeadlineInv(items, mi);
    var amtVal = Number.isFinite(inv.amount) ? formatMoney(inv.amount) : "-";
    var daysVal = Number.isFinite(inv.days) ? Math.round(inv.days) + "일" : "-";
    amtRow  += "<td>" + escapeHtml(amtVal)  + "</td>";
    daysRow += "<td>" + escapeHtml(daysVal) + "</td>";

    if (hasDelta && baseItems) {
      var baseInv = rtfHeadlineInv(baseItems, mi);
      // 재고금액 delta
      if (Number.isFinite(inv.amount) && Number.isFinite(baseInv.amount)) {
        var amtDelta = inv.amount - baseInv.amount;
        var amtSign = amtDelta >= 0 ? "+" : "";
        var amtCls = amtDelta >= 0 ? "rtf-inv-delta-pos" : "rtf-inv-delta-neg";
        amtDeltaRow += "<td class=\"" + amtCls + "\">" + escapeHtml(amtSign + formatMoney(amtDelta)) + "</td>";
      } else {
        amtDeltaRow += "<td>-</td>";
      }
      // 재고일수 delta
      if (Number.isFinite(inv.days) && Number.isFinite(baseInv.days)) {
        var daysDelta = inv.days - baseInv.days;
        var daysSign = daysDelta >= 0 ? "+" : "";
        var daysCls = daysDelta >= 0 ? "rtf-inv-delta-pos" : "rtf-inv-delta-neg";
        daysDeltaRow += "<td class=\"" + daysCls + "\">" + escapeHtml(daysSign + Math.round(daysDelta) + "일") + "</td>";
      } else {
        daysDeltaRow += "<td>-</td>";
      }
    }
  });
  var _invIsTotal = getActualsAnchor() != null;

  var monthHeaders = months.map(function(m) {
    return "<th>" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");

  var deltaRows = hasDelta ? (
    "<tr class=\"rtf-inv-delta-row\"><td class=\"rtf-inv-label\">재고금액 변동</td>" + amtDeltaRow + "</tr>" +
    "<tr class=\"rtf-inv-delta-row\"><td class=\"rtf-inv-label\">재고일수 변동</td>" + daysDeltaRow + "</tr>"
  ) : "";

  return "<div class=\"rtf-inv-bar rtf-card\" style=\"padding:14px 18px;margin-top:10px;\">" +
    "<div class=\"rtf-inv-bar-title\">" + (_invIsTotal ? "월별 전체재고 · 재고일수 <span style=\"font-weight:400;color:#94a3b8;font-size:12px;\">(결산 총재고 기준 · 완제품·상품 변동 반영)</span>" : "월별 재고금액 · 재고일수") + "</div>" +
    "<div><table class=\"rtf-inv-table\">" +
    "<thead><tr><th class=\"rtf-inv-row-label\"></th>" + monthHeaders + "</tr></thead>" +
    "<tbody>" +
    "<tr><td class=\"rtf-inv-label\">재고금액</td>" + amtRow  + "</tr>" +
    "<tr><td class=\"rtf-inv-label\">재고일수</td>" + daysRow + "</tr>" +
    deltaRows +
    "</tbody></table></div></div>";
}

// ── 월별 요약 카드 띠 — 공유 3시나리오 배너로 통일 ────────────────────────────
// 예전엔 자기 계산을 했는데 두 군데가 어긋나 있었다:
//   · items    = RTF조정 품목집합만 (excessAdj가 안 실림)
//   · matScen  = { fg: fgProdAdj, mat: matSimAdj } (matExcessAdj가 빠짐)
// → 과잉감축을 아무리 해도 RTF판정 탭의 전체재고는 꿈쩍하지 않았다. 같은 회의에서
//   화면을 옮기면 숫자가 달라져 "뭐가 맞는 거냐"가 된다.
// 산출 HTML은 renderScenarioKpiBanner와 이미 동일했다(rtf-kpi-table 3행). 중복 구현이
// 갈라진 것뿐이라 공유 배너를 그대로 쓴다. 본값 = 최종(감축까지), 칩 = (RTF +x)(감축 −y).
// 1부에서 아직 감축이 없으면 감축 칩은 자동으로 안 뜬다 — 스포일러가 되지 않는다.
function renderRtfMonthCards() {
  return (typeof renderScenarioKpiBanner === "function") ? renderScenarioKpiBanner() : "";
}

// [사용처 없음 — 위 함수로 대체됨] 옛 자체계산 버전. 롤백 참고용.
function renderRtfMonthCards_deprecated(items, baseItemsForDelta) {
  var months  = getRtfMonths();
  var hasDelta = !!baseItemsForDelta;
  // 조정 후 보기: 원부자재 롤포워드도 RTF조정 시나리오(생산·자재입고) 반영 — base는 원래계획(null)
  var matScen = hasDelta ? { fg: state.fgProdAdj, mat: state.matSimAdj } : null;

  var monthData = months.map(function(month, mi) {
    var agg = aggregateMonth(items, mi);
    var shortageCount = items.filter(function(i) {
      return i.monthlyStatus[mi] && i.monthlyStatus[mi].status === STATUS.SHORTAGE;
    }).length;
    var unknownCount = items.filter(function(i) {
      var ms = i.monthlyStatus[mi];
      return ms && ms.status === STATUS.UNKNOWN;
    }).length;

    var cls, icon, label;
    if (shortageCount > 0)     { cls = "shortage"; icon = "●"; label = "공급부족 " + shortageCount + "건"; }
    else if (unknownCount > 0) { cls = "unknown";  icon = "?"; label = "판단불가 " + unknownCount + "건"; }
    else                       { cls = "ok";        icon = "✓"; label = "대응가능"; }

    var inv     = rtfHeadlineInv(items, mi, matScen);
    var amtRaw  = Number.isFinite(inv.amount)  ? inv.amount              : null;
    var amtVal  = amtRaw !== null              ? formatMoney(amtRaw)     : "—";
    var daysVal = Number.isFinite(inv.days)    ? Math.round(inv.days)    : null;
    var discRaw = rtfDisclosureDays(items, mi, matScen);
    var discVal = Number.isFinite(discRaw)     ? Math.round(discRaw)     : null;

    // 공급원인 표(deltaSpan)와 동일 클래스·형식 — 재고금액·재고일수(공시·관리) 전부 괄호 증감 표시
    var deltaHtml = "", daysDeltaHtml = "", discDeltaHtml = "";
    if (hasDelta && baseItemsForDelta) {
      var baseInv = rtfHeadlineInv(baseItemsForDelta, mi, null);
      var baseDisc = rtfDisclosureDays(baseItemsForDelta, mi, null);
      var mkDelta = function(val, isDays) {
        if (val === null || Math.round(isDays ? val : val / 1e8) === 0) return "";
        var c = val > 0 ? "cst-kpi-delta up" : "cst-kpi-delta dn";
        var t = isDays ? (val >= 0 ? "+" : "") + Math.round(val) + "일" : (val >= 0 ? "+" : "") + formatMoney(val);
        return "<span class=\"" + c + "\">(" + t + ")</span>";
      };
      if (amtRaw !== null && Number.isFinite(baseInv.amount)) deltaHtml = mkDelta(amtRaw - baseInv.amount, false);
      if (Number.isFinite(inv.days) && Number.isFinite(baseInv.days)) daysDeltaHtml = mkDelta(inv.days - baseInv.days, true);
      if (Number.isFinite(discRaw) && Number.isFinite(baseDisc))     discDeltaHtml = mkDelta(discRaw - baseDisc, true);
    }
    return { month: month, cls: cls, icon: icon, label: label, amtRaw: amtRaw, amtVal: amtVal, daysVal: daysVal, discVal: discVal,
      deltaHtml: deltaHtml, daysDeltaHtml: daysDeltaHtml, discDeltaHtml: discDeltaHtml };
  });

  // 해넘김 마지막 달(2027-01처럼 계획연도를 벗어나는 1개월)은 이 요약 띠에서는 제외
  var displayData = monthData.filter(function(d) { return d.month.slice(0, 4) === months[0].slice(0, 4); });

  var headerRow = "<tr>" +
    "<th class=\"rtf-kpi-lbl-hd\"></th>" +
    displayData.map(function(d) {
      return "<th class=\"rtf-kpi-month-hd\">" + escapeHtml(monthLabel(d.month)) + "</th>";
    }).join("") + "</tr>";

  var _isTotalInv = getActualsAnchor() != null;
  var amtRow = "<tr class=\"rtf-kpi-r-amt\">" +
    "<td class=\"rtf-kpi-row-lbl\">" + (_isTotalInv ? "전체재고" : "재고금액") + "</td>" +
    displayData.map(function(d) {
      return "<td class=\"rtf-kpi-val\">" +
        "<span class=\"rtf-kpi-main\">" + escapeHtml(d.amtVal) + "</span>" +
        (d.deltaHtml || "") +
        "</td>";
    }).join("") + "</tr>";

  // 공시기준 행: 결산 매출원가(누적) 연결 시에만 표시
  var hasDisc = displayData.some(function(d) { return d.discVal !== null; });
  var discRow = hasDisc ? "<tr class=\"rtf-kpi-r-days\">" +
    "<td class=\"rtf-kpi-row-lbl\">재고일수(공시기준)</td>" +
    displayData.map(function(d) {
      var txt = d.discVal !== null ? d.discVal + "일" : "—";
      return "<td class=\"rtf-kpi-val\">" +
        "<span class=\"rtf-kpi-main\">" + escapeHtml(txt) + "</span>" +
        (d.discDeltaHtml || "") +
        "</td>";
    }).join("") + "</tr>" : "";

  var daysRow = "<tr class=\"rtf-kpi-r-days\">" +
    "<td class=\"rtf-kpi-row-lbl\">" + (hasDisc ? "재고일수(관리기준)" : "재고일수") + "</td>" +
    displayData.map(function(d) {
      var txt = d.daysVal !== null ? d.daysVal + "일" : "—";
      var hiCls = d.daysVal !== null && d.daysVal > 120 ? " hi" : "";
      return "<td class=\"rtf-kpi-val" + hiCls + "\">" +
        "<span class=\"rtf-kpi-main\">" + escapeHtml(txt) + "</span>" +
        (d.daysDeltaHtml || "") +
        "</td>";
    }).join("") + "</tr>";

  return "<div class=\"rtf-kpi-wrap\" style=\"margin-bottom:12px;\">" +
    "<table class=\"rtf-kpi-table\">" +
    "<thead>" + headerRow + "</thead>" +
    "<tbody>" + amtRow + discRow + daysRow + "</tbody>" +
    "</table></div>";
}

// ── RTF 화면 ─────────────────────────────────────────────────────────────────
function renderRtf() {
  // 1. 현재 계획 기준 items (항상 계산)
  const baseItems = computeRtfItems();
  _rtfBaseItemMap.clear();
  baseItems.forEach(function(item) { _rtfBaseItemMap.set(item.itemCode + "|" + item.plantCode, item); });

  // 2. 조정후 items (matSimAdj[자재 증량] / goodsSupplyAdj[상품 입고] / fgProdAdj[생산계획 증량] 있을 때)
  const hasMatAdj   = Object.keys(state.matSimAdj || {}).length > 0;
  const hasGoodsAdj = Object.keys(state.goodsSupplyAdj || {}).length > 0;
  const hasAdj = hasMatAdj || hasGoodsAdj || hasFgProdAdj();
  const adjItems = hasAdj ? computeRtfItems(buildBomMaxProducibleMap(state.matSimAdj, state.fgProdAdj), false, rtfSupplyAdjAll()) : null;
  if (!hasAdj && state.rtfViewMode === "adjusted") state.rtfViewMode = "current";
  if (hasAdj && !state._rtfToggleManual) state.rtfViewMode = "adjusted";
  state._rtfToggleManual = false;

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
  const _dm = state.rtfDisplayMode;
  const firstShortage = _dm === "amount" ? firstMonth.shortageAmount : _dm === "revenue" ? firstMonth.shortageRevenue : firstMonth.shortageQty;
  const summaryUnit = _dm === "qty" ? "개" : "";
  const summaryLine = `${monthLabel(months[0])} 총 판매계획 <b>${escapeHtml(formatDisplayQtyMoney(firstMonth.salesQty, firstMonth.salesPlanAmount, firstMonth.salesRevenue))}${summaryUnit}</b>, RTF <b>${escapeHtml(formatDisplayQtyMoney(firstMonth.rtfQty, firstMonth.rtfAmount, firstMonth.rtfRevenue))}${summaryUnit}</b>. ${Number.isFinite(firstShortage) && firstShortage > 0 ? `<span class="rtf-alert-text">Shortage ${escapeHtml(_dm === "qty" ? formatNumber(firstShortage) + summaryUnit : formatMoney(firstShortage))}</span>` : `<span class="rtf-ok-text">Shortage 없음</span>`}`;

  // 4. 전후 토글 UI (항상 표시, 조정 없으면 "조정 후" 비활성)
  const adjCount = Object.keys(state.matSimAdj || {}).length + Object.keys(state.goodsSupplyAdj || {}).length + Object.keys(state.fgProdAdj || {}).length;
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
      <span class="rtf-ib-meta">기준월: ${escapeHtml(months[0])} &nbsp;·&nbsp; 대상기간: ${escapeHtml(months.map(monthLabel).join(" ~ "))} &nbsp;·&nbsp; 표시: ${state.rtfDisplayMode === "qty" ? "수량" : state.rtfDisplayMode === "revenue" ? "매출" : "원가"}</span>
      <span class="rtf-ib-sep">|</span>
      ${bomBadge}
      ${verifyHtml}
    </div>
    <div class="rtf-ib-right">${toggleHtml}</div>
  </div>`;

  // 7. 섹션 + 카드 띠
  const activeSection = activeRtfSection();
  const sectionTabs = state.rtfExpanded ? RTF_SECTION_OPTIONS.map((option) =>
    `<button type="button" class="rtf-section-tab ${activeSection.mode === option.mode ? "active" : ""}" data-rtf-section="${escapeHtml(option.mode)}">${escapeHtml(option.label)}</button>`
  ).join("") : "";
  // 나보타(비점검) 완결 행을 매트릭스에만 주입 (KPI·요약·카드·인스펙션 화면은 미영향)
  const nabotaItem  = buildNabotaMatrixItem(months);
  const matrixItems = nabotaItem ? items.concat([nabotaItem]) : items;
  const sectionHtml = state.rtfExpanded
    ? renderMatrixSection(activeSection.title, activeSection.mode, matrixItems, activeSection.sectionId)
    : RTF_SECTION_OPTIONS.map((option) => renderMatrixSection(option.title, option.mode, matrixItems, option.sectionId)).join("");

  // 공유 3시나리오 배너 — 공급원인·과잉감축·재고진단·회의안건과 완전히 같은 숫자.
  // (state.rtfViewMode 전/후 토글은 아래 매트릭스 표에만 적용된다. 상단 배너는 항상 3단 전부를
  //  보여줘야 조정할 때마다 회의의 성과가 실시간으로 보인다.)
  const monthCardsHtml = renderRtfMonthCards();

  return `<div class="rtf-screen rtf-excel-layout">
    ${infobarHtml}
    ${monthCardsHtml}
    <div class="rtf-toolbar">
      ${state.rtfExpanded ? `<div class="rtf-section-tabs" aria-label="RTF 보기 기준">${sectionTabs}</div>` : ""}
      <div class="rtf-mode-group" aria-label="표시 단위">
        <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "qty" ? "active" : ""}" data-rtf-mode="qty">수량</button>
        <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "amount" ? "active" : ""}" data-rtf-mode="amount">원가</button>
        ${(state.mappedData.sales_actual || []).length ? `<button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "revenue" ? "active" : ""}" data-rtf-mode="revenue">매출</button>` : ""}
      </div>
      <button type="button" id="rtfExpandToggle" class="rtf-extra-toggle ${state.rtfExpanded ? "active" : ""}">${state.rtfExpanded ? "축소" : "확대"}</button>
      <button type="button" id="rtfGoConstraintBtn" class="rtf-go-constraint-btn">공급원인 분석 →</button>
      <span class="rtf-toolbar-hint">${state.rtfExpanded ? "분석용 상세 · 보기 기준 탭 선택" : "발표용 기본 · 사업부/플랜트/유형 전체 표시"}</span>
    </div>
    ${adjPanelHtml}
    ${sectionHtml}
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

  // 전후 토글
  document.querySelectorAll("[data-rtf-view]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (state.rtfViewMode === btn.dataset.rtfView) return;
      state.rtfViewMode = btn.dataset.rtfView;
      state._rtfToggleManual = true;
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
