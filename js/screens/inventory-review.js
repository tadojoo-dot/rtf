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

// ── 조정행 (나보타 · 미착품 · 평가충당금) ─────────────────────────────────────
function reviewAdjustments() {
  var meta = {};
  (state.mappedData.actuals_meta || []).forEach(function(r) { meta[r.month] = r; });
  var nb = (typeof getNabotaInv === "function") ? getNabotaInv() : {};
  var all = REVIEW_MONTHS.concat(FCST_MONTHS);

  function series(pick) {
    return all.map(function(m) {
      var v = pick(m);
      return Number.isFinite(v) ? v * 1e8 : null;   // 억 → 원
    });
  }
  return {
    // 나보타 실적은 결산_RAW 사업장 합계(315억)와 나보타_RAW(323억)가 8억 어긋난다(스펙 §9).
    // 전망이 필요하므로 나보타_RAW를 쓴다.
    nabota:    series(function(m) { return nb[m] ? nb[m].invAmt : null; }),
    michak:    series(function(m) { return meta[m] ? meta[m].michakInv : null; }),
    allowance: series(function(m) { return meta[m] ? meta[m].allowanceInv : null; }),
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
    ccHeavy: [],                     // 코스트센터출고 > 판매×2 → 팔린 게 아니라 비용 처리
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
    if (it.isFg && it.cc6 > it.sale6 * 2 && it.cc6 > 1e8) d.ccHeavy.push(it);

    // BOM 어디에도 안 걸리는 자재 = 쓸 데가 없다. 감축이 아니라 처분 결정 대상.
    // BOM이 아예 안 실렸으면 판정하지 않는다 (전 자재가 불용으로 잡히는 허위 경보 방지).
    if (!it.isFg && bomOk && it.group === MAT_UNUSED_GROUP && it.end6 > 0) {
      d.unusedAmt += it.end6; d.unusedCnt++;
    }
  });

  d.topGroups = Array.from(d.byGroup.entries())
    .sort(function(a, b) { return b[1].delta - a[1].delta; })
    .slice(0, 8);
  d.ccHeavy.sort(function(a, b) { return b.cc6 - a.cc6; });
  d.ccAmt = d.ccHeavy.reduce(function(s, x) { return s + x.cc6; }, 0);
  return d;
}

