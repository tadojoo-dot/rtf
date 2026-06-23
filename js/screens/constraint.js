// ── 전개 상태 상수 ────────────────────────────────────────────────────────────
var BOM_STATUS = { IDLE:"idle", RUNNING:"running", DONE:"done", FAILED:"failed" };
var _bomAnimId = 0;

// ── 컬럼 / 메트릭 정의 ───────────────────────────────────────────────────────
// 기본 표시 컬럼 (영향 품목군·대표 영향품목 제거 → 영향품목수 tooltip/펼침에서 확인)
var CONSTR_LEFT_COLS = [
  { key:"plant",        label:"플랜트",       width:60,  align:"center" },
  { key:"itemCategory", label:"제약대상 유형",width:80,  align:"center" },
  { key:"shareType",    label:"공용/전용",    width:60,  align:"center" },
  { key:"code",         label:"자재코드",     width:90,  align:"center" },
  { key:"name",         label:"자재명",       width:160, align:"left",  isName:true },
  { key:"unit",         label:"단위",         width:52,  align:"center" },
  { key:"impactCount",  label:"영향품목수",   width:60,  align:"center", sortable:true },
  { key:"note",         label:"확인 필요사항",width:172, align:"left",  isLast:true },
];
var CONSTR_COMPACT_W = 96;  // 압축 모드 월별 컬럼 너비
var CONSTR_METRIC_W  = 72;  // 상세 모드 지표 컬럼 너비
var CONSTR_METRICS   = ["필요","가용","부족"];

// ── 제약대상 유형 표시 매핑 ──────────────────────────────────────────────────
var ITEM_CATEGORY_DISPLAY = {
  "L":"자재","N":"자재","D":"자재","R":"원료","U":"반제품","T":"자재",
  "ROH":"원료","HALB":"반제품","FERT":"완제품","HIBE":"자재","VERP":"자재","NLAG":"자재","UNBW":"자재",
  "원료":"원료","자재":"자재","반제품":"반제품","재공품":"재공품","완제품":"완제품",
  "상품":"상품공급","소모품":"자재","포장재":"자재","세미":"반제품",
};
var _DISPLAY_VALID = new Set(["원료","자재","반제품","재공품","상품공급","완제품","기준정보"]);

function displayItemCategory(raw) {
  if (!raw || raw === NEED_MASTER) return "확인필요";
  var t = String(raw).trim();
  if (!t) return "확인필요";
  return ITEM_CATEGORY_DISPLAY[t] || ITEM_CATEGORY_DISPLAY[t.toUpperCase()] || (_DISPLAY_VALID.has(t) ? t : "확인필요");
}

// ── 확인 필요사항 짧은 라벨 ──────────────────────────────────────────────────
var NOTE_SHORT = {
  "현재고 데이터 연결 필요":                       "현재고 연결필요",
  "공통자재 부족 발생. 완제품별 배분기준 확인 필요": "공통자재 배분필요",
  "대체 BOM 존재. 적용 기준 확인 필요":             "대체BOM 확인",
  "반제품 하위 BOM 추가전개 기준 확인 필요":         "반제품 추가전개 확인",
  "단위 정합 확인 필요":                            "단위 정합 확인",
  "단위 기준정보 확인 필요":                        "단위 정합 확인",
};

function shortNoteLabel(note) {
  if (!note || note === "-") return "-";
  return note.split(" | ").map(function(n) {
    return NOTE_SHORT[n.trim()] || n.trim();
  }).join(" / ");
}

