// ── 전개 상태 상수 ────────────────────────────────────────────────────────────
var BOM_STATUS = { IDLE:"idle", RUNNING:"running", DONE:"done", FAILED:"failed" };
var _bomAnimId = 0;
var _cstBomRtfItems = null; // renderCstCompareBanner용 computeRtfItems 캐시 (BOM 재전개 시 null 초기화)

// ── BOM 전개 입력 시그니처 (계획·재고·BOM 변경 감지용) ─────────────────────────
// 전개 결과(bomResult)는 "전개" 시점의 스냅샷이므로, 이후 계획/재고 파일이 바뀌면
// 낡은 스냅샷이 남는다. 시그니처를 result.inputSig에 심어두고 현재 입력과 비교해
// staleness(재전개 필요)를 판정한다. 새 파일 로드 시 processFiles가 자동 재전개.
function computeBomInputSig() {
  var md = (typeof state !== "undefined" && state.mappedData) || {};
  function acc(arr, fields) {
    var out = [arr ? arr.length : 0];
    (fields || []).forEach(function(f) {
      var s = 0;
      if (arr) for (var i = 0; i < arr.length; i++) {
        var v = arr[i][f];
        if (typeof v === "number" && isFinite(v)) s += v;
      }
      out.push(Math.round(s));
    });
    return out.join(":");
  }
  return [
    "p" + acc(md.plan_monthly,   ["salesQty", "supplyQty"]),
    "i" + acc(md.inventory_base, ["baseQty", "baseAmount"]),
    "b" + acc(md.bom_components, ["componentQty"]),
  ].join("|");
}

