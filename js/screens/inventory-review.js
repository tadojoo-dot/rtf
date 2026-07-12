// ── 재고 총괄장: 결산 리뷰(1~6월) + 전망(7~12월) ─────────────────────────────
// 스펙: docs/재고전망-스펙.md
//
// 이 화면이 회의의 시작점이다. 6월 결산을 리뷰해서 "왜 늘었는가"를 특정하고,
// 그대로 하반기 전망(원계획 → RTF조정 → 과잉감축)으로 이어진다.
//
// 핵심 규칙
//   · 헤드라인 총재고 = 공시기준(결산_RAW 합계). 세부 전개 = 관리기준(자재수불).
//     차액(미착품·평가충당금)은 조정행으로 명시 → 표를 다 더하면 헤드라인이 나온다.
//   · 재고일수 = 재고금액 ÷ 매출원가 × 일수. 결산_RAW의 '출고금액'은 원부자재 사내소비를
//     포함해 이중계상하므로 쓰지 않는다(72.8일 vs 실제 142.3일).
//   · 3평판 = 최근 3개월 평균 '판매(금액)'. 코스트센터출고(샘플·데모)는 판매가 아니다.
//   · 나보타(플랜트 1220)는 품목 전개 없이 총액 한 줄.

var REVIEW_MONTHS = ["2026-01","2026-02","2026-03","2026-04","2026-05","2026-06"];
var FCST_MONTHS   = ["2026-07","2026-08","2026-09","2026-10","2026-11","2026-12"];

// 전망 매출원가 보정계수 — 판매계획 파일이 전사 매출원가의 약 77%만 커버한다.
// 보정 없이 계획×표준원가를 분모로 쓰면 6→7월에 재고일수가 30일 점프한다.
// 상반기 6개월 실측(결산 매출원가 ÷ 계획파일 실적수량×표준원가)의 평균.
var COGS_COVERAGE_K = 1.301;

var REV_FG     = ["완제품", "상품"];
var TYPE_ORDER = ["상품", "완제품", "원료", "반제품", "구매반제품", "자재", "기타"];

var _reviewCache = null, _reviewCacheEpoch = -1;

// ── 선행 커버리지(일) ─────────────────────────────────────────────────────────
// 6월말 재고를 7월부터의 월별 소요(금액)로 차례로 소진시켜, 몇 일 만에 0이 되는지 센다.
// 과거 3개월 평균(3평판)이 아니라 "앞으로의 계획대로면 며칠 버티는가"를 답한다.
// 계획 구간(6개월)을 넘기고도 재고가 남으면 계획 말기 속도로 외삽 — 그래야 "68개월치" 같은
// 극단값이 184일에서 잘리지 않는다. 나갈 계획이 아예 없으면 소진 불가(∞) — 지어내지 않는다.
function revForwardCoverDays(endWon, monthlyNeedWon) {
  if (!(endWon > 0)) return 0;
  var totalNeed = (monthlyNeedWon || []).reduce(function(s, v) { return s + (v > 0 ? v : 0); }, 0);
  if (!(totalNeed > 0)) return Infinity;
  var rem = endWon, days = 0, lastDaily = 0;
  for (var mi = 0; mi < monthlyNeedWon.length; mi++) {
    var dim  = monthDays(FCST_MONTHS[mi]);
    var need = monthlyNeedWon[mi];
    if (!(need > 0)) { days += dim; continue; }
    lastDaily = need / dim;
    if (rem >= need) { rem -= need; days += dim; }
    else { days += rem / lastDaily; return days; }
  }
  if (rem > 0 && lastDaily > 0) days += rem / lastDaily;
  return days;
}

// ── 품목 유니버스 (결산 기준, 나보타 제외) ────────────────────────────────────
function buildReviewItems() {
  if (_reviewCache && _reviewCacheEpoch === (window._renderEpoch || 0)) return _reviewCache;
  var c = state.closing;
  if (!c || c.status !== CLOSING_STATUS.DONE) return null;

  // 전망: RTF 품목을 코드 단위로 합산 (결산은 플랜트 합산 기준이므로 축을 맞춘다)
  var rtfItems = (typeof computeRtfItems === "function") ? computeRtfItems(undefined, true) : [];
  var hasRtfAdj = (Object.keys(state.matSimAdj || {}).length > 0) ||
                  (typeof hasFgProdAdj === "function" && hasFgProdAdj());
  var bomMap = hasRtfAdj && typeof buildBomMaxProducibleMap === "function"
    ? buildBomMaxProducibleMap(state.matSimAdj, state.fgProdAdj) : null;

  var fcstByCode = new Map();   // itemCode → { base[], rtf[], exc[], needWon[] } (원)
  rtfItems.forEach(function(it) {
    var adjR = (typeof computeAdjMonthly    === "function") ? computeAdjMonthly(it, bomMap)    : null;
    var adjE = (typeof computeExcessMonthly === "function") ? computeExcessMonthly(it, bomMap) : null;
    var f = fcstByCode.get(it.itemCode);
    if (!f) { f = { base: [], rtf: [], exc: [], needWon: [0,0,0,0,0,0] }; fcstByCode.set(it.itemCode, f); }
    FCST_MONTHS.forEach(function(_, mi) {
      var ms = it.monthlyStatus && it.monthlyStatus[mi];
      var b  = ms && Number.isFinite(ms.endingAmount) ? ms.endingAmount : 0;
      var r  = adjR && adjR[mi] && Number.isFinite(adjR[mi].endingAmount) ? adjR[mi].endingAmount : b;
      var e  = adjE && adjE[mi] && Number.isFinite(adjE[mi].endingAmount) ? adjE[mi].endingAmount : r;
      f.base[mi] = (f.base[mi] || 0) + b;
      f.rtf[mi]  = (f.rtf[mi]  || 0) + r;
      f.exc[mi]  = (f.exc[mi]  || 0) + e;
      // 선행 커버리지용 월별 소요(금액) — 판매계획 수량 × 표준원가
      if (ms && Number.isFinite(ms.salesQty) && Number.isFinite(it.standardCost) && it.standardCost > 0)
        f.needWon[mi] += ms.salesQty * it.standardCost;
    });
  });

  // 원부자재 전망: 3시나리오 자재 흐름(BOM 롤포워드)을 품목코드별 금액 델타로 집계
  var matFcst = buildMatFcstMap();

  // 원부자재는 기준정보로 못 붙는다(매핑률 16.4%) → BOM 역전개로 품목군을 귀속시킨다
  var matGroups = buildMatGroupMap();

  var items = [];
  c.items.forEach(function(it) {
    var m6 = it.mon[5];
    if (!m6) return;
    var hist = it.mon.map(function(m) { return m ? m.end : null; });
    var end6 = m6.end;
    var isFg = REV_FG.indexOf(it.type) >= 0;

    // 품목군: 제·상품은 기준정보, 원부자재는 BOM 역전개
    var grp = "", shared = [], sharedN = 0;
    if (isFg) {
      grp = (it.businessUnit ? it.businessUnit + " / " : "") + (it.itemGroup || "(미분류)");
    } else {
      var mg = matGroups.get(it.itemCode);
      grp     = mg ? mg.group  : MAT_UNUSED_GROUP;
      shared  = mg ? mg.shared : [];
      sharedN = mg ? mg.n      : 0;
    }

    // 소진 속도의 분모는 유형에 따라 다르다.
    //  · 제·상품  → 3평판 = 최근 3개월 평균 '판매(금액)'. 코스트센터출고(샘플·데모)는 판매가 아니다.
    //  · 원부자재 → 판매되지 않고 생산에 투입된다 → '생산출고'.
    //    판매를 분모로 쓰면 원부자재 전량이 "소진 불가(∞)"로 잡히는 오진이 난다.
    var s3 = 0, n3 = 0;
    for (var i = 3; i <= 5; i++) {
      var m = it.mon[i];
      if (!m) continue;
      s3 += isFg ? m.sale : m.prodOut;
      n3++;
    }
    var avg3 = n3 ? s3 / n3 : 0;

    var f = fcstByCode.get(it.itemCode);
    var fBase, fRtf, fExc, shortF = null, hasMatFlow = false;
    if (isFg) {
      // 판매계획이 없는 품목은 나갈 경로가 없다 → 0이 아니라 6월말 재고를 그대로 이월(flat)
      fBase = f ? f.base : FCST_MONTHS.map(function() { return end6; });
      fRtf  = f ? f.rtf  : fBase;
      fExc  = f ? f.exc  : fBase;
    } else {
      var mf = matFcst && matFcst.get(it.itemCode);
      if (mf) {
        // 결산 6월말을 기준점으로, 자재 흐름 델타(rtf.js:computeMatRollforwardDeltas와 동일 산식)를
        // 얹는다. 물리 재고는 음수 불가 → 0 클램프.
        fBase = FCST_MONTHS.map(function(_, mi) { return Math.max(0, end6 + mf.dBase[mi]); });
        fRtf  = FCST_MONTHS.map(function(_, mi) { return Math.max(0, end6 + mf.dRtf[mi]);  });
        fExc  = FCST_MONTHS.map(function(_, mi) { return Math.max(0, end6 + mf.dExc[mi]);  });
        shortF = mf.short.some(function(v) { return v > 0; }) ? mf.short : null;
        hasMatFlow = true;
      } else {
        // BOM에 안 걸리거나(불용) 단위 불일치 → 흐름 계산 불가. 계산 불가는 계산 불가다.
        // 지어내지 말고 6월말 그대로 이월(flat)하고, hasMatFlow=false로 표시한다.
        fBase = fRtf = fExc = FCST_MONTHS.map(function() { return end6; });
      }
    }

    // 선행 커버리지(일) — 6월말 재고를 하반기 계획(제·상품=판매계획 / 원부자재=BOM 소요)대로
    // 소진하면 며칠 버티는가. 판매·소요 계획이 아예 없으면 needArr가 전부 0 → ∞.
    var needArr = isFg ? (f ? f.needWon : null) : (mf ? mf.needWon : null);
    var covDays = revForwardCoverDays(end6, needArr || [0,0,0,0,0,0]);

    items.push({
      itemCode: it.itemCode, itemName: it.itemName,
      type: it.type, isFg: isFg,
      businessUnit: it.businessUnit,
      group: grp,                       // 트리의 품목군 축 (제·상품=기준정보 / 원부자재=BOM 역전개)
      shared: shared, sharedN: sharedN, // 공용 자재의 사용처
      hist: hist, end6: end6,
      delta: m6.end - m6.base,
      sale6: m6.sale, cc6: m6.ccOut, buy6: m6.buyIn, prod6: m6.prodIn, prodOut6: m6.prodOut,
      avg3out: avg3,   // 제·상품=3평판(판매) / 원부자재=3개월 평균 생산출고 — 팝업 참고용, 표에는 안 보임
      mos3: avg3 > 0 ? end6 / avg3 : (end6 > 0 ? Infinity : null),   // 재고월수(과거 3평판) — 팝업 참고용
      needWon: needArr || [0,0,0,0,0,0],   // 월별 소요(금액) — 팝업·롤업용
      covDays: covDays,   // 재고일수 표시값 — 선행 커버리지(일)
      // 계획이 없어 covDays가 ∞일 때 병기할 참고치 — 과거 3개월 출고 속도 기준(일)
      covFallback: (covDays === Infinity && avg3 > 0) ? (end6 / avg3) * 30 : null,
      hasPlan: isFg ? !!f : hasMatFlow,
      fBase: fBase, fRtf: fRtf, fExc: fExc,
      shortF: shortF, hasMatFlow: hasMatFlow,   // 부족 배지용 (원부자재만)
    });
  });

  _reviewCache = items;
  _reviewCacheEpoch = (window._renderEpoch || 0);
  return items;
}

// ── 원부자재 3시나리오 전망: BOM 롤포워드 → 품목코드별 금액 델타 ─────────────
// 왜 델타인가: BOM matFlows의 현재고(row.flow.baseQty)는 결산 6월말 재고(end6)와
// 원천이 다른 스냅샷이라 절대값을 그대로 쓰면 6→7월에 점프가 난다. rtf.js의
// computeMatRollforwardDeltas가 앵커(공시 총재고)에 얹는 것과 똑같은 산식으로
// "6월말 대비 증감분"만 뽑아 end6에 얹으면 총계가 자동으로 맞는다.
function buildMatFcstMap() {
  if (typeof calcMatFlowRows !== "function") return null;
  var base = calcMatFlowRows(null, null);
  if (!base) return null;   // BOM 미전개 → 계산 불가
  var rtf = calcMatFlowRows(state.fgProdAdj, state.matSimAdj) || base;
  var exc = calcMatFlowRows(
    Object.assign({}, state.fgProdAdj || {}, state.excessAdj    || {}),
    Object.assign({}, state.matSimAdj || {}, state.matExcessAdj || {})) || base;

  var map = new Map();   // itemCode(componentCode) → { dBase[6], dRtf[6], dExc[6], short[6], needWon[6] } (원)
  function get(code) {
    var m = map.get(code);
    if (!m) {
      m = { dBase: [0,0,0,0,0,0], dRtf: [0,0,0,0,0,0], dExc: [0,0,0,0,0,0], short: [0,0,0,0,0,0],
            needWon: [0,0,0,0,0,0] };
      map.set(code, m);
    }
    return m;
  }
  // 플랜트를 합산해 품목코드 단위로 델타를 쌓는다 (결산도 플랜트 합산 기준)
  function accum(rows, key, withShort) {
    rows.forEach(function(row) {
      if (!Number.isFinite(row.flow.unitVal)) return;   // 단위 불일치 → 이 row는 건너뛴다
      var m = get(row.flow.componentCode);
      FCST_MONTHS.forEach(function(_, mi) {
        m[key][mi] += (Math.max(0, row.ending[mi]) - Math.max(0, row.flow.baseQty)) * row.flow.unitVal;
        if (withShort) m.short[mi] += Math.max(0, -row.ending[mi]) * row.flow.unitVal;
      });
    });
  }
  accum(base, "dBase", false);
  accum(rtf,  "dRtf",  false);
  accum(exc,  "dExc",  true);   // 부족 배지는 실제 표시되는 감축후(fExc) 시나리오 기준

  // 선행 커버리지용 월별 소요(금액) — base 시나리오의 BOM 소비량 × 단가. calcMatFlowRows를
  // 다시 부르지 않고 이미 계산된 base rows의 cons를 그대로 합산한다(느린 재호출 방지).
  base.forEach(function(row) {
    if (!Number.isFinite(row.flow.unitVal)) return;
    var m = get(row.flow.componentCode);
    FCST_MONTHS.forEach(function(_, mi) { m.needWon[mi] += (row.cons[mi] || 0) * row.flow.unitVal; });
  });
  return map;
}

