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

  var fcstByCode = new Map();   // itemCode → { base[], rtf[], exc[] } (원)
  rtfItems.forEach(function(it) {
    var adjR = (typeof computeAdjMonthly    === "function") ? computeAdjMonthly(it, bomMap)    : null;
    var adjE = (typeof computeExcessMonthly === "function") ? computeExcessMonthly(it, bomMap) : null;
    var f = fcstByCode.get(it.itemCode);
    if (!f) { f = { base: [], rtf: [], exc: [] }; fcstByCode.set(it.itemCode, f); }
    FCST_MONTHS.forEach(function(_, mi) {
      var ms = it.monthlyStatus && it.monthlyStatus[mi];
      var b  = ms && Number.isFinite(ms.endingAmount) ? ms.endingAmount : 0;
      var r  = adjR && adjR[mi] && Number.isFinite(adjR[mi].endingAmount) ? adjR[mi].endingAmount : b;
      var e  = adjE && adjE[mi] && Number.isFinite(adjE[mi].endingAmount) ? adjE[mi].endingAmount : r;
      f.base[mi] = (f.base[mi] || 0) + b;
      f.rtf[mi]  = (f.rtf[mi]  || 0) + r;
      f.exc[mi]  = (f.exc[mi]  || 0) + e;
    });
  });

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
    // 판매계획이 없는 품목은 나갈 경로가 없다 → 0이 아니라 6월말 재고를 그대로 이월(flat)
    var fBase = f ? f.base : FCST_MONTHS.map(function() { return end6; });
    var fRtf  = f ? f.rtf  : fBase;
    var fExc  = f ? f.exc  : fBase;

    items.push({
      itemCode: it.itemCode, itemName: it.itemName,
      type: it.type, isFg: isFg,
      businessUnit: it.businessUnit,
      group: grp,                       // 트리의 품목군 축 (제·상품=기준정보 / 원부자재=BOM 역전개)
      shared: shared, sharedN: sharedN, // 공용 자재의 사용처
      hist: hist, end6: end6,
      delta: m6.end - m6.base,
      sale6: m6.sale, cc6: m6.ccOut, buy6: m6.buyIn, prod6: m6.prodIn, prodOut6: m6.prodOut,
      avg3out: avg3,   // 제·상품=3평판(판매) / 원부자재=3개월 평균 생산출고
      mos3: avg3 > 0 ? end6 / avg3 : (end6 > 0 ? Infinity : null),   // 재고월수
      hasPlan: !!f,
      fBase: fBase, fRtf: fRtf, fExc: fExc,
    });
  });

  _reviewCache = items;
  _reviewCacheEpoch = (window._renderEpoch || 0);
  return items;
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
//            ② MOQ 제약 — 최소발주단위가 월 판매의 N개월치라 안 쌓일 수가 없다
//            ③ 신규진입 — 1월 재고 0에서 시작
//   출고 측  ④ 판매부진 — 판매계획 대비 실적 미달 (판매계획 파일 1~6월 계획 vs 실적)
//            ⑤ 계획없음 — 하반기 판매계획이 아예 없다
//   근거     ⑥ 수요변동% — CV(표준편차÷평균). "수요가 불안정해서 쌓았다"는 변명을 막는다
//
// 원인이 안 잡히면 비워둔다. "원인 미상"이라고 쓰면 AI가 모른다는 뜻이 되어 신뢰가 깎인다.
// 코스트센터출고는 재고를 '줄이는' 출고라 증가 원인이 아니다 — 여기서 다루지 않는다.

var CAUSE_SURGE_X   = 2.0;   // 입고급증: 최근 3개월 평균의 2배 초과
var CAUSE_ACH_LOW   = 0.8;   // 판매부진: 계획 대비 달성률 80% 미만
var CAUSE_MOQ_M     = 1.5;   // MOQ 제약: 월 판매의 1.5개월치 초과
var CV_STABLE       = 0.20;  // 수요변동 20% 이하 = 안정
var CV_VOLATILE     = 0.50;  // 50% 초과 = 불안정

var _causeCache = null, _causeEpoch = -1;

