// ── 전개 상태 상수 ────────────────────────────────────────────────────────────
var BOM_STATUS = { IDLE:"idle", RUNNING:"running", DONE:"done", FAILED:"failed" };
var _bomAnimId = 0;

// ── 컬럼 / 메트릭 정의 ───────────────────────────────────────────────────────
// 기본 표시 컬럼 (영향 품목군·대표 영향품목 제거 → 영향품목수 tooltip/펼침에서 확인)
var CONSTR_LEFT_COLS = [
  { key:"plant",        label:"플랜트",       width:60,  align:"center" },
  { key:"itemCategory", label:"제약대상 유형", width:80, align:"center" },
  { key:"shareType",    label:"공용/전용",     width:60,  align:"center" },
  { key:"code",         label:"자재코드",      width:90,  align:"center" },
  { key:"name",         label:"자재명",        width:140, align:"left",  isName:true },
  { key:"unit",         label:"단위",          width:52,  align:"center" },
  { key:"impactCount",  label:"영향품목수",    width:60,  align:"center", sortable:true, isLast:true },
];
var CONSTR_COMPACT_W = 140;  // 압축 모드 월별 컬럼 너비 (자재 부족 표시용)
var CONSTR_METRIC_W  = 72;  // 상세 모드 지표 컬럼 너비
var CONSTR_METRICS       = ["필요","가용","부족"];
var CONSTR_METRICS_LABEL = { "필요":"총 자재 필요수량", "가용":"가용수량", "부족":"자재 부족수량" };

// ── 제약대상 유형 표시 매핑 ──────────────────────────────────────────────────
// 단글자 코드(L/N/D/R/U/T)는 임의 추정이므로 제외. SAP 표준코드·한글만 허용.
var ITEM_CATEGORY_DISPLAY = {
  "ROH":"원료","HALB":"반제품","FERT":"완제품","HIBE":"자재","VERP":"포장재",
  "NLAG":"자재","UNBW":"자재",
  "원료":"원료","주원료":"원료","부원료":"원료",
  "자재":"자재","소모품":"자재","판촉물":"자재",
  "포장재":"포장재",
  "반제품":"반제품","반제품(구매)":"반제품(구매)","세미":"반제품",
  "재공품":"재공품",
  "완제품":"완제품","완제품(수탁)":"완제품(수탁)",
  "상품":"상품","상품공급":"상품",
};
var _DISPLAY_VALID = new Set(["원료","자재","포장재","반제품","반제품(구매)","재공품","완제품","완제품(수탁)","상품","기준정보"]);

function displayItemCategory(raw) {
  if (!raw || raw === NEED_MASTER) return "품목유형 확인 필요";
  var t = String(raw).trim();
  if (!t) return "품목유형 확인 필요";
  var mapped = ITEM_CATEGORY_DISPLAY[t] || ITEM_CATEGORY_DISPLAY[t.toUpperCase()];
  if (mapped) return mapped;
  return _DISPLAY_VALID.has(t) ? t : "품목유형 확인 필요";
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

  // 반제품 하위 BOM 맵 (비9코드 루트 — 추가전개 기준 데이터)
  var semiBomRowsMap = new Map();  // semiCode|plant → [baseBomRow, ...]
  var codesWithSubBom = new Set(); // 정합성 검증용 유지
  bomRows.forEach(function(r) {
    if (!r.rootItemCode || r.rootItemCode.startsWith("9")) return;
    var alt = cleanOptional(r.alternativeBom);
    if (alt !== "" && alt !== "1") return;
    codesWithSubBom.add(r.rootItemCode);
    if (!r.componentCode || !String(r.componentCode).trim()) return;
    var semiKey = r.rootItemCode + "|" + r.plant;
    if (!semiBomRowsMap.has(semiKey)) semiBomRowsMap.set(semiKey, []);
    semiBomRowsMap.get(semiKey).push(r);
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

  // 하위 자재 공급계획 연결 여부 추적 (자재+플랜트 단위, 완제품 9코드 제외)
  var compSupplyKeys = new Set();
  planRows.forEach(function(row) {
    var code = cleanOptional(row.itemCode), plant = cleanOptional(row.plant);
    if (!code || !plant || code.startsWith("9")) return;
    compSupplyKeys.add(code + "|" + plant);
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

  // ── 루트별 구성품 코드 집합 (다단계 BOM 감지용)
  var rootCompSet = new Map();
  baseBomRows.forEach(function(r) {
    if (!r.rootItemCode || !r.rootItemCode.startsWith("9")) return;
    if (!r.componentCode || !String(r.componentCode).trim()) return;
    var rk = r.rootItemCode + "|" + r.plant;
    if (!rootCompSet.has(rk)) rootCompSet.set(rk, new Set());
    rootCompSet.get(rk).add(r.componentCode);
  });

  // ── 반제품/재공품 판별 헬퍼
  var _SEMI_DISP = new Set(["반제품", "재공품"]);
  var _isSemi = function(code, catFromBom) {
    if (catFromBom && _SEMI_DISP.has(displayItemCategory(catFromBom))) return true;
    var m = masterMap.get(code);
    if (m) {
      var mc = cleanOptional(m.itemCategory || m.category || "");
      if (mc && _SEMI_DISP.has(displayItemCategory(mc))) return true;
    }
    return false;
  };

  // ── BOM 구조 통계 (정합성 검증용)
  var bomStat = {
    multiLevelRoots:  new Set(),  // 다단계 BOM 감지된 루트
    singleLevelRoots: new Set(),  // 반제품 추가전개 필요 루트
    semiExpanded:     new Set(),  // 추가전개 완료된 반제품
    semiNoSubBom:     new Set(),  // 하위 BOM 없는 반제품
    dupExactCount:    0,
    dupInRootCount:   0,
    _dupInRoot:       new Map(),
  };
  var _seenExact = new Set();

  // ── 구성품별 소요량 집계 (혼합형 다단계 BOM)
  var compReqs = new Map();
  var missingCompCodeCount = 0;

  // 소요량 등록 내부 헬퍼
  var _addComp = function(code, name, unit, cat, plant, rootKey, rootCode, rootName, rootGroup, effRatio) {
    var ck = code + "|" + plant;
    if (!compReqs.has(ck)) {
      compReqs.set(ck, {
        componentCode:   code,
        componentName:   name || code,
        plant:           plant,
        itemCategory:    cleanOptional(cat),
        bomUnit:         cleanOptional(unit) || "",
        parentItems:     new Map(),
        requiredByMonth: new Map(),
      });
    }
    var comp = compReqs.get(ck);
    if (!comp.bomUnit && unit) comp.bomUnit = cleanOptional(unit) || "";
    if (!comp.parentItems.has(rootKey)) {
      comp.parentItems.set(rootKey, {
        code: rootCode, name: rootName, plant: plant, itemGroup: rootGroup, monthly: new Map(),
      });
    }
    var pi = comp.parentItems.get(rootKey);
    months.forEach(function(month) {
      var prodQty = prodPlanMap.get(rootCode + "|" + plant + "|" + month) || 0;
      var addReq  = prodQty * effRatio;
      comp.requiredByMonth.set(month, (comp.requiredByMonth.get(month) || 0) + addReq);
      if (!pi.monthly.has(month)) pi.monthly.set(month, { prodQty:prodQty, reqQty:0 });
      pi.monthly.get(month).reqQty += addReq;
    });
  };

  baseBomRows.forEach(function(bom) {
    if (!bom.rootItemCode || !bom.rootItemCode.startsWith("9")) return;
    if (!bom.componentCode || !String(bom.componentCode).trim()) { missingCompCodeCount++; return; }

    // 완전 중복 행 제거
    var exactKey = bom.rootItemCode + "|" + bom.componentCode + "|" + bom.componentQty + "|" + bom.baseQty + "|" + bom.plant;
    if (_seenExact.has(exactKey)) { bomStat.dupExactCount++; return; }
    _seenExact.add(exactKey);

    var rootKey    = bom.rootItemCode + "|" + bom.plant;
    var parent     = finishedItemMap.get(rootKey);
    var rootMaster = masterMap.get(bom.rootItemCode);
    var rootName   = parent ? parent.name : bom.rootItemCode;
    var rootGroup  = cleanText(rootMaster ? rootMaster.itemGroup : null, NEED_MASTER);
    var ratio      = bom.baseQty > 0 ? bom.componentQty / bom.baseQty : (bom.componentQty || 0);

    // 동일 Root 내 반복 자재 집계 (필요수량은 합산, 카운트만)
    if (!bomStat._dupInRoot.has(rootKey)) bomStat._dupInRoot.set(rootKey, new Set());
    var rootSeen = bomStat._dupInRoot.get(rootKey);
    if (rootSeen.has(bom.componentCode)) bomStat.dupInRootCount++;
    else rootSeen.add(bom.componentCode);

    // ── 반제품/재공품 혼합형 다단계 BOM 처리
    if (_isSemi(bom.componentCode, bom.itemCategory)) {
      var semiSubs  = semiBomRowsMap.get(bom.componentCode + "|" + bom.plant);
      var rootComps = rootCompSet.get(rootKey);

      // 다단계 감지: 이 반제품의 하위 원료가 이미 같은 Root 안에 포함되어 있는가
      var isTransit = !!(semiSubs && semiSubs.some(function(sr) {
        return sr.componentCode && rootComps && rootComps.has(sr.componentCode);
      }));

      if (isTransit) {
        // 경유 단계 — 반제품 행 건너뜀 (하위 원료는 별도 BOM 행으로 이미 집계됨)
        bomStat.multiLevelRoots.add(rootKey);
        return;
      }

      // 단일 단계 — 추가 전개 필요
      bomStat.singleLevelRoots.add(rootKey);

      if (semiSubs && semiSubs.length) {
        // 반제품 하위 BOM 발견 → 연쇄 계수로 원료/자재 전개
        bomStat.semiExpanded.add(bom.componentCode + "|" + bom.plant);
        semiSubs.forEach(function(sub) {
          if (!sub.componentCode || !String(sub.componentCode).trim()) return;
          var subR = sub.baseQty > 0 ? sub.componentQty / sub.baseQty : (sub.componentQty || 0);
          _addComp(sub.componentCode, sub.componentName, sub.componentUnit, sub.itemCategory,
                   bom.plant, rootKey, bom.rootItemCode, rootName, rootGroup, ratio * subR);
        });
        return; // 반제품 자체는 집계 제외
      }

      // 하위 BOM 없음 → 반제품을 부족 판정 대상으로 유지하며 경고 부착
      bomStat.semiNoSubBom.add(bom.componentCode + "|" + bom.plant);
      // fall through — 반제품을 일반 자재처럼 집계
    }

    // 일반 집계 (원료·자재 또는 하위 BOM 없는 반제품)
    _addComp(bom.componentCode, bom.componentName, bom.componentUnit, bom.itemCategory,
             bom.plant, rootKey, bom.rootItemCode, rootName, rootGroup, ratio);
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

    // 반제품 하위 BOM 연결 필요 (추가전개 시도 후 BOM 없음)
    var needsSemiBom = bomStat.semiNoSubBom.has(comp.componentCode + "|" + comp.plant);

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
    // 현재고·입고계획 모두 연결되어야 부족 확정 가능 — 하나라도 없으면 판단불가
    var hasSupplyPlan = compSupplyKeys.has(comp.componentCode + "|" + comp.plant);
    var monthlyData = [], hasAnyShortage = false, totalShortage = 0;
    if (unitMismatch) {
      months.forEach(function(month) {
        var requiredQty = comp.requiredByMonth.get(month) || 0;
        monthlyData.push({ month:month, requiredQty:requiredQty, availableQty:null, shortageQty:null });
      });
    } else {
      var openingQty = baseQty;
      // canCompute: 현재고·입고계획 둘 다 연결된 경우만 계산
      var canCompute = (openingQty !== null) && hasSupplyPlan;
      months.forEach(function(month) {
        var requiredQty = comp.requiredByMonth.get(month) || 0;
        var availableQty = null, shortageQty = null;
        if (canCompute) {
          var sd        = compSupplyMap.get(comp.componentCode + "|" + comp.plant + "|" + month);
          var supplyQty = sd ? sd.qty : 0;
          availableQty  = openingQty + supplyQty;
          shortageQty   = Math.max(requiredQty - availableQty, 0);
          var endingQty = Math.max(availableQty - requiredQty, 0);
          if (shortageQty > 0) { hasAnyShortage = true; totalShortage += shortageQty; }
          openingQty = endingQty;
        }
        monthlyData.push({ month:month, requiredQty:requiredQty, availableQty:availableQty, shortageQty:shortageQty });
      });
    }

    var hasReq = monthlyData.some(function(md) { return md.requiredQty > 0; });
    if (!hasReq) return;

    // 품목유형 판별 (임의 추정 금지)
    var categoryDisplay = displayItemCategory(comp.itemCategory);
    var categoryUnknown = categoryDisplay === "품목유형 확인 필요";
    // 반제품 조달구분 확인 필요: 하위 BOM 없는 반제품 (구매/자체 구분 불가)
    var needsProvenanceCheck = needsSemiBom;

    // 확인 필요사항
    var notes = [];
    if (!hasInv)                                  notes.push("현재고 연결 필요");
    if (!hasSupplyPlan)                           notes.push("입고계획 확인 필요");
    if (needsProvenanceCheck)                     notes.push("반제품 조달구분 확인 필요");
    if (categoryUnknown)                          notes.push("품목유형 확인 필요");
    if (isShared && hasAnyShortage)               notes.push("공통자재 부족 발생. 완제품별 배분기준 확인 필요");
    if (hasAltBom)                                notes.push("대체 BOM 존재. 적용 기준 확인 필요");
    if (unitMismatch)                             notes.push("단위 정합 확인 필요");
    else if (unitMissing && !unitMismatch)        notes.push("단위 기준정보 확인 필요");

    var needsMaster = !comp.itemCategory || comp.itemCategory === NEED_MASTER || categoryUnknown;
    var parentArrResult = parentArr.map(function(p) {
      var pMaster = masterMap.get(p.code);
      var pUnit   = cleanOptional(pMaster ? (pMaster.unit || pMaster.unitOfMeasure || pMaster.baseUnit || "") : "") || "EA";
      return {
        code:      p.code,
        name:      p.name,
        plant:     p.plant,
        itemGroup: p.itemGroup,
        unit:      pUnit,
        monthly:   months.map(function(m) { return Object.assign({ month:m }, p.monthly.get(m) || { prodQty:0, reqQty:0 }); }),
      };
    });

    var resolvedCompName = cleanText(comp.componentName, null);
    if (!resolvedCompName) resolvedCompName = "자재명 확인필요";

    resultItems.push({
      plant:                comp.plant,
      componentCode:        comp.componentCode,
      componentName:        resolvedCompName,
      itemCategory:         comp.itemCategory,
      displayCategory:      categoryDisplay,
      categoryUnknown:      categoryUnknown,
      parentItemGroup:      parentItemGroup,
      unit:                 resolvedUnit,
      unitMismatch:         unitMismatch,
      unitMissing:          unitMissing,
      isShared:             isShared,
      parentItems:          parentArrResult,
      hasInventory:         hasInv,
      hasSupplyPlan:        hasSupplyPlan,
      monthlyData:          monthlyData,
      hasAnyShortage:       hasAnyShortage,
      totalShortage:        totalShortage,
      hasAltBom:            hasAltBom,
      hasSemiSubBom:        needsSemiBom,
      needsProvenanceCheck: needsProvenanceCheck,
      needsMaster:          needsMaster,
      notes:                notes,
      note:                 notes.join(" | "),
    });
  });

  // 제약 대상: 부족 확정·현재고/입고계획 미연결·단위 불일치·반제품 조달구분 확인 필요
  var constraintItems = resultItems.filter(function(i) {
    return i.hasAnyShortage || !i.hasInventory || !i.hasSupplyPlan || i.unitMismatch || i.needsProvenanceCheck;
  });
  var sorted = sortConstraintItems(constraintItems);

  result.status      = BOM_STATUS.DONE;
  result.completedAt = new Date();
  result.items       = sorted;
  result.stats = {
    totalConstraints:  sorted.filter(function(i) { return i.hasAnyShortage; }).length,
    sharedConstraints: sorted.filter(function(i) { return i.isShared && i.hasAnyShortage; }).length,
    dedicatedShortage: sorted.filter(function(i) { return !i.isShared && i.hasAnyShortage; }).length,
    provenanceCheck:   sorted.filter(function(i) { return i.needsProvenanceCheck; }).length,
    categoryUnknown:   sorted.filter(function(i) { return i.categoryUnknown; }).length,
    noInventory:       sorted.filter(function(i) { return !i.hasInventory; }).length,
    noSupplyPlan:      sorted.filter(function(i) { return !i.hasSupplyPlan; }).length,
    indeterminate:     sorted.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan || i.unitMismatch; }).length,
    needMaster:        sorted.filter(function(i) { return i.needsMaster; }).length,
    missingCompCode:   missingCompCodeCount,
    // BOM 구조 통계
    multiLevelRoots:   bomStat.multiLevelRoots.size,
    singleLevelRoots:  bomStat.singleLevelRoots.size,
    semiExpanded:      bomStat.semiExpanded.size,
    semiNoSubBom:      bomStat.semiNoSubBom.size,
    dupExactCount:     bomStat.dupExactCount,
    dupInRootCount:    bomStat.dupInRootCount,
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
    if (item.unitMismatch)                     return 2;
    if (item.needsProvenanceCheck)             return 3;
    if (!item.hasInventory && !item.hasSupplyPlan) return 4;
    if (!item.hasInventory)                    return 5;
    if (!item.hasSupplyPlan)                   return 6;
    if (item.needsMaster || item.categoryUnknown) return 7;
    return 8;
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
  var d = state.cstDrilldown;

  // ── 드릴다운 필터 우선 적용 ──────────────────────────────────────────────
  if (d && !d.isAggregate && d.itemCode) {
    return items.filter(function(item) {
      return item.parentItems.some(function(p) {
        return p.code === d.itemCode && (!d.plant || p.plant === d.plant);
      });
    });
  }
  if (d && d.isAggregate && d.itemCodes && d.itemCodes.length) {
    var codeSet = new Set(d.itemCodes);
    return items.filter(function(item) {
      return item.parentItems.some(function(p) {
        return codeSet.has(p.code) && (!d.plant || p.plant === d.plant);
      });
    });
  }

  // ── 일반 필터 ────────────────────────────────────────────────────────────
  var filter = state.constraintFilter || "all";
  var search = ((state.constraintSearch || "")).toLowerCase().trim();
  var filtered = items;
  if      (filter === "shortage")      filtered = items.filter(function(i) { return i.hasAnyShortage; });
  else if (filter === "shared")        filtered = items.filter(function(i) { return i.isShared && i.hasAnyShortage; });
  else if (filter === "dedicated")     filtered = items.filter(function(i) { return !i.isShared && i.hasAnyShortage; });
  else if (filter === "indeterminate") filtered = items.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan || i.unitMismatch; });
  else if (filter === "need-data")     filtered = items.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan; });
  else if (filter === "provenance")    filtered = items.filter(function(i) { return i.needsProvenanceCheck; });
  else if (filter === "need-master")   filtered = items.filter(function(i) { return i.needsMaster || i.categoryUnknown; });
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