// ── BOM 역전개: 원부자재 → 품목군 귀속 ───────────────────────────────────────
// 왜 필요한가: 기준정보(품목구분1)로 원부자재를 매핑하면 금액 기준 16.4%밖에 안 붙는다.
// 기준정보는 애초에 제·상품 위주로 만들어진 파일이다. 원부자재의 품목군은 BOM으로
// "이 자재가 어느 완제품에 들어가는가"를 거꾸로 타고 올라가야만 알 수 있다.
//
// 귀속 규칙 (스펙 §4)
//   · 전용 (조상 품목군 1개)   → 그 품목군에 귀속
//   · 공용 (2개 이상)          → 금액을 쪼개지 않고 소요량 최대 품목군에 전액 귀속 +
//                                [공용 N] 배지로 사용처를 드러낸다. 금액 분할은 자의적이라
//                                회의에서 "왜 여기 넣었냐"는 반박을 막을 수 없다.
//   · 미사용 (BOM에 없음)      → "BOM 미사용 · 불용" 별도 그룹. 처분 검토 대상.
//
// 공용의 실체: 펙수프라잔염산염은 펙수클루/생동·허가용/기타품목 3개 품목군에 걸리지만
// 실질은 같은 브랜드가 사업부·규격으로 쪼개진 것뿐이다. 그래서 대표 귀속이 정당하다.

var MAT_UNUSED_GROUP = "BOM 미사용 · 불용";
var MAT_NOBOM_GROUP  = "(BOM 미연결)";
var _matGroupCache = null, _matGroupSig = null;

// BOM이 안 실렸으면 전 자재가 "불용"으로 잡혀 "불용 572억" 같은 허위 경보가 뜬다.
// 그때는 판정 자체를 하지 않는다.
function hasBomData() {
  return (state.mappedData.bom_components || []).length > 0;
}

function buildMatGroupMap() {
  var boms = state.mappedData.bom_components || [];
  var sig  = boms.length + "|" + (state.bomResult ? "exp" : "raw");
  if (_matGroupCache && _matGroupSig === sig) return _matGroupCache;

  // BOM 미연결 — 자재를 불용으로 오판하지 않도록 별도 그룹으로 묶고 판정을 보류한다
  if (!boms.length) {
    var nomap = new Map();
    (state.closing ? Array.from(state.closing.items.keys()) : []).forEach(function(code) {
      nomap.set(code, { group: MAT_NOBOM_GROUP, shared: [], n: 0 });
    });
    _matGroupCache = nomap;
    _matGroupSig   = sig;
    return nomap;
  }

  // 제·상품의 품목군 (조상이 여기 닿으면 그게 답이다)
  var fgGroup = new Map();
  (state.mappedData.item_master || []).forEach(function(m) {
    if (m.itemCode && m.itemGroup)
      fgGroup.set(m.itemCode, (m.businessUnit ? m.businessUnit + " / " : "") + m.itemGroup);
  });

  // child → set(parent). BOM 행의 root는 그 BOM을 소유한 완제품/반제품이다.
  var parents = new Map();
  boms.forEach(function(b) {
    if (!b.componentCode || !b.rootItemCode) return;
    if (b.componentCode === b.rootItemCode) return;
    var s = parents.get(b.componentCode);
    if (!s) { s = new Set(); parents.set(b.componentCode, s); }
    s.add(b.rootItemCode);
  });

  // 소요량 가중치 — BOM 전개가 끝났으면 실제 소요량(7~12월), 아니면 제·상품 재고금액으로 대용.
  // 가중치는 "공용일 때 어느 품목군을 대표로 삼을지"에만 쓰인다.
  var weight = new Map();   // "품목군" → 가중치
  var flows  = state.bomResult && state.bomResult.matFlows;
  if (flows) {
    flows.forEach(function(f) {
      (f.parents || []).forEach(function(p) {
        var g = fgGroup.get(p.code);
        if (!g) return;
        var q = 0;
        Object.keys(p.monthly || {}).forEach(function(m) {
          if (FCST_MONTHS.indexOf(m) >= 0) q += (p.monthly[m].reqQty || 0);
        });
        weight.set(g, (weight.get(g) || 0) + q);
      });
    });
  }
  if (!weight.size && state.closing) {
    state.closing.items.forEach(function(it) {
      if (REV_FG.indexOf(it.type) < 0 || !it.itemGroup) return;
      var g = (it.businessUnit ? it.businessUnit + " / " : "") + it.itemGroup;
      var m6 = it.mon[5];
      if (m6) weight.set(g, (weight.get(g) || 0) + m6.end);
    });
  }

  // 상향 전개 — 자재에서 출발해 조상 제·상품의 품목군을 모은다 (사이클 방어)
  var memo = new Map();
  function ancestors(code, seen) {
    if (memo.has(code)) return memo.get(code);
    seen = seen || new Set();
    if (seen.has(code)) return new Set();
    seen.add(code);

    var out = new Set();
    var own = fgGroup.get(code);
    if (own) out.add(own);                       // 자기 자신이 제·상품이면 그 품목군
    var ps = parents.get(code);
    if (ps) ps.forEach(function(p) {
      if (p === code) return;
      ancestors(p, seen).forEach(function(g) { out.add(g); });
    });
    if (seen.size < 400) memo.set(code, out);
    return out;
  }

  // 대표 귀속에서 후순위로 미는 그룹 — "기타품목"·"생동/의동/허가용"은 실제 브랜드가 아니라
  // 잡다한 것을 담는 통이다. 이런 데로 귀속되면 회의에서 아무 의미가 없다.
  // (예: 소마트로핀 원액 18.5억이 '기타/기타품목'으로 가버리면 담당이 없어진다)
  function isCatchAll(g) {
    return /기타품목|생동|의동|허가용|미분류/.test(g);
  }

  var map = new Map();   // 자재코드 → { group, shared[], n }
  (state.closing ? Array.from(state.closing.items.keys()) : []).forEach(function(code) {
    var gs = Array.from(ancestors(code));
    if (!gs.length) { map.set(code, { group: MAT_UNUSED_GROUP, shared: [], n: 0 }); return; }
    gs.sort(function(a, b) {
      var ca = isCatchAll(a), cb = isCatchAll(b);
      if (ca !== cb) return ca ? 1 : -1;                       // 잡다 그룹은 뒤로
      return (weight.get(b) || 0) - (weight.get(a) || 0);      // 그다음 소요량(또는 재고) 순
    });
    map.set(code, { group: gs[0], shared: gs, n: gs.length });
  });

  _matGroupCache = map;
  _matGroupSig   = sig;
  return map;
}

// ── 조정행 (재공품 · 나보타 · 미착품 · 평가충당금) ────────────────────────────
//
// 이 행들이 있어야 표가 닫힌다. 검산(6월):
//   유형별(자재수불) +201.4  재공품 −3.7  나보타 −16.9  미착품 +5.7  충당금 −3.5
//   = +183.0억  = 공시기준 총증감 ✓  (차이 0.0억)
//
// ⚠ 나보타 실적은 반드시 **결산 실측**(자재수불 플랜트1220 + 재공품 1220)을 써야 한다.
//   나보타_RAW는 기준이 8억 어긋나 있어(323 vs 315) 증감도 −10.8억으로 잘못 나온다.
//   실측은 −16.9억이고, 이 값을 써야 합이 183억으로 닫힌다.
//   나보타_RAW는 **전망 구간의 월별 증감분**을 얻는 용도로만 쓴다.
function reviewAdjustments() {
  var meta = {};
  (state.mappedData.actuals_meta || []).forEach(function(r) { meta[r.month] = r; });
  var nbRaw = (typeof getNabotaInv === "function") ? getNabotaInv() : {};
  var c     = state.closing;
  var all   = REVIEW_MONTHS.concat(FCST_MONTHS);

  function metaSeries(key) {
    return all.map(function(m) {
      var v = meta[m] ? meta[m][key] : null;
      return Number.isFinite(v) ? v * 1e8 : null;
    });
  }

  // 재공품 (나보타 제외) — 실적은 결산 실측, 전망은 6월값 고정(BOM 소요 전개는 자재 쪽에서 반영)
  var wip = all.map(function(_, i) {
    if (i < 6) return c.wip[i] ? c.wip[i].end : null;
    return c.wip[5] ? c.wip[5].end : null;
  });

  // 나보타 — 실적은 결산 실측, 전망은 6월 실측을 앵커로 나보타_RAW의 월별 증감만 얹는다
  var nabota = all.map(function(m, i) {
    if (i < 6) {
      var s = c.nabota[i], w = c.wip[i];
      return (s && w) ? s.end + w.nabotaEnd : null;
    }
    var anchor = (c.nabota[5] && c.wip[5]) ? c.nabota[5].end + c.wip[5].nabotaEnd : null;
    var r6 = nbRaw[REVIEW_MONTHS[5]], rm = nbRaw[m];
    if (!Number.isFinite(anchor) || !r6 || !rm) return anchor;
    return anchor + (rm.invAmt - r6.invAmt) * 1e8;
  });

  return {
    wip:       wip,
    nabota:    nabota,
    michak:    metaSeries("michakInv"),
    allowance: metaSeries("allowanceInv"),
    cogs:      REVIEW_MONTHS.map(function(m) {
                 return meta[m] && Number.isFinite(meta[m].monthCogs) ? meta[m].monthCogs * 1e8 : null; }),
    totalInv:  REVIEW_MONTHS.map(function(m) {
                 return meta[m] && Number.isFinite(meta[m].totalInv) ? meta[m].totalInv * 1e8 : null; }),
  };
}

// ── 전망 매출원가 (판매계획 × 표준원가 × K) ───────────────────────────────────
function reviewForecastCogs() {
  var std = new Map();
  var c = state.closing;
  if (c && c.items) c.items.forEach(function(it) { if (it.std > 0) std.set(it.itemCode, it.std); });

  var byMonth = FCST_MONTHS.map(function() { return 0; });
  (state.mappedData.plan_monthly || []).forEach(function(r) {
    var mi = FCST_MONTHS.indexOf(r.month);
    if (mi < 0) return;
    var s = std.get(r.itemCode);
    var q = cleanNumber(r.salesQty);
    if (s > 0 && Number.isFinite(q) && q > 0) byMonth[mi] += q * s;
  });
  return byMonth.map(function(v) { return v > 0 ? v * COGS_COVERAGE_K : null; });
}

// ── 증가 원인 진단 ────────────────────────────────────────────────────────────
//
// 증감 = 입고 − 출고.  그러니 원인은 둘뿐이다: 많이 들어왔거나, 안 팔렸거나.
// 각각의 "왜"를 가진 데이터로 증명한다. 담당자가 설명하기 전에 화면이 이미 답을 말한다.
//
//   입고 측  ① 입고급증 — 6월 입고가 최근 3개월 평균의 N배
//            ② MOQ구조 — 최소발주단위가 월평균 출고의 N개월치라 안 쌓일 수가 없다 (구조적, 상시 판정)
//            ③ 신규진입 — 1월 재고 0에서 시작
//   출고 측  ④ 판매부진 — 판매계획 대비 실적 미달 (판매계획 파일 1~6월 계획 vs 실적)
//            ⑤ 계획없음 — 하반기 판매계획이 아예 없다
//            ⑥ 판매중단 — 1~3월엔 팔렸는데 4~6월 판매가 0
//   재고 수준 ⑦ 적정초과 — 적정재고 금액의 N배 (제·상품만)
//            ⑧ 소진불가 — 하반기 계획대로 소진해도 계획 구간(6개월) 안에 안 끝난다
//            ⑨ 장기정체 — 6개월 내내 입고도 출고도 없는데 재고가 있다
//   근거     ⑩ 수요변동% — CV(표준편차÷평균). "수요가 불안정해서 쌓았다"는 변명을 막는다.
//            수요안정(CV≤20%)은 다른 원인이 이미 붙은 품목에만 반박 근거로 부가한다 —
//            단독으로 뜨면 "수요가 안정적이니 문제 없다"는 착시를 만든다.
//
// ①③④⑤는 "이번 달 증가"를 설명하는 원인이라 delta>3억 품목만 따진다.
// ②⑥⑦⑧⑨는 이번 달 증감과 무관하게 존재하는 구조적 문제라 모든 품목에 상시 판정한다.
// 원인이 안 잡히면 비워둔다. "원인 미상"이라고 쓰면 AI가 모른다는 뜻이 되어 신뢰가 깎인다.
// 코스트센터출고는 재고를 '줄이는' 출고라 증가 원인이 아니다 — 여기서 다루지 않는다.

var CAUSE_SURGE_X   = 2.0;   // 입고급증: 최근 3개월 평균의 2배 초과
var CAUSE_ACH_LOW   = 0.8;   // 판매부진: 계획 대비 달성률 80% 미만
var CAUSE_MOQ_M     = 3.0;   // MOQ구조: 월평균 출고의 3개월치 이상 (상시 판정)
var CAUSE_TARGET_X  = 2.0;   // 적정초과: 적정재고 금액의 2배 이상
var CV_STABLE       = 0.20;  // 수요변동 20% 이하 = 안정
var CV_VOLATILE     = 0.50;  // 50% 초과 = 불안정

var _causeCache = null, _causeEpoch = -1;