function buildCauseMap() {
  if (_causeCache && _causeEpoch === (window._renderEpoch || 0)) return _causeCache;

  // 적정재고_RAW — MOQ · 12개월 평균 출고 · 표준편차
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

  // 하반기 판매계획 유무
  var hasPlan712 = new Set();
  (state.mappedData.plan_monthly || []).forEach(function(r) {
    if (r.itemCode && FCST_MONTHS.indexOf(r.month) >= 0 && cleanNumber(r.salesQty) > 0)
      hasPlan712.add(r.itemCode);
  });

  var map = new Map();
  (buildReviewItems() || []).forEach(function(it) {
    var t = ti.get(it.itemCode) || {};
    var c = { causes: [], cv: null, ach: null, surge: null, moqM: null };

    // 수요변동 (CV) — 근거로 항상 계산
    if (t.stdDev > 0 && t.avg12OutQty > 0) c.cv = t.stdDev / t.avg12OutQty;

    // 증가한 품목만 원인을 따진다 (감소는 원인 진단 대상이 아니다)
    if (it.delta > 3e8) {
      // ① 입고급증 — 6월 입고가 최근 3개월(3·4·5월) 평균의 몇 배인가
      var cl = state.closing && state.closing.items.get(it.itemCode);
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

      // ④ 판매부진
      var a = ach.get(it.itemCode);
      if (a && a.plan > 0) {
        c.ach = a.act / a.plan;
        if (c.ach < CAUSE_ACH_LOW)
          c.causes.push({ k: "under", label: "판매부진 " + Math.round(c.ach * 100) + "%" });
      }

      // ② MOQ 제약 — 월평균 판매 대비 몇 개월치인가
      if (t.moq > 0 && t.avg12OutQty > 0) {
        c.moqM = t.moq / t.avg12OutQty;
        if (c.moqM > CAUSE_MOQ_M)
          c.causes.push({ k: "moq", label: "MOQ " + c.moqM.toFixed(1) + "개월치" });
      }

      // ⑤ 하반기 계획 없음
      if (it.isFg && !hasPlan712.has(it.itemCode))
        c.causes.push({ k: "noplan", label: "하반기 계획없음" });
    }
    map.set(it.itemCode, c);
  });

  _causeCache = map;
  _causeEpoch = (window._renderEpoch || 0);
  return map;
}