// ── 드릴다운 배너 ─────────────────────────────────────────────────────────────
function renderCstDrilldownBanner(d) {
  var parts = ["RTF(공급가능성 판정)"];
  if (d.businessUnit) parts.push(d.businessUnit);
  if (d.typeGroup)    parts.push(d.typeGroup);
  // 집계 행: itemGroup > label 순으로 사용 (label에서 " 계" 제거)
  if (d.isAggregate) {
    var aggLabel = d.itemGroup || (d.label ? d.label.replace(/ 계$/, "") : null);
    if (aggLabel) parts.push(aggLabel);
  } else {
    if (d.itemGroup) parts.push(d.itemGroup);
    if (d.itemName)  parts.push(d.itemName);
  }

  var monthLbl = monthLabel(d.month);
  var qtyStr = Number.isFinite(d.shortageQty) ? formatNumber(d.shortageQty) : "-";
  parts.push(monthLbl + " 부족 " + qtyStr);

  var breadcrumb = parts.join(" > ");

  // 상품 유형은 BOM 전개 제외 안내 (개별/집계 모두 표시)
  var goodsNote = d.typeGroup === "상품"
    ? "<div class=\"cst-drill-goods-note\">상품 품목은 BOM 전개 대상이 아니며, 현재고/입고계획 기준으로 공급가능성을 판단합니다.</div>"
    : "";

  return "<div class=\"cst-drilldown-banner\">" +
    "<span class=\"cst-drill-label\">" + escapeHtml(breadcrumb) + " 기준 조회 중</span>" +
    "<button type=\"button\" class=\"cst-drill-clear\" id=\"cstClearDrilldown\">전체 공급원인 보기</button>" +
    "</div>" + goodsNote;
}

// ── 상품 드릴다운 상세 ────────────────────────────────────────────────────────
function renderCstGoodsPanel(d) {
  if (d.isAggregate) return _renderCstGoodsAggPanel(d);
  return _renderCstGoodsSinglePanel(d);
}

// 단일 상품 — 월별 공급계획 테이블
function _renderCstGoodsSinglePanel(d) {
  var months = getRtfMonths();
  var rows = months.map(function(month) {
    var plan = null;
    state.mappedData.plan_monthly.some(function(r) {
      if (cleanOptional(r.itemCode) === d.itemCode && cleanOptional(r.month) === month) {
        plan = r; return true;
      }
      return false;
    });
    var salesQty  = plan ? (cleanNumber(plan.salesQty)  || 0) : null;
    var supplyQty = plan ? (cleanNumber(plan.supplyQty) || 0) : null;
    var shortage  = (salesQty !== null && supplyQty !== null) ? Math.max(0, salesQty - supplyQty) : null;
    var isShort   = shortage !== null && shortage > 0;
    var hlCls     = month === d.month ? " cst-drill-month-hi" : "";
    return "<tr class=\"" + hlCls + "\">" +
      "<td class=\"cst-ss-month\">" + escapeHtml(monthLabel(month)) + "</td>" +
      "<td class=\"cst-ss-num\">" + (salesQty  !== null ? formatNumber(salesQty)  : "-") + "</td>" +
      "<td class=\"cst-ss-num\">" + (supplyQty !== null ? formatNumber(supplyQty) : "-") + "</td>" +
      "<td class=\"cst-ss-num" + (isShort ? " cst-ss-short-num" : "") + "\">" +
        (shortage !== null ? formatNumber(shortage) : "-") + "</td>" +
      "</tr>";
  }).join("");

  return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
    "<div class=\"cst-det-section-title\">" + escapeHtml(d.itemName || d.itemCode || "상품") + " · 월별 공급계획 현황</div>" +
    "<div class=\"cst-det-scroll\"><table class=\"cst-ss-table cst-drill-goods-table\"><thead><tr>" +
    "<th>월</th><th>판매계획</th><th>공급계획</th><th>부족수량</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
}