// 전개 완료 상태인데 입력 시그니처가 달라졌으면 재전개 필요(stale)
function isBomStale() {
  return typeof state !== "undefined" &&
    state.bomStatus === BOM_STATUS.DONE &&
    state.bomResult &&
    typeof state.bomResult.inputSig === "string" &&
    state.bomResult.inputSig !== computeBomInputSig();
}

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
// demandField: 완제품 수요 기준 컬럼. 기본 "supplyQty"(공급계획=생산계획, 화면 전개용).
// 요청양식 다운로드는 공급계획 회신 전 단계라 "salesQty"(판매계획)로 소요량을 선전개한다.
function computeBomExpansion(demandField) {
  demandField = demandField || "supplyQty";
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
    prodPlanMap.set(key, (prodPlanMap.get(key) || 0) + (cleanNumber(row[demandField]) || 0));
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

  // 기초재고: code|plant → { qty, unit, amt, stdCost } (amt·stdCost는 장부단가용)
  var inventoryMap = new Map();
  inventoryRows.forEach(function(row) {
    var code = cleanOptional(row.itemCode), plant = cleanOptional(row.plant);
    if (!code || !plant) return;
    var key  = code + "|" + plant;
    var unit = cleanOptional(row.unit) || "";
    var qty  = cleanNumber(row.baseQty) || 0;
    var amt  = cleanNumber(row.baseAmount) || 0;
    var std  = cleanNumber(row.standardCost);
    var ex   = inventoryMap.get(key);
    if (ex) {
      ex.qty += qty; ex.amt += amt;
      if (!ex.unit && unit) ex.unit = unit;
      if (ex.stdCost === null && std !== null) ex.stdCost = std;
    }
    else inventoryMap.set(key, { qty:qty, unit:unit, amt:amt, stdCost:std });
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

  // ── 월별 단계 투입금액 집계 (관리기준 출고 추정용) ─────────────────────────
  // 결산 전체출고는 원료→반제품→완제품 각 투입 단계를 단계마다 세므로 (중복 집계),
  // 여기서도 모든 BOM 구성품 행(원료·자재·반제품)의 투입금액을 단계별로 누적.
  // 장부단가 = 기초금액/기초수량 (없으면 표준원가). 단가 없는 구성품은 스킵.
  var stageOutByMonth = {};
  function _unitVal(code, plant) {
    var e = inventoryMap.get(code + "|" + plant);
    if (!e) return null;
    if (e.amt > 0 && e.qty > 0) return e.amt / e.qty;
    return Number.isFinite(e.stdCost) && e.stdCost > 0 ? e.stdCost : null;
  }
  function _addStage(code, matPlant, parentPlant, rootCode, effRatio) {
    var uv = _unitVal(code, matPlant);
    if (uv === null) return;
    months.forEach(function(month) {
      var prodQty = prodPlanMap.get(rootCode + "|" + parentPlant + "|" + month) || 0;
      if (!prodQty) return;
      stageOutByMonth[month] = (stageOutByMonth[month] || 0) + prodQty * effRatio * uv;
    });
  }

  // ── 구성품별 소요량 집계 (혼합형 다단계 BOM)
  var compReqs = new Map();
  var missingCompCodeCount = 0;

  // ── 완제품 생산플랜트 폴백 매핑 ──────────────────────────────────────────────
  // 판매계획 플랜트(예: 향남)와 BOM 플랜트(예: 오송)가 다를 때: 그 완제품 BOM이
  // 단일 공장에만 있고 계획도 단일 공장이면, 생산계획을 그 계획 플랜트에 귀속시켜
  // "자재는 BOM 공장 재고, 부모완제품은 계획 플랜트"로 매칭 (BOM 연결 없음 방지).
  var planPlantsByRoot = new Map(); // rootCode → Set(계획 플랜트)
  prodPlanMap.forEach(function(_qty, key) {
    var parts = key.split("|"), code = parts[0], plant = parts[1];
    if (!planPlantsByRoot.has(code)) planPlantsByRoot.set(code, new Set());
    if (plant) planPlantsByRoot.get(code).add(plant);
  });
  var bomPlantsByRoot = new Map(); // rootCode(9) → Set(BOM 플랜트)
  baseBomRows.forEach(function(r) {
    if (!r.rootItemCode || !r.rootItemCode.startsWith("9")) return;
    if (!bomPlantsByRoot.has(r.rootItemCode)) bomPlantsByRoot.set(r.rootItemCode, new Set());
    if (r.plant) bomPlantsByRoot.get(r.rootItemCode).add(r.plant);
  });
  function effParentPlant(rootCode, bomPlant) {
    var planSet = planPlantsByRoot.get(rootCode);
    if (planSet && planSet.has(bomPlant)) return bomPlant;   // 정상: 계획=BOM 플랜트
    var bomSet = bomPlantsByRoot.get(rootCode);
    if (bomSet && bomSet.size === 1 && planSet && planSet.size === 1) {
      return Array.from(planSet)[0];  // 폴백: 계획 플랜트로 귀속 (단일공장 BOM만)
    }
    return bomPlant;  // 폴백 불가 → 그대로 (생산계획 0 → 요건 0)
  }

  // 소요량 등록 내부 헬퍼 — matPlant: 자재(재고) 플랜트, parentPlant: 부모완제품(계획) 플랜트
  var _addComp = function(code, name, unit, cat, matPlant, parentPlant, rootKey, rootCode, rootName, rootGroup, effRatio) {
    var ck = code + "|" + matPlant;
    if (!compReqs.has(ck)) {
      compReqs.set(ck, {
        componentCode:   code,
        componentName:   name || code,
        plant:           matPlant,
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
        code: rootCode, name: rootName, plant: parentPlant, itemGroup: rootGroup, monthly: new Map(),
      });
    }
    var pi = comp.parentItems.get(rootKey);
    months.forEach(function(month) {
      var prodQty = prodPlanMap.get(rootCode + "|" + parentPlant + "|" + month) || 0;
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
    var parentPlant = effParentPlant(bom.rootItemCode, bom.plant); // 계획 플랜트(폴백 시 향남)
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

    // 단계 투입금액: 모든 구성품 행(반제품 경유 포함)을 단계별로 집계
    _addStage(bom.componentCode, bom.plant, parentPlant, bom.rootItemCode, ratio);

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
                   bom.plant, parentPlant, rootKey, bom.rootItemCode, rootName, rootGroup, ratio * subR);
          _addStage(sub.componentCode, bom.plant, parentPlant, bom.rootItemCode, ratio * subR);
        });
        return; // 반제품 자체는 집계 제외
      }

      // 하위 BOM 없음 → 반제품을 부족 판정 대상으로 유지하며 경고 부착
      bomStat.semiNoSubBom.add(bom.componentCode + "|" + bom.plant);
      // fall through — 반제품을 일반 자재처럼 집계
    }

    // 일반 집계 (원료·자재 또는 하위 BOM 없는 반제품)
    _addComp(bom.componentCode, bom.componentName, bom.componentUnit, bom.itemCategory,
             bom.plant, parentPlant, rootKey, bom.rootItemCode, rootName, rootGroup, ratio);
  });

  // 결과 아이템 생성
  var resultItems = [];
  var matFlows    = []; // 과잉감축 원부자재 탭용: 전체 구성품 흐름 (부족 필터와 무관)
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

    // 자재 과잉관리용 흐름 데이터 (소비=부모 생산계획 비례라 완제품 감축 시 재계산 가능)
    var _intake = {}, _reqBy = {};
    months.forEach(function(month) {
      var sd = compSupplyMap.get(comp.componentCode + "|" + comp.plant + "|" + month);
      _intake[month] = sd ? sd.qty : 0;
      _reqBy[month]  = comp.requiredByMonth.get(month) || 0;
    });
    var _parents = [];
    comp.parentItems.forEach(function(pi) {
      var pm = {};
      pi.monthly.forEach(function(v, month) { pm[month] = { prodQty: v.prodQty, reqQty: v.reqQty }; });
      _parents.push({ code: pi.code, plant: pi.plant, monthly: pm });
    });
    // 단위 정합: BOM·재고·입고계획 단위가 (알려진 것끼리) 모두 일치해야 흐름 계산 신뢰 가능
    // (예: 재고 KG · 입고계획 TB 혼재 시 소비/입고 비교 불가 → 과잉 판단에서 제외)
    var _units = [comp.bomUnit, invUnit, firstSupplyUnit]
      .filter(function(u) { return u; })
      .map(function(u) { return String(u).toLowerCase(); });
    var unitOk = new Set(_units).size <= 1;
    matFlows.push({
      componentCode: comp.componentCode,
      componentName: comp.componentName,
      plant:         comp.plant,
      category:      categoryDisplay,
      unit:          resolvedUnit,
      unitOk:        unitOk,
      baseQty:       baseQty, // 현재고 (미연결이면 null)
      unitVal:       _unitVal(comp.componentCode, comp.plant),
      intakeByMonth: _intake,
      reqByMonth:    _reqBy,
      parents:       _parents,
    });
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

  result.status          = BOM_STATUS.DONE;
  result.completedAt     = new Date();
  result.inputSig        = computeBomInputSig(); // 전개 당시 입력 스냅샷 지문 (staleness 판정용)
  result.items           = sorted;
  result.stageOutByMonth = stageOutByMonth; // 월별 단계 투입금액 (원) — 관리기준 출고 추정용
  result.matFlows        = matFlows;        // 구성품 전체 흐름 — 과잉감축 원부자재 탭용
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