// ── BOM 전개 엔진 ─────────────────────────────────────────────────────────────
function computeBomExpansion() {
  var planRows      = state.mappedData.plan_monthly;
  var inventoryRows = state.mappedData.inventory_base;
  var bomRows       = state.mappedData.bom_components;
  var masterRows    = state.mappedData.item_master;
  var months        = getRtfMonths();
  var result        = { status:BOM_STATUS.FAILED, failReasons:[], completedAt:null, items:[], stats:{} };

  if (!planRows.length)      result.failReasons.push("판매계획 연결 필요");
  if (!bomRows.length)       result.failReasons.push("BOM 연결 필요");
  if (!inventoryRows.length) result.failReasons.push("현재고 연결 필요");
  if (result.failReasons.length) return result;

  // 대체 BOM 존재 여부 추적 (완제품 9코드만)
  var rootsWithAltBom = new Set();
  bomRows.forEach(function(r) {
    if (!r.rootItemCode || !r.rootItemCode.startsWith("9")) return;
    var alt = cleanOptional(r.alternativeBom);
    if (alt !== "" && alt !== "1") rootsWithAltBom.add(r.rootItemCode + "|" + r.plant);
  });

  // 반제품·재공품이 자체 BOM 루트로 등록된 코드 감지 (하위 자동 전개 방지·경고용)
  var codesWithSubBom = new Set();
  bomRows.forEach(function(r) {
    if (r.rootItemCode && !r.rootItemCode.startsWith("9")) codesWithSubBom.add(r.rootItemCode);
  });

  // 기본 BOM 필터 (alternativeBom 공란 or "1")
  var baseBomRows = bomRows.filter(function(r) {
    var alt = cleanOptional(r.alternativeBom);
    return alt === "" || alt === "1";
  });
  if (!baseBomRows.length) {
    result.failReasons.push("BOM 연결 필요 (기본 BOM 항목 없음)");
    return result;
  }

  // 완제품 정보 map: rootCode|plant → {code, name} (9코드 완제품만)
  var finishedItemMap = new Map();
  baseBomRows.forEach(function(r) {
    if (!r.rootItemCode || !r.rootItemCode.startsWith("9")) return;
    var key = r.rootItemCode + "|" + r.plant;
    if (!finishedItemMap.has(key))
      finishedItemMap.set(key, { code:r.rootItemCode, name:cleanText(r.rootItemName, r.rootItemCode) });
  });

  // 완제품 생산계획: code|plant|month → supplyQty (9코드만)
  var prodPlanMap = new Map();
  planRows.forEach(function(row) {
    var code = cleanOptional(row.itemCode);
    if (!code || !code.startsWith("9")) return;
    var key = code + "|" + cleanOptional(row.plant) + "|" + cleanOptional(row.month);
    prodPlanMap.set(key, (prodPlanMap.get(key) || 0) + (cleanNumber(row.supplyQty) || 0));
  });

  // 하위 자재 공급계획: code|plant|month → { qty, unit }
  var compSupplyMap = new Map();
  planRows.forEach(function(row) {
    var code = cleanOptional(row.itemCode), plant = cleanOptional(row.plant), month = cleanOptional(row.month);
    if (!code || !plant || !month) return;
    var key  = code + "|" + plant + "|" + month;
    var unit = cleanOptional(row.unit) || "";
    var qty  = cleanNumber(row.supplyQty) || 0;
    var ex   = compSupplyMap.get(key);
    if (ex) { ex.qty += qty; if (!ex.unit && unit) ex.unit = unit; }
    else compSupplyMap.set(key, { qty:qty, unit:unit });
  });

  // 기초재고: code|plant → { qty, unit }
  var inventoryMap = new Map();
  inventoryRows.forEach(function(row) {
    var code = cleanOptional(row.itemCode), plant = cleanOptional(row.plant);
    if (!code || !plant) return;
    var key  = code + "|" + plant;
    var unit = cleanOptional(row.unit) || "";
    var qty  = cleanNumber(row.baseQty) || 0;
    var ex   = inventoryMap.get(key);
    if (ex) { ex.qty += qty; if (!ex.unit && unit) ex.unit = unit; }
    else inventoryMap.set(key, { qty:qty, unit:unit });
  });

  // 기준정보 map
  var masterMap = new Map();
  masterRows.forEach(function(r) { if (r.itemCode && !masterMap.has(r.itemCode)) masterMap.set(r.itemCode, r); });

  // 구성품별 소요량 집계 — 완제품(9코드) BOM만 전개, 반제품·재공품 하위 BOM 자동전개 방지
  var compReqs = new Map();
  var missingCompCodeCount = 0;
  baseBomRows.forEach(function(bom) {
    // 9코드 완제품 루트만 소요량/부모 집계에 사용 → 반제품 하위 BOM 중복 전개 방지
    if (!bom.rootItemCode || !bom.rootItemCode.startsWith("9")) return;
    // 구성요소코드 누락 행 → 집계 제외, 별도 카운트
    if (!bom.componentCode || !String(bom.componentCode).trim()) { missingCompCodeCount++; return; }

    var rootKey    = bom.rootItemCode + "|" + bom.plant;
    var compKey    = bom.componentCode + "|" + bom.plant;
    var parent     = finishedItemMap.get(rootKey);
    var rootMaster = masterMap.get(bom.rootItemCode);

    if (!compReqs.has(compKey)) {
      compReqs.set(compKey, {
        componentCode:   bom.componentCode,
        componentName:   bom.componentName,
        plant:           bom.plant,
        itemCategory:    cleanOptional(bom.itemCategory),
        bomUnit:         cleanOptional(bom.componentUnit) || "",
        parentItems:     new Map(),
        requiredByMonth: new Map(),
      });
    }
    var comp = compReqs.get(compKey);
    if (!comp.bomUnit && bom.componentUnit) comp.bomUnit = cleanOptional(bom.componentUnit) || "";

    if (!comp.parentItems.has(rootKey)) {
      comp.parentItems.set(rootKey, {
        code:      bom.rootItemCode,
        name:      parent ? parent.name : bom.rootItemCode,
        plant:     bom.plant,
        itemGroup: cleanText(rootMaster ? rootMaster.itemGroup : null, NEED_MASTER),
        monthly:   new Map(),
      });
    }
    var pi = comp.parentItems.get(rootKey);

    months.forEach(function(month) {
      var prodQty = prodPlanMap.get(bom.rootItemCode + "|" + bom.plant + "|" + month) || 0;
      var ratio   = bom.baseQty > 0 ? bom.componentQty / bom.baseQty : bom.componentQty;
      var addReq  = prodQty * ratio;
      comp.requiredByMonth.set(month, (comp.requiredByMonth.get(month) || 0) + addReq);
      if (!pi.monthly.has(month)) pi.monthly.set(month, { prodQty:prodQty, reqQty:0 });
      pi.monthly.get(month).reqQty += addReq;
    });
  });

  // 결과 아이템 생성
  var resultItems = [];
  compReqs.forEach(function(comp) {
    var invKey   = comp.componentCode + "|" + comp.plant;
    var invData  = inventoryMap.get(invKey);
    var hasInv   = !!invData;
    var baseQty  = hasInv ? (invData.qty || 0) : null;
    var invUnit  = (invData && invData.unit) ? invData.unit : "";
    var master   = masterMap.get(comp.componentCode);
    var masterUnit = cleanOptional(master ? (master.unit || master.unitOfMeasure || master.baseUnit || "") : "") || "";
    var isShared = comp.parentItems.size > 1;

    // 단위 결정 (BOM > 재고 > 공급계획 > 기준정보)
    var firstSupplyUnit = "";
    months.some(function(m) {
      var sd = compSupplyMap.get(comp.componentCode + "|" + comp.plant + "|" + m);
      if (sd && sd.unit) { firstSupplyUnit = sd.unit; return true; }
      return false;
    });
    var resolvedUnit = comp.bomUnit || invUnit || firstSupplyUnit || masterUnit || "확인필요";
    var compareUnit  = invUnit || masterUnit;
    var unitMismatch = !!(comp.bomUnit && compareUnit && comp.bomUnit.toLowerCase() !== compareUnit.toLowerCase());
    var unitMissing  = resolvedUnit === "확인필요";

    // 대체 BOM 존재 여부
    var parentArr = [];
    comp.parentItems.forEach(function(pi) { parentArr.push(pi); });
    var hasAltBom = parentArr.some(function(p) { return rootsWithAltBom.has(p.code + "|" + comp.plant); });

    // 반제품·재공품 하위 BOM 보유 여부
    var hasSemiSubBom = codesWithSubBom.has(comp.componentCode);

    // 영향 품목군 (부모 완제품 기준 DISTINCT)
    var parentGroups = [], groupSeen = new Set();
    parentArr.forEach(function(p) {
      if (p.itemGroup && p.itemGroup !== NEED_MASTER && !groupSeen.has(p.itemGroup)) {
        groupSeen.add(p.itemGroup); parentGroups.push(p.itemGroup);
      }
    });
    var parentItemGroup = parentGroups.length === 0 ? NEED_MASTER
      : parentGroups.length === 1 ? parentGroups[0]
      : parentGroups[0] + " 외 " + (parentGroups.length - 1) + "개";

    // 월별 순차 계산
    var monthlyData = [], hasAnyShortage = false, totalShortage = 0;
    if (unitMismatch) {
      months.forEach(function(month) {
        var requiredQty = comp.requiredByMonth.get(month) || 0;
        monthlyData.push({ month:month, requiredQty:requiredQty, availableQty:null, shortageQty:null });
      });
    } else {
      var openingQty = baseQty;
      months.forEach(function(month) {
        var requiredQty = comp.requiredByMonth.get(month) || 0;
        var sd          = compSupplyMap.get(comp.componentCode + "|" + comp.plant + "|" + month);
        var supplyQty   = sd ? sd.qty : 0;
        var availableQty = null, shortageQty = null;
        if (openingQty !== null) {
          availableQty = openingQty + supplyQty;
          shortageQty  = Math.max(requiredQty - availableQty, 0);
          var endingQty = Math.max(availableQty - requiredQty, 0);
          if (shortageQty > 0) { hasAnyShortage = true; totalShortage += shortageQty; }
          openingQty = endingQty;
        }
        monthlyData.push({ month:month, requiredQty:requiredQty, availableQty:availableQty, shortageQty:shortageQty });
      });
    }

    var hasReq = monthlyData.some(function(md) { return md.requiredQty > 0; });
    if (!hasReq) return;

    // 확인 필요사항
    var notes = [];
    if (!hasInv)                           notes.push("현재고 데이터 연결 필요");
    if (isShared && hasAnyShortage)        notes.push("공통자재 부족 발생. 완제품별 배분기준 확인 필요");
    if (hasAltBom)                         notes.push("대체 BOM 존재. 적용 기준 확인 필요");
    if (hasSemiSubBom)                     notes.push("반제품 하위 BOM 추가전개 기준 확인 필요");
    if (unitMismatch)                      notes.push("단위 정합 확인 필요");
    else if (unitMissing && !unitMismatch) notes.push("단위 기준정보 확인 필요");

    var needsMaster = !comp.itemCategory || comp.itemCategory === NEED_MASTER || displayItemCategory(comp.itemCategory) === "확인필요";
    var parentArrResult = parentArr.map(function(p) {
      return {
        code:      p.code,
        name:      p.name,
        plant:     p.plant,
        itemGroup: p.itemGroup,
        monthly:   months.map(function(m) { return Object.assign({ month:m }, p.monthly.get(m) || { prodQty:0, reqQty:0 }); }),
      };
    });

    var resolvedCompName = cleanText(comp.componentName, null);
    if (!resolvedCompName) resolvedCompName = "자재명 확인필요";

    resultItems.push({
      plant:           comp.plant,
      componentCode:   comp.componentCode,
      componentName:   resolvedCompName,
      itemCategory:    comp.itemCategory,
      displayCategory: displayItemCategory(comp.itemCategory),
      parentItemGroup: parentItemGroup,
      unit:            resolvedUnit,
      unitMismatch:    unitMismatch,
      unitMissing:     unitMissing,
      isShared:        isShared,
      parentItems:     parentArrResult,
      hasInventory:    hasInv,
      monthlyData:     monthlyData,
      hasAnyShortage:  hasAnyShortage,
      totalShortage:   totalShortage,
      hasAltBom:       hasAltBom,
      hasSemiSubBom:   hasSemiSubBom,
      needsMaster:     needsMaster,
      notes:           notes,
      note:            notes.join(" | "),
    });
  });

  // 제약 대상만 (부족 발생·재고 미연결·단위 불일치)
  var constraintItems = resultItems.filter(function(i) {
    return i.hasAnyShortage || !i.hasInventory || i.unitMismatch;
  });
  var sorted = sortConstraintItems(constraintItems);

  result.status      = BOM_STATUS.DONE;
  result.completedAt = new Date();
  result.items       = sorted;
  result.stats = {
    totalConstraints:  sorted.filter(function(i) { return i.hasAnyShortage; }).length,
    sharedConstraints: sorted.filter(function(i) { return i.isShared && i.hasAnyShortage; }).length,
    dedicatedShortage: sorted.filter(function(i) { return !i.isShared && i.hasAnyShortage; }).length,
    needMaster:        sorted.filter(function(i) { return i.needsMaster; }).length,
    needData:          sorted.filter(function(i) { return !i.hasInventory; }).length,
    missingCompCode:   missingCompCodeCount,
  };
  return result;
}