// 집계 상품 — 기준월 기준 품목별 공급계획 테이블
function _renderCstGoodsAggPanel(d) {
  var targetMonth = d.month;
  var codeSet = new Set(d.itemCodes || []);

  // plan_monthly에서 기준월 + 해당 품목코드 집계
  var itemMap = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode);
    if (!code || !codeSet.has(code)) return;
    if (cleanOptional(r.month) !== targetMonth) return;
    if (!itemMap.has(code)) {
      itemMap.set(code, { itemCode: code, itemName: cleanOptional(r.itemName) || code, salesQty: 0, supplyQty: 0 });
    }
    var e = itemMap.get(code);
    e.salesQty  += (cleanNumber(r.salesQty)  || 0);
    e.supplyQty += (cleanNumber(r.supplyQty) || 0);
  });

  var entries = Array.from(itemMap.values());
  if (entries.length === 0) {
    return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
      "<div class=\"cst-drill-goods-note\">해당 품목군의 " + escapeHtml(monthLabel(targetMonth)) +
      " 공급계획 데이터가 없습니다.</div></div>";
  }

  // 부족 내림차순 정렬
  entries.sort(function(a, b) {
    return Math.max(0, b.salesQty - b.supplyQty) - Math.max(0, a.salesQty - a.supplyQty);
  });

  var rows = entries.map(function(e) {
    var shortage = Math.max(0, e.salesQty - e.supplyQty);
    var isShort  = shortage > 0;
    return "<tr>" +
      "<td>" + escapeHtml(e.itemCode) + "</td>" +
      "<td>" + escapeHtml(e.itemName) + "</td>" +
      "<td>" + formatNumber(e.salesQty) + "</td>" +
      "<td>" + formatNumber(e.supplyQty) + "</td>" +
      "<td class=\"" + (isShort ? "cst-ss-short-num" : "") + "\">" + formatNumber(shortage) + "</td>" +
      "</tr>";
  }).join("");

  var titleLabel = d.itemGroup || (d.label ? d.label.replace(/ 계$/, "") : "품목군");
  return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
    "<div class=\"cst-det-section-title\">" +
    escapeHtml(titleLabel) + " · " + escapeHtml(monthLabel(targetMonth)) + " 품목별 공급계획 현황</div>" +
    "<div class=\"cst-det-scroll\"><table class=\"cst-ss-table cst-drill-goods-table\"><thead><tr>" +
    "<th>품목코드</th><th>품목명</th><th>판매계획</th><th>공급계획</th><th>부족수량</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
}

// ── 완제품 드릴다운 공급현황 패널 ─────────────────────────────────────────────
function renderCstFinishedGoodsPanel(d) {
  var months = getRtfMonths();
  var targetMonth = d.month;

  if (d.isAggregate) {
    var codeSet = new Set(d.itemCodes || []);
    var itemMap = new Map();
    state.mappedData.plan_monthly.forEach(function(r) {
      var code = cleanOptional(r.itemCode), month = cleanOptional(r.month);
      if (!code || !codeSet.has(code) || month !== targetMonth) return;
      if (!itemMap.has(code)) itemMap.set(code, { itemCode:code, itemName:cleanOptional(r.itemName)||code, salesQty:0, supplyQty:0 });
      var e = itemMap.get(code);
      e.salesQty  += (cleanNumber(r.salesQty)  || 0);
      e.supplyQty += (cleanNumber(r.supplyQty) || 0);
    });
    var entries = Array.from(itemMap.values()).sort(function(a, b) {
      return Math.max(0, b.salesQty - b.supplyQty) - Math.max(0, a.salesQty - a.supplyQty);
    });
    if (entries.length === 0) return "";
    var titleLabel = d.itemGroup || (d.label ? d.label.replace(/ 계$/, "") : "완제품");
    var rows = entries.map(function(e) {
      var shortage = Math.max(0, e.salesQty - e.supplyQty);
      var isShort = shortage > 0;
      return "<tr><td>" + escapeHtml(e.itemCode) + "</td><td>" + escapeHtml(e.itemName) + "</td>" +
        "<td>" + formatNumber(e.salesQty) + "</td><td>" + formatNumber(e.supplyQty) + "</td>" +
        "<td class=\"" + (isShort ? "cst-ss-short-num" : "") + "\">" + formatNumber(shortage) + "</td></tr>";
    }).join("");
    return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
      "<div class=\"cst-det-section-title\">" + escapeHtml(titleLabel) + " · " + escapeHtml(monthLabel(targetMonth)) + " 완제품 공급현황</div>" +
      "<div class=\"cst-det-scroll\"><table class=\"cst-ss-table cst-drill-goods-table\"><thead><tr>" +
      "<th>품목코드</th><th>품목명</th><th>판매계획</th><th>공급계획</th><th>부족수량</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  // 개별 품목: 월별 현황
  var rows2 = months.map(function(month) {
    var salesQty = 0, supplyQty = 0, found = false;
    state.mappedData.plan_monthly.forEach(function(r) {
      if (cleanOptional(r.itemCode) === d.itemCode && cleanOptional(r.month) === month &&
          (!d.plant || cleanOptional(r.plant) === d.plant)) {
        salesQty  += (cleanNumber(r.salesQty)  || 0);
        supplyQty += (cleanNumber(r.supplyQty) || 0);
        found = true;
      }
    });
    var shortage = found ? Math.max(0, salesQty - supplyQty) : null;
    var isShort  = shortage !== null && shortage > 0;
    var hlCls    = month === targetMonth ? " cst-drill-month-hi" : "";
    return "<tr class=\"" + hlCls + "\">" +
      "<td>" + escapeHtml(monthLabel(month)) + "</td>" +
      "<td>" + (found ? formatNumber(salesQty)  : "-") + "</td>" +
      "<td>" + (found ? formatNumber(supplyQty) : "-") + "</td>" +
      "<td class=\"" + (isShort ? "cst-ss-short-num" : "") + "\">" + (shortage !== null ? formatNumber(shortage) : "-") + "</td>" +
      "</tr>";
  }).join("");
  return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
    "<div class=\"cst-det-section-title\">" + escapeHtml(d.itemName || d.itemCode || "") + " · 월별 공급현황</div>" +
    "<div class=\"cst-det-scroll\"><table class=\"cst-ss-table cst-drill-goods-table\"><thead><tr>" +
    "<th>월</th><th>판매계획</th><th>공급계획</th><th>부족수량</th>" +
    "</tr></thead><tbody>" + rows2 + "</tbody></table></div></div>";
}

// ── 드릴다운 부족자재 패널 ────────────────────────────────────────────────────
function renderCstShortMaterialsPanel(d) {
  if (state.bomStatus !== BOM_STATUS.DONE || !state.bomResult) {
    return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
      "<div class=\"cst-det-section-title\">부족 자재 리스트</div>" +
      "<div class=\"cst-drill-mat-note\">공급원인 화면에서 BOM 전개 후 확인 가능합니다.</div></div>";
  }
  var months     = getRtfMonths();
  var targetMonth = d.month;
  var monthIdx   = months.indexOf(targetMonth);
  var codes      = d.isAggregate ? new Set(d.itemCodes || []) : new Set(d.itemCode ? [d.itemCode] : []);
  var plantFilter = (!d.isAggregate && d.plant) ? d.plant : null;

  // 9코드가 없으면 BOM 전개 대상 없음
  var has9Code = Array.from(codes).some(function(c) { return c && c.toString().startsWith("9"); });

  // 자재 입고계획 맵 (plan_monthly에서 자재 공급수량 추출)
  var matSupplyMap = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant), month = cleanOptional(r.month);
    if (!code || !month) return;
    var k = code + "|" + plant + "|" + month;
    matSupplyMap.set(k, (matSupplyMap.get(k) || 0) + (cleanNumber(r.supplyQty) || 0));
  });

  var relatedItems = (state.bomResult.items || []).filter(function(item) {
    return item.parentItems.some(function(p) {
      return codes.has(p.code) && (!plantFilter || p.plant === plantFilter);
    });
  }).sort(function(a, b) {
    // 부족 확정 → 확정불가 → 정상 순; 같은 그룹 내에서는 부족수량 내림차순
    var aS = (a.monthlyData[monthIdx] || {}).shortageQty || 0;
    var bS = (b.monthlyData[monthIdx] || {}).shortageQty || 0;
    var aCan = a.hasInventory && a.hasSupplyPlan ? 1 : 0;
    var bCan = b.hasInventory && b.hasSupplyPlan ? 1 : 0;
    if (bS > 0 && aS <= 0) return 1;
    if (aS > 0 && bS <= 0) return -1;
    if (bCan !== aCan) return aCan - bCan;
    return bS - aS;
  });

  if (relatedItems.length === 0) {
    var note = has9Code ? "연결된 BOM 제약자재 없음"
      : "9코드(완제품) 외 품목은 BOM 전개 대상이 아닙니다. 공급원인 화면 자재 테이블을 확인하세요.";
    return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
      "<div class=\"cst-det-section-title\">부족 자재 리스트 · " + escapeHtml(monthLabel(targetMonth)) + "</div>" +
      "<div class=\"cst-drill-mat-note\">" + note + "</div></div>";
  }

  var hasShared = relatedItems.some(function(i) { return i.isShared; });

  // 합계 누계
  var tot = { req: 0, opening: 0, incoming: 0, shortage: 0, shortageCount: 0, unknownCount: 0 };

  var rows = relatedItems.map(function(item) {
    var md       = item.monthlyData[monthIdx] || {};
    var canComp  = item.hasInventory && item.hasSupplyPlan;
    var dec      = _cstDecByUnit(item.unit);

    // 매칭 완제품 기준 생산계획 + 필요수량
    var matchParents = item.parentItems.filter(function(p) {
      return codes.has(p.code) && (!plantFilter || p.plant === plantFilter);
    });
    var matchProd = matchParents.reduce(function(s, p) {
      return s + ((p.monthly[monthIdx] && p.monthly[monthIdx].prodQty) || 0);
    }, 0);
    var matchReq = matchParents.reduce(function(s, p) {
      return s + ((p.monthly[monthIdx] && p.monthly[monthIdx].reqQty) || 0);
    }, 0);
    var usageRate = (matchProd > 0) ? matchReq / matchProd : null;

    // 기초재고·입고계획 (availableQty = opening + incoming)
    var incomingQty = matSupplyMap.get(item.componentCode + "|" + item.plant + "|" + targetMonth) || 0;
    var openingQty  = (canComp && md.availableQty !== null)
      ? Math.max(md.availableQty - incomingQty, 0) : null;

    // 부족수량: 매칭 완제품 기준 재산출 (가용수량은 전체 공유이므로 안분 미적용)
    var shortage = null;
    if (canComp && md.availableQty !== null) {
      shortage = Math.max(matchReq - md.availableQty, 0);
    }

    // 합계 누적
    tot.req      += matchReq;
    tot.opening  += (openingQty !== null ? openingQty : 0);
    tot.incoming += incomingQty;
    if (shortage === null) { tot.unknownCount++; }
    else if (shortage > 0) { tot.shortage += shortage; tot.shortageCount++; }

    // 셀 표시값
    function fmtV(v) { return v !== null && isFinite(v) ? escapeHtml(_cstFmtVal(v, dec, item.unit)) : "-"; }
    var usageDisp   = usageRate !== null ? escapeHtml(_cstFmtVal(usageRate, 4, "")) : "-";
    var prodDisp    = matchProd > 0 ? formatNumber(Math.round(matchProd)) : "-";
    var reqDisp     = matchReq  > 0 ? fmtV(matchReq)  : "-";
    var openDisp    = openingQty  !== null ? fmtV(openingQty)  : (item.hasInventory ? "-" : "미연결");
    var incomDisp   = item.hasSupplyPlan ? fmtV(incomingQty) : "미연결";
    var shortDisp   = shortage === null ? "확정불가" : shortage > 0 ? fmtV(shortage) : "-";
    var shortCls    = shortage === null ? "cst-imp-adj" : shortage > 0 ? "cst-ss-short-num" : "";
    var rowCls      = shortage > 0 ? " cst-mat-shortage-row" : shortage === null ? " cst-mat-unknown-row" : "";
    var sharedBadge = item.isShared ? " <span class=\"cst-shared-badge\">공용</span>" : "";

    return "<tr class=\"" + rowCls + "\">" +
      "<td>" + escapeHtml(item.componentCode) + "</td>" +
      "<td>" + escapeHtml(item.componentName) + sharedBadge + "</td>" +
      "<td>" + escapeHtml(displayPlantName(item.plant)) + "</td>" +
      "<td>" + escapeHtml(item.unit || "-") + "</td>" +
      "<td class=\"cst-drill-usage\">" + usageDisp + "</td>" +
      "<td>" + prodDisp + "</td>" +
      "<td>" + reqDisp + "</td>" +
      "<td>" + openDisp + "</td>" +
      "<td>" + incomDisp + "</td>" +
      "<td class=\"" + shortCls + "\">" + shortDisp + "</td>" +
      "</tr>";
  }).join("");

  var totalRow = "<tr class=\"cst-imp-total\">" +
    "<td colspan=\"5\" class=\"cst-imp-total-label\">합계 · " + escapeHtml(monthLabel(targetMonth)) + " 기준</td>" +
    "<td>-</td>" +
    "<td class=\"cst-imp-total-num\">" + formatNumber(Math.round(tot.req)) + "</td>" +
    "<td class=\"cst-imp-total-num\">" + formatNumber(Math.round(tot.opening)) + "</td>" +
    "<td class=\"cst-imp-total-num\">" + formatNumber(Math.round(tot.incoming)) + "</td>" +
    "<td class=\"cst-imp-total-num" + (tot.shortageCount > 0 ? " cst-ss-short-num" : "") + "\">" +
      (tot.shortageCount > 0 ? formatNumber(Math.round(tot.shortage)) + " (" + tot.shortageCount + "종)" :
       tot.unknownCount > 0  ? "확정불가 " + tot.unknownCount + "종" : "-") +
    "</td></tr>";

  var sharedNote = hasShared
    ? "<div class=\"cst-imp-note\">공용자재 포함 — 기초재고·입고계획은 전체 완제품 공용이므로 실제 가용수량은 배분 기준 별도 확인 필요</div>"
    : "";

  return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
    "<div class=\"cst-det-section-title\">부족 자재 리스트 · " + escapeHtml(monthLabel(targetMonth)) + " (" + relatedItems.length + "건)</div>" +
    sharedNote +
    "<div class=\"cst-det-scroll\"><table class=\"cst-ss-table cst-drill-goods-table cst-mat-panel-table\"><thead><tr>" +
    "<th>자재코드</th><th>자재명</th><th>플랜트</th><th>단위</th>" +
    "<th>개당<br>소요량</th><th>완제품<br>생산계획</th><th>필요수량</th><th>기초재고</th><th>입고계획</th><th>부족수량</th>" +
    "</tr></thead><tbody>" + rows + totalRow + "</tbody></table></div></div>";
}