function buildCauseMap() {
  if (_causeCache && _causeEpoch === (window._renderEpoch || 0)) return _causeCache;

  // 적정재고_RAW — MOQ · 12개월 평균 출고 · 표준편차 · 적정재고금액 · 공급주기 · 리드타임 · 중요도
  var ti = new Map();
  (state.mappedData.target_inv || []).forEach(function(r) {
    if (r.itemCode) ti.set(r.itemCode, r);
  });

  // 판매계획 파일 1~6월 계획 vs 실적 (sales_history) — 최근 3개월(4·5·6월) 달성률
  var RECENT = ["2026-04", "2026-05", "2026-06"];
  var ach = new Map();   // code → { plan, act }
  (state.mappedData.sales_history || []).forEach(function(r) {
    if (!r.itemCode || RECENT.indexOf(r.month) < 0) return;
    var a = ach.get(r.itemCode);
    if (!a) { a = { plan: 0, act: 0 }; ach.set(r.itemCode, a); }
    if (Number.isFinite(r.planQty))   a.plan += r.planQty;
    if (Number.isFinite(r.actualQty)) a.act  += r.actualQty;
  });

  // 6월 판매계획 vs 실적 (당월만) — 팝업 워터폴 근거용. RECENT(3개월 합산)와 별개.
  var juneSales = new Map();
  (state.mappedData.sales_history || []).forEach(function(r) {
    if (!r.itemCode || r.month !== "2026-06") return;
    var plan = cleanNumber(r.planQty), act = cleanNumber(r.actualQty);
    if (Number.isFinite(plan) || Number.isFinite(act))
      juneSales.set(r.itemCode, { plan: plan, act: act });
  });

  // 하반기 판매계획 유무
  var hasPlan712 = new Set();
  (state.mappedData.plan_monthly || []).forEach(function(r) {
    if (r.itemCode && FCST_MONTHS.indexOf(r.month) >= 0 && cleanNumber(r.salesQty) > 0)
      hasPlan712.add(r.itemCode);
  });

  var map = new Map();
  (buildReviewItems() || []).forEach(function(it) {
    var t  = ti.get(it.itemCode) || {};
    var cl = state.closing && state.closing.items.get(it.itemCode);
    var c = {
      causes: [], cv: null, ach: null, surge: null, moqM: null,
      targetAmt: null, targetRatio: null,
      covDays: it.covDays, june: juneSales.get(it.itemCode) || null,
      cycleMonths: Number.isFinite(t.cycleMonths) ? t.cycleMonths : null,
      leadTime:    Number.isFinite(t.leadTime)    ? t.leadTime    : null,
      grade: t.grade || null, moq: Number.isFinite(t.moq) ? t.moq : null,
    };

    // 수요변동 (CV) — 근거로 항상 계산
    if (t.stdDev > 0 && t.avg12OutQty > 0) c.cv = t.stdDev / t.avg12OutQty;

    // MOQ구조 — 월평균 출고 대비 몇 개월치인가. 이번 달 증감과 무관한 구조적 문제라 상시 판정한다.
    if (t.moq > 0 && t.avg12OutQty > 0) {
      c.moqM = t.moq / t.avg12OutQty;
      if (c.moqM >= CAUSE_MOQ_M)
        c.causes.push({ k: "moq", label: "MOQ " + c.moqM.toFixed(1) + "개월치" });
    }

    // 적정초과 — 제·상품만, 6월말 재고가 적정재고 금액의 N배
    if (it.isFg && t.targetAmt > 0) {
      c.targetAmt = t.targetAmt;
      c.targetRatio = it.end6 / t.targetAmt;
      if (c.targetRatio >= CAUSE_TARGET_X)
        c.causes.push({ k: "target", label: "적정초과 " + c.targetRatio.toFixed(1) + "배" });
    }

    // 소진불가 — 선행 커버리지가 ∞ 이거나 720일(2년) 초과
    if (it.end6 > 0 && (it.covDays === Infinity || it.covDays > 720)) {
      var covLabel = it.covDays === Infinity ? "소진불가 ∞" : "소진불가 " + Math.round(it.covDays / 30) + "개월";
      c.causes.push({ k: "noCoverage", label: covLabel });
    }

    // 장기정체 — 6개월 내내 입고(구매+생산)도 출고(판매+생산출고+코스트센터출고)도 0인데 재고가 있다
    if (cl && it.end6 > 0) {
      var noIn = true, noOut = true;
      for (var di = 0; di < 6; di++) {
        var dm = cl.mon[di];
        if (!dm) continue;
        if ((dm.buyIn || 0) !== 0 || (dm.prodIn || 0) !== 0) noIn = false;
        if ((dm.sale || 0) !== 0 || (dm.prodOut || 0) !== 0 || (dm.ccOut || 0) !== 0) noOut = false;
      }
      if (noIn && noOut) c.causes.push({ k: "dormant6", label: "장기정체 6개월 무거래" });
    }

    // 판매중단 — 제·상품, 1~3월엔 팔렸는데 4~6월 판매가 0
    if (it.isFg && cl) {
      var s13 = 0, s46 = 0;
      for (var pi = 0; pi < 3; pi++) { var pm = cl.mon[pi]; if (pm) s13 += pm.sale || 0; }
      for (var qi = 3; qi < 6; qi++) { var qm = cl.mon[qi]; if (qm) s46 += qm.sale || 0; }
      c.saleStopS13 = s13; c.saleStopS46 = s46;
      if (s13 > 0 && s46 === 0) c.causes.push({ k: "saleStop", label: "판매중단 3개월" });
    }

    // 증가한 품목만 따지는 원인 — 이번 달 증가를 직접 설명한다
    if (it.delta > 3e8) {
      // ① 입고급증 — 6월 입고가 최근 3개월(3·4·5월) 평균의 몇 배인가
      if (cl) {
        var inSum = 0, inCnt = 0;
        for (var i = 2; i <= 4; i++) {
          var mm = cl.mon[i];
          if (mm) { inSum += mm.buyIn + mm.prodIn; inCnt++; }
        }
        var inAvg = inCnt ? inSum / inCnt : 0;
        var in6   = it.buy6 + it.prod6;
        if (inAvg > 0 && in6 / inAvg >= CAUSE_SURGE_X) c.surge = in6 / inAvg;
      }
      if (c.surge) c.causes.push({ k: "surge", label: "입고급증 " + c.surge.toFixed(1) + "배" });

      // ③ 신규진입
      if (Number.isFinite(it.hist[0]) && it.hist[0] === 0 && it.end6 > 0)
        c.causes.push({ k: "new", label: "신규진입" });

      // ④ 판매부진 (최근 3개월 합산 달성률)
      var a = ach.get(it.itemCode);
      if (a && a.plan > 0) {
        c.ach = a.act / a.plan;
        if (c.ach < CAUSE_ACH_LOW)
          c.causes.push({ k: "under", label: "판매부진 " + Math.round(c.ach * 100) + "%" });
      }

      // ⑤ 하반기 계획 없음
      if (it.isFg && !hasPlan712.has(it.itemCode))
        c.causes.push({ k: "noplan", label: "하반기 계획없음" });
    }

    // 수요안정 — 단독으로 뜨면 안 된다. 다른 원인이 이미 붙은 품목에만 반박 근거로 부가한다.
    if (c.causes.length && Number.isFinite(c.cv) && c.cv <= CV_STABLE)
      c.causes.push({ k: "stableDemand", label: "수요안정 CV " + Math.round(c.cv * 100) + "%" });

    map.set(it.itemCode, c);
  });

  _causeCache = map;
  _causeEpoch = (window._renderEpoch || 0);
  return map;
}

var CAUSE_CLS = {
  under: "rv-b-danger", noplan: "rv-b-danger",
  target: "rv-b-danger", noCoverage: "rv-b-danger",
  dormant6: "rv-b-danger", saleStop: "rv-b-danger",
  stableDemand: "rv-b-good",
};

// 품목 행 — 그 품목의 원인 배지
// 이 컬럼은 "6월 증가원인"이다. 줄어든 품목에 증가원인을 다는 건 앞뒤가 안 맞고,
// 전 품목에 배지를 달면 배지가 아니라 배경이 된다(검증: 소진불가만 1,569품목).
// → 실제로 늘었고(delta>0) 금액이 유의미한(1억↑) 품목에만 단다.
// 팝업은 클릭해서 들어간 것이므로 게이트 없이 전부 보여준다 — 거기선 노이즈가 아니다.
var CAUSE_MIN_END = 1e8;   // 1억
function revCauseBadges(c, item) {
  var out = "";
  var show = item && item.delta > 0 && item.end6 >= CAUSE_MIN_END;
  if (show && c && c.causes.length) {
    out += c.causes.map(function(x) {
      return "<span class='rv-badge " + (CAUSE_CLS[x.k] || "rv-b-warn") + "'>" +
        escapeHtml(x.label) + "</span>";
    }).join("");
    if (Number.isFinite(c.cv)) out += revCvBadge(c.cv);
  }
  // 공용 자재 — 소요량 최대 품목군에 전액 귀속했음을 드러낸다.
  // 숨기지 않아야 "왜 여기 넣었냐"에 답할 수 있다.
  if (item && item.sharedN > 1) {
    out += "<span class='rv-badge rv-b-shared' title='" +
      escapeHtml(item.shared.join(" · ")) + "'>공용 " + item.sharedN + "</span>";
  }
  return out || "<span class='rv-mut'>-</span>";
}

// 품목군·유형 행 — 하위 품목의 원인을 증가액 기준으로 집계해 대표 원인을 보여준다.
// 원인마다 "그 원인에 해당하는 품목들의 증가액 합"을 달아, 어느 원인이 얼마나 큰지 보이게 한다.
function revGroupCauseBadges(items, causes, agg) {
  if (!agg || agg.delta <= 5e8) return "<span class='rv-mut'>-</span>";

  var byCause = {};   // k → { label, amt }
  items.forEach(function(it) {
    if (it.delta <= 0) return;
    var c = causes.get(it.itemCode);
    if (!c || !c.causes.length) return;
    c.causes.forEach(function(x) {
      var b = byCause[x.k];
      if (!b) { b = byCause[x.k] = { k: x.k, amt: 0, n: 0 }; }
      b.amt += it.delta;
      b.n++;
    });
  });

  var LABEL = { surge: "입고급증", under: "판매부진", moq: "MOQ구조",
                "new": "신규진입", noplan: "하반기 계획없음",
                target: "적정초과", noCoverage: "소진불가",
                dormant6: "장기정체", saleStop: "판매중단", stableDemand: "수요안정" };
  var list = Object.keys(byCause).map(function(k) { return byCause[k]; })
    .sort(function(a, b) { return b.amt - a.amt; })
    .slice(0, 3);

  if (!list.length) {
    // 원인이 하나도 안 잡히면 최소한 입고 경로만 — "원인 미상"이라고 쓰지 않는다
    var via = agg.buy >= agg.prod ? "구매" : "생산";
    return "<span class='rv-badge rv-b-warn'>" + via + "입고 " +
           revMoney(Math.max(agg.buy, agg.prod)) + "억</span>";
  }
  return list.map(function(b) {
    return "<span class='rv-badge " + (CAUSE_CLS[b.k] || "rv-b-warn") + "'>" +
      escapeHtml(LABEL[b.k] || b.k) + " <b>+" + revMoney(b.amt) + "억</b>" +
      (b.n > 1 ? " <small>" + b.n + "품목</small>" : "") + "</span>";
  }).join("");
}

// 수요변동 배지 — % 로 쓴다. "CV 0.06"은 설명이 필요하지만 "수요변동 6%"는 그냥 읽힌다.
// 안정(CV≤20%)은 여기서 다루지 않는다 — "수요안정" 원인 배지(단독으로 뜨지 않도록 다른 원인이
// 있을 때만 붙는다)로만 노출한다. 여기서까지 무조건 보여주면 반박 근거가 늘 상주해 버린다.
function revCvBadge(cv) {
  if (!Number.isFinite(cv) || cv <= CV_STABLE) return "";
  var pct = Math.round(cv * 100);
  var tag = cv > CV_VOLATILE ? "불안정" : "보통";
  return "<span class='rv-badge rv-b-shared' title='수요 표준편차 ÷ 12개월 평균 출고'>" +
    "수요변동 " + pct + "% · " + tag + "</span>";
}

// 진단 문장 — 표에는 배지, 팝업·소견에는 문장. 배지는 스캔용, 문장은 설명용.
function revCauseSentence(it, c) {
  if (!c || !c.causes.length) return "";
  var s = [];
  if (c.surge) s.push("6월 입고가 최근 3개월 평균의 <b>" + c.surge.toFixed(1) + "배</b>입니다");
  if (c.ach !== null && c.ach < CAUSE_ACH_LOW)
    s.push("최근 3개월 판매계획 대비 실적이 <b>" + Math.round(c.ach * 100) + "%</b>에 그쳤습니다");
  if (c.moqM !== null && c.moqM > CAUSE_MOQ_M)
    s.push("최소발주단위(MOQ)가 월평균 판매의 <b>" + c.moqM.toFixed(1) + "개월치</b>라 필요한 만큼만 발주해도 쌓입니다");
  if (c.causes.some(function(x) { return x.k === "noplan"; }))
    s.push("<b>하반기 판매계획이 없습니다</b>");
  var tail = "";
  if (Number.isFinite(c.cv)) {
    var pct = Math.round(c.cv * 100);
    tail = c.cv <= CV_STABLE
      ? " 수요변동은 <b>" + pct + "%</b>로 안정적입니다 — 수요가 흔들려서 쌓였다고 보기 어렵습니다."
      : (c.cv > CV_VOLATILE
          ? " 다만 수요변동이 <b>" + pct + "%</b>로 커서 어느 정도의 안전재고는 합리적일 수 있습니다."
          : " 수요변동은 <b>" + pct + "%</b>입니다.");
  }
  return s.join(". ") + "." + tail;
}