// ── 시나리오별 총재고 시리즈 (원) — 표 합계·차트 공용 ─────────────────────────
function reviewTotals() {
  var items = buildReviewItems();
  if (!items) return null;
  var adj = reviewAdjustments();
  var c   = state.closing;

  var wip6 = c.wip[5] ? c.wip[5].end : 0;
  var hist = adj.totalInv.slice(0, 6);   // 실적은 공시기준 총재고 그대로 (대표 보고 숫자)

  function sumF(key, mi) {
    var t = 0;
    for (var i = 0; i < items.length; i++) t += items[i][key][mi] || 0;
    return t;
  }
  // 전망 = 품목 전개 + 재공품(flat) + 나보타 + 미착 − 충당금
  // 미착·충당금은 전망이 없으면 6월 값으로 고정한다.
  function fcst(key) {
    return FCST_MONTHS.map(function(_, mi) {
      var k = 6 + mi;
      var v = sumF(key, mi) + wip6;
      if (Number.isFinite(adj.nabota[k])) v += adj.nabota[k];
      var mi2 = Number.isFinite(adj.michak[k])    ? adj.michak[k]    : adj.michak[5];
      var al2 = Number.isFinite(adj.allowance[k]) ? adj.allowance[k] : adj.allowance[5];
      if (Number.isFinite(mi2)) v += mi2;
      if (Number.isFinite(al2)) v += al2;
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
    histDays: REVIEW_MONTHS.map(function(m, mi) {
      var inv = hist[mi], cg = adj.cogs[mi];
      return (Number.isFinite(inv) && cg > 0) ? inv / cg * monthDays(m) : null;
    }),
    fcstDays: function(series) {
      return FCST_MONTHS.map(function(m, mi) {
        var cg = fCogs[mi];
        return (cg > 0 && Number.isFinite(series[mi])) ? series[mi] / cg * monthDays(m) : null;
      });
    },
    adj: adj, wip6: wip6, fCogs: fCogs,
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

function buildReviewTree(items, tab) {
  var pool = items.filter(function(it) { return tab === "mat" ? !it.isFg : it.isFg; });
  var nodes = [];
  TYPE_ORDER.forEach(function(type) {
    var ti = pool.filter(function(it) { return it.type === type; });
    if (!ti.length) return;
    nodes.push({ id: "t|" + type, parent: null, level: 0, label: type, items: ti });

    var groups = {};
    ti.forEach(function(it) { (groups[it.group] = groups[it.group] || []).push(it); });
    Object.keys(groups)
      .sort(function(a, b) { return revAgg(groups[b]).end - revAgg(groups[a]).end; })
      .forEach(function(g) {
        var gid = "t|" + type + "|g|" + g;
        nodes.push({ id: gid, parent: "t|" + type, level: 1, label: g, items: groups[g] });
        groups[g].slice().sort(function(a, b) { return b.end6 - a.end6; }).forEach(function(it, i) {
          nodes.push({ id: gid + "|i|" + i, parent: gid, level: 2,
                       label: it.itemName || it.itemCode, items: [it], item: it });
        });
      });
  });
  return nodes;
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
  return "<td class='rv-name'><span class='rv-tw'>" +
    (hasKid ? "<button class='rv-tog' data-rvtog='" + escapeHtml(n.id) + "'>" + (open ? "−" : "+") + "</button>"
            : "<span class='rv-tog rv-tog-x'></span>") +
    escapeHtml(n.label) + "</span></td>";
}

// ── 요약 뷰 ───────────────────────────────────────────────────────────────────
function revSumTable(tree, T) {
  var byId  = new Map(tree.map(function(x) { return [x.id, x]; }));
  var total = T.hist[5] || 1;
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
    // 증가 기여도 — "이번 증가에 얼마나 기여했나". 감소한 행은 표시하지 않는다
    // (음수 기여도는 "덜 늘렸다"는 뜻이라 회의에서 오해를 부른다).
    var contrib = (headDelta > 0 && a.delta > 0) ? a.delta / headDelta * 100 : null;
    var cls = "";
    // BOM 어디에도 안 걸리고 출고도 없는 자재 = 불용. 감축이 아니라 처분 결정 대상.
    if (n.level === 1 && n.label === MAT_UNUSED_GROUP) cls = " rv-crit";
    else if (n.level === 1 && a.delta > 50e8)          cls = " rv-hot";
    else if (a.mos === Infinity && a.end > 10e8)       cls = " rv-crit";

    // "왜 늘었나" — 구매입고인지 생산입고인지가 답이다
    var cause = "";
    if (a.delta > 5e8) {
      var via = a.buy >= a.prod ? "구매" : "생산";
      cause += "<span class='rv-badge rv-b-warn'>" + via + "입고 " + revMoney(Math.max(a.buy, a.prod)) + "억</span>";
    }
    if (a.cc > a.sale && a.cc > 1e8) {
      cause += "<span class='rv-badge rv-b-danger'>비판매출고 " + revMoney(a.cc) + "억</span>";
    }
    // 공용 자재 — 여러 품목군에 쓰이지만 소요량 최대 품목군에 전액 귀속했다.
    // 숨기지 않고 배지로 드러내야 "왜 여기 넣었냐"에 답할 수 있다.
    if (n.item && n.item.sharedN > 1) {
      cause += "<span class='rv-badge rv-b-shared' title='" +
        escapeHtml(n.item.shared.join(" · ")) + "'>공용 " + n.item.sharedN + "</span>";
    }

    rows += "<tr class='rv-l" + n.level + cls + "'>" + revRowHead(n, hasKid) +
      "<td class='rv-n rv-gsep'><b>" + revMoney(a.end) + "</b></td>" +
      "<td class='rv-n'>" + revDelta(a.delta) + "</td>" +
      // 증가 기여도 — 막대로 보여야 크기가 한눈에 들어온다
      "<td class='rv-n'>" + (contrib === null
        ? "<span class='rv-mut'>-</span>"
        : "<span class='rv-pbar'><i class='rv-pbar-hot' style='width:" +
          Math.min(100, contrib).toFixed(0) + "%'></i></span>" +
          "<span class='rv-pct rv-pct-hot'>" + contrib.toFixed(0) + "%</span>") + "</td>" +
      "<td class='rv-n rv-mut'>" + pct.toFixed(1) + "%</td>" +
      "<td class='rv-n rv-gsep rv-band'>" + revMos(a.mos) + "</td>" +
      "<td class='rv-band'>" + (cause || "<span class='rv-mut'>-</span>") + "</td>" +
      "<td class='rv-n rv-gsep'>" + revSpark(a.hist) + "</td></tr>";
  });

  return "<table class='rv-tbl'><thead><tr>" +
    "<th class='rv-th-name'>구분</th>" +
    "<th class='rv-gsep'>6월말 재고금액<small>억</small></th>" +
    "<th>전월대비</th>" +
    "<th class='rv-th-pct'>증가 기여도</th>" +
    "<th>재고금액 비중</th>" +
    "<th class='rv-gsep rv-band'>재고월수</th>" +
    "<th class='rv-band rv-th-cause'>6월 증가 원인</th>" +
    "<th class='rv-gsep'>1~6월 추이</th></tr></thead>" +
    "<tbody>" + rows + revFooterSum(T) + "</tbody></table>";
}

// ── 월별 뷰 ───────────────────────────────────────────────────────────────────
// 셀 하나에 세 가지를 층으로 쌓는다 (컬럼을 3배로 늘리면 36컬럼이 되어 못 읽는다).
//   재고금액 (굵게) / 재고일수 (작게, 회색) / 전월대비 (▲▽ + 색)
// 전월대비는 뱃지가 아니라 화살표다 — 12개월 × 수백 행에 뱃지를 달면 알약밭이 되어
// 정작 강조해야 할 것(진단 뱃지)이 묻힌다. 뱃지는 드물게 나타나는 것에만 쓴다.
function revMonCell(amt, days, prev, cls) {
  if (!Number.isFinite(amt)) return "<td class='rv-mc " + cls + "'><span class='rv-mut'>-</span></td>";
  var d = Number.isFinite(prev) ? amt - prev : null;
  var dh = "";
  if (d !== null && Math.abs(d) >= 5e6) {
    var up = d > 0;
    dh = "<span class='rv-mc-d " + (up ? "rv-up" : "rv-down") + "'>" +
         (up ? "▲" : "▽") + revMoney(Math.abs(d)) + "</span>";
  }
  return "<td class='rv-mc " + cls + "'>" +
    "<span class='rv-mc-a'>" + revMoney(amt) + "</span>" +
    (Number.isFinite(days) ? "<span class='rv-mc-y'>" + days.toFixed(1) + "일</span>" : "") +
    dh + "</td>";
}

function revMonthTable(tree, T) {
  var byId = new Map(tree.map(function(x) { return [x.id, x]; }));

  // 재고일수는 전사(합계) 레벨에서만 의미가 있다. 품목군·품목 단위의 매출원가를
  // 나눠 쓸 수 없으므로(계획 파일이 77%만 커버) 개별 행에는 표시하지 않는다.
  var fd = T.fcstDays(T.exc);

  var head = T.months.map(function(m, i) {
    return "<th class='" + (i === 0 || i === 6 ? "rv-gsep " : "") + (i >= 6 ? "rv-band" : "") + "'>" +
      monthLabel(m) + (i === 6 ? "<small>전망</small>" : "") + "</th>";
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
function revAdjRow(label, val, note) {
  return "<tr class='rv-adj'><td class='rv-name'>" + label + "</td>" +
    "<td class='rv-n rv-gsep'>" + (Number.isFinite(val) ? revMoney(val) : "-") + "</td>" +
    "<td colspan='6' class='rv-mut rv-l-note'>" + note + "</td></tr>";
}
function revFooterSum(T) {
  var A = T.adj;
  return revAdjRow("나보타 (통합관리)", A.nabota[5], "품목 전개 없음 — 총액만 관리") +
    revAdjRow("미착품", A.michak[5], "공시 조정 항목") +
    revAdjRow("평가충당금", A.allowance[5], "공시 조정 항목") +
    "<tr class='rv-total'><td class='rv-name'>총재고 (공시기준)</td>" +
      "<td class='rv-n rv-gsep'>" + revMoney(T.hist[5]) + "</td>" +
      "<td class='rv-n'>" + revDelta(T.hist[5] - T.hist[4]) + "</td>" +
      "<td class='rv-n'>100%</td>" +
      "<td class='rv-n'>100%</td>" +
      "<td class='rv-n rv-gsep'>" + (T.histDays[5] ? T.histDays[5].toFixed(1) + "일" : "-") + "</td>" +
      "<td colspan='2' class='rv-mut'>결산_RAW 합계와 일치</td></tr>";
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
      "<div class='rv-kpis'>" +
        revKpi("총재고 · 6월말", revMoney(jun), "억",
               "전월 " + revMoney(may) + "억 · " + revDelta(jun - may) + "억", true) +
        revKpi("재고일수", junD ? junD.toFixed(1) : "-", "일",
               mayD ? "전월 " + mayD.toFixed(1) + "일 · " + revDaysDelta(junD - mayD) : "") +
        revKpi("전년 동월 대비",
               lyD ? ((junD - lyD) >= 0 ? "+" : "") + (junD - lyD).toFixed(1) : "-", "일",
               lyD ? "25년 6월 " + lyD.toFixed(1) + "일 → " + junD.toFixed(1) + "일" : "") +
        revKpi("6월 증가 기여", share ? Math.round(share) : "-", "%",
               topG ? escapeHtml(topName) + " 단일 품목군 " + revDelta(topG[1].delta) + "억" : "") +
      "</div>" +
    "</div>";

  var chips = [];
  if (topG) chips.push(revChip("hot", topName + " +" + revMoney(topG[1].delta) + "억",
                               "6월 증가의 " + Math.round(share) + "%"));
  if (D.ccAmt > 1e8) chips.push(revChip("danger", "비판매출고 " + revMoney(D.ccAmt) + "억",
                               D.ccHeavy.length + "품목 · 샘플·데모 등 비용처리"));
  chips.push(revChip("warn",   "계획없음 " + revMoney(D.noPlanAmt) + "억", D.noPlanCnt + "품목"));
  if (D.bomOk && D.unusedAmt > 1e8)
    chips.push(revChip("danger", "불용자재 " + revMoney(D.unusedAmt) + "억",
                       D.unusedCnt + "품목 · BOM 미사용 → 처분 검토"));
  chips.push(revChip("danger", "소진불가 " + revMoney(D.dormantAmt) + "억", D.dormantCnt + "품목 · 3개월 무출고"));
  chips.push(revChip("",       "재고 12개월↑ " + revMoney(D.longMosAmt) + "억", D.longMosCnt + "품목"));

  var opinion = "";
  if (topG) {
    var g = topG[1];
    var via = g.buy >= g.prod ? "구매입고" : "생산입고";
    var viaAmt = Math.max(g.buy, g.prod);
    opinion = "<div class='rv-op'><b>AI 소견</b> — 6월 총재고가 " + revMoney(may) + "억에서 " +
      revMoney(jun) + "억으로 <b>" + revMoney(jun - may) + "억</b> 늘었고, 그 <b>" +
      Math.round(share) + "%</b>가 <b>" + escapeHtml(topName) + "</b> 한 품목군입니다(+" +
      revMoney(g.delta) + "억). 이 품목군은 6월에 <b>" + via + " " + revMoney(viaAmt) +
      "억</b>이 들어왔는데 <b>판매는 " + revMoney(g.sale) + "억</b>입니다" +
      (g.cc > g.sale
        ? ". 그리고 <b>코스트센터출고가 " + revMoney(g.cc) +
          "억</b>입니다 — 팔린 것이 아니라 샘플·데모 등으로 <b>비용 처리된 물량</b>입니다"
        : "") + ".</div>";
  }

  // ── 3단 시나리오 스트립 — 회의의 성과가 실시간으로 움직이는 자리 ──
  // 공장 담당자가 판정을 누를 때마다 '과잉감축 후' 숫자가 내려간다. 그 하강폭이 오늘의 성과다.
  var fdB = T.fcstDays(T.base), fdR = T.fcstDays(T.rtf), fdE = T.fcstDays(T.exc);
  var L = 5;   // 12월 = 전망 마지막 달
  var scn =
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

  var tree  = buildReviewTree(items, tab);
  var table = (view === "mon") ? revMonthTable(tree, T) : revSumTable(tree, T);

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
    "</div>";

  return "<div class='rv'>" + hero +
    "<div class='rv-diag'><span class='rv-diag-lbl'>AI 진단</span>" + chips.join("") + "</div>" +
    opinion +
    "<div class='rv-card'>" +
      "<div class='rv-card-hd'>총재고 추이 <span>1~6월 결산 실적 · 7~12월 3단 전망</span></div>" +
      "<div class='rv-chart'><canvas id='revChart' height='300'></canvas></div>" +
      "<div class='rv-legend'>" +
        "<span><i class='rv-lg' style='background:var(--muted-2)'></i>실적(결산)</span>" +
        "<span><i class='rv-lg' style='background:var(--sc-base)'></i>원계획</span>" +
        "<span><i class='rv-lg' style='background:var(--sc-rtf)'></i>RTF 조정후</span>" +
        "<span><i class='rv-lg' style='background:var(--sc-exc)'></i>과잉감축 후</span>" +
        "<span><i class='rv-lg rv-lg-day'></i>재고일수</span>" +
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
        "<b>재고일수</b> — 실적 구간(1~6월)은 <b>결산 매출원가</b>가 분모입니다. " +
        "전망 구간(7~12월)은 매출원가가 마감 후에나 확정되므로 <b>판매계획 × 표준원가</b>로 추정하고, " +
        "판매계획 파일이 전사 매출원가의 77%만 담고 있어 상반기 실측 보정계수(×1.301)를 적용합니다. " +
        "<b>두 구간의 분모가 다릅니다.</b><br>" +
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
  var pad = function(arr, off) {
    var a = new Array(N).fill(null);
    arr.forEach(function(v, i) { a[off + i] = Number.isFinite(v) ? v / 1e8 : null; });
    return a;
  };
  var actual = pad(T.hist, 0);
  var base   = pad(T.base, 6);
  var rtf    = pad(T.rtf,  6);
  var exc    = pad(T.exc,  6);

  // 재고일수 뱃지 — 실적은 마감 매출원가, 전망은 최종(과잉감축) 시나리오
  var fdE  = T.fcstDays(T.exc);
  var days = new Array(N).fill(null);
  T.histDays.forEach(function(d, i) { days[i] = d; });
  fdE.forEach(function(d, i) { days[6 + i] = d; });

  var bar = function(label, data, color) {
    return { label: label, data: data, backgroundColor: color, borderColor: color,
             borderWidth: 0, borderRadius: 4, categoryPercentage: 0.72, barPercentage: 0.92 };
  };

  var daysPlugin = {
    id: "revDays",
    afterDatasetsDraw: function(chart) {
      var x = chart.ctx;
      var area = chart.chartArea;
      x.save();
      x.textAlign = "center";
      x.font = "700 11px system-ui";
      chart.getDatasetMeta(0).data.forEach(function(_, i) {
        var d = days[i];
        if (!Number.isFinite(d)) return;
        // 그 달의 막대 중 가장 왼쪽 x를 기준으로 가운데를 잡는다
        var xs = [];
        chart.data.datasets.forEach(function(_, di) {
          var el = chart.getDatasetMeta(di).data[i];
          if (el && Number.isFinite(el.x) && chart.data.datasets[di].data[i] !== null) xs.push(el.x);
        });
        if (!xs.length) return;
        var cx = xs.reduce(function(a, b) { return a + b; }, 0) / xs.length;
        var t  = d.toFixed(0) + "일";
        var tw = x.measureText(t).width + 12, th = 18;
        var ty = area.bottom + 6;
        var isFcst = i >= 6;
        x.fillStyle   = isFcst ? "rgba(22,163,74,.10)" : "rgba(15,118,110,.10)";
        x.strokeStyle = isFcst ? CSS("--good") : CSS("--days");
        x.lineWidth = 1;
        x.beginPath();
        x.roundRect(cx - tw / 2, ty, tw, th, 5);
        x.fill(); x.stroke();
        x.fillStyle = isFcst ? CSS("--good") : CSS("--days");
        x.textBaseline = "middle";
        x.fillText(t, cx, ty + th / 2);
      });
      x.restore();
    },
  };

  _revChart = new Chart(cv.getContext("2d"), {
    type: "bar",
    data: {
      labels: T.months.map(monthLabel),
      datasets: [
        bar("실적", actual, CSS("--muted-2")),
        bar("원계획", base, CSS("--sc-base")),
        bar("RTF 조정후", rtf, CSS("--sc-rtf")),
        bar("과잉감축 후", exc, CSS("--sc-exc")),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { bottom: 26, top: 8 } },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(c) {
              if (c.raw === null) return null;
              return c.dataset.label + ": " + Math.round(c.raw).toLocaleString() + "억";
            },
            afterBody: function(items) {
              var d = days[items[0].dataIndex];
              return Number.isFinite(d) ? "재고일수 " + d.toFixed(1) + "일" : "";
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 12, weight: "700" } } },
        y: { beginAtZero: true,
             grid: { color: CSS("--line-2") },
             ticks: { callback: function(v) { return v.toLocaleString(); }, font: { size: 11 } } },
      },
    },
    plugins: [daysPlugin],
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
  });
}