// ── 요약 카드 ─────────────────────────────────────────────────────────────────
function renderConstraintSummaryCard(result) {
  var s = result.stats;
  var fmtTime = result.completedAt
    ? result.completedAt.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit", second:"2-digit" })
    : "-";
  var items = [
    { label:"전개상태",              value:"완료",                                                                      cls:"ok"       },
    { label:"전개완료시각",          value:fmtTime,                                                                     cls:""         },
    { label:"확정 부족 제약대상",    value:s.totalConstraints  > 0 ? s.totalConstraints  + "건" : "-",   cls:s.totalConstraints  > 0 ? "shortage" : "" },
    { label:"공용자재 제약",         value:s.sharedConstraints > 0 ? s.sharedConstraints + "건" : "-",   cls:s.sharedConstraints > 0 ? "warn"     : "" },
    { label:"전용자재 부족",         value:s.dedicatedShortage > 0 ? s.dedicatedShortage + "건" : "-",   cls:s.dedicatedShortage > 0 ? "shortage" : "" },
    { label:"반제품 조달구분 확인",  value:s.provenanceCheck   > 0 ? s.provenanceCheck   + "건" : "-",   cls:s.provenanceCheck   > 0 ? "warn"     : "" },
    { label:"품목유형 확인 필요",    value:s.categoryUnknown   > 0 ? s.categoryUnknown   + "건" : "-",   cls:s.categoryUnknown   > 0 ? "warn"     : "" },
    { label:"현재고 미연결",         value:s.noInventory       > 0 ? s.noInventory       + "건" : "-",   cls:s.noInventory       > 0 ? "warn"     : "" },
    { label:"입고계획 미연결",       value:s.noSupplyPlan      > 0 ? s.noSupplyPlan      + "건" : "-",   cls:s.noSupplyPlan      > 0 ? "warn"     : "" },
    { label:"부족 확정 불가",        value:s.indeterminate     > 0 ? s.indeterminate     + "건" : "-",   cls:s.indeterminate     > 0 ? "warn"     : "" },
    { label:"BOM 코드 누락",         value:s.missingCompCode   > 0 ? s.missingCompCode   + "행" : "-",   cls:s.missingCompCode   > 0 ? "warn"     : "" },
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
    { key:"all",           label:"전체",           count:allItems.length },
    { key:"shortage",      label:"확정 부족",       count:allItems.filter(function(i) { return i.hasAnyShortage; }).length },
    { key:"shared",        label:"공용자재",        count:allItems.filter(function(i) { return i.isShared && i.hasAnyShortage; }).length },
    { key:"dedicated",     label:"전용자재",        count:allItems.filter(function(i) { return !i.isShared && i.hasAnyShortage; }).length },
    { key:"indeterminate", label:"확정 불가",       count:allItems.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan || i.unitMismatch; }).length },
    { key:"need-data",     label:"데이터 미연결",   count:allItems.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan; }).length },
    { key:"provenance",    label:"반제품 조달구분", count:allItems.filter(function(i) { return i.needsProvenanceCheck; }).length },
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

// ── 의사결정 필요사항 ────────────────────────────────────────────────────────
function decisionLabel(item) {
  if (item.needsProvenanceCheck)                 return "반제품 조달구분 확인 필요";
  if (item.categoryUnknown)                      return "품목유형 확인 필요";
  if (item.needsMaster)                          return "기준정보 확인 필요";
  if (item.unitMismatch)                         return "단위 정합 확인 필요";
  if (!item.hasInventory && !item.hasSupplyPlan) return "현재고·입고계획 연결 필요";
  if (!item.hasInventory)                        return "현재고 연결 필요";
  if (!item.hasSupplyPlan)                       return "입고계획 확인 필요";
  if (item.isShared && item.hasAnyShortage)      return "공용자재 배분기준 필요";
  if (item.hasAltBom && item.hasAnyShortage)     return "대체BOM 검토 필요";
  if (item.hasAnyShortage)                       return "긴급입고 검토 필요";
  return "-";
}
var DECISION_CLS = {
  "긴급입고 검토 필요":         "cst-dec-urgent",
  "공용자재 배분기준 필요":     "cst-dec-warn",
  "대체BOM 검토 필요":          "cst-dec-info",
  "반제품 조달구분 확인 필요":  "cst-dec-check",
  "품목유형 확인 필요":         "cst-dec-check",
  "현재고 연결 필요":           "cst-dec-link",
  "현재고·입고계획 연결 필요":  "cst-dec-link",
  "입고계획 확인 필요":         "cst-dec-link",
  "공급계획 연결 필요":         "cst-dec-link",
  "단위 정합 확인 필요":        "cst-dec-check",
  "기준정보 확인 필요":         "cst-dec-check",
};
function decisionCls(label) { return DECISION_CLS[label] || "cst-dec-neutral"; }

// ── 단위별 표시 정밀도 ───────────────────────────────────────────────────────
function _cstDecByUnit(unit) {
  var u = (unit || "").trim().toUpperCase();
  if (/^(KG|L|KL)$/.test(u))                                         return 4;
  if (/^(G|ML|MG)$/.test(u))                                         return 3;
  if (/^(TB|EA|SH|ROL|PCS|정|매|개|병|봉|캔|포|통|박|SET)$/.test(u)) return 0;
  return 4;
}
// v > 0 전제. 반올림 결과가 0이면 "<최소단위" 반환 (plain text, 호출측에서 escapeHtml)
function _cstFmtVal(v, dec, unit) {
  var suf = unit ? " " + unit : "";
  if (!v || !isFinite(v) || v <= 0) return "-";
  if (dec === 0) {
    var r0 = Math.round(v);
    return r0 === 0 ? ("<1" + suf) : (formatNumber(r0) + suf);
  }
  var factor = Math.pow(10, dec);
  var r = Math.round(v * factor) / factor;
  if (r === 0) return "<0." + "0".repeat(dec - 1) + "1" + suf;
  return r.toLocaleString("ko-KR", { maximumFractionDigits: dec, minimumFractionDigits: 0 }) + suf;
}