// ── 정렬 ─────────────────────────────────────────────────────────────────────
function sortConstraintItems(items) {
  // 영향품목수 기준 정렬 (toggleable)
  if (state.constraintImpactSort !== 0) {
    var dir = state.constraintImpactSort;
    return items.slice().sort(function(a, b) { return dir * (b.parentItems.length - a.parentItems.length); });
  }
  function priority(item) {
    if (item.hasAnyShortage && item.isShared)  return 0;
    if (item.hasAnyShortage && !item.isShared) return 1;
    if (item.unitMismatch)                     return 2; // 판단불가
    if (item.needsMaster)                      return 3;
    if (!item.hasInventory)                    return 4;
    return 5;
  }
  return items.slice().sort(function(a, b) {
    var pd = priority(a) - priority(b);
    if (pd !== 0) return pd;
    // 부족 그룹 내: 부족 합계 큰 순
    if (a.hasAnyShortage && b.hasAnyShortage) return b.totalShortage - a.totalShortage;
    // 나머지 그룹 내: 영향품목수 큰 순
    return b.parentItems.length - a.parentItems.length;
  });
}

// ── 필터 ─────────────────────────────────────────────────────────────────────
function filterConstraintItems(items) {
  var filter = state.constraintFilter || "all";
  var search = ((state.constraintSearch || "")).toLowerCase().trim();
  var filtered = items;
  if      (filter === "shortage")    filtered = items.filter(function(i) { return i.hasAnyShortage; });
  else if (filter === "shared")      filtered = items.filter(function(i) { return i.isShared && i.hasAnyShortage; });
  else if (filter === "dedicated")   filtered = items.filter(function(i) { return !i.isShared && i.hasAnyShortage; });
  else if (filter === "need-master") filtered = items.filter(function(i) { return i.needsMaster; });
  else if (filter === "need-data")   filtered = items.filter(function(i) { return !i.hasInventory; });
  if (search) {
    filtered = filtered.filter(function(i) {
      return i.componentCode.toLowerCase().includes(search) ||
             i.componentName.toLowerCase().includes(search) ||
             i.parentItems.some(function(p) {
               return p.code.toLowerCase().includes(search) || p.name.toLowerCase().includes(search);
             });
    });
  }
  return filtered;
}

// ── 요약 카드 ─────────────────────────────────────────────────────────────────
function renderConstraintSummaryCard(result) {
  var s = result.stats;
  var fmtTime = result.completedAt
    ? result.completedAt.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit", second:"2-digit" })
    : "-";
  var items = [
    { label:"전개상태",          value:"완료",                                                           cls:"ok"       },
    { label:"전개완료시각",      value:fmtTime,                                                         cls:""         },
    { label:"확정부족 제약대상", value:s.totalConstraints  > 0 ? s.totalConstraints  + "건" : "-",  cls:s.totalConstraints  > 0 ? "shortage" : "" },
    { label:"공용자재 제약",     value:s.sharedConstraints > 0 ? s.sharedConstraints + "건" : "-",  cls:s.sharedConstraints > 0 ? "warn"     : "" },
    { label:"전용자재 부족",     value:s.dedicatedShortage > 0 ? s.dedicatedShortage + "건" : "-",  cls:s.dedicatedShortage > 0 ? "shortage" : "" },
    { label:"기준정보 확인 필요",value:s.needMaster        > 0 ? s.needMaster        + "건" : "-",  cls:s.needMaster        > 0 ? "warn"     : "" },
    { label:"데이터 연결 필요",  value:s.needData          > 0 ? s.needData          + "건" : "-",  cls:s.needData          > 0 ? "warn"     : "" },
    { label:"BOM 코드 누락",     value:s.missingCompCode   > 0 ? s.missingCompCode   + "행" : "-",  cls:s.missingCompCode   > 0 ? "warn"     : "" },
  ];
  return "<section class=\"cst-card cst-summary-card\"><div class=\"cst-summary-grid\">" +
    items.map(function(i) {
      return "<div class=\"cst-sum-item\"><div class=\"cst-sum-label\">" + escapeHtml(i.label) +
             "</div><div class=\"cst-sum-value" + (i.cls ? " " + i.cls : "") + "\">" + escapeHtml(i.value) + "</div></div>";
    }).join("") + "</div></section>";
}

// ── 필터 바 (상세보기 토글 포함) ─────────────────────────────────────────────
function renderConstraintFilterBar(allItems) {
  var f          = state.constraintFilter || "all";
  var detailMode = state.constraintDetailMode;
  var filters = [
    { key:"all",         label:"전체",         count:allItems.length },
    { key:"shortage",    label:"부족만",        count:allItems.filter(function(i) { return i.hasAnyShortage; }).length },
    { key:"shared",      label:"공용자재",      count:allItems.filter(function(i) { return i.isShared && i.hasAnyShortage; }).length },
    { key:"dedicated",   label:"전용자재",      count:allItems.filter(function(i) { return !i.isShared && i.hasAnyShortage; }).length },
    { key:"need-master", label:"기준정보 확인", count:allItems.filter(function(i) { return i.needsMaster; }).length },
    { key:"need-data",   label:"데이터 연결",   count:allItems.filter(function(i) { return !i.hasInventory; }).length },
  ];
  var btns = filters.map(function(ft) {
    return "<button type=\"button\" class=\"cst-filter-btn" + (f === ft.key ? " active" : "") +
           "\" data-cst-filter=\"" + escapeHtml(ft.key) + "\">" + escapeHtml(ft.label) +
           "<span class=\"cst-filter-count\">" + ft.count + "</span></button>";
  }).join("");
  var toggleBtn = "<button type=\"button\" class=\"cst-detail-toggle" + (detailMode ? " active" : "") +
                  "\" id=\"cstDetailToggle\">월별 상세보기</button>";
  return "<div class=\"cst-filter-bar\">" +
         "<div class=\"cst-filter-btns\">" + btns + "</div>" +
         "<div class=\"cst-filter-right\">" + toggleBtn +
         "<input type=\"search\" class=\"cst-search\" id=\"cstSearch\" placeholder=\"자재코드·자재명·영향품목 검색\" value=\"" +
         escapeHtml(state.constraintSearch || "") + "\"></div></div>";
}

// ── 압축 셀 계산 ─────────────────────────────────────────────────────────────
function compactCellValue(item, md) {
  if (item.unitMismatch)                              return { text:"판단불가", cls:"cst-neutral-cell" };
  if (!item.hasInventory)                             return { text:"연결필요",  cls:"cst-neutral-cell" };
  if (md.shortageQty === null)                        return { text:"판단불가", cls:"cst-neutral-cell" };
  if (md.shortageQty > 0) {
    if (item.isShared) return { text:"공통제약", cls:"cst-compact-shared" };
    return { text:"부족 " + formatNumber(Math.round(md.shortageQty)), cls:"cst-shortage-cell" };
  }
  return { text:"-", cls:"cst-neutral-cell" };
}

// ── 정합성 검증 헬퍼 ─────────────────────────────────────────────────────────
function vldNum(v) {
  if (v === null || v === undefined) return "-";
  var n = (typeof v === "number") ? v : cleanNumber(v);
  if (n === null || n === undefined || !isFinite(n) || isNaN(n)) return "-";
  return formatNumber(Math.round(n));
}
function vldRatio(v) {
  if (v === null || v === undefined || !isFinite(v) || isNaN(v)) return "-";
  return v.toFixed(4);
}
var VLD_STATUS_CLS = {
  "정상":"vld-s-ok","연결필요":"vld-s-link","확인필요":"vld-s-check",
  "단위 정합 확인":"vld-s-unit","판단불가":"vld-s-unknown","부족":"vld-s-short",
};
function vldBadge(status) {
  var cls = VLD_STATUS_CLS[status] || "vld-s-check";
  return "<span class=\"vld-badge " + cls + "\">" + escapeHtml(status || "확인필요") + "</span>";
}