// ── 완제품 중심 그룹핑 (카드 뷰용) ──────────────────────────────────────────
function groupByFinishedGood(items) {
  var months = getRtfMonths();
  var fgMap = new Map();

  items.forEach(function(item) {
    if (!item.hasAnyShortage) return;
    item.parentItems.forEach(function(p) {
      var key = p.code + "|" + (p.plant || "");
      if (!fgMap.has(key)) {
        fgMap.set(key, {
          code: p.code, name: p.name, plant: p.plant || "",
          shortageMonthIdxSet: new Set(),
          materials: []
        });
      }
      var fg = fgMap.get(key);
      var matShortMonthIdxs = [];
      item.monthlyData.forEach(function(md, mi) {
        if (md.shortageQty !== null && md.shortageQty > 0) {
          fg.shortageMonthIdxSet.add(mi);
          matShortMonthIdxs.push(mi);
        }
      });
      if (matShortMonthIdxs.length === 0) return;
      // 동일 자재 중복 방지
      var alreadyAdded = fg.materials.some(function(m) { return m.code === item.componentCode && m.plant === item.plant; });
      if (alreadyAdded) return;
      fg.materials.push({
        code: item.componentCode,
        name: item.componentName,
        unit: item.unit,
        isShared: item.isShared,
        totalShortage: item.totalShortage,
        monthlyData: item.monthlyData,
        shortageMonthIdxs: matShortMonthIdxs,
        plant: item.plant,
      });
    });
  });

  return Array.from(fgMap.values()).sort(function(a, b) {
    return b.shortageMonthIdxSet.size - a.shortageMonthIdxSet.size;
  });
}