// ── 압축 셀 계산 ─────────────────────────────────────────────────────────────
function compactCellValue(item, md) {
  if (item.needsProvenanceCheck) return { text:"조달구분 확인", cls:"cst-neutral-cell" };
  if (item.unitMismatch)         return { text:"단위 판단불가", cls:"cst-neutral-cell" };
  if (!item.hasInventory)        return { text:"현재고 연결필요", cls:"cst-neutral-cell" };
  if (!item.hasSupplyPlan)       return { text:"입고계획 확인", cls:"cst-neutral-cell" };
  if (md.shortageQty === null)   return { text:"판단불가",      cls:"cst-neutral-cell" };
  if (md.shortageQty > 0) {
    var matUnit = (item.unit && item.unit !== "확인필요") ? item.unit : "";
    var qty = _cstFmtVal(md.shortageQty, _cstDecByUnit(matUnit), matUnit);
    if (item.isShared) return { text:"공통제약 " + qty, cls:"cst-compact-shared" };
    return { text:"자재 부족 " + qty, cls:"cst-shortage-cell" };
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
  "단위 정합 확인":"vld-s-unit","판단불가":"vld-s-unknown","자재 부족":"vld-s-short",
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
  var _bs = (state.bomResult && state.bomResult.stats) || {};
  var sec1 = {
    totalRtf:         planKeys9.size + planKeys7.size,
    codes9:           planKeys9.size,
    codes7:           planKeys7.size,
    semiInRoot:       semiInBomRoot.size,
    missingKey:       missingKeyRows,
    semiList:         Array.from(semiInBomRoot),
    // BOM 구조 통계 (BOM 전개 결과)
    multiLevelRoots:  _bs.multiLevelRoots  || 0,
    singleLevelRoots: _bs.singleLevelRoots || 0,
    semiExpanded:     _bs.semiExpanded     || 0,
    semiNoSubBom:     _bs.semiNoSubBom     || 0,
    dupExactCount:    _bs.dupExactCount    || 0,
    dupInRootCount:   _bs.dupInRootCount   || 0,
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
          : md.shortageQty > 0 ? "자재 부족" : "정상";
        return { month:md.month, required:md.requiredQty, supply:supplyQty,
                 available:md.availableQty, shortage:md.shortageQty, judgment:judgment };
      });
      return { code:item.componentCode, name:item.componentName, plant:item.plant,
               baseQty:inv ? inv.qty : null, unitMismatch:item.unitMismatch,
               hasInv:item.hasInventory, monthly:monthly };
    });

  var summary = {
    targetCount:     items.length,
    bomUnmatched:    sec2.unmatched,
    categoryUnknown: items.filter(function(i) { return i.categoryUnknown; }).length,
    needInventory:   items.filter(function(i) { return !i.hasInventory; }).length,
    needSupply:      items.filter(function(i) { return !i.hasSupplyPlan; }).length,
    provenanceCheck: items.filter(function(i) { return i.needsProvenanceCheck; }).length,
    unitMismatch:    sec6.filter(function(r) { return r.mismatch; }).length,
    indeterminate:   items.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan || i.unitMismatch; }).length,
    shortage:        items.filter(function(i) { return i.hasAnyShortage; }).length,
  };
  // ⑧ BOM 계산 정합 + 플랜트별 자재 분리 검증
  var sec8 = { calcChecks:[], plantSplit:[] };

  items.forEach(function(item) {
    var anyMismatch = false;
    var monthlyCheck = months.map(function(m, mi) {
      var md = item.monthlyData[mi] || {};
      var engineReq = md.requiredQty || 0;
      var parentSum = item.parentItems.reduce(function(s, p) {
        return s + ((p.monthly[mi] && p.monthly[mi].reqQty) || 0);
      }, 0);
      var ok = Math.abs(engineReq - parentSum) < 0.001;
      if (!ok) anyMismatch = true;
      return { month:m, engineReq:engineReq, parentSum:parentSum, ok:ok };
    });
    sec8.calcChecks.push({
      code:item.componentCode, name:item.componentName, plant:item.plant,
      isShared:item.isShared, parentCount:item.parentItems.length,
      monthlyCheck:monthlyCheck, anyMismatch:anyMismatch,
    });
  });

  var codeToItems = new Map();
  items.forEach(function(item) {
    if (!codeToItems.has(item.componentCode)) codeToItems.set(item.componentCode, []);
    codeToItems.get(item.componentCode).push(item);
  });
  codeToItems.forEach(function(itemList, code) {
    if (itemList.length > 1) {
      sec8.plantSplit.push({
        code:code, name:itemList[0].componentName,
        items:itemList.map(function(i) { return { plant:i.plant, isShared:i.isShared, parentCount:i.parentItems.length }; }),
      });
    }
  });

  return { summary:summary, sec1:sec1, sec2:sec2, sec3:sec3, sec4:sec4, sec5:sec5, sec6:sec6, sec7:sec7, sec8:sec8, months:months };
}