// ── 정합성 검증 계산 ─────────────────────────────────────────────────────────
function computeValidation() {
  var planRows      = state.mappedData.plan_monthly;
  var inventoryRows = state.mappedData.inventory_base;
  var bomRows       = state.mappedData.bom_components;
  var masterRows    = state.mappedData.item_master;
  var months        = getRtfMonths();
  var items         = (state.bomResult && state.bomResult.items) || [];

  var baseBomRows = bomRows.filter(function(r) {
    var alt = cleanOptional(r.alternativeBom); return alt === "" || alt === "1";
  });

  // 완제품 생산계획 map
  var prodPlanMap = new Map();
  planRows.forEach(function(r) {
    var code = cleanOptional(r.itemCode);
    if (!code || !code.startsWith("9")) return;
    var key = code + "|" + cleanOptional(r.plant) + "|" + cleanOptional(r.month);
    prodPlanMap.set(key, (prodPlanMap.get(key) || 0) + (cleanNumber(r.supplyQty) || 0));
  });
  // 현재고 map
  var inventoryMap = new Map();
  inventoryRows.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant);
    if (!code || !plant) return;
    var key = code + "|" + plant;
    var qty = cleanNumber(r.baseQty) || 0, unit = cleanOptional(r.unit) || "";
    var ex = inventoryMap.get(key);
    if (ex) { ex.qty += qty; if (!ex.unit && unit) ex.unit = unit; }
    else inventoryMap.set(key, { qty:qty, unit:unit });
  });
  // 공급계획 map
  var supplyMap = new Map();
  planRows.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant), month = cleanOptional(r.month);
    if (!code || !plant || !month) return;
    var key = code + "|" + plant + "|" + month;
    var qty = cleanNumber(r.supplyQty) || 0, unit = cleanOptional(r.unit) || "";
    var ex = supplyMap.get(key);
    if (ex) { ex.qty += qty; if (!ex.unit && unit) ex.unit = unit; }
    else supplyMap.set(key, { qty:qty, unit:unit });
  });
  // 기준정보 map
  var masterMap = new Map();
  masterRows.forEach(function(r) { if (r.itemCode && !masterMap.has(r.itemCode)) masterMap.set(r.itemCode, r); });

  // ① 대상 품목 검증
  var planKeys9 = new Set(), planKeys7 = new Set(); var missingKeyRows = 0;
  planRows.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant);
    if (!code || !plant) { missingKeyRows++; return; }
    if (code.startsWith("9")) planKeys9.add(code + "|" + plant);
    else if (code.startsWith("7")) planKeys7.add(code + "|" + plant);
  });
  var semiInBomRoot = new Set();
  bomRows.forEach(function(r) { if (r.rootItemCode && r.rootItemCode.startsWith("8")) semiInBomRoot.add(r.rootItemCode); });
  var sec1 = {
    totalRtf:   planKeys9.size + planKeys7.size,
    codes9:     planKeys9.size,
    codes7:     planKeys7.size,
    semiInRoot: semiInBomRoot.size,
    missingKey: missingKeyRows,
    semiList:   Array.from(semiInBomRoot),
  };

  // ② BOM 매칭 검증
  var bomRoots9 = new Set();
  baseBomRows.forEach(function(r) {
    if (r.rootItemCode && r.rootItemCode.startsWith("9")) bomRoots9.add(r.rootItemCode + "|" + r.plant);
  });
  var unmatchedList = [];
  planKeys9.forEach(function(k) {
    if (!bomRoots9.has(k)) { var p = k.split("|"); unmatchedList.push({ code:p[0], plant:p[1] }); }
  });
  var altBomRoots = new Set();
  bomRows.forEach(function(r) {
    if (!r.rootItemCode || !r.rootItemCode.startsWith("9")) return;
    var alt = cleanOptional(r.alternativeBom);
    if (alt !== "" && alt !== "1") altBomRoots.add(r.rootItemCode + "|" + r.plant);
  });
  var missingBase = 0, missingComp = 0, missingCode = 0;
  baseBomRows.forEach(function(r) {
    if (!r.rootItemCode || !r.rootItemCode.startsWith("9")) return;
    if (!r.componentCode || !String(r.componentCode).trim()) { missingCode++; return; }
    var bq = cleanNumber(r.baseQty);
    if (!bq || bq === 0) missingBase++;
    if (cleanNumber(r.componentQty) === null) missingComp++;
  });
  var sec2 = {
    target9:planKeys9.size, matched:planKeys9.size - unmatchedList.length,
    unmatched:unmatchedList.length, multiAlt:altBomRoots.size,
    missingBase:missingBase, missingComp:missingComp, missingCode:missingCode,
    unmatchedList:unmatchedList,
  };

  // ③ BOM 수량 검증 (부족·판단불가 대상)
  var targetItems = items.filter(function(i) { return i.hasAnyShortage || i.unitMismatch || !i.hasInventory; });
  var sec3 = [];
  targetItems.forEach(function(item) {
    baseBomRows.forEach(function(bom) {
      if (!bom.componentCode || bom.componentCode !== item.componentCode || bom.plant !== item.plant) return;
      if (!bom.rootItemCode || !bom.rootItemCode.startsWith("9")) return;
      var baseQty = cleanNumber(bom.baseQty), compQty = cleanNumber(bom.componentQty);
      var ratio = (baseQty && baseQty > 0 && compQty !== null) ? compQty / baseQty : null;
      var totalProd = months.reduce(function(s, m) {
        return s + (prodPlanMap.get(bom.rootItemCode + "|" + bom.plant + "|" + m) || 0);
      }, 0);
      sec3.push({
        rootCode:cleanText(bom.rootItemCode, "확인필요"),
        rootName:cleanText(bom.rootItemName, bom.rootItemCode || "확인필요"),
        compCode:item.componentCode, compName:item.componentName,
        plant:item.plant, baseQty:baseQty, compQty:compQty, ratio:ratio,
        totalProd:totalProd, totalReq:(ratio !== null ? totalProd * ratio : null),
      });
    });
  });

  // ④ 현재고 연결 검증
  var sec4 = items.map(function(item) {
    var inv = inventoryMap.get(item.componentCode + "|" + item.plant);
    return { code:item.componentCode, name:item.componentName, plant:item.plant,
             hasInv:!!inv, qty:inv ? inv.qty : null, unit:inv ? inv.unit : "" };
  });

  // ⑤ 공급계획 연결 검증
  var sec5 = items.map(function(item) {
    var md = months.map(function(m) {
      var sd = supplyMap.get(item.componentCode + "|" + item.plant + "|" + m);
      return { month:m, qty:sd ? sd.qty : null, unit:sd ? sd.unit : "" };
    });
    var hasAny = md.some(function(d) { return d.qty !== null && d.qty > 0; });
    var firstUnit = ""; md.some(function(d) { if (d.unit) { firstUnit = d.unit; return true; } return false; });
    return { code:item.componentCode, name:item.componentName, plant:item.plant,
             hasSupply:hasAny, unit:firstUnit, monthly:md };
  });

  // ⑥ 단위 정합 검증
  var sec6 = items.map(function(item) {
    var inv = inventoryMap.get(item.componentCode + "|" + item.plant);
    var invUnit = inv ? inv.unit : "";
    var firstSupplyUnit = "";
    months.some(function(m) {
      var sd = supplyMap.get(item.componentCode + "|" + item.plant + "|" + m);
      if (sd && sd.unit) { firstSupplyUnit = sd.unit; return true; } return false;
    });
    var master = masterMap.get(item.componentCode);
    var masterUnit = cleanOptional(master ? (master.unit || master.unitOfMeasure || master.baseUnit || "") : "") || "";
    var bomUnit = "";
    baseBomRows.some(function(r) {
      if (r.componentCode === item.componentCode && r.plant === item.plant && r.componentUnit) {
        bomUnit = cleanOptional(r.componentUnit) || ""; return true;
      } return false;
    });
    var compareUnit = invUnit || masterUnit;
    var mismatch = !!(bomUnit && compareUnit && bomUnit.toLowerCase() !== compareUnit.toLowerCase());
    var status = mismatch ? "단위 정합 확인" : (!bomUnit && !invUnit && !firstSupplyUnit) ? "확인필요" : "정상";
    return { code:item.componentCode, name:item.componentName,
             bomUnit:bomUnit||"-", invUnit:invUnit||"-", supplyUnit:firstSupplyUnit||"-",
             masterUnit:masterUnit||"-", mismatch:mismatch, status:status };
  });

  // ⑦ 부족 판정 검증
  var sec7 = items.filter(function(i) { return i.hasAnyShortage || i.unitMismatch || !i.hasInventory; })
    .map(function(item) {
      var inv = inventoryMap.get(item.componentCode + "|" + item.plant);
      var monthly = item.monthlyData.map(function(md) {
        var sd = supplyMap.get(item.componentCode + "|" + item.plant + "|" + md.month);
        var supplyQty = sd ? sd.qty : 0;
        var judgment = item.unitMismatch ? "판단불가"
          : !item.hasInventory ? "연결필요"
          : md.shortageQty === null ? "판단불가"
          : md.shortageQty > 0 ? "부족" : "정상";
        return { month:md.month, required:md.requiredQty, supply:supplyQty,
                 available:md.availableQty, shortage:md.shortageQty, judgment:judgment };
      });
      return { code:item.componentCode, name:item.componentName, plant:item.plant,
               baseQty:inv ? inv.qty : null, unitMismatch:item.unitMismatch,
               hasInv:item.hasInventory, monthly:monthly };
    });

  var summary = {
    targetCount:   items.length,
    bomUnmatched:  sec2.unmatched,
    needInventory: sec4.filter(function(r) { return !r.hasInv; }).length,
    needSupply:    sec5.filter(function(r) { return !r.hasSupply; }).length,
    unitMismatch:  sec6.filter(function(r) { return r.mismatch; }).length,
    uncertain:     items.filter(function(i) { return i.unitMismatch || !i.hasInventory; }).length,
    shortage:      items.filter(function(i) { return i.hasAnyShortage; }).length,
  };
  return { summary:summary, sec1:sec1, sec2:sec2, sec3:sec3, sec4:sec4, sec5:sec5, sec6:sec6, sec7:sec7, months:months };
}