// 수요변동 배지 — % 로 쓴다. "CV 0.06"은 설명이 필요하지만 "수요변동 6%"는 그냥 읽힌다.
function revCvBadge(cv) {
  if (!Number.isFinite(cv)) return "";
  var pct = Math.round(cv * 100);
  var tag = cv <= CV_STABLE ? "안정" : (cv > CV_VOLATILE ? "불안정" : "보통");
  var cls = cv <= CV_STABLE ? "rv-b-good" : (cv > CV_VOLATILE ? "rv-b-shared" : "rv-b-shared");
  return "<span class='rv-badge " + cls + "' title='수요 표준편차 ÷ 12개월 평균 출고'>" +
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
  // 전망 = 품목 전개 + 재공품 + 나보타 + 미착 − 충당금
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

  return {
    months:   REVIEW_MONTHS.concat(FCST_MONTHS),
    hist:     hist,
    base:     fcst("fBase"),
    rtf:      fcst("fRtf"),
    exc:      fcst("fExc"),
    // ── 재고일수 = 재고금액 ÷ 누적 매출원가 × 누적일수 ──
    //
    // 회사는 연초부터 누적으로 마감한다. 당월 매출원가만 쓰면 그 달이 튈 때 재고일수도
    // 같이 튄다(2월이 118일로 꺼지는 식). 누적이 재고 수준을 안정적으로 말한다.
    //   6월 = 2,714억 ÷ 누적 매출원가 3,516억 × 누적일수 181일 = 139.7일  ← 회사가 보는 140일
    //   (당월 기준으로 하면 2,714 ÷ 572 × 30 = 142.3일이 나온다 — 회사 숫자와 다르다)
    //
    // 전망 구간도 누적을 그대로 이어간다. 상반기 실적 누적에 하반기 계획 누적을 더한다.
    histDays: REVIEW_MONTHS.map(function(m, mi) {
      var cumC = 0, cumD = 0;
      for (var i = 0; i <= mi; i++) {
        if (!(adj.cogs[i] > 0)) return null;
        cumC += adj.cogs[i];
        cumD += monthDays(REVIEW_MONTHS[i]);
      }
      return Number.isFinite(hist[mi]) ? hist[mi] / cumC * cumD : null;
    }),
    fcstDays: function(series) {
      // 상반기 실적 누적을 출발점으로
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
// 재고월수 — 24개월↑ 위험 / 12~24 주의 / 미만 정상. 출고 0은 ∞(소진 불가).
function revMos(mos) {
  if (mos === null || mos === undefined) return "<span class='rv-mut'>-</span>";
  if (mos === Infinity) return "<span class='rv-mos rv-mos-x'>∞</span>";
  var cls = mos >= 24 ? "rv-mos-x" : mos >= 12 ? "rv-mos-w" : "rv-mos-g";
  return "<span class='rv-mos " + cls + "'>" + (mos >= 100 ? Math.round(mos) : mos.toFixed(1)) + "</span>";
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
            hist: [0,0,0,0,0,0], fBase: [0,0,0,0,0,0], fRtf: [0,0,0,0,0,0], fExc: [0,0,0,0,0,0] };
  items.forEach(function(it) {
    a.end += it.end6; a.delta += it.delta; a.out3 += it.avg3out;
    a.sale += it.sale6; a.cc += it.cc6; a.buy += it.buy6; a.prod += it.prod6;
    for (var i = 0; i < 6; i++) {
      if (Number.isFinite(it.hist[i])) a.hist[i] += it.hist[i];
      a.fBase[i] += it.fBase[i] || 0;
      a.fRtf[i]  += it.fRtf[i]  || 0;
      a.fExc[i]  += it.fExc[i]  || 0;
    }
  });
  // 롤업 재고월수 — 금액 기준이라 합산해서 나눌 수 있다 (수량이면 단위가 달라 불가)
  a.mos = a.out3 > 0 ? a.end / a.out3 : (a.end > 0 ? Infinity : null);
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
    case "mos":     return agg.mos === Infinity ? 1e9 : (agg.mos === null ? -1 : agg.mos);
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
  return { end: it.end6, delta: it.delta, mos: it.mos3, hist: it.hist, fExc: it.fExc,
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

// 담당자 의견 — 회의 전에 미리 채운다. AI가 모르는 맥락(전략비축 등)이 들어가는 자리.
function revOpinionCell(n) {
  if (!n.item) return "<td class='rv-band'></td>";
  var v = (state.revOpinion || {})[n.item.itemCode] || "";
  return "<td class='rv-band rv-op-cell'>" +
    "<input class='rv-op-in' data-rvop='" + escapeHtml(n.item.itemCode) + "' " +
    "value='" + escapeHtml(v) + "' placeholder='의견 입력' />" +
    "</td>";
}

// ── 요약 뷰 ───────────────────────────────────────────────────────────────────
function revSumTable(tree, T) {
  var byId   = new Map(tree.map(function(x) { return [x.id, x]; }));
  var causes = buildCauseMap();
  var total  = T.hist[5] || 1;
  // 증가 기여도의 분모 = 헤드라인 증감(공시기준 전월대비). 관리기준 증감을 쓰면
  // 소견 문장과 어긋난다 ("183억 늘었고 그 84%가…" ← 84%는 다른 분모).
  var headDelta = (Number.isFinite(T.hist[5]) && Number.isFinite(T.hist[4]))
    ? T.hist[5] - T.hist[4] : 0;
  var rows  = "";

  tree.forEach(function(n, i) {
    if (!revVisible(n, byId)) return;
    var hasKid = !!(tree[i + 1] && tree[i + 1].parent === n.id);
    var a = n.item
      ? { end: n.item.end6, delta: n.item.delta, mos: n.item.mos3, hist: n.item.hist,
          sale: n.item.sale6, cc: n.item.cc6, buy: n.item.buy6, prod: n.item.prod6 }
      : revAgg(n.items);

    var pct = a.end / total * 100;
    // 증가 기여도 = 그 행의 증감 ÷ 총 증감. 감소한 행은 음수로 표시한다.
    // 양수만 보여주면 합이 100%를 넘어(증가분만 더해지므로) "왜 119%냐"는 말이 나온다.
    // 음수까지 포함하고 조정행(나보타·미착·충당금)에도 기여도를 붙이면 합이 정확히 100%가 되어
    // 회의에서 검산해도 맞는다.
    var contrib = (headDelta !== 0 && Math.abs(a.delta) >= 5e7) ? a.delta / headDelta * 100 : null;
    var cls = "";
    // BOM 어디에도 안 걸리고 출고도 없는 자재 = 불용. 감축이 아니라 처분 결정 대상.
    if (n.level === 1 && n.label === MAT_UNUSED_GROUP) cls = " rv-crit";
    else if (n.level === 1 && a.delta > 50e8)          cls = " rv-hot";
    else if (a.mos === Infinity && a.end > 10e8)       cls = " rv-crit";

    // "왜 늘었나" — 담당자가 설명하기 전에 화면이 먼저 답한다
    var cause = "";
    if (n.item) {
      var c = causes.get(n.item.itemCode);
      if (c && c.causes.length) {
        cause += c.causes.map(function(x) {
          var cls = x.k === "under" || x.k === "noplan" ? "rv-b-danger" : "rv-b-warn";
          return "<span class='rv-badge " + cls + "'>" + escapeHtml(x.label) + "</span>";
        }).join("");
        if (Number.isFinite(c.cv)) cause += revCvBadge(c.cv);
      }
      // 공용 자재 — 소요량 최대 품목군에 전액 귀속했음을 드러낸다.
      // 숨기지 않아야 "왜 여기 넣었냐"에 답할 수 있다.
      if (n.item.sharedN > 1) {
        cause += "<span class='rv-badge rv-b-shared' title='" +
          escapeHtml(n.item.shared.join(" · ")) + "'>공용 " + n.item.sharedN + "</span>";
      }
    } else if (a.delta > 5e8) {
      // 집계 행 — 구매입고인지 생산입고인지만
      var via = a.buy >= a.prod ? "구매" : "생산";
      cause += "<span class='rv-badge rv-b-warn'>" + via + "입고 " + revMoney(Math.max(a.buy, a.prod)) + "억</span>";
    }

    rows += "<tr class='rv-l" + n.level + cls + "'>" + revRowHead(n, hasKid) +
      "<td class='rv-n rv-gsep'><b>" + revMoney(a.end) + "</b></td>" +
      "<td class='rv-n'>" + revDelta(a.delta) + "</td>" +
      "<td class='rv-n'>" + revContrib(contrib) + "</td>" +
      "<td class='rv-n rv-mut'>" + pct.toFixed(1) + "%</td>" +
      "<td class='rv-n rv-gsep rv-band'>" + revMos(a.mos) + "</td>" +
      "<td class='rv-band'>" + (cause || "<span class='rv-mut'>-</span>") + "</td>" +
      revOpinionCell(n) +
      "<td class='rv-n rv-gsep'>" + revSpark(a.hist) + "</td></tr>";
  });

  return "<table class='rv-tbl'><thead><tr>" +
    "<th class='rv-th-name'>구분</th>" +
    revTh("end",     "6월말 재고금액<small>억</small>", "rv-gsep") +
    revTh("delta",   "전월대비") +
    revTh("contrib", "증가 기여도", "rv-th-pct") +
    revTh("share",   "재고금액 비중") +
    revTh("mos",     "재고월수", "rv-gsep rv-band") +
    "<th class='rv-band rv-th-cause'>6월 증가 원인</th>" +
    "<th class='rv-band rv-th-op'>담당자 의견</th>" +
    "<th class='rv-gsep'>1~6월 추이</th></tr></thead>" +
    "<tbody>" + rows + revFooterSum(T) + "</tbody></table>";
}

// ── 월별 뷰 ───────────────────────────────────────────────────────────────────
// 셀 하나에 세 가지를 층으로 쌓는다 (컬럼을 3배로 늘리면 36컬럼이 되어 못 읽는다).
//   재고금액 (굵게) / 재고일수 (작게, 회색) / 전월대비 (▲▽ + 색)
// 전월대비는 뱃지가 아니라 화살표다 — 12개월 × 수백 행에 뱃지를 달면 알약밭이 되어
// 정작 강조해야 할 것(진단 뱃지)이 묻힌다. 뱃지는 드물게 나타나는 것에만 쓴다.
// 월별 뷰는 스캔용이다 — 소수점은 눈만 어지럽힌다. 전부 정수 + 단위 명시.
function revEok(won) {
  if (!Number.isFinite(won)) return "-";
  return Math.round(won / 1e8).toLocaleString("ko-KR") + "억";
}
function revMonCell(amt, days, prev, cls) {
  if (!Number.isFinite(amt)) return "<td class='rv-mc " + cls + "'><span class='rv-mut'>-</span></td>";
  var d = Number.isFinite(prev) ? amt - prev : null;
  var dh = "";
  if (d !== null && Math.abs(d) >= 5e7) {   // 0.5억 미만은 노이즈 → 표시 안 함
    var up = d > 0;
    dh = "<span class='rv-mc-d " + (up ? "rv-up" : "rv-down") + "'>" +
         (up ? "▲" : "▽") + revEok(Math.abs(d)) + "</span>";
  }
  return "<td class='rv-mc " + cls + "'>" +
    "<span class='rv-mc-a'>" + revEok(amt) + "</span>" +
    (Number.isFinite(days) ? "<span class='rv-mc-y'>" + Math.round(days) + "일</span>" : "") +
    dh + "</td>";
}

function revMonthTable(tree, T) {
  var byId = new Map(tree.map(function(x) { return [x.id, x]; }));

  // 재고일수는 전사(합계) 레벨에서만 의미가 있다. 품목군·품목 단위의 매출원가를
  // 나눠 쓸 수 없으므로(계획 파일이 77%만 커버) 개별 행에는 표시하지 않는다.
  var fd = T.fcstDays(T.exc);

  var head = T.months.map(function(m, i) {
    var cls = (i === 0 || i === 6 ? "rv-gsep " : "") + (i >= 6 ? "rv-band" : "");
    return revTh("m" + i, monthLabel(m) + (i === 6 ? "<small>전망</small>" : ""), cls);
  }).join("");

  var rows = "";
  tree.forEach(function(n, i) {
    if (!revVisible(n, byId)) return;
    var hasKid = !!(tree[i + 1] && tree[i + 1].parent === n.id);
    var a = n.item
      ? { hist: n.item.hist, fExc: n.item.fExc, delta: n.item.delta }
      : revAgg(n.items);
    var cls = (n.level === 1 && a.delta > 50e8) ? " rv-hot" : "";

    var cells = "";
    for (var k = 0; k < 6; k++) {
      cells += revMonCell(a.hist[k], null, k > 0 ? a.hist[k - 1] : null, (k === 0 ? "rv-gsep" : ""));
    }
    for (var j = 0; j < 6; j++) {
      var prev = j === 0 ? a.hist[5] : a.fExc[j - 1];
      cells += revMonCell(a.fExc[j], null, prev, "rv-band" + (j === 0 ? " rv-gsep" : ""));
    }
    rows += "<tr class='rv-l" + n.level + cls + "'>" + revRowHead(n, hasKid) + cells + "</tr>";
  });

  // 합계행에는 재고일수를 함께 넣는다 (여기서만 매출원가 분모가 성립)
  var tot = "<tr class='rv-total'><td class='rv-name'>총재고 (공시기준)</td>";
  T.hist.forEach(function(v, i) {
    tot += revMonCell(v, T.histDays[i], i > 0 ? T.hist[i - 1] : null, (i === 0 ? "rv-gsep" : ""));
  });
  T.exc.forEach(function(v, i) {
    var prev = i === 0 ? T.hist[5] : T.exc[i - 1];
    tot += revMonCell(v, fd[i], prev, "rv-band" + (i === 0 ? " rv-gsep" : ""));
  });
  tot += "</tr>";

  return "<table class='rv-tbl rv-tbl-mon'><thead><tr><th class='rv-th-name'>구분</th>" + head +
    "</tr></thead><tbody>" + rows + tot + "</tbody></table>";
}

// ── 합계 + 조정행 — 표를 다 더하면 헤드라인(공시기준)이 나온다 ────────────────
// 조정행도 기여도를 가져야 표를 다 더해 100%가 나온다.
// (나보타가 19억 줄어든 것도 이번 달 총증감을 만든 요인이다)
function revAdjRow(label, cur, prev, total, headDelta, note) {
  var d = (Number.isFinite(cur) && Number.isFinite(prev)) ? cur - prev : null;
  var c = (d !== null && headDelta !== 0 && Math.abs(d) >= 5e7) ? d / headDelta * 100 : null;
  var pct = Number.isFinite(cur) ? (cur / total * 100).toFixed(1) + "%" : "-";
  return "<tr class='rv-adj'><td class='rv-name'>" + label + "</td>" +
    "<td class='rv-n rv-gsep'>" + (Number.isFinite(cur) ? revMoney(cur) : "-") + "</td>" +
    "<td class='rv-n'>" + (d !== null ? revDelta(d) : "<span class='rv-mut'>-</span>") + "</td>" +
    "<td class='rv-n'>" + revContrib(c) + "</td>" +
    "<td class='rv-n rv-mut'>" + pct + "</td>" +
    "<td colspan='4' class='rv-mut rv-l-note rv-gsep'>" + note + "</td></tr>";
}
// 조정행 4개(재공품·나보타·미착품·평가충당금)가 다 있어야 표가 닫힌다.
// 하나라도 빠지면 기여도 합이 100%가 안 된다 — 실제로 재공품이 빠져 9.9억이 안 맞았다.
function revFooterSum(T) {
  var A = T.adj;
  var total = T.hist[5] || 1;
  var hd = T.hist[5] - T.hist[4];
  return revAdjRow("재공품", A.wip[5], A.wip[4], total, hd, "공정 중 재고 (별도 수불)") +
    revAdjRow("나보타 (통합관리)", A.nabota[5], A.nabota[4], total, hd,
              "품목 전개 없음 — 총액만 관리") +
    revAdjRow("미착품", A.michak[5], A.michak[4], total, hd, "공시 조정 항목") +
    revAdjRow("평가충당금", A.allowance[5], A.allowance[4], total, hd, "공시 조정 항목") +
    "<tr class='rv-total'><td class='rv-name'>총재고 (공시기준)</td>" +
      "<td class='rv-n rv-gsep'>" + revMoney(T.hist[5]) + "</td>" +
      "<td class='rv-n'>" + revDelta(hd) + "</td>" +
      "<td class='rv-n'><b>100%</b></td>" +
      "<td class='rv-n'><b>100%</b></td>" +
      "<td class='rv-n rv-gsep'>" + (T.histDays[5] ? T.histDays[5].toFixed(0) + "일" : "-") + "</td>" +
      "<td colspan='3' class='rv-mut'>결산_RAW 합계와 일치 · 기여도 합계 100%</td></tr>";
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
  var tab   = state.revTab  || "fg";
  var view  = state.revView || "sum";

  // 처음 열 때는 유형 전체 + 증가 기여도 상위 3개 품목군을 펼쳐둔다.
  // 다 접힌 채로 열면 유형 7줄만 보이고 정작 이번 달 주범(thynC)이 안 보인다.
  // 회의를 켜자마자 눈앞에 있어야 한다. (한 번만 — 사용자가 접으면 그대로 둔다)
  if (!state.revOpenInit) {
    state.revOpenInit = true;
    TYPE_ORDER.forEach(function(t) { state.revOpen.add("t|" + t); });
    (D.topGroups || []).slice(0, 3).forEach(function(g) {
      var name = g[0];
      items.some(function(it) {
        if (it.group !== name) return false;
        state.revOpen.add("t|" + it.type + "|g|" + name);
        return true;
      });
    });
  }

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
  var table = (view === "mon") ? revMonthTable(tree, T) : revSumTable(tree, T);

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
    "<div class='rv-card'>" +
      "<div class='rv-card-hd'>총재고 추이 " +
        "<span>막대 전체 높이 = 원계획 · 진한 부분 = 조정 후 남는 재고 · 위에 쌓인 층 = 우리가 줄인 만큼</span></div>" +
      "<div class='rv-chart'><canvas id='revChart' height='320'></canvas></div>" +
      "<div class='rv-legend'>" +
        "<span><i class='rv-lg' style='background:var(--muted-2)'></i>실적(결산)</span>" +
        "<span><i class='rv-lg' style='background:var(--sc-exc)'></i>조정 후 재고</span>" +
        "<span><i class='rv-lg' style='background:var(--sc-rtf)'></i>RTF 조정으로 줄인 분</span>" +
        "<span><i class='rv-lg' style='background:var(--sc-base)'></i>과잉감축으로 줄인 분</span>" +
        "<span><i class='rv-lg rv-lg-day'></i>재고일수 (우측 축)</span>" +
      "</div>" +
    "</div>" +
    scn +
    "<div class='rv-card'>" + bar +
      "<div class='rv-scroll'>" + table + "</div>" +
      "<div class='rv-note'>" +
        "<b>증가 기여도</b> = 그 행의 증가액 ÷ 이번 달 총 증가액 (누가 이번 증가를 만들었나) · " +
        "<b>재고금액 비중</b> = 그 행의 재고 ÷ 공시기준 총재고 (규모가 얼마나 되나)<br>" +
        "<b>재고월수</b> = 6월말 재고 ÷ 최근 3개월 평균 출고 " +
        "(제·상품 = <b>3평판</b>(판매금액) / 원부자재 = 생산출고. 코스트센터출고는 판매가 아니므로 제외)<br>" +
        "<b>재고일수</b> = 재고금액 ÷ <b>누적 매출원가</b> × <b>누적일수</b> (연초부터 누적 — 회사 마감 방식). " +
        "실적 구간(1~6월)은 결산 매출원가를 그대로 씁니다. " +
        "전망 구간(7~12월)은 매출원가가 마감 후에나 확정되므로 <b>판매계획 × 표준원가</b>로 추정하고, " +
        "판매계획 파일이 전사 매출원가의 77%만 담고 있어 상반기 실측 보정계수(×1.301)를 적용합니다.<br>" +
        "재고금액 = 결산 자재수불 기말 · <b>나보타(플랜트 1220)는 총액만</b> · 유형 = CN열 · " +
        "제·상품 품목군 = 기준정보 품목구분1 / 원부자재 = <b>BOM 역전개</b>(공용은 소요량 최대 품목군에 전액 귀속) · " +
        "<b>판매계획이 없는 재고는 0이 아니라 그대로 이월(flat)</b>되어 12월까지 수평선으로 남습니다." +
      "</div>" +
    "</div></div>";
}

// ── 차트 ──────────────────────────────────────────────────────────────────────
// 1~6월 실적 막대 + 7~12월 3단 막대(원계획 / RTF조정 / 과잉감축) + 재고일수 뱃지.
// 회의안건 차트(summary.js daysTagsPlugin)와 같은 문법 — 뱃지는 월당 하나뿐이라 소음이 안 된다.
var _revChart = null;

function revDrawChart() {
  var cv = document.getElementById("revChart");
  if (!cv || !window.Chart) return;
  var T = reviewTotals();
  if (!T) return;

  if (_revChart) { _revChart.destroy(); _revChart = null; }

  var CSS = function(k) {
    return getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  };
  var N = 12;
  var E = function(v) { return Number.isFinite(v) ? v / 1e8 : null; };
  var blank = function() { return new Array(N).fill(null); };

  // ── 막대는 한 달에 하나. 층으로 쌓아서 "우리가 걷어낸 만큼"이 드러나게 한다. ──
  //   전체 높이 = 원계획.  진한 층 = 최종(과잉감축 후) 재고.  그 위 두 층 = 우리가 줄인 분량.
  //   조정 전에는 위 두 층이 0이라 막대 하나만 보이고, 조정할수록 층이 자란다.
  //   나란한 막대 3개로는 (회의 시작 시 셋이 같은 값이라) 볼 게 없다.
  var actual = blank();   // 1~6월 실적
  var final_ = blank();   // 7~12월 최종(과잉감축 후)
  var cutExc = blank();   // 과잉감축으로 줄인 분량
  var cutRtf = blank();   // RTF 조정으로 줄인 분량 (증산이면 음수 → 0 처리하고 툴팁에만)
  T.hist.forEach(function(v, i) { actual[i] = E(v); });
  FCST_MONTHS.forEach(function(_, i) {
    var k = 6 + i;
    var b = T.base[i], r = T.rtf[i], e = T.exc[i];
    final_[k] = E(e);
    cutExc[k] = E(Math.max(0, r - e));   // RTF조정후 → 과잉감축후 로 줄인 만큼
    cutRtf[k] = E(Math.max(0, b - r));   // 원계획 → RTF조정후 로 줄인 만큼
  });

  // 재고일수 — 라인으로 우측 축에 올린다. 금액은 ±4%밖에 안 움직여 막대로는 안 보이지만
  // 재고일수는 140 → 130일대로 뚜렷하게 내려간다. 회의의 메시지는 여기서 읽힌다.
  var fdE  = T.fcstDays(T.exc);
  var days = blank();
  T.histDays.forEach(function(d, i) { days[i] = d; });
  fdE.forEach(function(d, i) { days[6 + i] = d; });

  var bar = function(label, data, color, stack) {
    return { type: "bar", label: label, data: data, stack: stack,
             backgroundColor: color, borderColor: color, borderWidth: 0,
             borderRadius: 3, categoryPercentage: 0.6, barPercentage: 0.9,
             order: 2, yAxisID: "y" };
  };

  // 재고일수 뱃지 — 라인 위에 붙인다. x축 라벨 자리에 그리면 월 이름과 겹친다.
  var daysBadge = {
    id: "revDaysBadge",
    afterDatasetsDraw: function(chart) {
      var meta = chart.getDatasetMeta(3);   // 재고일수 라인
      if (!meta || !meta.data) return;
      var x = chart.ctx;
      x.save();
      x.textAlign = "center";
      meta.data.forEach(function(el, i) {
        var d = days[i];
        if (!Number.isFinite(d) || !el) return;
        var t  = Math.round(d) + "일";
        x.font = "800 11px system-ui";
        var tw = x.measureText(t).width + 12, th = 18;
        var ty = el.y - th - 7;                       // 점 위로 띄운다
        if (ty < chart.chartArea.top) ty = el.y + 8;  // 위가 좁으면 아래로
        var isFcst = i >= 6;
        x.fillStyle   = CSS("--surface");
        x.strokeStyle = isFcst ? CSS("--good") : CSS("--days");
        x.lineWidth   = 1.2;
        x.beginPath();
        x.roundRect(el.x - tw / 2, ty, tw, th, 5);
        x.fill(); x.stroke();
        x.fillStyle    = isFcst ? CSS("--good") : CSS("--days");
        x.textBaseline = "middle";
        x.fillText(t, el.x, ty + th / 2 + 0.5);
      });
      x.restore();
    },
  };

  // 실적 / 전망 경계선
  var divider = {
    id: "revDivider",
    beforeDatasetsDraw: function(chart) {
      var xs = chart.scales.x, a = chart.chartArea;
      if (!xs) return;
      var px = xs.getPixelForValue(5) + (xs.getPixelForValue(6) - xs.getPixelForValue(5)) / 2;
      var x = chart.ctx;
      x.save();
      x.setLineDash([5, 4]);
      x.strokeStyle = CSS("--line");
      x.lineWidth = 1.5;
      x.beginPath(); x.moveTo(px, a.top); x.lineTo(px, a.bottom); x.stroke();
      x.setLineDash([]);
      x.fillStyle = CSS("--muted");
      x.font = "700 11px system-ui";
      x.textAlign = "center";
      x.fillText("실적", px - 34, a.top + 12);
      x.fillText("전망", px + 34, a.top + 12);
      x.restore();
    },
  };

  var maxDay = Math.max.apply(null, days.filter(Number.isFinite).concat([150]));

  _revChart = new Chart(cv.getContext("2d"), {
    data: {
      labels: T.months.map(monthLabel),
      datasets: [
        bar("실적(결산)",    actual, CSS("--muted-2"), "s"),
        bar("과잉감축 후",   final_, CSS("--sc-exc"),  "s"),
        bar("RTF 조정 감축", cutRtf, CSS("--sc-rtf"),  "s"),
        // ↑ 3개까지가 막대. 아래는 라인 (daysBadge가 index 3을 참조하므로 순서 유지)
        { type: "line", label: "재고일수", data: days, yAxisID: "y1",
          borderColor: CSS("--days"), backgroundColor: "transparent",
          borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: CSS("--surface"),
          pointBorderWidth: 2, tension: 0.25, spanGaps: true, order: 0 },
        bar("과잉감축 절감", cutExc, CSS("--sc-base"), "s"),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 28 } },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(c) {
              if (c.raw === null || c.raw === 0) return null;
              var u = c.dataset.yAxisID === "y1" ? "일" : "억";
              return c.dataset.label + ": " + Math.round(c.raw).toLocaleString() + u;
            },
          },
        },
      },
      scales: {
        x:  { stacked: true, grid: { display: false },
              ticks: { font: { size: 12, weight: "700" } } },
        y:  { stacked: true, beginAtZero: true, position: "left",
              title: { display: true, text: "재고금액 (억)", font: { size: 11, weight: "700" } },
              grid: { color: CSS("--line-2") },
              ticks: { callback: function(v) { return v.toLocaleString(); }, font: { size: 11 } } },
        y1: { position: "right", beginAtZero: false,
              min: 0, max: Math.ceil(maxDay / 20) * 20 + 20,
              title: { display: true, text: "재고일수", font: { size: 11, weight: "700" } },
              grid: { display: false },
              ticks: { callback: function(v) { return v + "일"; }, font: { size: 11 } } },
      },
    },
    plugins: [divider, daysBadge],
  });
}

// ── 바인딩 ────────────────────────────────────────────────────────────────────
function bindInventoryReview() {
  var root = document.querySelector(".rv");
  if (!root) return;

  revDrawChart();

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