// ── 정합성 검증 패널 렌더 ─────────────────────────────────────────────────────
function renderValidationPanel() {
  if (!state.validationPanelOpen || !state.bomResult || state.bomResult.status !== BOM_STATUS.DONE) return "";
  var vd = computeValidation(), tab = state.validationTab || 0, s = vd.summary;
  var kpiItems = [
    { label:"제약 대상",           v:s.targetCount,     warn:false },
    { label:"BOM 미매칭",          v:s.bomUnmatched,    warn:s.bomUnmatched    > 0 },
    { label:"품목유형 확인 필요",   v:s.categoryUnknown, warn:s.categoryUnknown > 0 },
    { label:"현재고 미연결",        v:s.needInventory,   warn:s.needInventory   > 0 },
    { label:"입고계획 미연결",      v:s.needSupply,      warn:s.needSupply      > 0 },
    { label:"반제품 조달구분",      v:s.provenanceCheck, warn:s.provenanceCheck > 0 },
    { label:"단위 정합 확인",       v:s.unitMismatch,    warn:s.unitMismatch    > 0 },
    { label:"부족 확정 불가",       v:s.indeterminate,   warn:s.indeterminate   > 0 },
    { label:"확정 부족",            v:s.shortage,        warn:false, shortage:s.shortage > 0 },
  ];
  var kpiHtml = kpiItems.map(function(k) {
    var cls = k.shortage ? " vld-kpi-shortage" : k.warn ? " vld-kpi-warn" : "";
    return "<div class=\"vld-kpi" + cls + "\"><div class=\"vld-kpi-label\">" + escapeHtml(k.label) +
           "</div><div class=\"vld-kpi-value\">" + k.v + "</div></div>";
  }).join("");
  var tabLabels = ["①대상품목","②BOM매칭","③BOM수량","④현재고","⑤공급계획","⑥단위정합","⑦부족판정","⑧계산·플랜트"];
  var tabBar = tabLabels.map(function(lbl, i) {
    return "<button type=\"button\" class=\"vld-tab-btn" + (i === tab ? " active" : "") +
           "\" data-vld-tab=\"" + i + "\">" + escapeHtml(lbl) + "</button>";
  }).join("");
  var secData = [vd.sec1, vd.sec2, vd.sec3, vd.sec4, vd.sec5, vd.sec6, vd.sec7, vd.sec8];
  var secFns  = [renderVldSec1, renderVldSec2, renderVldSec3, renderVldSec4, renderVldSec5, renderVldSec6, renderVldSec7, renderVldSec8];
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
  var base = _vldKVTable([
    { label:"RTF 대상 품목 수 (코드+플랜트 기준)", value: s.totalRtf + "건" },
    { label:"완제품 9코드 수", value: s.codes9 + "건" },
    { label:"상품 7코드 수",   value: s.codes7 + "건" },
    { label:"반제품 8코드 BOM 루트 등록",
      value: s.semiInRoot > 0 ? s.semiInRoot + "건 발견" : "없음", warn: s.semiInRoot > 0,
      note:  s.semiInRoot > 0 ? "공급원인 분석은 9코드 완제품 기준으로만 전개함." : "" },
    { label:"품목코드+플랜트 누락 행",
      value: s.missingKey > 0 ? s.missingKey + "행" : "없음", warn: s.missingKey > 0 },
  ]);
  var bomStructRows = [
    { label:"다단계 BOM 루트 (반제품 경유 감지)", value: s.multiLevelRoots > 0 ? s.multiLevelRoots + "건" : "없음",
      note: s.multiLevelRoots > 0 ? "반제품 하위 원료가 이미 Root BOM에 포함 — 경유단계 처리됨." : "" },
    { label:"단일 단계 루트 (반제품 추가전개 필요)", value: s.singleLevelRoots > 0 ? s.singleLevelRoots + "건" : "없음",
      warn: s.singleLevelRoots > 0 },
    { label:"반제품 추가전개 완료", value: s.semiExpanded > 0 ? s.semiExpanded + "건" : "없음",
      note: s.semiExpanded > 0 ? "반제품 하위 BOM 발견 → 원료/자재 기준으로 연쇄 전개됨." : "" },
    { label:"반제품 하위 BOM 연결 필요", value: s.semiNoSubBom > 0 ? s.semiNoSubBom + "건" : "없음",
      warn: s.semiNoSubBom > 0, note: s.semiNoSubBom > 0 ? "반제품 자체가 부족 판정 대상으로 유지됨 — BOM 연결 권장." : "" },
    { label:"완전 중복 행 (제거됨)", value: s.dupExactCount > 0 ? s.dupExactCount + "행" : "없음",
      note: s.dupExactCount > 0 ? "Root+구성품+수량+플랜트 모두 동일한 행은 1회만 반영." : "" },
    { label:"동일 Root 내 반복 자재 (합산 처리)", value: s.dupInRootCount > 0 ? s.dupInRootCount + "건" : "없음",
      note: s.dupInRootCount > 0 ? "같은 자재가 동일 Root에 복수 등장 — 필요수량 합산 처리됨." : "" },
  ];
  var bomStruct = "<div class=\"vld-sub-title\">BOM 구조 분석</div>" + _vldKVTable(bomStructRows);
  return base +
    (s.semiList && s.semiList.length ?
      "<div class=\"vld-sub-note\">반제품 루트: " + s.semiList.slice(0,10).map(escapeHtml).join(", ") + "</div>" : "") +
    bomStruct;
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
    "<th class=\"vld-th-r\">BOM 환산계수</th><th class=\"vld-th-r\">총생산계획</th><th class=\"vld-th-r\">총 자재 필요수량</th>" +
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
           "<th class=\"vld-th-r\">가용</th><th class=\"vld-th-r\">자재 부족수량</th><th>판정</th>";
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

function renderVldSec8(s, months) {
  var mismatchCount = s.calcChecks.filter(function(r) { return r.anyMismatch; }).length;
  var summaryHtml = _vldKVTable([
    { label:"BOM 계산 검증 대상 자재", value:s.calcChecks.length + "건" },
    { label:"계산 불일치",
      value:mismatchCount === 0 ? "없음" : mismatchCount + "건",
      warn:mismatchCount > 0,
      note:mismatchCount === 0 ? "엔진 집계 = Σ 완제품별 기여 합계 — 정상" : "불일치 항목 확인 필요" },
    { label:"동일 자재코드 복수 플랜트",
      value:s.plantSplit.length === 0 ? "없음" : s.plantSplit.length + "건",
      note:s.plantSplit.length > 0 ? "각 플랜트별 별도 행으로 분리 관리 중 (정상)" : "" },
  ]);

  // 계산 정합
  var calcHtml;
  var mismatches = s.calcChecks.filter(function(r) { return r.anyMismatch; });
  if (mismatches.length > 0) {
    var mHeads = months.map(function(m) {
      return "<th class=\"vld-month-head\" colspan=\"3\">" + escapeHtml(monthLabel(m)) + "</th>";
    }).join("");
    var subHeads = months.map(function() {
      return "<th class=\"vld-th-r\">엔진</th><th class=\"vld-th-r\">부모합</th><th>정합</th>";
    }).join("");
    var rows = mismatches.map(function(r) {
      var mCells = r.monthlyCheck.map(function(mc) {
        return "<td class=\"vld-td-r\">" + vldNum(mc.engineReq) + "</td>" +
               "<td class=\"vld-td-r\">" + vldNum(mc.parentSum) + "</td>" +
               "<td>" + vldBadge(mc.ok ? "정상" : "불일치") + "</td>";
      }).join("");
      return "<tr><td>" + escapeHtml(r.code) + "</td>" +
             "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
             "<td>" + escapeHtml(displayPlantName(r.plant)) + "</td>" + mCells + "</tr>";
    }).join("");
    calcHtml = "<div class=\"vld-sub-title\">계산 불일치 자재 목록</div>" +
      "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead>" +
      "<tr><th>자재코드</th><th>자재명</th><th>플랜트</th>" + mHeads + "</tr>" +
      "<tr><th></th><th></th><th></th>" + subHeads + "</tr>" +
      "</thead><tbody>" + rows + "</tbody></table></div>";
  } else {
    calcHtml = "<div class=\"vld-sub-title\">BOM 계산 정합</div>" +
      "<div class=\"vld-empty\">모든 자재의 엔진 집계 = 완제품별 기여 합산 — 정상</div>";
  }

  // 플랜트별 자재 분리 현황
  var plantHtml = "";
  if (s.plantSplit.length > 0) {
    var plantRows = s.plantSplit.map(function(r) {
      var plantCells = r.items.map(function(i) {
        return "<td>" + escapeHtml(displayPlantName(i.plant)) + "</td>" +
               "<td>" + vldBadge(i.isShared ? "공용(" + i.parentCount + "품목)" : "전용") + "</td>";
      }).join("");
      return "<tr><td>" + escapeHtml(r.code) + "</td>" +
             "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
             plantCells + "</tr>";
    }).join("");
    // 최대 플랜트 수 계산 (가변 컬럼)
    var maxPlants = s.plantSplit.reduce(function(mx, r) { return Math.max(mx, r.items.length); }, 0);
    var phCols = Array.from({ length: maxPlants }, function(_, i) {
      return "<th>플랜트 " + (i + 1) + "</th><th>공용여부</th>";
    }).join("");
    plantHtml = "<div class=\"vld-sub-title\">복수 플랜트 자재 분리 현황 (플랜트별 별도 관리 확인)</div>" +
      "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr>" +
      "<th>자재코드</th><th>자재명</th>" + phCols + "</tr></thead><tbody>" +
      plantRows + "</tbody></table></div>";
  }

  return summaryHtml + calcHtml + plantHtml;
}

// ── 계산기준 패널 ─────────────────────────────────────────────────────────────
function renderCalcCriteria() {
  if (!state.calcCriteriaOpen) return "";
  var formulas = [
    ["총 자재 필요수량", "생산계획 × 구성요소수량 ÷ BOM 기준수량"],
    ["BOM 환산계수",     "구성요소수량 ÷ BOM 기준수량"],
    ["가용수량",         "월초재고 + 공급계획"],
    ["자재 부족수량",    "MAX(총 자재 필요수량 − 가용수량, 0)"],
    ["부족금액",         "자재 부족수량 × 표준원가"],
  ];
  var criteria = [
    "RTF 대상(완제품·상품)과 BOM 하위 공급제약 품목을 분리 처리",
    "공용자재는 완제품별 임의 배분 없이 <b>공통제약</b>으로 표시",
    "반제품·재공품은 중간단계 처리 — 하위 원료·자재 기준으로 전개",
    "품목유형이 없거나 불명확 시 <b>품목유형 확인 필요</b>로 표시 — 임의 추정 금지",
    "반제품 조달구분(자체생산/구매) 불명확 시 <b>반제품 조달구분 확인 필요</b>로 표시",
    "현재고 미연결 시 0 가정하지 않고 <b>현재고 연결 필요</b>로 표시",
    "입고계획 미연결 시 0 가정하지 않고 <b>입고계획 확인 필요</b>로 표시",
    "현재고·입고계획 모두 연결되어야 자재 부족수량 확정 가능",
    "대체BOM 적용 제외 — 기본BOM(1번)만 사용",
    "단위 불일치 시 임의 환산 없이 <b>단위 정합 확인</b>으로 표시",
  ];
  var formulaRows = formulas.map(function(f) {
    return "<li><span class=\"cst-crit-formula\">" + escapeHtml(f[0]) + "</span> = " + escapeHtml(f[1]) + "</li>";
  }).join("");
  var criteriaRows = criteria.map(function(c) {
    return "<li>" + c + "</li>";
  }).join("");
  return "<div class=\"cst-criteria-panel\">" +
    "<div class=\"cst-criteria-grid\">" +
    "<div class=\"cst-criteria-group\">" +
    "<div class=\"cst-criteria-group-title\">산식</div>" +
    "<ul class=\"cst-criteria-list\">" + formulaRows + "</ul></div>" +
    "<div class=\"cst-criteria-group\">" +
    "<div class=\"cst-criteria-group-title\">판정 기준</div>" +
    "<ul class=\"cst-criteria-list\">" + criteriaRows + "</ul></div>" +
    "</div></div>";
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

  var critOpen     = state.calcCriteriaOpen;
  var critBtnLabel = critOpen ? "계산기준 ▲" : "계산기준 ▼";
  var headerRight  = "<div class=\"cst-sec-actions\">" +
    "<button type=\"button\" id=\"calcCriteriaBtn\" class=\"cst-criteria-btn" + (critOpen ? " active" : "") + "\">" +
    escapeHtml(critBtnLabel) + "</button>" +
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
         renderCalcCriteria() +
         tableContent + "</section>";
}

// ── 빠른 시뮬레이션 핸들러 ──────────────────────────────────────────────────
function _cstSimRun(compKey) {
  var sec = document.querySelector(".cst-sim-section[data-compkey=\"" + compKey + "\"]");
  if (!sec) return;
  var sd;
  try { sd = JSON.parse(sec.getAttribute("data-simdata")); } catch(e) { return; }

  var incomingByMonth = {}, prodAdjByMonth = {}, altBomCoeff = null;
  sec.querySelectorAll(".cst-sim-input").forEach(function(inp) {
    var type  = inp.getAttribute("data-type");
    var month = inp.getAttribute("data-month");
    var raw   = inp.value.trim();
    var val   = raw !== "" ? (parseFloat(raw) || 0) : 0;
    if (type === "incoming") incomingByMonth[month] = val;
    else if (type === "prod") prodAdjByMonth[month] = val;
    else if (type === "altbom" && raw !== "") altBomCoeff = parseFloat(raw) || null;
  });

  var matUnit = sd.matUnit || "";
  var dec     = typeof sd.dec === "number" ? sd.dec : 0;
  function fmtN(v) {
    if (!v || !isFinite(v) || v <= 0) return "-";
    return v.toLocaleString("ko-KR", { maximumFractionDigits: dec, minimumFractionDigits: 0 }) + (matUnit ? " " + matUnit : "");
  }

  var rows = sd.months.map(function(month, i) {
    var md = sd.monthlyData[i] || {};
    if (md.availableQty === null || md.availableQty === undefined) return null;
    var incoming = incomingByMonth[month] || 0;
    var prodAdj  = prodAdjByMonth[month]  || 0;
    var useCoeff = (altBomCoeff !== null && sd.hasAltBom) ? altBomCoeff : sd.avgUnitReq;
    var newAvail = (md.availableQty || 0) + incoming;
    var newReq   = md.requiredQty || 0;
    if ((prodAdj !== 0 || (altBomCoeff !== null && sd.hasAltBom)) && sd.avgUnitReq) {
      var origProd = sd.avgUnitReq > 0 ? newReq / sd.avgUnitReq : 0;
      newReq = Math.max(0, (origProd + prodAdj) * (useCoeff || sd.avgUnitReq));
    }
    var before = md.shortageQty !== null && md.shortageQty !== undefined
      ? md.shortageQty : Math.max(0, (md.requiredQty || 0) - (md.availableQty || 0));
    var after  = Math.max(0, newReq - newAvail);
    return { month: month, before: before, after: after };
  }).filter(Boolean);

  var beforeRow = "<tr><td class=\"cst-sim-rlabel\">시뮬레이션 전 자재 부족수량</td>" +
    rows.map(function(r) {
      return "<td class=\"cst-sim-rnum" + (r.before > 0 ? " cst-sim-rnum-s" : "") + "\">" + fmtN(r.before) + "</td>";
    }).join("") + "</tr>";
  var afterRow = "<tr><td class=\"cst-sim-rlabel\">시뮬레이션 후 자재 부족수량</td>" +
    rows.map(function(r) {
      return "<td class=\"cst-sim-rnum" + (r.after > 0 ? " cst-sim-rnum-s" : (r.before > 0 ? " cst-sim-rnum-ok" : "")) + "\">" + fmtN(r.after) + "</td>";
    }).join("") + "</tr>";
  var resolveRow = "<tr><td class=\"cst-sim-rlabel\">부족 해소 여부</td>" +
    rows.map(function(r) {
      if (r.before === 0) return "<td class=\"cst-sim-rstat\">-</td>";
      if (r.after === 0)  return "<td class=\"cst-sim-rstat cst-sim-resolved\">✓ 해소</td>";
      if (r.after < r.before) return "<td class=\"cst-sim-rstat cst-sim-improved\">▽ 개선</td>";
      return "<td class=\"cst-sim-rstat cst-sim-unresolved\">✗ 미해소</td>";
    }).join("") + "</tr>";
  var noteRow = "<tr><td class=\"cst-sim-rlabel\">검토 결과</td>" +
    rows.map(function(r) {
      var note = r.before === 0 ? "부족 없음"
               : r.after === 0  ? "가정 시나리오로 해소 가능"
               : r.after < r.before ? "개선되나 부족 잔존"
               : "추가 조정 검토 필요";
      return "<td class=\"cst-sim-rnote\">" + note + "</td>";
    }).join("") + "</tr>";

  var tbody = sec.querySelector(".cst-sim-result tbody");
  if (tbody) tbody.innerHTML = beforeRow + afterRow + resolveRow + noteRow;
  var res = sec.querySelector(".cst-sim-result");
  if (res) res.style.display = "";
}

function _cstSimReset(compKey) {
  var sec = document.querySelector(".cst-sim-section[data-compkey=\"" + compKey + "\"]");
  if (!sec) return;
  sec.querySelectorAll(".cst-sim-input").forEach(function(inp) { inp.value = ""; });
  var res = sec.querySelector(".cst-sim-result");
  if (res) res.style.display = "none";
}

// ── 펼침 상세 v2: 수급요약 + 영향품목/조율 후보 ──────────────────────────────
function renderCstDetailExpanded(item, months, totalCols) {
  var matUnit    = (item.unit && item.unit !== "확인필요") ? item.unit : "";
  var dec        = _cstDecByUnit(matUnit);
  var canCompute = item.hasInventory && item.hasSupplyPlan && !item.unitMismatch;

  // 입고계획 by month
  var supplyByMonth = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant), month = cleanOptional(r.month);
    if (code !== item.componentCode || plant !== item.plant || !month) return;
    supplyByMonth.set(month, (supplyByMonth.get(month) || 0) + (cleanNumber(r.supplyQty) || 0));
  });

  // 월초재고: availableQty - supplyQty (canCompute 시), 1월은 기초재고만 표시
  var baseInv = null;
  state.mappedData.inventory_base.some(function(r) {
    if (cleanOptional(r.itemCode) === item.componentCode && cleanOptional(r.plant) === item.plant) {
      baseInv = cleanNumber(r.baseQty); return true;
    }
    return false;
  });
  var openingByMonth = new Map();
  months.forEach(function(month, i) {
    var md        = item.monthlyData[i] || {};
    var supplyQty = supplyByMonth.get(month) || 0;
    var opening;
    if (canCompute && md.availableQty !== null) {
      opening = Math.max(md.availableQty - supplyQty, 0);
    } else if (i === 0 && item.hasInventory && baseInv !== null) {
      opening = baseInv;
    } else {
      opening = null;
    }
    openingByMonth.set(month, opening);
  });

  function fmtZ(v, d, u) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    if (v === 0) return "0" + (u ? " " + u : "");
    return _cstFmtVal(v, d, u);
  }

  // ══ SECTION 1: 월별 자재 수급요약 ══
  function statusBadge(status) {
    var cls = {
      "확정부족":         "cst-sum-s-shortage",
      "정상":             "cst-sum-s-ok",
      "현재고 연결필요":  "cst-sum-s-link",
      "입고계획 확인필요":"cst-sum-s-link",
      "품목유형 확인필요":"cst-sum-s-check",
      "판단불가":         "cst-sum-s-unknown",
    }[status] || "cst-sum-s-unknown";
    return "<span class=\"cst-sum-s-badge " + cls + "\">" + escapeHtml(status) + "</span>";
  }

  var summaryRows = months.map(function(month, i) {
    var md        = item.monthlyData[i] || {};
    var supplyQty  = supplyByMonth.get(month) || 0;
    var openingQty = openingByMonth.get(month);
    var isShort   = canCompute && md.shortageQty > 0;

    var status;
    if (!item.hasInventory)        status = "현재고 연결필요";
    else if (!item.hasSupplyPlan)  status = "입고계획 확인필요";
    else if (item.categoryUnknown) status = "품목유형 확인필요";
    else if (md.shortageQty === null) status = "판단불가";
    else if (md.shortageQty > 0)   status = "확정부족";
    else                            status = "정상";

    var rowCls = status === "확정부족" ? " cst-ss-shortage"
               : status === "정상"      ? " cst-ss-ok"
               : " cst-ss-uncertain";

    return "<tr class=\"cst-ss-row" + rowCls + "\">" +
      "<td class=\"cst-ss-month\">" + escapeHtml(monthLabel(month)) + "</td>" +
      "<td class=\"cst-ss-num\">" + escapeHtml(md.requiredQty > 0 ? _cstFmtVal(md.requiredQty, dec, matUnit) : "-") + "</td>" +
      "<td class=\"cst-ss-num\">" + escapeHtml(item.hasInventory ? fmtZ(openingQty, dec, matUnit) : "연결필요") + "</td>" +
      "<td class=\"cst-ss-num\">" + escapeHtml(item.hasSupplyPlan ? fmtZ(supplyQty, dec, matUnit) : "확인필요") + "</td>" +
      "<td class=\"cst-ss-num\">" + escapeHtml(canCompute && md.availableQty !== null ? fmtZ(md.availableQty, dec, matUnit) : "-") + "</td>" +
      "<td class=\"cst-ss-num" + (isShort ? " cst-ss-short-num" : "") + "\">" +
        escapeHtml(isShort ? _cstFmtVal(md.shortageQty, dec, matUnit) : "-") + "</td>" +
      "<td class=\"cst-ss-status\">" + statusBadge(status) + "</td>" +
      "</tr>";
  }).join("");

  var summaryHtml =
    "<div class=\"cst-det-section\">" +
    "<div class=\"cst-det-section-title\">월별 자재 수급요약</div>" +
    "<div class=\"cst-det-scroll\"><table class=\"cst-ss-table supply-summary-table\"><thead><tr>" +
    "<th>월</th><th>총 자재 필요수량</th><th>월초재고</th><th>입고계획</th><th>가용수량</th><th>자재 부족수량</th><th>판단상태</th>" +
    "</tr></thead><tbody>" + summaryRows + "</tbody></table></div></div>";

  // ══ SECTION SIM: 빠른 시뮬레이션 ══
  var simHtml = "";
  if (canCompute) {
    var tp = 0, tr2 = 0;
    item.parentItems.forEach(function(p) {
      p.monthly.forEach(function(m) { tp += m.prodQty; tr2 += m.reqQty; });
    });
    var avgUnitReq = tp > 0 ? tr2 / tp : null;

    var simKey = item.componentCode + "|" + item.plant;
    var simDataObj = {
      months:      months,
      monthlyData: item.monthlyData.map(function(md) {
        return { requiredQty: md.requiredQty || 0, availableQty: md.availableQty, shortageQty: md.shortageQty };
      }),
      hasAltBom:   !!item.hasAltBom,
      avgUnitReq:  avgUnitReq,
      matUnit:     matUnit,
      dec:         dec,
    };
    var simKey_esc  = escapeHtml(simKey);
    var simData_esc = escapeHtml(JSON.stringify(simDataObj));

    var simMHds = months.map(function(m) {
      return "<th class=\"cst-sim-mh\">" + escapeHtml(monthLabel(m)) + "</th>";
    }).join("");

    var simInRow = "<tr><td class=\"cst-sim-ilabel\">입고 추가/당김 (" + escapeHtml(matUnit || "자재단위") + ")</td>" +
      months.map(function(m) {
        return "<td><input type=\"number\" step=\"any\" class=\"cst-sim-input\" data-type=\"incoming\" data-month=\"" +
          escapeHtml(m) + "\" placeholder=\"0\"></td>";
      }).join("") + "</tr>";

    var simPRow = "<tr><td class=\"cst-sim-ilabel\">생산계획 조정 (EA — 음수 감소/양수 증가)</td>" +
      months.map(function(m) {
        return "<td><input type=\"number\" step=\"1\" class=\"cst-sim-input\" data-type=\"prod\" data-month=\"" +
          escapeHtml(m) + "\" placeholder=\"0\"></td>";
      }).join("") + "</tr>";

    var simAltRow = item.hasAltBom
      ? "<tr><td class=\"cst-sim-ilabel\">대체BOM 1개당 소요량 (" + escapeHtml(matUnit || "자재단위") +
        ") <span class=\"cst-sim-tag\">대체BOM 있음</span></td>" +
        "<td colspan=\"" + months.length + "\"><input type=\"number\" step=\"any\" class=\"cst-sim-input\" data-type=\"altbom\"" +
        " placeholder=\"미입력 시 기본BOM 계수 유지\" style=\"width:220px\"></td></tr>"
      : "";

    var coefNote = avgUnitReq !== null
      ? "<div class=\"cst-sim-coefnote\">기본BOM 기준 1개당 소요량: " + escapeHtml(_cstFmtVal(avgUnitReq, 6, matUnit)) + "</div>"
      : "";

    simHtml =
      "<div class=\"cst-det-section cst-sim-section\" data-compkey=\"" + simKey_esc + "\" data-simdata=\"" + simData_esc + "\">" +
      "<div class=\"cst-det-section-title\">빠른 시뮬레이션 <span class=\"cst-sim-tag cst-sim-tag-warn\">임시 가정 결과 · 원본 미반영</span></div>" +
      "<div class=\"cst-sim-body\">" +
      coefNote +
      "<div class=\"cst-det-scroll\"><table class=\"cst-sim-input-table\"><thead><tr>" +
      "<th class=\"cst-sim-ilabel-h\">입력 항목</th>" + simMHds + "</tr></thead>" +
      "<tbody>" + simInRow + simPRow + simAltRow + "</tbody></table></div>" +
      "<div class=\"cst-sim-btns\">" +
      "<button type=\"button\" class=\"btn-sim-run\"" +
      " onclick=\"_cstSimRun(this.closest('.cst-sim-section').getAttribute('data-compkey'))\">▶ 시뮬레이션 실행</button> " +
      "<button type=\"button\" class=\"btn-sim-reset\"" +
      " onclick=\"_cstSimReset(this.closest('.cst-sim-section').getAttribute('data-compkey'))\">초기화</button> " +
      "<button type=\"button\" class=\"btn-sim-send\" disabled title=\"확정 조정은 조정입력 화면에서 반영\">조정안으로 보내기</button>" +
      "</div>" +
      "<div class=\"cst-sim-result\" style=\"display:none\">" +
      "<div class=\"cst-sim-result-title\">▼ 시뮬레이션 결과 (가정 기준)</div>" +
      "<div class=\"cst-det-scroll\"><table class=\"cst-sim-result-table\"><thead><tr>" +
      "<th class=\"cst-sim-ilabel-h\">결과 항목</th>" + simMHds + "</tr></thead>" +
      "<tbody></tbody></table></div>" +
      "</div>" +
      "</div></div>";
  }

  // ══ SECTION 2: 영향품목 및 조율 후보 ══

  // 판매계획 lookup (부족 컬럼 — shortageConfirmed 여부 무관)
  var salesByParentMonth = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant), month = cleanOptional(r.month);
    if (!code || !plant || !month) return;
    var key = code + "|" + plant + "|" + month;
    salesByParentMonth.set(key, (salesByParentMonth.get(key) || 0) + (cleanNumber(r.salesQty) || 0));
  });

  // 월별 자재 부족수량 index
  var monthlyShortage = new Map();
  item.monthlyData.forEach(function(md, i) { monthlyShortage.set(months[i], md.shortageQty); });

  // 월별 전체 자재 필요수량 (자재 부족수량 안분 기준)
  var totalReqByMonth = new Map();
  item.parentItems.forEach(function(p) {
    p.monthly.forEach(function(md) {
      totalReqByMonth.set(md.month, (totalReqByMonth.get(md.month) || 0) + md.reqQty);
    });
  });

  var sortedParents = item.parentItems.slice().sort(function(a, b) {
    var aR = a.monthly.reduce(function(s, m) { return s + m.reqQty; }, 0);
    var bR = b.monthly.reduce(function(s, m) { return s + m.reqQty; }, 0);
    return bR - aR;
  });
  var EXPAND_LIMIT = 20;
  var hasMore = sortedParents.length > EXPAND_LIMIT;
  var shownParents = sortedParents.slice(0, EXPAND_LIMIT);

  // 3컬럼/월: 생산계획, 부족, 자재 부족수량
  var impMonthHeads = months.map(function(m) {
    return "<th class=\"cst-imp-month impact-month-header\" colspan=\"3\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var impSubHeads = months.map(function() {
    return "<th class=\"cst-imp-sub impact-month-metric-header\">생산계획</th>" +
           "<th class=\"cst-imp-sub impact-month-metric-header\">부족</th>" +
           "<th class=\"cst-imp-sub impact-month-metric-header\">자재 부족수량</th>";
  }).join("");

  var impRows = shownParents.map(function(p) {
    var unitReqNum = null;
    p.monthly.some(function(m) {
      if (m.prodQty > 0 && m.reqQty > 0) { unitReqNum = m.reqQty / m.prodQty; return true; }
      return false;
    });
    var adjLabel = !canCompute ? "데이터 연결 후 판단"
                 : item.hasAnyShortage ? "조율 검토 대상" : "-";
    var adjCls = adjLabel === "조율 검토 대상"      ? " cst-adj-candidate"
               : adjLabel === "데이터 연결 후 판단" ? " cst-adj-unknown" : "";

    var monthlyCells = p.monthly.map(function(md, mi) {
      var month = months[mi];
      var sc = mi % 2 === 1 ? " cst-imp-col-shade" : "";

      // 생산계획
      var prodDisp = md.prodQty > 0 ? formatNumber(Math.round(md.prodQty)) : "-";

      // 부족: 판매계획 - 생산계획
      var salesQty = salesByParentMonth.get(p.code + "|" + p.plant + "|" + month) || 0;
      var rtfShortage = Math.max(0, salesQty - md.prodQty);
      var rtfDisp = rtfShortage > 0 ? formatNumber(Math.round(rtfShortage)) : "-";

      // 자재 부족수량: 전체 자재 부족수량을 reqQty 비율로 안분
      var totalShortage = monthlyShortage.get(month);
      var totalReqQty = totalReqByMonth.get(month) || 0;
      var pMatShortage = null;
      if (canCompute && totalShortage !== null && totalShortage > 0 && totalReqQty > 0) {
        pMatShortage = totalShortage * (md.reqQty / totalReqQty);
      }
      var matDisp = (pMatShortage !== null && pMatShortage > 0)
        ? escapeHtml(_cstFmtVal(pMatShortage, dec, matUnit)) : "-";

      return "<td class=\"cst-imp-num" + sc + "\">" + prodDisp + "</td>" +
             "<td class=\"cst-imp-num cst-imp-short" + sc + "\">" + rtfDisp + "</td>" +
             "<td class=\"cst-imp-num cst-imp-matshort" + sc + "\">" + matDisp + "</td>";
    }).join("");

    return "<tr class=\"cst-imp-row\">" +
      "<td class=\"cst-imp-code\" title=\"" + escapeHtml(p.code) + "\">" + escapeHtml(p.code) + "</td>" +
      "<td class=\"cst-imp-name\" title=\"" + escapeHtml(p.name) + "\">" + escapeHtml(p.name) + "</td>" +
      "<td class=\"cst-imp-center\">" + escapeHtml(p.itemGroup === NEED_MASTER ? "확인필요" : p.itemGroup) + "</td>" +
      "<td class=\"cst-imp-num cst-imp-coeff\" title=\"완제품 1개 생산 시 소요량\">" +
        escapeHtml(unitReqNum !== null ? _cstFmtVal(unitReqNum, 6, matUnit) : "-") + "</td>" +
      monthlyCells +
      "<td class=\"cst-imp-adj" + adjCls + "\">" + escapeHtml(adjLabel) + "</td>" +
      "</tr>";
  }).join("");

  // 합계 행
  var totalRow = "<tr class=\"cst-imp-total\">" +
    "<td colspan=\"4\" class=\"cst-imp-total-label\">합계</td>" +
    months.map(function(month, mi) {
      var sc = mi % 2 === 1 ? " cst-imp-col-shade" : "";
      var md = item.monthlyData[mi];
      var totalShortage = monthlyShortage.get(month);
      var shortDisp = (canCompute && totalShortage !== null && totalShortage > 0)
        ? escapeHtml(_cstFmtVal(totalShortage, dec, matUnit)) : "-";
      return "<td class=\"cst-imp-num" + sc + "\">-</td>" +
             "<td class=\"cst-imp-num" + sc + "\">-</td>" +
             "<td class=\"cst-imp-num cst-imp-total-num cst-imp-matshort" + sc + "\">" + shortDisp + "</td>";
    }).join("") +
    "<td class=\"cst-imp-adj\">-</td>" +
    "</tr>";

  var moreMsg = hasMore
    ? "<div class=\"cst-detail-more\">전체 " + sortedParents.length + "개 중 " + EXPAND_LIMIT + "개 표시</div>"
    : "";

  var impactHtml =
    "<div class=\"cst-det-section\">" +
    "<div class=\"cst-det-section-title\">영향품목 및 조율 후보</div>" +
    "<div class=\"cst-imp-note\">공용자재의 자재 부족수량은 영향품목 기준으로 표시되며, 최종 배분은 회의에서 결정합니다.</div>" +
    "<div class=\"cst-det-scroll\"><table class=\"cst-imp-table impact-items-table\"><thead>" +
    "<tr class=\"cst-imp-head\">" +
    "<th class=\"impact-month-header\" rowspan=\"2\">완제품코드</th>" +
    "<th class=\"impact-month-header\" rowspan=\"2\">완제품명</th>" +
    "<th class=\"impact-month-header\" rowspan=\"2\">품목군</th>" +
    "<th class=\"impact-month-header\" rowspan=\"2\" title=\"완제품 1개 생산 시 소요량\">개당 소요량</th>" +
    impMonthHeads +
    "<th class=\"impact-month-header\" rowspan=\"2\">조율 후보</th></tr>" +
    "<tr class=\"cst-imp-head\">" + impSubHeads + "</tr>" +
    "</thead><tbody>" + impRows + totalRow + "</tbody></table>" + moreMsg + "</div></div>";

  return "<tr class=\"cst-detail-row\"><td colspan=\"" + totalCols + "\" class=\"cst-detail-cell\">" +
    "<div class=\"cst-detail-inner cst-detail-v2\">" +
    summaryHtml + simHtml + impactHtml +
    "</div></td></tr>";
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
               (ci === 0 && mi > 0 ? " cst-month-start" : "") + "\">" + escapeHtml(CONSTR_METRICS_LABEL[metric] || metric) + "</th>";
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
    var emptyMsg = "공급 제약 대상이 없습니다";
    var _d = state.cstDrilldown;
    if (_d) {
      var tg = _d.typeGroup || "";
      if (tg === "완제품" || tg === "완제품(수탁)") {
        emptyMsg = "해당 품목의 BOM 연결 자재가 없습니다. BOM 파일에서 품목코드(자재번호 Root)를 확인하십시오.";
      } else if (!tg || tg === STATUS.UNKNOWN) {
        emptyMsg = "집계 조건 기준 조회입니다. 개별 품목 행을 클릭하여 공급원인을 확인하십시오.";
      } else {
        emptyMsg = "RTF 결과와 공급원인 결과 연결 필요 — BOM 전개 후 재조회하십시오.";
      }
    }
    bodyRows = "<tr><td colspan=\"" + totalCols + "\" class=\"cst-empty\">" + escapeHtml(emptyMsg) + "</td></tr>";
  } else {
    bodyRows = items.map(function(item) {
      var compKey    = item.componentCode + "|" + item.plant;
      var isExpanded = state.expandedConstraintRows && state.expandedConstraintRows.has(compKey);
      var unitTitle  = item.unitMismatch
        ? "BOM 단위와 현재고/공급계획 단위가 일치하지 않아 자재 부족수량 계산이 불가능합니다."
        : item.unitMissing ? "단위 기준정보가 없어 단위 정합성을 확인할 수 없습니다." : "";
      var parentTooltip = "영향 품목군: " + (item.parentItemGroup === NEED_MASTER ? "확인필요" : item.parentItemGroup) +
                          "\n대표 영향품목: " + (item.parentItems.length > 0 ? item.parentItems[0].name : "-");

      var leftCells = cols.map(function(col) {
        var aCls = col.align === "left" ? " cst-cell-left" : "";
        var xCls = col.isName ? " cst-col-name" : col.isLast ? " cst-col-last-sticky" : "";
        var value = "", extra = "", titleAttr = "", htmlContent = null;
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
        else if (col.key === "decision") {
          var dLabel = decisionLabel(item);
          htmlContent = "<span class=\"" + decisionCls(dLabel) + "\">" + escapeHtml(dLabel) + "</span>" +
            ((item.hasAltBom && item.hasAnyShortage)
              ? " <button type=\"button\" class=\"cst-altbom-btn\" title=\"대체BOM이 존재합니다. 적용 기준 검토 후 수동 반영하십시오.\">대체BOM 검토</button>"
              : "");
        }
        var unitWarnCls = (col.key === "unit" && (item.unitMismatch || item.unitMissing)) ? " cst-unit-warn" : "";
        return "<td class=\"cst-sticky cst-td" + aCls + xCls + unitWarnCls + "\" style=\"left:" + col.left + "px;width:" + col.width + "px;\"" + titleAttr + ">" +
               (htmlContent !== null ? htmlContent : extra + escapeHtml(value)) + "</td>";
      }).join("");

      var metricCells;
      if (detailMode) {
        var _mUnit = (item.unit && item.unit !== "확인필요") ? item.unit : "";
        var _mDec  = _cstDecByUnit(_mUnit);
        metricCells = item.monthlyData.map(function(md, mi) {
          return CONSTR_METRICS.map(function(metric, ci) {
            var borderCls = ci === 0 && mi > 0 ? " cst-month-start" : "";
            var value = "-", cls = "cst-metric-cell", tip = "";
            if (metric === "필요") {
              if (md.requiredQty > 0) {
                value = _cstFmtVal(md.requiredQty, _mDec, _mUnit);
                tip   = "정확값: " + md.requiredQty + (_mUnit ? " " + _mUnit : "");
              }
            } else if (metric === "가용") {
              if (item.unitMismatch || md.availableQty === null) {
                value = "판단불가"; cls += " cst-neutral-cell";
              } else if (md.availableQty === 0) {
                value = "0" + (_mUnit ? " " + _mUnit : "");
              } else {
                value = _cstFmtVal(md.availableQty, _mDec, _mUnit);
                tip   = "정확값: " + md.availableQty + (_mUnit ? " " + _mUnit : "");
              }
            } else {
              if (item.unitMismatch || md.shortageQty === null) {
                value = "판단불가"; cls += " cst-neutral-cell";
              } else if (md.shortageQty > 0) {
                value = _cstFmtVal(md.shortageQty, _mDec, _mUnit);
                cls  += " cst-shortage-cell";
                tip   = "정확값: " + md.shortageQty + (_mUnit ? " " + _mUnit : "");
              } else {
                value = "-"; cls += " cst-neutral-cell";
              }
            }
            var tipAttr = tip ? " title=\"" + escapeHtml(tip) + "\"" : "";
            return "<td class=\"" + cls + borderCls + "\"" + tipAttr + ">" + escapeHtml(value) + "</td>";
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
        detailRow = renderCstDetailExpanded(item, months, totalCols);
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

  var d = state.cstDrilldown;
  // 상품 유형은 BOM 전개 불필요 — 개별/집계 모두 goods 패널로 처리
  var isGoods = d && d.typeGroup === "상품";

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
    (d ? renderCstDrilldownBanner(d) : "") +
    (isGoods ? renderCstGoodsPanel(d) : "") +
    (isGoods && d ? renderCstShortMaterialsPanel(d) : "") +
    (!isGoods && d ? renderCstFinishedGoodsPanel(d) : "") +
    (!isGoods ? (bomStatus === BOM_STATUS.DONE && state.bomResult ? renderConstraintSummaryCard(state.bomResult) : "") : "") +
    (!isGoods ? renderConstraintTableSection(state.bomResult, bomStatus, months) : "") +
    (!isGoods ? renderValidationPanel() : "") +
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
        try {
          var res = computeBomExpansion();
          state.bomResult       = res;
          state.bomStatus       = res.status;
        } catch(e) {
          state.bomResult  = { status:BOM_STATUS.FAILED, failReasons:["BOM 전개 오류: " + (e.message || e)], items:[], stats:{} };
          state.bomStatus  = BOM_STATUS.FAILED;
        }
        state.bomProgressStep = "";
        state.constraintSearch = "";
        state.constraintDetailMode = false;
        state.constraintImpactSort = 0;
        state.constraintFilter = (state.bomResult && state.bomResult.items && state.bomResult.items.some(function(i) { return i.hasAnyShortage; })) ? "shortage" : "all";
        render("constraint");
        if (state.currentMenuId === "rtf") render("rtf");
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
  var critBtn = document.querySelector("#calcCriteriaBtn");
  if (critBtn) critBtn.addEventListener("click", function() {
    state.calcCriteriaOpen = !state.calcCriteriaOpen;
    render("constraint");
  });

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

  // 드릴다운 해제
  var clearDrill = document.querySelector("#cstClearDrilldown");
  if (clearDrill) clearDrill.addEventListener("click", function() {
    state.cstDrilldown = null;
    render("constraint");
  });
}