// ── 정합성 검증 패널 렌더 ─────────────────────────────────────────────────────
function renderValidationPanel() {
  if (!state.validationPanelOpen || !state.bomResult || state.bomResult.status !== BOM_STATUS.DONE) return "";
  var vd = computeValidation(), tab = state.validationTab || 0, s = vd.summary;
  var kpiItems = [
    { label:"제약 대상",         v:s.targetCount,   warn:false },
    { label:"BOM 미매칭",        v:s.bomUnmatched,  warn:s.bomUnmatched  > 0 },
    { label:"현재고 연결 필요",  v:s.needInventory, warn:s.needInventory > 0 },
    { label:"공급계획 연결 필요",v:s.needSupply,    warn:s.needSupply    > 0 },
    { label:"단위 정합 확인",    v:s.unitMismatch,  warn:s.unitMismatch  > 0 },
    { label:"판단불가",          v:s.uncertain,     warn:s.uncertain     > 0 },
    { label:"확정 부족",         v:s.shortage,      warn:false, shortage:s.shortage > 0 },
  ];
  var kpiHtml = kpiItems.map(function(k) {
    var cls = k.shortage ? " vld-kpi-shortage" : k.warn ? " vld-kpi-warn" : "";
    return "<div class=\"vld-kpi" + cls + "\"><div class=\"vld-kpi-label\">" + escapeHtml(k.label) +
           "</div><div class=\"vld-kpi-value\">" + k.v + "</div></div>";
  }).join("");
  var tabLabels = ["①대상품목","②BOM매칭","③BOM수량","④현재고","⑤공급계획","⑥단위정합","⑦부족판정"];
  var tabBar = tabLabels.map(function(lbl, i) {
    return "<button type=\"button\" class=\"vld-tab-btn" + (i === tab ? " active" : "") +
           "\" data-vld-tab=\"" + i + "\">" + escapeHtml(lbl) + "</button>";
  }).join("");
  var secData = [vd.sec1, vd.sec2, vd.sec3, vd.sec4, vd.sec5, vd.sec6, vd.sec7];
  var secFns  = [renderVldSec1, renderVldSec2, renderVldSec3, renderVldSec4, renderVldSec5, renderVldSec6, renderVldSec7];
  var content = secFns[tab](secData[tab], vd.months);

  return "<div class=\"vld-overlay\" id=\"validationOverlay\">" +
         "<div class=\"vld-panel\">" +
         "<div class=\"vld-panel-header\"><span class=\"vld-panel-title\">정합성 검증</span>" +
         "<button type=\"button\" class=\"vld-close-btn\" id=\"vldCloseBtn\">✕ 닫기</button></div>" +
         "<div class=\"vld-kpi-bar\">" + kpiHtml + "</div>" +
         "<div class=\"vld-tab-bar\">" + tabBar + "</div>" +
         "<div class=\"vld-content\">" + content + "</div>" +
         "</div></div>";
}

function _vldKVTable(rows) {
  return "<table class=\"vld-table vld-kv-table\"><thead><tr><th>검증 항목</th><th>결과</th><th>비고</th></tr></thead>" +
    "<tbody>" + rows.map(function(r) {
      return "<tr><td class=\"vld-td-label\">" + escapeHtml(r.label) + "</td>" +
             "<td class=\"" + (r.warn ? "vld-td-warn" : "vld-td-ok") + "\">" + escapeHtml(String(r.value)) + "</td>" +
             "<td class=\"vld-td-note\">" + escapeHtml(r.note || "") + "</td></tr>";
    }).join("") + "</tbody></table>";
}

function renderVldSec1(s) {
  return _vldKVTable([
    { label:"RTF 대상 품목 수 (코드+플랜트 기준)", value: s.totalRtf + "건" },
    { label:"완제품 9코드 수", value: s.codes9 + "건" },
    { label:"상품 7코드 수",   value: s.codes7 + "건" },
    { label:"반제품 8코드 BOM 루트 등록",
      value: s.semiInRoot > 0 ? s.semiInRoot + "건 발견" : "없음", warn: s.semiInRoot > 0,
      note:  s.semiInRoot > 0 ? "공급원인 분석은 9코드 완제품 기준으로만 전개함." : "" },
    { label:"품목코드+플랜트 누락 행",
      value: s.missingKey > 0 ? s.missingKey + "행" : "없음", warn: s.missingKey > 0 },
  ]) + (s.semiList && s.semiList.length ?
    "<div class=\"vld-sub-note\">반제품 루트: " + s.semiList.slice(0,10).map(escapeHtml).join(", ") + "</div>" : "");
}

function renderVldSec2(s) {
  var summary = _vldKVTable([
    { label:"9코드 완제품 대상", value: s.target9 + "건" },
    { label:"BOM 매칭 성공",     value: s.matched + "건" },
    { label:"BOM 미매칭",        value: s.unmatched > 0 ? s.unmatched + "건" : "없음", warn: s.unmatched > 0,
      note: s.unmatched > 0 ? "BOM 데이터에 해당 완제품+플랜트 없음." : "" },
    { label:"대체BOM 존재",      value: s.multiAlt > 0 ? s.multiAlt + "건" : "없음", warn: s.multiAlt > 0,
      note: s.multiAlt > 0 ? "기본BOM(1번)만 사용. 대체BOM 제외됨." : "" },
    { label:"BOM 기준수량 누락", value: s.missingBase > 0 ? s.missingBase + "행" : "없음", warn: s.missingBase > 0 },
    { label:"구성요소수량 누락", value: s.missingComp > 0 ? s.missingComp + "행" : "없음", warn: s.missingComp > 0 },
    { label:"구성요소코드 누락", value: s.missingCode > 0 ? s.missingCode + "행" : "없음", warn: s.missingCode > 0,
      note: s.missingCode > 0 ? "해당 행은 집계에서 제외됨." : "" },
  ]);
  var detail = s.unmatchedList.length === 0 ? "" :
    "<div class=\"vld-sub-title\">BOM 미매칭 목록</div>" +
    "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr><th>완제품코드</th><th>플랜트</th></tr></thead><tbody>" +
    s.unmatchedList.slice(0, 50).map(function(r) {
      return "<tr><td>" + escapeHtml(r.code) + "</td><td>" + escapeHtml(displayPlantName(r.plant)) + "</td></tr>";
    }).join("") + "</tbody></table></div>";
  return summary + detail;
}

function renderVldSec3(rows) {
  if (!rows || rows.length === 0) return "<div class=\"vld-empty\">부족·판단불가 대상 없음</div>";
  var bodyHtml = rows.slice(0, 100).map(function(r) {
    return "<tr><td>" + escapeHtml(r.rootCode) + "</td>" +
           "<td class=\"vld-td-left\">" + escapeHtml(r.rootName) + "</td>" +
           "<td>" + escapeHtml(r.compCode) + "</td>" +
           "<td class=\"vld-td-left\">" + escapeHtml(r.compName) + "</td>" +
           "<td class=\"vld-td-r\">" + vldNum(r.baseQty) + "</td>" +
           "<td class=\"vld-td-r\">" + vldNum(r.compQty) + "</td>" +
           "<td class=\"vld-td-r\">" + vldRatio(r.ratio) + "</td>" +
           "<td class=\"vld-td-r\">" + vldNum(r.totalProd) + "</td>" +
           "<td class=\"vld-td-r\">" + vldNum(r.totalReq) + "</td></tr>";
  }).join("");
  return "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr>" +
    "<th>완제품코드</th><th>완제품명</th><th>하위품목코드</th><th>하위품목명</th>" +
    "<th class=\"vld-th-r\">BOM 기준수량</th><th class=\"vld-th-r\">구성요소수량</th>" +
    "<th class=\"vld-th-r\">BOM 환산계수</th><th class=\"vld-th-r\">총생산계획</th><th class=\"vld-th-r\">총필요수량</th>" +
    "</tr></thead><tbody>" + bodyHtml + "</tbody></table></div>" +
    (rows.length > 100 ? "<div class=\"vld-sub-note\">전체 " + rows.length + "건 중 100건 표시</div>" : "");
}