// ── AI 진단 ───────────────────────────────────────────────────────────────────
// 결산 6개월 시계열로 "왜 늘었나"를 특정한다. 판정 근거는 전부 실측값.
function reviewDiagnosis() {
  var items = buildReviewItems();
  if (!items) return null;
  var bomOk = hasBomData();

  var d = {
    bomOk: bomOk,
    totalDelta: 0,
    byGroup: new Map(),
    noPlanAmt: 0,  noPlanCnt: 0,     // 판매계획 없는 제·상품
    dormantAmt: 0, dormantCnt: 0,    // 최근 3개월 무출고 → 소진 불가(∞)
    longMosAmt: 0, longMosCnt: 0,    // 재고월수 12개월 초과
    unusedAmt: 0,  unusedCnt: 0,     // BOM 미사용 자재 = 불용 (처분 검토)
  };

  items.forEach(function(it) {
    d.totalDelta += it.delta;

    if (it.isFg) {
      var key = it.group;
      var g = d.byGroup.get(key);
      if (!g) { g = { delta: 0, buy: 0, prod: 0, sale: 0, cc: 0, end: 0 }; d.byGroup.set(key, g); }
      g.delta += it.delta; g.buy += it.buy6; g.prod += it.prod6;
      g.sale  += it.sale6; g.cc   += it.cc6;  g.end  += it.end6;
      if (!it.hasPlan && it.end6 > 0) { d.noPlanAmt += it.end6; d.noPlanCnt++; }
    }

    if (it.end6 > 0) {
      if (it.mos3 === Infinity) { d.dormantAmt += it.end6; d.dormantCnt++; }
      else if (it.mos3 > 12)    { d.longMosAmt += it.end6; d.longMosCnt++; }
    }
    // BOM 어디에도 안 걸리는 자재 = 쓸 데가 없다. 감축이 아니라 처분 결정 대상.
    // BOM이 아예 안 실렸으면 판정하지 않는다 (전 자재가 불용으로 잡히는 허위 경보 방지).
    if (!it.isFg && bomOk && it.group === MAT_UNUSED_GROUP && it.end6 > 0) {
      d.unusedAmt += it.end6; d.unusedCnt++;
    }
  });

  d.topGroups = Array.from(d.byGroup.entries())
    .sort(function(a, b) { return b[1].delta - a[1].delta; })
    .slice(0, 8);
  return d;
}

