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

  var items = [];
  c.items.forEach(function(it) {
    var m6 = it.mon[5];
    if (!m6) return;
    var hist = it.mon.map(function(m) { return m ? m.end : null; });
    var end6 = m6.end;

    // 3평판 = 최근 3개월 평균 판매(금액). 코스트센터출고는 판매가 아니므로 제외.
    var s3 = 0, n3 = 0;
    for (var i = 3; i <= 5; i++) { var m = it.mon[i]; if (m) { s3 += m.sale; n3++; } }
    var avg3 = n3 ? s3 / n3 : 0;

    var f = fcstByCode.get(it.itemCode);
    // 판매계획이 없는 품목은 나갈 경로가 없다 → 0이 아니라 6월말 재고를 그대로 이월(flat)
    var fBase = f ? f.base : FCST_MONTHS.map(function() { return end6; });
    var fRtf  = f ? f.rtf  : fBase;
    var fExc  = f ? f.exc  : fBase;

    items.push({
      itemCode: it.itemCode, itemName: it.itemName,
      type: it.type, businessUnit: it.businessUnit, itemGroup: it.itemGroup || "(미분류)",
      hist: hist, end6: end6, base5: it.mon[4] ? it.mon[4].base : null,
      delta: m6.end - m6.base,
      sale6: m6.sale, cc6: m6.ccOut, buy6: m6.buyIn, prod6: m6.prodIn,
      avg3sale: avg3,
      mos3: avg3 > 0 ? end6 / avg3 : (end6 > 0 ? Infinity : null),  // 재고월수(3평판)
      hasPlan: !!f,
      fBase: fBase, fRtf: fRtf, fExc: fExc,
    });
  });

  _reviewCache = items;
  _reviewCacheEpoch = (window._renderEpoch || 0);
  return items;
}

// ── 조정행 (나보타 · 미착품 · 평가충당금) ─────────────────────────────────────
function reviewAdjustments() {
  var meta = {};
  (state.mappedData.actuals_meta || []).forEach(function(r) { meta[r.month] = r; });
  var nb = (typeof getNabotaInv === "function") ? getNabotaInv() : {};

  function series(months, pick) {
    return months.map(function(m) {
      var v = pick(m);
      return Number.isFinite(v) ? v * 1e8 : null;   // 억 → 원
    });
  }
  return {
    // 나보타: 실적은 결산_RAW 사업장 합계와 맞아야 하나 파일에 그 행이 없어 나보타_RAW를 씀.
    // (결산_RAW 315억 vs 나보타_RAW 323억 — 8억 차이는 알려진 이슈. 스펙 §9)
    nabota:   series(REVIEW_MONTHS.concat(FCST_MONTHS), function(m) { return nb[m] ? nb[m].invAmt : null; }),
    michak:   series(REVIEW_MONTHS.concat(FCST_MONTHS), function(m) { return meta[m] ? meta[m].michakInv : null; }),
    allowance:series(REVIEW_MONTHS.concat(FCST_MONTHS), function(m) { return meta[m] ? meta[m].allowanceInv : null; }),
    cogs:     series(REVIEW_MONTHS, function(m) { return meta[m] ? meta[m].monthCogs : null; }),
    totalInv: series(REVIEW_MONTHS, function(m) { return meta[m] ? meta[m].totalInv : null; }),
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
  // 계획파일이 전사 매출원가의 77%만 커버 → 상반기 실측 보정계수 적용
  return byMonth.map(function(v) { return v > 0 ? v * COGS_COVERAGE_K : null; });
}

// ── 시나리오별 총재고 시리즈 (원) — 표 합계·차트 공용 ─────────────────────────
function reviewTotals() {
  var items = buildReviewItems();
  if (!items) return null;
  var adj = reviewAdjustments();

  function sumF(key, mi) {
    var t = 0;
    for (var i = 0; i < items.length; i++) t += items[i][key][mi] || 0;
    return t;
  }
  var c = state.closing;
  var wipHist = REVIEW_MONTHS.map(function(_, mi) { return c.wip[mi] ? c.wip[mi].end : 0; });
  var wip6    = wipHist[5] || 0;

  // 실적(1~6월): 공시기준 총재고를 그대로 쓴다 (결산_RAW 합계 = 대표 보고 숫자)
  var hist = adj.totalInv.slice(0, 6);

  // 전망(7~12월): 품목 전개 + 재공품(flat) + 나보타 + 미착 − 충당금
  function fcst(key) {
    return FCST_MONTHS.map(function(_, mi) {
      var v = sumF(key, mi) + wip6;
      var k = 6 + mi;
      if (Number.isFinite(adj.nabota[k]))    v += adj.nabota[k];
      if (Number.isFinite(adj.michak[k]))    v += adj.michak[k];
      else if (Number.isFinite(adj.michak[5])) v += adj.michak[5];      // 전망 없으면 6월 고정
      if (Number.isFinite(adj.allowance[k])) v += adj.allowance[k];
      else if (Number.isFinite(adj.allowance[5])) v += adj.allowance[5];
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
    adj:   adj,
    wip6:  wip6,
    fCogs: fCogs,
  };
}