function renderVldSec4(rows) {
  if (!rows || rows.length === 0) return "<div class=\"vld-empty\">제약 대상 없음</div>";
  return "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr>" +
    "<th>하위품목코드</th><th>하위품목명</th><th>플랜트</th><th>현재고 연결</th>" +
    "<th class=\"vld-th-r\">현재고 수량</th><th>단위</th>" +
    "</tr></thead><tbody>" + rows.map(function(r) {
      return "<tr><td>" + escapeHtml(r.code) + "</td>" +
             "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
             "<td>" + escapeHtml(displayPlantName(r.plant)) + "</td>" +
             "<td>" + vldBadge(r.hasInv ? "정상" : "연결필요") + "</td>" +
             "<td class=\"vld-td-r\">" + vldNum(r.qty) + "</td>" +
             "<td>" + escapeHtml(r.unit || "-") + "</td></tr>";
    }).join("") + "</tbody></table></div>";
}

function renderVldSec5(rows, months) {
  if (!rows || rows.length === 0) return "<div class=\"vld-empty\">제약 대상 없음</div>";
  var mHeads = months.map(function(m) { return "<th class=\"vld-th-r\">" + escapeHtml(monthLabel(m)) + "</th>"; }).join("");
  return "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr>" +
    "<th>하위품목코드</th><th>하위품목명</th><th>플랜트</th><th>공급계획 연결</th><th>단위</th>" + mHeads +
    "</tr></thead><tbody>" + rows.map(function(r) {
      var mCells = r.monthly.map(function(md) {
        return "<td class=\"vld-td-r\">" + (md.qty !== null && md.qty > 0 ? vldNum(md.qty) : "-") + "</td>";
      }).join("");
      return "<tr><td>" + escapeHtml(r.code) + "</td>" +
             "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
             "<td>" + escapeHtml(displayPlantName(r.plant)) + "</td>" +
             "<td>" + vldBadge(r.hasSupply ? "정상" : "연결필요") + "</td>" +
             "<td>" + escapeHtml(r.unit || "-") + "</td>" + mCells + "</tr>";
    }).join("") + "</tbody></table></div>";
}

function renderVldSec6(rows) {
  if (!rows || rows.length === 0) return "<div class=\"vld-empty\">제약 대상 없음</div>";
  return "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr>" +
    "<th>하위품목코드</th><th>하위품목명</th>" +
    "<th>BOM 단위</th><th>현재고 단위</th><th>공급계획 단위</th><th>기준정보 단위</th><th>단위 정합</th>" +
    "</tr></thead><tbody>" + rows.map(function(r) {
      return "<tr><td>" + escapeHtml(r.code) + "</td>" +
             "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
             "<td>" + escapeHtml(r.bomUnit) + "</td><td>" + escapeHtml(r.invUnit) + "</td>" +
             "<td>" + escapeHtml(r.supplyUnit) + "</td><td>" + escapeHtml(r.masterUnit) + "</td>" +
             "<td>" + vldBadge(r.status) + "</td></tr>";
    }).join("") + "</tbody></table></div>";
}

function renderVldSec7(rows, months) {
  if (!rows || rows.length === 0) return "<div class=\"vld-empty\">부족·판단불가 대상 없음</div>";
  var mHeads = months.map(function(m) {
    return "<th class=\"vld-month-head\" colspan=\"5\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHeads = months.map(function() {
    return "<th class=\"vld-th-r\">필요</th><th class=\"vld-th-r\">공급계획</th>" +
           "<th class=\"vld-th-r\">가용</th><th class=\"vld-th-r\">부족</th><th>판정</th>";
  }).join("");
  var bodyHtml = rows.map(function(r) {
    var mCells = r.monthly.map(function(md) {
      var avail = md.available === null ? "-" : vldNum(md.available);
      var short = md.shortage === null ? "-"
        : md.shortage > 0 ? "<span class=\"vld-short-num\">" + vldNum(md.shortage) + "</span>" : "-";
      return "<td class=\"vld-td-r\">" + vldNum(md.required) + "</td>" +
             "<td class=\"vld-td-r\">" + (md.supply > 0 ? vldNum(md.supply) : "-") + "</td>" +
             "<td class=\"vld-td-r\">" + avail + "</td>" +
             "<td class=\"vld-td-r\">" + short + "</td>" +
             "<td>" + vldBadge(md.judgment) + "</td>";
    }).join("");
    return "<tr><td>" + escapeHtml(r.code) + "</td>" +
           "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
           "<td>" + escapeHtml(displayPlantName(r.plant)) + "</td>" +
           "<td class=\"vld-td-r\">" + vldNum(r.baseQty) + "</td>" +
           mCells + "</tr>";
  }).join("");
  return "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead>" +
    "<tr><th>하위품목코드</th><th>하위품목명</th><th>플랜트</th><th class=\"vld-th-r\">기초재고</th>" + mHeads + "</tr>" +
    "<tr><th></th><th></th><th></th><th></th>" + subHeads + "</tr>" +
    "</thead><tbody>" + bodyHtml + "</tbody></table></div>";
}

// ── 결과 표 섹션 ─────────────────────────────────────────────────────────────
function renderConstraintTableSection(result, bomStatus, months) {
  var isRunning = bomStatus === BOM_STATUS.RUNNING;
  var isDone    = bomStatus === BOM_STATUS.DONE;
  var lastTime  = isDone && result && result.completedAt
    ? result.completedAt.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit", second:"2-digit" })
    : null;
  var statusLabel = { idle:"미실행", running:"진행중", done:"완료", failed:"실패" }[bomStatus] || "-";
  var statusCls   = isDone ? " cst-status-done" : bomStatus === BOM_STATUS.FAILED ? " cst-status-fail" : "";

  var headerRight = "<div class=\"cst-sec-actions\">" +
    "<span class=\"cst-status-badge" + statusCls + "\">전개상태: " + escapeHtml(statusLabel) + "</span>" +
    (lastTime ? "<span class=\"cst-status-time\">마지막 전개: " + escapeHtml(lastTime) + "</span>" : "") +
    (isDone ? "<button type=\"button\" id=\"validationBtn\" class=\"cst-validate-btn\">정합성 검증</button>" : "") +
    "<button type=\"button\" id=\"bomExpandBtn\" class=\"cst-bom-btn" + (isRunning ? " running" : "") + "\"" +
    (isRunning ? " disabled" : "") + ">BOM 전개</button></div>";

  var tableContent = "";
  if (bomStatus === BOM_STATUS.IDLE) {
    tableContent = "<div class=\"cst-guide-box\">BOM 전개 전입니다. 기준월과 대상기간을 확인한 뒤 BOM 전개 버튼을 눌러 공급제약 대상을 산출하십시오.</div>";
  } else if (bomStatus === BOM_STATUS.RUNNING) {
    tableContent = "<div class=\"cst-progress-box\"><div class=\"cst-spinner\"></div>" +
                   "<span class=\"cst-progress-label\">" + escapeHtml(state.bomProgressStep || "BOM 전개 중") + "</span></div>";
  } else if (bomStatus === BOM_STATUS.FAILED) {
    var reasons = ((result && result.failReasons) || []).map(function(r) { return "<li>" + escapeHtml(r) + "</li>"; }).join("");
    tableContent = "<div class=\"cst-fail-box\"><p>BOM 전개를 완료할 수 없습니다. 필수 데이터 연결 상태를 확인하십시오.</p>" +
                   (reasons ? "<ul class=\"cst-fail-list\">" + reasons + "</ul>" : "") + "</div>";
  } else if (isDone && result) {
    var detailMode = state.constraintDetailMode;
    var filtered   = filterConstraintItems(result.items);
    tableContent   = renderConstraintFilterBar(result.items) +
                     renderConstraintTableBody(filtered, months, detailMode);
  }

  return "<section class=\"cst-card cst-table-block\">" +
         "<div class=\"cst-sec-title\">BOM 전개 공급원인 분석" + headerRight + "</div>" +
         tableContent + "</section>";
}