// ── 시나리오별 총재고 시리즈 (원) — 표 합계·차트 공용 ─────────────────────────
function reviewTotals() {
  var items = buildReviewItems();
  if (!items) return null;
  var adj = reviewAdjustments();
  var c   = state.closing;

  var hist = adj.totalInv.slice(0, 6);   // 실적은 공시기준 총재고 그대로 (대표 보고 숫자)

  function sumF(key, mi) {
    var t = 0;
    for (var i = 0; i < items.length; i++) t += items[i][key][mi] || 0;
    return t;
  }
  // 전망 = 품목 전개 + 재공품 + 나보타 + 미착 − 충당금 (폴백 전용 — 공용 엔진 미연결 시)
  // 미착·충당금은 전망이 없으면 6월 값으로 고정한다.
  function fcst(key) {
    return FCST_MONTHS.map(function(_, mi) {
      var k = 6 + mi;
      var v = sumF(key, mi);
      [adj.wip[k], adj.nabota[k],
       Number.isFinite(adj.michak[k])    ? adj.michak[k]    : adj.michak[5],
       Number.isFinite(adj.allowance[k]) ? adj.allowance[k] : adj.allowance[5],
      ].forEach(function(x) { if (Number.isFinite(x)) v += x; });
      return v;
    });
  }
  var fCogs = reviewForecastCogs();

  // ── 전망 총재고·재고일수 = 공용 엔진(rtf.js) ─────────────────────────────────
  // KPI 배너(renderScenarioKpiBanner)·회의안건/재고진단 차트가 전부 rtfHeadlineInv(앵커+델타)
  // 로 총재고를 낸다. 여기서 품목합산으로 따로 조립하면 총계가 어긋난다 — 같은 함수를 쓴다.
  // matScenario 조합은 renderScenarioKpiBanner(rtf.js:1600-1622)와 완전히 같은 패턴.
  // rtfHeadlineInv는 원(won) 단위 — hist/fcst 기존 값도 전부 원 단위라 그대로 맞는다.
  var sc     = (typeof computeScenarioItemSets === "function") ? computeScenarioItemSets() : null;
  var anchor = (typeof getActualsAnchor        === "function") ? getActualsAnchor()        : null;
  var base, rtf, exc, fcstDaysArr = null;

  if (sc && anchor && typeof rtfHeadlineInv === "function" && typeof rtfDisclosureDays === "function") {
    var matScenRtf   = { fg: state.fgProdAdj, mat: state.matSimAdj };
    var matScenFinal = {
      fg:  Object.assign({}, state.fgProdAdj || {}, state.excessAdj    || {}),
      mat: Object.assign({}, state.matSimAdj || {}, state.matExcessAdj || {}),
    };
    var fItems = sc.hasExcess ? sc.final : sc.rtfAdj;

    base = FCST_MONTHS.map(function(_, mi) { return rtfHeadlineInv(sc.base, mi, null).amount; });
    rtf  = FCST_MONTHS.map(function(_, mi) {
      return sc.hasRtfAdj ? rtfHeadlineInv(sc.rtfAdj, mi, matScenRtf).amount
                          : rtfHeadlineInv(sc.base, mi, null).amount;
    });
    exc  = FCST_MONTHS.map(function(_, mi) { return rtfHeadlineInv(fItems, mi, matScenFinal).amount; });

    fcstDaysArr = {
      base: FCST_MONTHS.map(function(_, mi) { return rtfDisclosureDays(sc.base, mi, null); }),
      rtf:  FCST_MONTHS.map(function(_, mi) {
        return sc.hasRtfAdj ? rtfDisclosureDays(sc.rtfAdj, mi, matScenRtf) : rtfDisclosureDays(sc.base, mi, null);
      }),
      exc:  FCST_MONTHS.map(function(_, mi) { return rtfDisclosureDays(fItems, mi, matScenFinal); }),
    };
  } else {
    // 폴백: 기존 품목합산 방식 그대로 유지 (데이터 미연결 시)
    base = fcst("fBase");
    rtf  = fcst("fRtf");
    exc  = fcst("fExc");
  }

  return {
    months:   REVIEW_MONTHS.concat(FCST_MONTHS),
    hist:     hist,
    base:     base,
    rtf:      rtf,
    exc:      exc,
    // ── 재고일수 = 재고금액 ÷ 누적 매출원가 × 누적일수 ──
    //
    // 회사는 연초부터 누적으로 마감한다. 당월 매출원가만 쓰면 그 달이 튈 때 재고일수도
    // 같이 튄다(2월이 118일로 꺼지는 식). 누적이 재고 수준을 안정적으로 말한다.
    //   6월 = 2,714억 ÷ 누적 매출원가 3,516억 × 누적일수 181일 = 139.7일  ← 회사가 보는 140일
    //   (당월 기준으로 하면 2,714 ÷ 572 × 30 = 142.3일이 나온다 — 회사 숫자와 다르다)
    //
    // 실적(1~6월)은 그대로 결산 매출원가 누적. 이 방식은 안 바꾼다.
    histDays: REVIEW_MONTHS.map(function(m, mi) {
      var cumC = 0, cumD = 0;
      for (var i = 0; i <= mi; i++) {
        if (!(adj.cogs[i] > 0)) return null;
        cumC += adj.cogs[i];
        cumD += monthDays(REVIEW_MONTHS[i]);
      }
      return Number.isFinite(hist[mi]) ? hist[mi] / cumC * cumD : null;
    }),
    // 전망(7~12월) 재고일수 — 공용 엔진(rtfDisclosureDays)이 있으면 그 결과를 시리즈 참조로
    // 돌려준다(KPI 배너·차트와 동일 산식). 없으면 기존 매출원가 누적 방식으로 폴백.
    fcstDays: function(series) {
      if (fcstDaysArr) {
        if (series === base) return fcstDaysArr.base;
        if (series === rtf)  return fcstDaysArr.rtf;
        if (series === exc)  return fcstDaysArr.exc;
      }
      // 폴백(구방식) — 상반기 실적 누적을 출발점으로 매출원가 누적 적용
      var baseC = 0, baseD = 0;
      for (var i = 0; i < 6; i++) {
        if (adj.cogs[i] > 0) { baseC += adj.cogs[i]; baseD += monthDays(REVIEW_MONTHS[i]); }
      }
      var cumC = baseC, cumD = baseD;
      return FCST_MONTHS.map(function(m, mi) {
        if (!(fCogs[mi] > 0)) return null;
        cumC += fCogs[mi];
        cumD += monthDays(m);
        return Number.isFinite(series[mi]) ? series[mi] / cumC * cumD : null;
      });
    },
    adj: adj, fCogs: fCogs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 렌더
// ═══════════════════════════════════════════════════════════════════════════

function revMoney(won) {
  if (!Number.isFinite(won)) return "-";
  return (won / 1e8).toFixed(1);
}
function revDelta(won) {
  if (!Number.isFinite(won) || Math.abs(won) < 5e6) return "<span class='rv-mut'>-</span>";
  var up = won > 0;
  return "<span class='" + (up ? "rv-up" : "rv-down") + "'>" + (up ? "+" : "−") +
         revMoney(Math.abs(won)) + "</span>";
}
function revDaysDelta(d) {
  if (!Number.isFinite(d)) return "";
  return "<span class='" + (d > 0 ? "rv-up" : "rv-down") + "'>" + (d > 0 ? "+" : "") + d.toFixed(1) + "일</span>";
}
// 재고일수(선행 커버리지) — 6월말 재고를 하반기 계획대로 소진할 때 버티는 일수(revForwardCoverDays).
// 전사 재고일수(140일, 누적 매출원가 분모)와는 산식이 다른 품목·품목군 단위 참고치다.
//   360일(1년) 초과 = 주의 / 720일(2년) 초과 = 위험 / 나갈 계획 없음 = ∞(소진 불가)
// 나갈 계획이 없으면 선행 커버리지는 수학적으로 ∞다. 그런데 그런 품목이 절반이라
// (제·상품 541 / 원부자재 1,028) 표가 ∞로 덮여 정보가 사라진다.
// → ∞일 때는 과거 3평판 속도로 환산한 값을 회색으로 병기한다. 계획이 없다는 사실은
//   ∞ 기호로 그대로 드러내되, "그럼 실제론 얼마나 버티나"에도 답한다.
function revMos(days, fallbackDays) {
  if (days === null || days === undefined) return "<span class='rv-mut'>-</span>";
  if (days === Infinity) {
    if (!Number.isFinite(fallbackDays) || fallbackDays <= 0)
      return "<span class='rv-mos rv-mos-x'>∞</span>";
    return "<span class='rv-mos rv-mos-x' title='하반기 계획 없음 — 과거 3개월 출고 속도로 환산한 참고치'>∞" +
      "<small class='rv-mos-fb'>~" + Math.round(fallbackDays).toLocaleString("ko-KR") + "일</small></span>";
  }
  var cls = days >= 720 ? "rv-mos-x" : days >= 360 ? "rv-mos-w" : "rv-mos-g";
  return "<span class='rv-mos " + cls + "'>" +
    Math.round(days).toLocaleString("ko-KR") + "<small>일</small></span>";
}
// 증가 기여도 — 막대로 보여야 크기가 한눈에 들어온다.
// 증가는 오른쪽(주황), 감소는 왼쪽(초록)으로 뻗는다. 0을 가운데 두면 부호가 눈에 바로 읽힌다.
function revContrib(pct) {
  if (pct === null || pct === undefined) return "<span class='rv-mut'>-</span>";
  var w = Math.min(50, Math.abs(pct) / 2);   // 100% = 반쪽 폭
  var up = pct > 0;
  return "<span class='rv-cbar'>" +
    "<i class='" + (up ? "rv-cbar-up" : "rv-cbar-dn") + "' style='width:" + w.toFixed(0) + "%;" +
      (up ? "left:50%" : "right:50%") + "'></i>" +
    "</span><span class='rv-pct " + (up ? "rv-pct-hot" : "rv-pct-dn") + "'>" +
    (up ? "+" : "−") + Math.abs(pct).toFixed(0) + "%</span>";
}

function revSpark(hist) {
  var v = hist.filter(function(x) { return Number.isFinite(x); });
  if (v.length < 2) return "";
  var mn = Math.min.apply(null, v), mx = Math.max.apply(null, v), r = (mx - mn) || 1;
  var w = 64, h = 18;
  var pts = [];
  hist.forEach(function(x, i) {
    if (!Number.isFinite(x)) return;
    pts.push([i * (w / (hist.length - 1)), h - 2 - ((x - mn) / r) * (h - 5)]);
  });
  var d = pts.map(function(p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
  var last = pts[pts.length - 1];
  var col = (v[v.length - 1] >= v[0]) ? "var(--danger)" : "var(--good)";
  return "<svg class='rv-spark' width='" + w + "' height='" + h + "' aria-hidden='true'>" +
    "<path d='" + d + "' fill='none' stroke='" + col + "' stroke-width='1.6' stroke-linejoin='round'/>" +
    "<circle cx='" + last[0].toFixed(1) + "' cy='" + last[1].toFixed(1) + "' r='2.2' fill='" + col + "'/></svg>";
}

// ── 트리 (유형 > 품목군 > 품목) ───────────────────────────────────────────────
function revAgg(items) {
  var a = { end: 0, delta: 0, out3: 0, sale: 0, cc: 0, buy: 0, prod: 0,
            hist: [0,0,0,0,0,0], fBase: [0,0,0,0,0,0], fRtf: [0,0,0,0,0,0], fExc: [0,0,0,0,0,0],
            shortF: [0,0,0,0,0,0], needWon: [0,0,0,0,0,0] };   // 부족 금액 롤업 (원부자재 배지용)
  items.forEach(function(it) {
    a.end += it.end6; a.delta += it.delta; a.out3 += it.avg3out;
    a.sale += it.sale6; a.cc += it.cc6; a.buy += it.buy6; a.prod += it.prod6;
    for (var i = 0; i < 6; i++) {
      if (Number.isFinite(it.hist[i])) a.hist[i] += it.hist[i];
      a.fBase[i] += it.fBase[i] || 0;
      a.fRtf[i]  += it.fRtf[i]  || 0;
      a.fExc[i]  += it.fExc[i]  || 0;
      if (it.shortF)  a.shortF[i]  += it.shortF[i]  || 0;
      if (it.needWon) a.needWon[i] += it.needWon[i] || 0;
    }
  });
  // 롤업 재고월수(과거 3평판 기준) — 팝업 참고용. 금액 기준이라 합산해서 나눌 수 있다.
  a.mos = a.out3 > 0 ? a.end / a.out3 : (a.end > 0 ? Infinity : null);
  // 롤업 재고일수(선행 커버리지) — 그룹 합계 재고를 그룹 합계 소요로 소진하는 일수.
  // needWon도 금액이라 선형 합산이 유효하다.
  a.covDays = revForwardCoverDays(a.end, a.needWon);
  a.covFallback = (a.covDays === Infinity && a.out3 > 0) ? (a.end / a.out3) * 30 : null;
  return a;
}

// 정렬 키 → 값. 계층은 유지하고 형제끼리만 정렬한다.
// 유형(최상위)은 정렬하지 않는다 — 회의에서 얘기하는 순서(제·상품 먼저, 자재 나중)라
// 매번 순서가 바뀌면 진행이 흔들린다.
function revSortValue(agg, key, total, headDelta) {
  switch (key) {
    case "end":     return agg.end;
    case "delta":   return agg.delta;
    case "contrib": return headDelta !== 0 ? agg.delta / headDelta : 0;
    case "share":   return agg.end / (total || 1);
    case "days":    return agg.covDays === Infinity ? 1e9 : (agg.covDays === null ? -1 : agg.covDays);
    default:
      // 월별 뷰 — "m0" ~ "m11" (재고금액 기준)
      if (/^m\d+$/.test(key)) {
        var i = Number(key.slice(1));
        return i < 6 ? (agg.hist[i] || 0) : (agg.fExc[i - 6] || 0);
      }
      return agg.end;
  }
}

function buildReviewTree(items, tab, T) {
  var q = (state.revSearch || "").trim().toLowerCase();
  var pool = items.filter(function(it) {
    if (tab === "mat" ? it.isFg : !it.isFg) return false;
    if (!q) return true;
    return (it.itemCode + " " + it.itemName + " " + it.group).toLowerCase().indexOf(q) >= 0;
  });

  var total = T.hist[5] || 1;
  var head  = T.hist[5] - T.hist[4];
  var sk = (state.revSort && state.revSort.key) || "contrib";
  var sd = (state.revSort && state.revSort.dir) || -1;
  var cmp = function(a, b) {
    var d = (revSortValue(a.agg, sk, total, head) - revSortValue(b.agg, sk, total, head)) * sd;
    return d || String(a.label).localeCompare(String(b.label), "ko-KR");
  };

  var nodes = [];
  TYPE_ORDER.forEach(function(type) {
    var ti = pool.filter(function(it) { return it.type === type; });
    if (!ti.length) return;
    nodes.push({ id: "t|" + type, parent: null, level: 0, label: type, items: ti });

    var groups = {};
    ti.forEach(function(it) { (groups[it.group] = groups[it.group] || []).push(it); });

    Object.keys(groups)
      .map(function(g) { return { label: g, items: groups[g], agg: revAgg(groups[g]) }; })
      .sort(cmp)
      .forEach(function(gn) {
        var gid = "t|" + type + "|g|" + gn.label;
        nodes.push({ id: gid, parent: "t|" + type, level: 1, label: gn.label, items: gn.items });

        gn.items
          .map(function(it) { return { label: it.itemName || it.itemCode, item: it, agg: revItemAgg(it) }; })
          .sort(cmp)
          .forEach(function(inode, i) {
            nodes.push({ id: gid + "|i|" + i, parent: gid, level: 2,
                         label: inode.label, items: [inode.item], item: inode.item });
          });
      });
  });
  return nodes;
}

// 품목 하나를 집계 형태로 (정렬·렌더가 같은 구조를 쓰도록)
function revItemAgg(it) {
  return { end: it.end6, delta: it.delta, mos: it.mos3, covDays: it.covDays, covFallback: it.covFallback,
           hist: it.hist, fExc: it.fExc,
           sale: it.sale6, cc: it.cc6, buy: it.buy6, prod: it.prod6 };
}

// 조상이 하나라도 접혀 있으면 안 보인다 (부모만 보면 유형을 접었는데 품목이 남는다)
function revVisible(n, byId) {
  var p = n.parent;
  while (p) {
    if (!state.revOpen.has(p)) return false;
    var pn = byId.get(p);
    p = pn ? pn.parent : null;
  }
  return true;
}
function revRowHead(n, hasKid) {
  var open = state.revOpen.has(n.id);
  // 품목 행에는 품목코드를 앞에 — 담당자가 SAP에서 바로 찾을 수 있어야 한다
  var code = n.item
    ? "<span class='rv-code'>" + escapeHtml(n.item.itemCode) + "</span> "
    : "";
  return "<td class='rv-name'><span class='rv-tw'>" +
    (hasKid ? "<button class='rv-tog' data-rvtog='" + escapeHtml(n.id) + "'>" + (open ? "−" : "+") + "</button>"
            : "<span class='rv-tog rv-tog-x'></span>") +
    code + escapeHtml(n.label) + "</span></td>";
}

// 정렬 가능한 헤더 — 클릭하면 내림차순 ↔ 오름차순
function revTh(key, label, cls) {
  var s  = state.revSort || {};
  var on = s.key === key;
  var ar = on ? (s.dir < 0 ? "▼" : "▲") : "";
  return "<th class='rv-th-sort " + (cls || "") + (on ? " rv-th-on" : "") +
    "' data-rvsort='" + key + "'>" + label +
    "<span class='rv-th-ar'>" + ar + "</span></th>";
}

// 의견 — 회의 전에 미리 채운다. AI가 데이터로 알 수 없는 맥락(전략비축 등)이 들어가는 자리.
// 품목뿐 아니라 유형·품목군 행에서도 쓸 수 있어야 한다. 회의에서는 대부분 품목군 단위로
// 얘기하고, 품목까지 펼치지 않은 상태에서 의견을 남기고 싶어 한다.
//   품목   → 키 = 품목코드
//   품목군 → 키 = "g|사업부 / 품목군"
//   유형   → 키 = "t|유형"
function revOpinionKey(n) {
  if (n.item) return n.item.itemCode;
  return (n.level === 0 ? "t|" : "g|") + n.label;
}
function revOpinionCell(n) {
  var k = revOpinionKey(n);
  var v = (state.revOpinion || {})[k] || "";
  return "<td class='rv-band rv-op-cell'>" +
    "<input class='rv-op-in' data-rvop='" + escapeHtml(k) + "' " +
    "value='" + escapeHtml(v) + "' placeholder='의견 입력' />" +
    "</td>";
}

// ── 요약 뷰 ───────────────────────────────────────────────────────────────────
function revSumTable(tree, T, wf) {
  var byId   = new Map(tree.map(function(x) { return [x.id, x]; }));
  var causes = buildCauseMap();
  var total  = T.hist[5] || 1;
  // 기여도의 분모 = 변동 총량(|증가| + |감소|). 왜 이 분모인지는 reviewWaterfall 주석 참고.
  // 유형 레벨에서 한 번만 계산해 하위(품목군·품목) 행에도 같은 분모를 쓴다 —
  // 행마다 분모가 달라지면 % 끼리 비교가 안 된다.
  var posSum = wf.abs;
  var rows  = "";

  tree.forEach(function(n, i) {
    if (!revVisible(n, byId)) return;
    var hasKid = !!(tree[i + 1] && tree[i + 1].parent === n.id);
    var a = n.item
      ? { end: n.item.end6, delta: n.item.delta, mos: n.item.mos3, covDays: n.item.covDays,
          covFallback: n.item.covFallback,
          hist: n.item.hist, sale: n.item.sale6, cc: n.item.cc6, buy: n.item.buy6, prod: n.item.prod6 }
      : revAgg(n.items);

    var pct = a.end / total * 100;
    // 변동 기여도 = 그 행의 증감 ÷ 변동 총량. 감소한 행은 음수로 표시한다.
    // 모든 행의 절대 기여도를 더하면 정확히 100%가 된다.
    var contrib = (posSum !== 0 && Math.abs(a.delta) >= 5e7) ? a.delta / posSum * 100 : null;
    var cls = "";
    // BOM 어디에도 안 걸리고 출고도 없는 자재 = 불용. 감축이 아니라 처분 결정 대상.
    if (n.level === 1 && n.label === MAT_UNUSED_GROUP) cls = " rv-crit";
    else if (n.level === 1 && a.delta > 50e8)          cls = " rv-hot";
    else if (a.covDays === Infinity && a.end > 10e8)   cls = " rv-crit";

    // "왜 늘었나" — 담당자가 설명하기 전에 화면이 먼저 답한다.
    // 품목군·유형 행에도 표시한다. 회의에서는 대부분 품목군 단위로 얘기하고,
    // 품목까지 펼치지 않은 상태에서도 원인이 보여야 한다.
    var cause = n.item ? revCauseBadges(causes.get(n.item.itemCode), n.item)
                       : revGroupCauseBadges(n.items, causes, a);

    // 품목(leaf) 행만 클릭하면 AI 분석 팝업이 뜬다 (유형·품목군 행은 토글만)
    var rowAttr = n.item ? " data-rvitem='" + escapeHtml(n.item.itemCode) + "'" : "";
    rows += "<tr class='rv-l" + n.level + cls + "'" + rowAttr + ">" + revRowHead(n, hasKid) +
      "<td class='rv-n rv-gsep'><b>" + revMoney(a.end) + "</b></td>" +
      "<td class='rv-n'>" + revDelta(a.delta) + "</td>" +
      "<td class='rv-n'>" + revContrib(contrib) + "</td>" +
      "<td class='rv-n rv-mut'>" + pct.toFixed(1) + "%</td>" +
      "<td class='rv-n rv-gsep rv-band'>" + revMos(a.covDays, a.covFallback) + "</td>" +
      "<td class='rv-band rv-cause-cell'>" + cause + "</td>" +
      revOpinionCell(n) +
      "<td class='rv-n rv-gsep'>" + revSpark(a.hist) + "</td></tr>";
  });

  return "<table class='rv-tbl'><thead><tr>" +
    "<th class='rv-th-name'>구분</th>" +
    revTh("end",     "6월말 재고금액 (억)", "rv-gsep rv-th-amt") +
    revTh("delta",   "전월대비") +
    revTh("contrib", "변동 기여도", "rv-th-pct") +
    revTh("share",   "재고금액 비중") +
    revTh("days",    "재고일수", "rv-gsep rv-band rv-th-days") +
    "<th class='rv-band rv-th-cause'>6월 증가 원인</th>" +
    "<th class='rv-band rv-th-op'>의견</th>" +
    "<th class='rv-gsep'>1~6월 추이</th></tr></thead>" +
    "<tbody>" + rows + revFooterSum(T, wf) + "</tbody></table>";
}

// ── 월별 뷰 ───────────────────────────────────────────────────────────────────
// 셀 하나에 세 가지를 층으로 쌓는다 (컬럼을 3배로 늘리면 36컬럼이 되어 못 읽는다).
//   재고금액 (굵게) / 재고일수 (작게, 회색) / 전월대비 (▲▽ + 색)
// 전월대비는 뱃지가 아니라 화살표다 — 12개월 × 수백 행에 뱃지를 달면 알약밭이 되어
// 정작 강조해야 할 것(진단 뱃지)이 묻힌다. 뱃지는 드물게 나타나는 것에만 쓴다.
// 월 라벨 — 공용 monthLabel()은 1월에만 "2026년 1월"처럼 연도를 붙인다(연 경계 표시용).
// 총괄장은 1~12월이 한 해 안에서 이어지므로 그 컬럼만 넓어지고 줄이 틀어진다. 그냥 "1월".
function revMonthLabel(m) {
  return Number(m.slice(5, 7)) + "월";
}

// 월별 뷰는 스캔용이다 — 소수점은 눈만 어지럽힌다. 전부 정수 + 단위 명시.
function revEok(won) {
  if (!Number.isFinite(won)) return "-";
  return Math.round(won / 1e8).toLocaleString("ko-KR") + "억";
}
function revMonCell(amt, days, prev, cls, shortWon) {
  if (!Number.isFinite(amt)) return "<td class='rv-mc " + cls + "'><span class='rv-mut'>-</span></td>";
  var d = Number.isFinite(prev) ? amt - prev : null;
  var dh = "";
  if (d !== null && Math.abs(d) >= 5e7) {   // 0.5억 미만은 노이즈 → 표시 안 함
    var up = d > 0;
    dh = "<span class='rv-mc-d " + (up ? "rv-up" : "rv-down") + "'>" +
         (up ? "▲" : "▽") + revEok(Math.abs(d)) + "</span>";
  }
  // 부족 배지 — 원부자재 흐름이 0 밑으로 내려간 달만. 계획이 물리적으로 못 채우는 만큼을 드러낸다.
  var shortBadge = (Number.isFinite(shortWon) && shortWon > 0)
    ? "<span class='rv-short'>부족 " + revEok(shortWon) + "</span>" : "";
  return "<td class='rv-mc " + cls + "'>" +
    "<span class='rv-mc-a'>" + revEok(amt) + "</span>" +
    (Number.isFinite(days) ? "<span class='rv-mc-y'>" + Math.round(days) + "일</span>" : "") +
    dh + shortBadge + "</td>";
}

function revMonthTable(tree, T) {
  var byId = new Map(tree.map(function(x) { return [x.id, x]; }));

  // 재고일수는 전사(합계) 레벨에서만 의미가 있다. 품목군·품목 단위의 매출원가를
  // 나눠 쓸 수 없으므로(계획 파일이 77%만 커버) 개별 행에는 표시하지 않는다.
  var fd = T.fcstDays(T.exc);

  // 전망 구간은 "전망" 글자를 붙이지 않고 색으로 구분한다.
  // 7월에만 글자를 넣으면 그 컬럼만 헤더가 높아져 줄이 틀어진다.
  var head = T.months.map(function(m, i) {
    var cls = (i === 0 || i === 6 ? "rv-gsep " : "") + (i >= 6 ? "rv-fcst" : "");
    return revTh("m" + i, revMonthLabel(m), cls);
  }).join("");

  var rows = "";
  tree.forEach(function(n, i) {
    if (!revVisible(n, byId)) return;
    var hasKid = !!(tree[i + 1] && tree[i + 1].parent === n.id);
    var a = n.item
      ? { hist: n.item.hist, fExc: n.item.fExc, delta: n.item.delta, shortF: n.item.shortF }
      : revAgg(n.items);
    var cls = (n.level === 1 && a.delta > 50e8) ? " rv-hot" : "";

    var cells = "";
    for (var k = 0; k < 6; k++) {
      cells += revMonCell(a.hist[k], null, k > 0 ? a.hist[k - 1] : null, (k === 0 ? "rv-gsep" : ""));
    }
    for (var j = 0; j < 6; j++) {
      var prev = j === 0 ? a.hist[5] : a.fExc[j - 1];
      var sVal = a.shortF ? a.shortF[j] : null;
      cells += revMonCell(a.fExc[j], null, prev, "rv-fcst" + (j === 0 ? " rv-gsep" : ""), sVal);
    }
    var rowAttr = n.item ? " data-rvitem='" + escapeHtml(n.item.itemCode) + "'" : "";
    rows += "<tr class='rv-l" + n.level + cls + "'" + rowAttr + ">" + revRowHead(n, hasKid) + cells + "</tr>";
  });

  // 합계행에는 재고일수를 함께 넣는다 (여기서만 매출원가 분모가 성립)
  var tot = "<tr class='rv-total'><td class='rv-name'>총재고 (공시기준)</td>";
  T.hist.forEach(function(v, i) {
    tot += revMonCell(v, T.histDays[i], i > 0 ? T.hist[i - 1] : null, (i === 0 ? "rv-gsep" : ""));
  });
  T.exc.forEach(function(v, i) {
    var prev = i === 0 ? T.hist[5] : T.exc[i - 1];
    tot += revMonCell(v, fd[i], prev, "rv-fcst" + (i === 0 ? " rv-gsep" : ""));
  });
  tot += "</tr>";

  return "<table class='rv-tbl rv-tbl-mon'><thead><tr><th class='rv-th-name'>구분</th>" + head +
    "</tr></thead><tbody>" + rows + tot + "</tbody></table>";
}

// 기여도의 분모를 무엇으로 둘 것인가 — 세 번 갈아엎은 자리라 기록해 둔다.
//
//   ① 순증(183.0억)을 분모로       → 상품 184.3 / 183.0 = 100.7% → 화면에 101%.
//                                    감소 행이 상쇄한 만큼 증가 행이 100%를 넘는다. "오류 아니냐"가 나온다.
//   ② 증가 요인 합계(212.7억)      → 증가 행끼리는 100%가 되지만, 총계 행이 183/212.7 = 86%가 된다.
//                                    총계가 100%가 아니면 그것도 오류로 읽힌다.
//   ③ 절대값 합(242.3억)  ← 현재    → |증가 212.7| + |감소 29.6|. 이번 달에 "실제로 움직인 총량"이다.
//                                    모든 행의 |기여도|를 더하면 정확히 100%. 총계 행도 100%.
//                                    뜻도 곧다: "재고가 242억 움직였고 그중 상품이 76%다."
//
// 컷오프(5천만원 미만)는 표 렌더 기준과 같아야 한다 — 다르면 합이 100%에서 어긋난다.
function reviewWaterfall(items, T) {
  var A = T.adj;
  var byType = {};
  (items || []).forEach(function(it) { byType[it.type] = (byType[it.type] || 0) + it.delta; });
  function adjDelta(key) {
    var cur = A[key][5], prev = A[key][4];
    return (Number.isFinite(cur) && Number.isFinite(prev)) ? cur - prev : 0;
  }
  var deltas = Object.keys(byType).map(function(k) { return byType[k]; });
  deltas.push(adjDelta("wip"), adjDelta("nabota"), adjDelta("michak"), adjDelta("allowance"));
  var pos = 0, neg = 0;
  deltas.forEach(function(d) {
    if (!Number.isFinite(d) || Math.abs(d) < 5e7) return;   // 노이즈 컷오프 — 표 렌더 기준과 동일
    if (d > 0) pos += d; else neg += d;
  });
  return { pos: pos, neg: neg, abs: pos + Math.abs(neg) };   // abs = 기여도의 분모
}

// ── 합계 + 조정행 — 표를 다 더하면 헤드라인(공시기준)이 나온다 ────────────────
// 조정행도 기여도를 가져야 표를 다 더해 100%가 나온다.
// (나보타가 19억 줄어든 것도 이번 달 총증감을 만든 요인이다)
function revAdjRow(label, cur, prev, total, posSum, note) {
  var d = (Number.isFinite(cur) && Number.isFinite(prev)) ? cur - prev : null;
  var c = (d !== null && posSum !== 0 && Math.abs(d) >= 5e7) ? d / posSum * 100 : null;
  var pct = Number.isFinite(cur) ? (cur / total * 100).toFixed(1) + "%" : "-";
  return "<tr class='rv-adj'><td class='rv-name'>" + label + "</td>" +
    "<td class='rv-n rv-gsep'>" + (Number.isFinite(cur) ? revMoney(cur) : "-") + "</td>" +
    "<td class='rv-n'>" + (d !== null ? revDelta(d) : "<span class='rv-mut'>-</span>") + "</td>" +
    "<td class='rv-n'>" + revContrib(c) + "</td>" +
    "<td class='rv-n rv-mut'>" + pct + "</td>" +
    "<td colspan='4' class='rv-mut rv-l-note rv-gsep'>" + note + "</td></tr>";
}
// 조정행 4개(재공품·나보타·미착품·평가충당금)가 다 있어야 표가 닫힌다.
// 하나라도 빠지면 증가 행 기여도 합이 100%가 안 된다 — 실제로 재공품이 빠져 9.9억이 안 맞았다.
//
// 표를 워터폴로 닫는다 — 증가 요인 → 감소 요인 → 총재고.
// 기여도의 분모는 변동 총량(|증가| + |감소|)이므로, 증가 소계 %와 감소 소계 %의 절대값을 더하면
// 정확히 100%가 되고, 총재고 행의 기여도도 100%다 (= 모든 행의 절대 기여도 합).
function revFooterSum(T, wf) {
  var A = T.adj;
  var total  = T.hist[5] || 1;
  var absSum = wf.abs, posSum = wf.pos, negSum = wf.neg;
  var hd     = T.hist[5] - T.hist[4];
  var pctOf  = function(v) { return absSum !== 0 ? (v / absSum * 100).toFixed(1) + "%" : "-"; };

  function subtotal(label, amt, note, cls) {
    return "<tr class='rv-sub" + (cls || "") + "'><td class='rv-name'>" + label + "</td>" +
      "<td class='rv-n rv-gsep rv-mut'>-</td>" +
      "<td class='rv-n'>" + revDelta(amt) + "</td>" +
      "<td class='rv-n'><b>" + pctOf(amt) + "</b></td>" +
      "<td class='rv-n rv-mut'>-</td>" +
      "<td colspan='4' class='rv-mut rv-l-note rv-gsep'>" + note + "</td></tr>";
  }

  return revAdjRow("재공품", A.wip[5], A.wip[4], total, absSum, "공정 중 재고 (별도 수불)") +
    revAdjRow("나보타 (통합관리)", A.nabota[5], A.nabota[4], total, absSum,
              "품목 전개 없음 — 총액만 관리") +
    revAdjRow("미착품", A.michak[5], A.michak[4], total, absSum, "공시 조정 항목") +
    revAdjRow("평가충당금", A.allowance[5], A.allowance[4], total, absSum, "공시 조정 항목") +
    subtotal("증가 요인", posSum, "위 행들 중 <b>늘어난 것</b>만 합산", " rv-sub-pos") +
    subtotal("감소 요인", negSum, "위 행들 중 <b>줄어든 것</b>만 합산", " rv-sub-neg") +
    "<tr class='rv-total'><td class='rv-name'>총재고 (공시기준)</td>" +
      "<td class='rv-n rv-gsep'>" + revMoney(T.hist[5]) + "</td>" +
      "<td class='rv-n'>" + revDelta(hd) + "</td>" +
      "<td class='rv-n'><b>100%</b></td>" +
      "<td class='rv-n'><b>100%</b></td>" +
      "<td class='rv-n rv-gsep'>" + (T.histDays[5] ? T.histDays[5].toFixed(0) + "일" : "-") + "</td>" +
      "<td colspan='3' class='rv-mut'>결산_RAW 합계와 일치 · " +
        "변동 총량 <b>" + revMoney(absSum) + "억</b> (증가 " + revMoney(posSum) +
        " + 감소 " + revMoney(Math.abs(negSum)) + ") = 기여도의 분모 · " +
        "순증 " + revMoney(hd) + "억</td></tr>";
}

// ── 메인 렌더 ─────────────────────────────────────────────────────────────────
function revKpi(label, val, unit, foot, lead) {
  return "<div class='rv-kpi" + (lead ? " rv-kpi-lead" : "") + "'>" +
    "<div class='rv-kpi-l'>" + label + "</div>" +
    "<div class='rv-kpi-v'>" + val + "<small>" + unit + "</small></div>" +
    "<div class='rv-kpi-f'>" + (foot || "") + "</div></div>";
}
function revChip(sev, main, sub) {
  return "<span class='rv-chip" + (sev ? " rv-chip-" + sev : "") + "'>" +
    "<b>" + escapeHtml(main) + "</b><span>" + escapeHtml(sub) + "</span></span>";
}

// 3단 시나리오 카드 — 이전 단계 대비 얼마나 줄었는지가 핵심
function revScn(label, amt, days, prevAmt, prevDays, key) {
  var d  = (Number.isFinite(amt) && Number.isFinite(prevAmt)) ? amt - prevAmt : null;
  var dd = (Number.isFinite(days) && Number.isFinite(prevDays)) ? days - prevDays : null;
  var moved = d !== null && Math.abs(d) >= 5e6;
  return "<div class='rv-scn-c rv-scn-" + key + (moved ? " rv-scn-on" : "") + "'>" +
    "<div class='rv-scn-l'>" + label + "</div>" +
    "<div class='rv-scn-v'>" + revMoney(amt) + "<small>억</small></div>" +
    "<div class='rv-scn-y'>" + (Number.isFinite(days) ? days.toFixed(1) + "일" : "-") + "</div>" +
    (moved
      ? "<div class='rv-scn-d'>" + (d < 0 ? "▽" : "▲") + revMoney(Math.abs(d)) + "억" +
        (dd !== null && Math.abs(dd) >= 0.1 ? " · " + (dd < 0 ? "▽" : "▲") + Math.abs(dd).toFixed(1) + "일" : "") +
        "</div>"
      : "<div class='rv-scn-d rv-scn-idle'>조정 없음</div>") +
  "</div>";
}

function renderInventoryReview() {
  if (!state.closing || state.closing.status !== CLOSING_STATUS.DONE) {
    // file:// 로 열면 브라우저가 fetch를 원천 차단한다 → 결산 파일을 직접 고르게 안내.
    if (state.closing && state.closing.fileMode) {
      return "<section class='section-band'><div class='rv-guide'>" +
        "<h2>결산자료를 연결해 주세요</h2>" +
        "<p>지금 <b>index.html을 파일로 직접 연 상태</b>라서 브라우저가 폴더 접근을 막고 있습니다. " +
        "둘 중 하나를 하시면 됩니다.</p>" +
        "<div class='rv-guide-2'>" +
          "<div class='rv-guide-box'><div class='rv-guide-n'>방법 1 — 권장</div>" +
            "<b>start.bat 으로 실행</b>" +
            "<p>결산자료가 자동으로 읽힙니다(0.04초). 파일을 고를 필요가 없습니다.</p></div>" +
          "<div class='rv-guide-box'><div class='rv-guide-n'>방법 2</div>" +
            "<b>파일 하나만 더 선택</b>" +
            "<p>데이터점검 화면에서 다른 RAW 파일과 함께 <code>data/closing.json</code> " +
            "<b>하나만</b> 고르면 됩니다. (없으면 <code>결산자료</code> 폴더의 xlsx 6개)</p>" +
            "<button class='rv-guide-btn' onclick=\"render('data-check')\">데이터점검으로 이동</button></div>" +
        "</div></div></section>";
    }
    var msg = (state.closing && state.closing.status === CLOSING_STATUS.ERROR)
      ? "결산자료를 읽지 못했습니다.<br><span class='rv-mut'>" +
        escapeHtml((state.closing.errors || []).join(" / ")) + "</span>"
      : "결산자료 로딩 중…";
    return "<section class='section-band'><div class='section-header'><h2>재고 총괄장</h2><p>" +
           msg + "</p></div></section>";
  }
  if (!state.mappedData.plan_monthly.length) {
    return "<section class='section-band'><div class='section-header'><h2>재고 총괄장</h2>" +
      "<p>데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 선택하세요.</p></div></section>";
  }

  var items = buildReviewItems();
  var T     = reviewTotals();
  var D     = reviewDiagnosis();
  var wf    = reviewWaterfall(items, T);
  var tab   = state.revTab  || "fg";
  var view  = state.revView || "sum";

  // 기본은 전부 접힘 — 유형 행만 보인다. 증가 원인·의견이 유형·품목군 행에도 표시되므로
  // 펼치지 않아도 무엇이 문제인지 읽힌다. 필요할 때만 파고든다.

  var jun = T.hist[5], may = T.hist[4];
  var junD = T.histDays[5], mayD = T.histDays[4];

  var meta = {};
  (state.mappedData.actuals_meta || []).forEach(function(r) { meta[r.month] = r; });
  var ly = meta["2025-06"];
  var lyD = (ly && Number.isFinite(ly.totalInv) && ly.monthCogs > 0)
    ? ly.totalInv / ly.monthCogs * 30 : null;

  var topG = D.topGroups[0];
  // 기여도의 분모는 헤드라인 증감(공시기준 전월대비)이어야 한다.
  // 관리기준 증감(D.totalDelta = 201억)을 쓰면 소견 문장 안에서 분모가 어긋난다
  // ("183억 늘었고 그 84%가…" ← 84%는 201억 대비라 말이 안 됨).
  var headDelta = (Number.isFinite(jun) && Number.isFinite(may)) ? jun - may : null;
  var share = (topG && headDelta > 0) ? topG[1].delta / headDelta * 100 : null;
  var topName = topG ? topG[0].split(" / ").pop() : "";

  var hero =
    "<div class='rv-hero'>" +
      "<div class='rv-hero-top'>" +
        "<div><div class='rv-eyebrow'>2부 재고절감 · 총괄장</div>" +
        "<h2 class='rv-title'>2026년 6월 결산 리뷰 <span>→ 하반기 전망</span></h2></div>" +
        "<div class='rv-hero-note'>공시기준 · 나보타 통합관리<br>재고일수는 매출원가 분모</div>" +
      "</div>" +
      // 증가 기여도(thynC 93%)는 여기 넣지 않는다 — 진단 칩과 소견에 이미 있어
      // 같은 말을 세 번 하게 된다. 히어로는 "재고가 얼마고 얼마나 나쁜가"만 답한다.
      "<div class='rv-kpis'>" +
        revKpi("총재고 · 6월말", revEok(jun).replace("억", ""), "억",
               "전월 " + revEok(may) + " · " + revDelta(jun - may) + "억", true) +
        revKpi("재고일수", junD ? junD.toFixed(1) : "-", "일",
               mayD ? "전월 " + mayD.toFixed(1) + "일 · " + revDaysDelta(junD - mayD) : "") +
        revKpi("전년 동월 대비",
               lyD ? ((junD - lyD) >= 0 ? "+" : "") + (junD - lyD).toFixed(1) : "-", "일",
               lyD ? "25년 6월 " + lyD.toFixed(1) + "일 → " + junD.toFixed(1) + "일" : "") +
      "</div>" +
    "</div>";

  var chips = [];
  if (topG) chips.push(revChip("hot", topName + " +" + revMoney(topG[1].delta) + "억",
                               "6월 증가의 " + Math.round(share) + "%"));
  chips.push(revChip("warn",   "계획없음 " + revMoney(D.noPlanAmt) + "억", D.noPlanCnt + "품목"));
  if (D.bomOk && D.unusedAmt > 1e8)
    chips.push(revChip("danger", "불용자재 " + revMoney(D.unusedAmt) + "억",
                       D.unusedCnt + "품목 · BOM 미사용 → 처분 검토"));
  chips.push(revChip("danger", "소진불가 " + revMoney(D.dormantAmt) + "억", D.dormantCnt + "품목 · 3개월 무출고"));
  chips.push(revChip("",       "재고 12개월↑ " + revMoney(D.longMosAmt) + "억", D.longMosCnt + "품목"));

  // ── AI 소견 ──
  // 회의는 4시간이다. 500품목을 다 볼 수 없다. "이것만 보면 된다"를 AI가 먼저 말해준다.
  var opinion = "";
  if (topG) {
    var hd = jun - may;
    // 증가의 90%를 설명하는 최소 품목군 집합 (최대 5개)
    var acc = 0, focus = [];
    (D.topGroups || []).forEach(function(g) {
      if (g[1].delta <= 0 || focus.length >= 5) return;
      if (focus.length && acc / hd >= 0.9) return;   // 이미 90% 설명 → 그만
      acc += g[1].delta;
      focus.push(g[0].split(" / ").pop());
    });

    var g0 = topG[1];
    var via = g0.buy >= g0.prod ? "구매입고" : "생산입고";
    var viaAmt = Math.max(g0.buy, g0.prod);

    opinion = "<div class='rv-op'><b>AI 소견</b> — 6월 총재고가 " + revMoney(may) + "억에서 " +
      revMoney(jun) + "억으로 <b>" + revMoney(hd) + "억</b> 늘었습니다. " +
      "그 <b>" + Math.round(share) + "%</b>가 <b>" + escapeHtml(topName) + "</b> 한 품목군입니다(+" +
      revMoney(g0.delta) + "억). 이 품목군은 6월에 <b>" + via + " " + revMoney(viaAmt) +
      "억</b>이 들어왔는데 <b>판매는 " + revMoney(g0.sale) + "억</b>입니다." +
      (focus.length
        ? "<span class='rv-op-focus'>회의는 4시간입니다. <b>이 " + focus.length +
          "개 품목군만 점검하면 이번 증가의 " + Math.round(acc / hd * 100) + "%</b>를 설명합니다 — " +
          escapeHtml(focus.join(" · ")) + "</span>"
        : "") +
      "</div>";
  }

  // ── 3단 시나리오 스트립 ──
  // 회의는 6월 결산 리뷰로 시작한다. 그 시점엔 조정이 하나도 없어서 3단이 전부 같은
  // 숫자다 — 똑같은 숫자 세 개를 나란히 두면 의미가 없고 "6월 얘기 중인데 왜 12월?"이
  // 된다. 그래서 조정이 생겼을 때만 나타나게 한다.
  //   리뷰 시작        → 안 보임 (화면이 6월 얘기만 한다)
  //   RTF·과잉감축 후  → 나타남 ("우리가 이만큼 줄였다")
  // 보여줄 성과가 없으면 안 보이는 게 정직하다.
  var hasAdj = (Object.keys(state.matSimAdj  || {}).length > 0) ||
               (Object.keys(state.excessAdj  || {}).length > 0) ||
               (typeof hasFgProdAdj === "function" && hasFgProdAdj());
  var scn = "";
  if (hasAdj) {
    var fdB = T.fcstDays(T.base), fdR = T.fcstDays(T.rtf), fdE = T.fcstDays(T.exc);
    var L = 5;   // 12월 = 전망 마지막 달
    scn =
      "<div class='rv-scn'>" +
        "<div class='rv-scn-hd'>12월말 전망 <span>— 조정할 때마다 실시간으로 바뀝니다</span></div>" +
        "<div class='rv-scn-row'>" +
          revScn("원계획", T.base[L], fdB[L], null, null, "base") +
          "<div class='rv-scn-arr'>→</div>" +
          revScn("RTF 조정후", T.rtf[L], fdR[L], T.base[L], fdB[L], "rtf") +
          "<div class='rv-scn-arr'>→</div>" +
          revScn("과잉감축 후", T.exc[L], fdE[L], T.rtf[L], fdR[L], "exc") +
        "</div>" +
      "</div>";
  }

  var tree  = buildReviewTree(items, tab, T);
  var table = (view === "mon") ? revMonthTable(tree, T) : revSumTable(tree, T, wf);

  // 회의 중 담당자가 "우리 품목 어디 있냐"고 묻는다. 검색창 하나가 시간을 크게 줄인다.
  var hits = tree.filter(function(n) { return n.level === 2; }).length;
  var bar =
    "<div class='rv-bar'>" +
      "<div class='rv-seg'>" +
        "<button data-rvtab='fg'"  + (tab === "fg"  ? " class='on'" : "") + ">제·상품</button>" +
        "<button data-rvtab='mat'" + (tab === "mat" ? " class='on'" : "") + ">원부자재</button>" +
      "</div>" +
      "<div class='rv-seg'>" +
        "<button data-rvview='sum'" + (view === "sum" ? " class='on'" : "") + ">요약 뷰</button>" +
        "<button data-rvview='mon'" + (view === "mon" ? " class='on'" : "") + ">월별 뷰</button>" +
      "</div>" +
      (view === "mon"
        ? "<div class='rv-mon-legend'>" +
            "<span><i class='rv-lg-act'></i>1~6월 실적</span>" +
            "<span><i class='rv-lg-fc'></i>7~12월 전망</span>" +
          "</div>"
        : "") +
      "<div class='rv-search'>" +
        "<input id='revSearch' value='" + escapeHtml(state.revSearch || "") +
          "' placeholder='품목코드 · 품목명 · 품목군 검색' />" +
        (state.revSearch
          ? "<span class='rv-search-n'>" + hits + "품목</span>" +
            "<button class='rv-search-x' id='revSearchX'>✕</button>"
          : "") +
      "</div>" +
    "</div>";

  return "<div class='rv'>" + hero +
    "<div class='rv-diag'><span class='rv-diag-lbl'>AI 진단</span>" + chips.join("") + "</div>" +
    opinion +
    renderScenarioChartCard("rv") +
    scn +
    "<div class='rv-card'>" + bar +
      "<div class='rv-scroll'>" + table + "</div>" +
      "<div class='rv-note'>" +
        "<div class='rv-note-wf'>증가 요인 <b>+" + revMoney(wf.pos) + "억</b> · 감소 요인 <b>−" +
          revMoney(Math.abs(wf.neg)) + "억</b> · 순증 <b>" +
          (Number.isFinite(headDelta) ? (headDelta >= 0 ? "+" : "−") + revMoney(Math.abs(headDelta)) : "-") +
          "억</b></div>" +
        "<b>증가 기여도</b> = 그 행의 증가액 ÷ 증가 요인 합계 (누가 이번 증가를 만들었나) · " +
        "<b>재고금액 비중</b> = 그 행의 재고 ÷ 공시기준 총재고 (규모가 얼마나 되나)<br>" +
        "<b>재고일수</b>(품목·품목군·유형 행) = 6월말 재고를 하반기 계획(제·상품 = 판매계획 / 원부자재 = BOM 소요)대로 " +
        "소진할 때 버티는 일수(선행 커버리지). 계획 구간(6개월)을 넘으면 계획 말기 속도로 외삽. 나갈 계획이 없으면 <b>∞</b>. " +
        "360일 초과 = 주의 · 720일 초과 = 위험. " +
        "<span class='rv-mut'>※ 아래 총재고 합계행의 재고일수(140일)는 산식이 다릅니다.</span><br>" +
        "<b>재고일수</b>(총재고 합계행) = 재고금액 ÷ <b>누적 매출원가</b> × <b>누적일수</b> (연초부터 누적 — 회사 마감 방식). " +
        "실적 구간(1~6월)은 결산 매출원가를 그대로 씁니다. " +
        "전망 구간(7~12월)은 매출원가가 마감 후에나 확정되므로 <b>판매계획 × 표준원가</b>로 추정하고, " +
        "판매계획 파일이 전사 매출원가의 77%만 담고 있어 상반기 실측 보정계수(×1.301)를 적용합니다.<br>" +
        "재고금액 = 결산 자재수불 기말 · <b>나보타(플랜트 1220)는 총액만</b> · 유형 = CN열 · " +
        "제·상품 품목군 = 기준정보 품목구분1 / 원부자재 = <b>BOM 역전개</b>(공용은 소요량 최대 품목군에 전액 귀속) · " +
        "<b>판매계획이 없는 재고는 0이 아니라 그대로 이월(flat)</b>되어 12월까지 수평선으로 남습니다." +
      "</div>" +
    "</div></div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 품목 AI 분석 팝업 — 마크업·CSS 클래스는 excess.js의 openAiDiagPopup 패턴을 그대로 따른다
// (exc-diag-overlay / exc-diag-card / exc-diag-head / exc-diag-close / exc-diag-opinion).
// 표의 구조·컬럼은 건드리지 않는다 — 품목(leaf) 행 클릭으로만 열린다.
// ═══════════════════════════════════════════════════════════════════════════

// 품목코드 → 표준원가. computeRtfItems 결과(플랜트별)에서 코드당 첫 유효값을 취한다.
// 팝업에서 판매계획(수량)을 금액으로 환산할 때만 쓴다 — 배지·판정에는 안 쓴다.
var _stdCostCache = null, _stdCostEpoch = -1;
function getStdCostMap() {
  if (_stdCostCache && _stdCostEpoch === (window._renderEpoch || 0)) return _stdCostCache;
  var map = new Map();
  var rtfItems = (typeof computeRtfItems === "function") ? computeRtfItems(undefined, true) : [];
  rtfItems.forEach(function(it) {
    if (it.itemCode && !map.has(it.itemCode) && Number.isFinite(it.standardCost) && it.standardCost > 0)
      map.set(it.itemCode, it.standardCost);
  });
  _stdCostCache = map;
  _stdCostEpoch = (window._renderEpoch || 0);
  return map;
}

// 워터폴 한 줄 — 0.05억 미만은 노이즈로 생략(표 컷오프와 동일)
function revWfLine(label, won) {
  if (!Number.isFinite(won) || Math.abs(won) < 5e6) return "";
  var sign = won > 0 ? "+" : "−";
  var cls  = won > 0 ? "rv-up" : "rv-down";
  return "<div class='rv-pop-wf-row'><span>" + escapeHtml(label) + "</span>" +
    "<b class='" + cls + "'>" + sign + revMoney(Math.abs(won)) + "억</b></div>";
}

var _revPopupEl = null;
function closeRevItemPopup() {
  if (_revPopupEl && _revPopupEl.parentNode) _revPopupEl.parentNode.removeChild(_revPopupEl);
  _revPopupEl = null;
}

function openRevItemPopup(itemCode) {
  closeRevItemPopup();
  var items = buildReviewItems() || [];
  var it = null;
  for (var i = 0; i < items.length; i++) { if (items[i].itemCode === itemCode) { it = items[i]; break; } }
  if (!it) return;

  var cl  = state.closing && state.closing.items.get(itemCode);
  var m6  = cl && cl.mon[5];
  var c   = buildCauseMap().get(itemCode) || { causes: [] };
  var trow = (state.mappedData.target_inv || []).filter(function(r) { return r.itemCode === itemCode; })[0] || {};
  var hasCause = {};
  (c.causes || []).forEach(function(x) { hasCause[x.k] = true; });

  var costMap = getStdCostMap();
  var cost = costMap.get(itemCode);
  if (!(cost > 0) && trow.unitPrice > 0) cost = trow.unitPrice;
  var costOk = cost > 0;

  // ① 6월에 무슨 일이 있었나 — 결산 실측 워터폴 + 검산
  var wf = "";
  if (m6) {
    wf += "<div class='rv-pop-wf-row rv-pop-wf-base'><span>기초재고</span><b>" + revMoney(m6.base) + "억</b></div>";
    wf += revWfLine("구매입고", m6.buyIn);
    wf += revWfLine("생산입고", m6.prodIn);
    wf += revWfLine("판매", -m6.sale);
    wf += revWfLine("생산출고", -m6.prodOut);
    wf += revWfLine("코스트센터출고(샘플·비용)", -m6.ccOut);
    var flowNet   = (m6.buyIn || 0) + (m6.prodIn || 0) - (m6.sale || 0) - (m6.prodOut || 0) - (m6.ccOut || 0);
    var actualNet = m6.end - m6.base;
    var diff = actualNet - flowNet;
    if (Math.abs(diff) >= 5e6) wf += revWfLine("기타(미상 차액)", diff);
    wf += "<div class='rv-pop-wf-row rv-pop-wf-tot'><span>기말재고</span><b>" + revMoney(m6.end) +
      "억 <small>(전월대비 " + (actualNet >= 0 ? "+" : "−") + revMoney(Math.abs(actualNet)) + "억)</small></b></div>";
  } else {
    wf = "<div class='rv-mut'>결산 실측 데이터가 연결되지 않았습니다.</div>";
  }

  // ② 왜 이렇게 됐나 — 판정 + 근거 숫자. 없는 근거는 행을 생략한다.
  var reasons = [];
  if (it.isFg && c.june && Number.isFinite(c.june.plan) && c.june.plan > 0) {
    var jAct = Number.isFinite(c.june.act) ? c.june.act : 0;
    var jAch = Math.round(jAct / c.june.plan * 100);
    var jText = costOk
      ? "판매계획 " + revMoney(c.june.plan * cost) + "억 → 실적 " + revMoney(jAct * cost) + "억 · 달성률 " + jAch + "%"
      : "판매계획 " + Math.round(c.june.plan).toLocaleString("ko-KR") + "개 → 실적 " +
        Math.round(jAct).toLocaleString("ko-KR") + "개 · 달성률 " + jAch + "%";
    reasons.push({ label: "판매부진", text: jText });
  }
  if (hasCause.target) {
    reasons.push({ label: "적정초과", text: "적정재고 " + revMoney(c.targetAmt) + "억의 " +
      c.targetRatio.toFixed(1) + "배 (초과 " + revMoney(it.end6 - c.targetAmt) + "억)" });
  }
  if (hasCause.noCoverage) {
    reasons.push({ label: "소진불가", text: it.covDays === Infinity
      ? "하반기 판매(소요) 계획이 없어 소진되지 않습니다 (∞)"
      : "하반기 계획대로면 " + Math.round(it.covDays / 30) + "개월치 — 계획 구간(6개월) 내 소진 불가" });
  }
  if (hasCause.moq && Number.isFinite(c.moqM)) {
    var moqQtyTxt = Number.isFinite(c.moq) ? Math.round(c.moq).toLocaleString("ko-KR") + "개 = " : "";
    reasons.push({ label: "MOQ구조", text: "MOQ " + moqQtyTxt + "월평균 출고의 " + c.moqM.toFixed(1) +
      "배. 한 번 발주에 " + Math.round(c.moqM) + "개월치가 들어옵니다" });
  }
  if (hasCause.stableDemand && Number.isFinite(c.cv)) {
    reasons.push({ label: "수요안정", text: "CV " + Math.round(c.cv * 100) + "%" +
      (c.grade ? " · 중요도 " + escapeHtml(c.grade) : "") +
      " — 수요는 안정적입니다. 불확실성 대비 비축으로 보기 어렵습니다" });
  }
  if (hasCause.dormant6) {
    reasons.push({ label: "장기정체", text: "6개월 내내 입고도 출고도 없는데 재고가 " +
      revMoney(it.end6) + "억 남아 있습니다" });
  }
  if (hasCause.saleStop) {
    reasons.push({ label: "판매중단", text: "1~3월 판매 " + revMoney(c.saleStopS13) +
      "억 → 4~6월 판매 0" });
  }
  if (c.cycleMonths !== null || c.leadTime !== null) {
    var supplyBits = [];
    if (c.cycleMonths !== null) supplyBits.push("공급주기 " + c.cycleMonths + "개월");
    if (c.leadTime    !== null) supplyBits.push("리드타임 " + c.leadTime + "개월");
    reasons.push({ label: "공급조건", text: supplyBits.join(" · ") });
  }
  if (it.mos3 !== null && it.mos3 !== undefined) {
    reasons.push({ label: "참고", text: "최근 3개월 평균 출고 기준으로는 " +
      (it.mos3 === Infinity ? "∞(무출고)" : Math.round(it.mos3) + "개월치") + " (과거 기준)" });
  }

  // ③ AI 소견 — 붙은 원인을 조합해 동적으로 생성. 단정하지 않고 확인 여지를 남긴다.
  var op = [];
  if (hasCause.under || (it.isFg && c.june && c.june.plan > 0)) {
    if (m6 && costOk && c.june && Number.isFinite(c.june.plan) && c.june.plan > 0) {
      var jAct2 = Number.isFinite(c.june.act) ? c.june.act : 0;
      var jAch2 = Math.round(jAct2 / c.june.plan * 100);
      op.push("6월에 " + revMoney(m6.buyIn) + "억을 사서 " + revMoney(m6.sale) +
        "억 팔았습니다. 판매는 계획의 " + jAch2 + "%인데 발주는 그대로 나갔습니다.");
    } else if (Number.isFinite(c.ach)) {
      op.push("최근 3개월 판매가 계획 대비 " + Math.round(c.ach * 100) + "%에 그쳤습니다.");
    }
  }
  if (hasCause.stableDemand) {
    op.push("수요변동이 " + Math.round(c.cv * 100) + "%로 안정적이라 불확실성 대비 비축이라는 설명은 성립하지 않습니다.");
  }
  if (hasCause.target || hasCause.noCoverage) {
    var bits2 = [];
    if (hasCause.target) bits2.push("적정재고의 " + c.targetRatio.toFixed(1) + "배");
    if (hasCause.noCoverage) {
      bits2.push(it.covDays === Infinity ? "하반기 계획대로면 소진되지 않습니다" :
        "하반기 계획대로면 " + Math.round(it.covDays / 30) + "개월치입니다");
    }
    op.push(bits2.join(", ") + ".");
  }
  if (hasCause.moq) {
    op.push("MOQ가 월평균 출고의 " + c.moqM.toFixed(1) + "개월치라 필요한 만큼만 발주해도 재고가 쌓이는 구조입니다.");
  }
  if (hasCause.dormant6) {
    op.push("6개월째 입출고가 전혀 없는 재고입니다 — 처분 여부를 확인해야 합니다.");
  }
  if (hasCause.saleStop) {
    op.push("4월 이후 판매가 끊겼습니다 — 단종·이관 등 사유 확인이 필요합니다.");
  }
  if (hasCause.noplan) {
    op.push("하반기 판매계획이 없어 이 재고는 이 회의로는 줄일 방법이 없습니다 — 사업부 확인이 필요합니다.");
  }
  var opinionHtml;
  if (op.length) {
    op.push("전략적 비축이나 별도 사유가 있다면 아래 의견란에 남겨 주십시오. 사유가 확인되지 않는다면 하반기 발주·계획 재검토가 필요합니다.");
    opinionHtml = op.join(" ");
  } else {
    opinionHtml = "특이 원인이 감지되지 않았습니다.";
  }

  var opKey = itemCode;
  var opVal = (state.revOpinion || {})[opKey] || "";

  var ov = document.createElement("div");
  ov.className = "exc-diag-overlay";
  ov.innerHTML =
    "<div class='exc-diag-card'>" +
      "<div class='exc-diag-head'>" +
        "<div class='exc-diag-titles'>" +
          "<div class='exc-diag-name'><span class='exc-ai-codehead'>" + escapeHtml(itemCode) + "</span> " +
            escapeHtml(it.itemName || itemCode) + "</div>" +
          "<div class='exc-diag-sub'>" + revCauseBadges(c, it) + "</div>" +
        "</div>" +
        "<button class='exc-diag-close' title='닫기'>×</button>" +
      "</div>" +
      "<div class='rv-pop-sec'>" +
        "<div class='rv-pop-h'>① 6월에 무슨 일이 있었나</div>" +
        "<div class='rv-pop-wf'>" + wf + "</div>" +
      "</div>" +
      (reasons.length
        ? "<div class='rv-pop-sec'>" +
            "<div class='rv-pop-h'>② 왜 이렇게 됐나</div>" +
            "<div class='rv-pop-reasons'>" + reasons.map(function(r) {
              return "<div class='rv-pop-r'><b>" + escapeHtml(r.label) + "</b><span>" + r.text + "</span></div>";
            }).join("") + "</div>" +
          "</div>"
        : "") +
      "<div class='exc-diag-opinion'><span class='exc-diag-opinion-tag'>🤖 AI 소견</span>" + opinionHtml + "</div>" +
      "<div class='rv-pop-sec'>" +
        "<span class='rv-pop-oplabel'>담당자 의견</span>" +
        "<input class='rv-pop-op-in' data-rvpopop='" + escapeHtml(opKey) + "' value='" +
          escapeHtml(opVal) + "' placeholder='의견 입력 — 전략비축·최소운영재고 등 AI가 모르는 맥락' />" +
      "</div>" +
      "<div class='rv-pop-sec rv-pop-goexc'>" +
        "<button class='exc-diag-save rv-pop-goexc-btn' type='button'>과잉감축에서 조정하기 →</button>" +
      "</div>" +
    "</div>";
  document.body.appendChild(ov);
  _revPopupEl = ov;

  ov.addEventListener("click", function(e) { if (e.target === ov) closeRevItemPopup(); });
  var closeBtn = ov.querySelector(".exc-diag-close");
  if (closeBtn) closeBtn.addEventListener("click", closeRevItemPopup);

  // 담당자 의견 — 표의 의견 컬럼과 같은 저장소(state.revOpinion, 키=품목코드)를 쓴다
  var opIn = ov.querySelector(".rv-pop-op-in");
  if (opIn) {
    opIn.addEventListener("input", function() {
      state.revOpinion = state.revOpinion || {};
      var v = opIn.value.trim();
      if (v) state.revOpinion[opKey] = v; else delete state.revOpinion[opKey];
    });
    opIn.addEventListener("change", function() {
      if (typeof saveMeetingState === "function") saveMeetingState();
      render("inventory-forecast");   // 표의 의견 셀 갱신 — 팝업은 body 직속이라 사라지지 않는다
    });
  }

  // 재고진단 → 과잉감축 드릴다운 — 그 품목이 검색된 채로 해당 탭(제·상품/원부자재)을 연다.
  // 과잉감축에 해당 품목이 없으면(적정재고 대상 아님 등) 검색 결과 없음 화면이 자연스럽게 뜬다.
  var goExcBtn = ov.querySelector(".rv-pop-goexc-btn");
  if (goExcBtn) {
    goExcBtn.addEventListener("click", function() {
      state.excSearch = itemCode;
      state.excessTab = it.isFg ? "fg" : "mat";
      closeRevItemPopup();
      render("inventory-variance");
      if (typeof saveMeetingState === "function") saveMeetingState();
    });
  }
}

// ── 바인딩 ────────────────────────────────────────────────────────────────────
function bindInventoryReview() {
  var root = document.querySelector(".rv");
  if (!root) return;

  mountScenarioChart("rv");

  root.addEventListener("click", function(e) {
    var tog = e.target.closest("[data-rvtog]");
    if (tog) {
      var id = tog.dataset.rvtog;
      if (state.revOpen.has(id)) state.revOpen.delete(id); else state.revOpen.add(id);
      render("inventory-forecast");
      return;
    }
    var tb = e.target.closest("[data-rvtab]");
    if (tb) { state.revTab = tb.dataset.rvtab; render("inventory-forecast"); return; }
    var vw = e.target.closest("[data-rvview]");
    if (vw) { state.revView = vw.dataset.rvview; render("inventory-forecast"); return; }

    // 정렬 — 같은 컬럼을 다시 누르면 방향이 바뀐다
    var th = e.target.closest("[data-rvsort]");
    if (th) {
      var k = th.dataset.rvsort;
      var s = state.revSort || {};
      state.revSort = (s.key === k) ? { key: k, dir: -s.dir } : { key: k, dir: -1 };
      render("inventory-forecast");
      return;
    }
    if (e.target.id === "revSearchX") {
      state.revSearch = "";
      render("inventory-forecast");
      return;
    }

    // 품목(leaf) 행 클릭 → AI 분석 팝업. 토글 버튼·의견 입력 클릭은 제외.
    if (e.target.closest(".rv-op-in")) return;
    var itemRow = e.target.closest("tr[data-rvitem]");
    if (itemRow) { openRevItemPopup(itemRow.dataset.rvitem); return; }
  });

  // 검색 — 입력할 때마다 걸러진다. 렌더 후 커서를 되돌려야 타이핑이 끊기지 않는다.
  var sb = document.getElementById("revSearch");
  if (sb) {
    sb.addEventListener("input", function() {
      state.revSearch = sb.value;
      var pos = sb.selectionStart;
      render("inventory-forecast");
      var nb = document.getElementById("revSearch");
      if (nb) { nb.focus(); nb.setSelectionRange(pos, pos); }
    });
  }

  // 담당자 의견 — 입력 즉시 상태에 담고, 포커스를 벗어날 때 저장한다.
  // 회의 전에 미리 채워두는 자리다. AI가 모르는 맥락(전략비축 등)이 여기 들어간다.
  root.querySelectorAll("[data-rvop]").forEach(function(el) {
    el.addEventListener("input", function() {
      state.revOpinion = state.revOpinion || {};
      var v = el.value.trim();
      if (v) state.revOpinion[el.dataset.rvop] = v;
      else   delete state.revOpinion[el.dataset.rvop];
    });
    el.addEventListener("change", function() {
      if (typeof saveMeetingState === "function") saveMeetingState();
    });
  });
}