// ── 결과 표 본문 ─────────────────────────────────────────────────────────────
function renderConstraintTableBody(items, months, detailMode) {
  var leftPos = 0;
  var cols = CONSTR_LEFT_COLS.map(function(c) { var r = Object.assign({}, c, { left:leftPos }); leftPos += c.width; return r; });
  var totalLeftW = leftPos;
  var impactSortState = state.constraintImpactSort || 0;
  var sortIcon = impactSortState === 1 ? " ↓" : impactSortState === -1 ? " ↑" : " ↕";

  var monthColW   = detailMode ? CONSTR_METRIC_W : CONSTR_COMPACT_W;
  var monthColCnt = detailMode ? CONSTR_METRICS.length : 1;
  var totalCols   = cols.length + months.length * monthColCnt;
  var minW        = totalLeftW + months.length * monthColCnt * monthColW;

  var colgroup = cols.map(function(c) { return "<col style=\"width:" + c.width + "px;\">"; }).join("") +
    months.reduce(function(acc) {
      for (var i = 0; i < monthColCnt; i++) acc += "<col style=\"width:" + monthColW + "px;\">";
      return acc;
    }, "");

  var leftHeaders = cols.map(function(col) {
    var aCls = col.align === "left" ? " cst-cell-left" : "";
    var xCls = col.isName ? " cst-col-name" : col.isLast ? " cst-col-last-sticky" : "";
    var label = escapeHtml(col.label);
    if (col.sortable) {
      label = "<span class=\"cst-sort-th\" data-sort-impact=\"1\">" + label + escapeHtml(sortIcon) + "</span>";
    }
    return "<th class=\"cst-sticky" + aCls + xCls + "\" style=\"left:" + col.left + "px;width:" + col.width + "px;\" rowspan=\"" + (detailMode ? 2 : 1) + "\">" + label + "</th>";
  }).join("");

  var monthHead, subHead = "";
  if (detailMode) {
    monthHead = months.map(function(m, mi) {
      return "<th class=\"cst-month-head" + (mi > 0 ? " cst-month-start" : "") + "\" colspan=\"" + CONSTR_METRICS.length + "\">" +
             escapeHtml(monthLabel(m)) + "</th>";
    }).join("");
    subHead = "<tr>" + months.map(function(_, mi) {
      return CONSTR_METRICS.map(function(metric, ci) {
        return "<th class=\"cst-sub-head" + (metric === "부족" ? " cst-key-sub" : "") +
               (ci === 0 && mi > 0 ? " cst-month-start" : "") + "\">" + escapeHtml(metric) + "</th>";
      }).join("");
    }).join("") + "</tr>";
  } else {
    monthHead = months.map(function(m, mi) {
      return "<th class=\"cst-month-head" + (mi > 0 ? " cst-month-start" : "") + "\">" +
             escapeHtml(monthLabel(m)) + "</th>";
    }).join("");
  }

  var bodyRows;
  if (!items.length) {
    bodyRows = "<tr><td colspan=\"" + totalCols + "\" class=\"cst-empty\">공급 제약 대상이 없습니다</td></tr>";
  } else {
    bodyRows = items.map(function(item) {
      var compKey    = item.componentCode + "|" + item.plant;
      var isExpanded = state.expandedConstraintRows && state.expandedConstraintRows.has(compKey);
      var unitTitle  = item.unitMismatch
        ? "BOM 단위와 현재고/공급계획 단위가 일치하지 않아 부족수량 계산이 불가능합니다."
        : item.unitMissing ? "단위 기준정보가 없어 단위 정합성을 확인할 수 없습니다." : "";
      var parentTooltip = "영향 품목군: " + (item.parentItemGroup === NEED_MASTER ? "확인필요" : item.parentItemGroup) +
                          "\n대표 영향품목: " + (item.parentItems.length > 0 ? item.parentItems[0].name : "-");

      var leftCells = cols.map(function(col) {
        var aCls = col.align === "left" ? " cst-cell-left" : "";
        var xCls = col.isName ? " cst-col-name" : col.isLast ? " cst-col-last-sticky" : "";
        var value = "", extra = "", titleAttr = "";
        if      (col.key === "plant")        value = displayPlantName(item.plant);
        else if (col.key === "itemCategory") value = item.displayCategory;
        else if (col.key === "shareType")    value = item.isShared ? "공용" : "전용";
        else if (col.key === "code")         value = item.componentCode;
        else if (col.key === "name") {
          value = item.componentName;
          titleAttr = " title=\"" + escapeHtml(item.componentName + "\n" + parentTooltip) + "\"";
        }
        else if (col.key === "unit") {
          value = item.unit;
          if (unitTitle) titleAttr = " title=\"" + escapeHtml(unitTitle) + "\"";
        }
        else if (col.key === "impactCount") {
          var icon = isExpanded ? "▲" : "▼";
          extra = "<button type=\"button\" class=\"cst-expand-btn\" data-comp-key=\"" + escapeHtml(compKey) +
                  "\" title=\"영향 완제품 목록 " + (isExpanded ? "접기" : "펼치기") + "\">" + icon + "</button>";
          value = String(item.parentItems.length);
          titleAttr = " title=\"" + escapeHtml(parentTooltip) + "\"";
        }
        else if (col.key === "note") {
          var shortLabel = shortNoteLabel(item.note);
          value = shortLabel;
          if (item.note && item.note !== "-") titleAttr = " title=\"" + escapeHtml(item.note) + "\"";
        }
        var unitWarnCls = (col.key === "unit" && (item.unitMismatch || item.unitMissing)) ? " cst-unit-warn" : "";
        return "<td class=\"cst-sticky cst-td" + aCls + xCls + unitWarnCls + "\" style=\"left:" + col.left + "px;width:" + col.width + "px;\"" + titleAttr + ">" +
               extra + escapeHtml(value) + "</td>";
      }).join("");

      var metricCells;
      if (detailMode) {
        metricCells = item.monthlyData.map(function(md, mi) {
          return CONSTR_METRICS.map(function(metric, ci) {
            var borderCls = ci === 0 && mi > 0 ? " cst-month-start" : "";
            var value = "-", cls = "cst-metric-cell";
            if (metric === "필요") {
              value = md.requiredQty > 0 ? formatNumber(Math.round(md.requiredQty)) : "-";
            } else if (metric === "가용") {
              if (item.unitMismatch || md.availableQty === null) { value = "판단불가"; cls += " cst-neutral-cell"; }
              else value = formatNumber(Math.round(md.availableQty));
            } else {
              if (item.unitMismatch || md.shortageQty === null) { value = "판단불가"; cls += " cst-neutral-cell"; }
              else if (md.shortageQty > 0)  { value = formatNumber(Math.round(md.shortageQty)); cls += " cst-shortage-cell"; }
              else                          { value = "-"; cls += " cst-neutral-cell"; }
            }
            return "<td class=\"" + cls + borderCls + "\">" + escapeHtml(value) + "</td>";
          }).join("");
        }).join("");
      } else {
        metricCells = item.monthlyData.map(function(md, mi) {
          var borderCls = mi > 0 ? " cst-month-start" : "";
          var cell = compactCellValue(item, md);
          return "<td class=\"cst-compact-cell " + cell.cls + borderCls + "\">" + escapeHtml(cell.text) + "</td>";
        }).join("");
      }

      var rowCls = !item.hasInventory ? "cst-row-nodata" : item.isShared ? "cst-row-shared" : "cst-row-dedicated";
      var mainRow = "<tr class=\"" + rowCls + "\" data-comp-key=\"" + escapeHtml(compKey) + "\">" + leftCells + metricCells + "</tr>";

      var detailRow = "";
      if (isExpanded && item.parentItems.length > 0) {
        // 필요수량 합계 기준 내림차순 정렬, 최대 20개
        var sortedParents = item.parentItems.slice().sort(function(a, b) {
          var aReq = a.monthly.reduce(function(s, m) { return s + m.reqQty; }, 0);
          var bReq = b.monthly.reduce(function(s, m) { return s + m.reqQty; }, 0);
          return bReq - aReq;
        });
        var EXPAND_LIMIT = 20;
        var hasMore = sortedParents.length > EXPAND_LIMIT;
        var shownParents = sortedParents.slice(0, EXPAND_LIMIT);
        var totalShown = shownParents.length;

        // 품목군 연속 동일값 rowspan 계산
        var groupRowspan = new Array(totalShown).fill(1);
        var groupSkip    = new Array(totalShown).fill(false);
        for (var gi = 0; gi < totalShown; gi++) {
          if (groupSkip[gi]) continue;
          var gSpan = 1;
          for (var gj = gi + 1; gj < totalShown; gj++) {
            if (shownParents[gj].itemGroup === shownParents[gi].itemGroup) { gSpan++; groupSkip[gj] = true; }
            else break;
          }
          groupRowspan[gi] = gSpan;
        }

        var detailMonthHeads = months.map(function(m) {
          return "<th class=\"cst-dtl-month\" colspan=\"2\">" + escapeHtml(monthLabel(m)) + "</th>";
        }).join("");
        var detailSubHeads = months.map(function() {
          return "<th class=\"cst-dtl-sub\">생산계획</th><th class=\"cst-dtl-sub\">필요수량</th>";
        }).join("");

        var detailBodyRows = shownParents.map(function(p, pi) {
          var monthlyCells = p.monthly.map(function(md) {
            return "<td class=\"cst-dtl-num\">" + (md.prodQty > 0 ? formatNumber(Math.round(md.prodQty)) : "-") + "</td>" +
                   "<td class=\"cst-dtl-num\">" + (md.reqQty  > 0 ? formatNumber(Math.round(md.reqQty))  : "-") + "</td>";
          }).join("");

          // 품목군: 연속 동일값이면 첫 행에서만 rowspan 셀 출력
          var groupCell = groupSkip[pi] ? "" :
            "<td class=\"cst-dtl-info cst-dtl-center\" rowspan=\"" + groupRowspan[pi] + "\">" +
            escapeHtml(p.itemGroup === NEED_MASTER ? "확인필요" : p.itemGroup) + "</td>";

          // 단위: 항상 동일값이므로 첫 행에서만 rowspan=전체로 출력
          var unitCell = pi === 0 ?
            "<td class=\"cst-dtl-info cst-dtl-center cst-dtl-unit\" rowspan=\"" + totalShown + "\">" + escapeHtml(item.unit) + "</td>" : "";

          return "<tr class=\"cst-detail-data-row\">" +
                 "<td class=\"cst-dtl-info cst-dtl-center\" title=\"" + escapeHtml(p.code) + "\">" + escapeHtml(p.code) + "</td>" +
                 "<td class=\"cst-dtl-info cst-dtl-name\" title=\"" + escapeHtml(p.name) + "\">" + escapeHtml(p.name) + "</td>" +
                 groupCell + unitCell + monthlyCells + "</tr>";
        }).join("");

        var moreMsg = hasMore ? "<div class=\"cst-detail-more\">전체 " + sortedParents.length + "개 중 " + EXPAND_LIMIT + "개 표시</div>" : "";

        detailRow = "<tr class=\"cst-detail-row\"><td colspan=\"" + totalCols + "\" class=\"cst-detail-cell\">" +
                    "<div class=\"cst-detail-inner\"><table class=\"cst-detail-table\"><thead>" +
                    "<tr class=\"cst-detail-head\">" +
                    "<th class=\"cst-dtl-info-h\" rowspan=\"2\">완제품 코드</th>" +
                    "<th class=\"cst-dtl-info-h\" rowspan=\"2\">완제품명</th>" +
                    "<th class=\"cst-dtl-info-h\" rowspan=\"2\">품목군</th>" +
                    "<th class=\"cst-dtl-info-h cst-dtl-unit\" rowspan=\"2\">단위</th>" +
                    detailMonthHeads + "</tr>" +
                    "<tr class=\"cst-detail-head\">" + detailSubHeads + "</tr>" +
                    "</thead><tbody>" + detailBodyRows + "</tbody></table>" + moreMsg + "</div></td></tr>";
      }

      return mainRow + detailRow;
    }).join("");
  }

  return "<div class=\"cst-h-scroll\"><table class=\"cst-table\" style=\"min-width:" + minW + "px;\">" +
         "<colgroup>" + colgroup + "</colgroup>" +
         "<thead><tr>" + leftHeaders + monthHead + "</tr>" + subHead + "</thead>" +
         "<tbody>" + bodyRows + "</tbody></table></div>";
}

// ── 화면 렌더 ─────────────────────────────────────────────────────────────────
function renderConstraint() {
  var hasData   = state.mappedData.plan_monthly.length > 0;
  var bomStatus = state.bomStatus || BOM_STATUS.IDLE;
  var months    = getRtfMonths();

  return "<div class=\"cst-screen\">" +
    "<div class=\"cst-toolbar\">" +
    "<button type=\"button\" class=\"adj-candidate-btn cst-adj-btn-sub\" disabled title=\"조정입력 연계 기능은 후속 단계에서 구현 예정입니다.\">조정안에 담기</button>" +
    (!hasData ? "<span class=\"cst-toolbar-warn\">데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 먼저 선택하십시오.</span>" : "") +
    "</div>" +
    "<section class=\"cst-card cst-top\">" +
    "<h2 class=\"cst-title\">공급제한 원인 분석</h2>" +
    "<div class=\"cst-meta\">기준월: " + escapeHtml(months[0]) + " | 대상기간: " + escapeHtml(months.map(monthLabel).join(" ~ ")) + "</div>" +
    "<div class=\"cst-notice\">현재 계획 기준 BOM 전개 결과입니다. 공급계획 조정 및 조정 후 영향은 조정입력/조정영향 화면에서 검토합니다.</div>" +
    "</section>" +
    (bomStatus === BOM_STATUS.DONE && state.bomResult ? renderConstraintSummaryCard(state.bomResult) : "") +
    renderConstraintTableSection(state.bomResult, bomStatus, months) +
    renderValidationPanel() +
    "</div>";
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindConstraint() {
  // BOM 전개 버튼
  var bomBtn = document.querySelector("#bomExpandBtn");
  if (bomBtn) bomBtn.addEventListener("click", function() {
    if (state.bomStatus === BOM_STATUS.RUNNING) return;
    var myId  = ++_bomAnimId;
    var steps = ["데이터 확인 중","소요량 산출 중","가용수량 비교 중","공용자재 확인 중"];
    var stepIdx = 0;
    state.bomStatus       = BOM_STATUS.RUNNING;
    state.bomProgressStep = "BOM 전개 중";
    state.expandedConstraintRows = new Set();
    render("constraint");

    var advance = function() {
      if (myId !== _bomAnimId) return;
      if (stepIdx < steps.length) {
        state.bomProgressStep = steps[stepIdx++];
        render("constraint");
        setTimeout(advance, 160);
      } else {
        var res = computeBomExpansion();
        state.bomResult       = res;
        state.bomStatus       = res.status;
        state.bomProgressStep = "";
        state.constraintSearch = "";
        state.constraintDetailMode = false;
        state.constraintImpactSort = 0;
        // 부족 건 있으면 "부족만" 필터 자동 선택
        state.constraintFilter = (res.items && res.items.some(function(i) { return i.hasAnyShortage; })) ? "shortage" : "all";
        render("constraint");
      }
    };
    setTimeout(advance, 100);
  });

  // 필터 버튼
  document.querySelectorAll("[data-cst-filter]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      state.constraintFilter = btn.dataset.cstFilter;
      render("constraint");
    });
  });

  // 검색
  var searchInput = document.querySelector("#cstSearch");
  if (searchInput) searchInput.addEventListener("input", function(e) {
    state.constraintSearch = e.target.value;
    render("constraint");
  });

  // 상세보기 토글
  var toggleBtn = document.querySelector("#cstDetailToggle");
  if (toggleBtn) toggleBtn.addEventListener("click", function() {
    state.constraintDetailMode = !state.constraintDetailMode;
    render("constraint");
  });

  // 영향품목수 정렬 (0→1→-1→0)
  document.querySelectorAll("[data-sort-impact]").forEach(function(el) {
    el.addEventListener("click", function() {
      var cur = state.constraintImpactSort || 0;
      state.constraintImpactSort = cur === 0 ? 1 : cur === 1 ? -1 : 0;
      render("constraint");
    });
  });

  // 정합성 검증 버튼
  var valBtn = document.querySelector("#validationBtn");
  if (valBtn) valBtn.addEventListener("click", function() {
    state.validationPanelOpen = true;
    state.validationTab = 0;
    render("constraint");
  });

  // 패널 닫기
  var closeBtn = document.querySelector("#vldCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", function() {
    state.validationPanelOpen = false;
    render("constraint");
  });
  // 오버레이 배경 클릭으로 닫기
  var overlay = document.querySelector("#validationOverlay");
  if (overlay) overlay.addEventListener("click", function(e) {
    if (e.target === overlay) { state.validationPanelOpen = false; render("constraint"); }
  });

  // 검증 탭 전환
  document.querySelectorAll("[data-vld-tab]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      state.validationTab = parseInt(btn.dataset.vldTab, 10) || 0;
      render("constraint");
    });
  });

  // 영향품목 펼침
  document.querySelectorAll(".cst-expand-btn").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var key = btn.dataset.compKey;
      if (!state.expandedConstraintRows) state.expandedConstraintRows = new Set();
      if (state.expandedConstraintRows.has(key)) state.expandedConstraintRows.delete(key);
      else state.expandedConstraintRows.add(key);
      render("constraint");
    });
  });
}
