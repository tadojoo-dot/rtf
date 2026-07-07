// ── 조정영향 화면 ─────────────────────────────────────────────────────────────

var _impactChart1Inst = null;
var _impactChart2Inst = null;
var _impactType       = "전체";

// ── 실적 월별 값 ──────────────────────────────────────────────────────────────

function _getActualsForMonth(month, filterType, metric) {
  var rows = (state.mappedData.actuals_monthly || []).filter(function(r) {
    if (r.month !== month || r.plant !== "전체") return false;
    if (filterType === "전체") return true;
    return r.type === filterType;
  });
  if (!rows.length) return null;
  if (metric === "invAmt")    return rows.reduce(function(s, r) { return s + (r.invAmt    || 0); }, 0);
  if (metric === "salesAmt")  return rows.reduce(function(s, r) { return s + (r.salesAmt  || 0); }, 0);
  if (metric === "supplyAmt") return rows.reduce(function(s, r) { return s + (r.supplyAmt || 0); }, 0);
  if (metric === "invDays") {
    var vals = rows.filter(function(r) { return Number.isFinite(r.invDays); });
    return vals.length ? vals.reduce(function(s, r) { return s + r.invDays; }, 0) / vals.length : null;
  }
  return null;
}

// ── 전망 시리즈 (rtfMonths 기준, 억원 또는 일) ────────────────────────────────

function _getForecastSeries(filterType, metric, mode, rtfItemsArr, matAdjBomMap) {
  var months = getRtfMonths();
  return months.map(function(month, mi) {
    var totalAmt = 0, totalEndQty = 0, totalSalesQty = 0, hasAmt = false;

    rtfItemsArr.forEach(function(item) {
      if (filterType !== "전체" && item.typeGroup !== filterType) return;
      var ms = item.monthlyStatus[mi];
      if (!ms) return;

      var adjData = null;
      if      (mode === "rtf")    adjData = computeAdjMonthly(item, matAdjBomMap)[mi];
      else if (mode === "excess") adjData = computeExcessMonthly(item, matAdjBomMap)[mi];

      if (metric === "invAmt") {
        var endAmt = adjData ? adjData.endingAmount : ms.endingAmount;
        if (Number.isFinite(endAmt)) { totalAmt += endAmt; hasAmt = true; }
      } else if (metric === "invDays") {
        var endQty   = adjData ? adjData.endingQty : ms.endingQty;
        var salesQty = ms.salesQty || 0;
        if (Number.isFinite(endQty)) totalEndQty  += endQty;
        if (salesQty > 0)            totalSalesQty += salesQty / monthDays(month);
      } else if (metric === "salesAmt") {
        if (item.hasCost && Number.isFinite(ms.salesQty))
          { totalAmt += ms.salesQty * item.standardCost; hasAmt = true; }
      } else if (metric === "supplyAmt") {
        if (item.hasCost) {
          var supQty = adjData
            ? (adjData.finalSupply !== undefined ? adjData.finalSupply : adjData.adjSupply)
            : (ms.supplyQty || 0);
          if (Number.isFinite(supQty)) { totalAmt += supQty * item.standardCost; hasAmt = true; }
        }
      }
    });

    if (metric === "invDays") return totalSalesQty > 0 ? totalEndQty / totalSalesQty : null;
    return hasAmt ? totalAmt / 100000000 : 0;
  });
}

// ── 차트 공통 기반 데이터 ─────────────────────────────────────────────────────

function _buildChartBase() {
  var allMonths = [];
  for (var m = 1; m <= 12; m++) allMonths.push("2026-" + (m < 10 ? "0" + m : "" + m));

  var rtfMonths    = getRtfMonths();
  var rtfItemsArr  = computeRtfItems(undefined, true);
  var matAdjBomMap = (Object.keys(state.matSimAdj || {}).length > 0 ||
                      (typeof hasFgProdAdj === "function" && hasFgProdAdj()))
    ? buildBomMaxProducibleMap(state.matSimAdj, state.fgProdAdj) : null;

  var lastActualIdx = -1;
  allMonths.forEach(function(m, i) {
    var hasData = (state.mappedData.actuals_monthly || []).some(function(r) {
      return r.month === m && r.plant === "전체";
    });
    if (hasData) lastActualIdx = i;
  });

  return { allMonths: allMonths, rtfMonths: rtfMonths, rtfItemsArr: rtfItemsArr, matAdjBomMap: matAdjBomMap, lastActualIdx: lastActualIdx };
}

// 전망 시리즈를 allMonths 길이 배열로 변환 (실적 구간 = null, 연결점 포함)
function _toFullArr(series, rtfMonths, allMonths, joinIdx, joinVal) {
  var arr = allMonths.map(function() { return null; });
  if (joinIdx >= 0 && joinVal !== null && joinVal !== undefined) arr[joinIdx] = joinVal;
  rtfMonths.forEach(function(m, i) {
    var idx = allMonths.indexOf(m);
    if (idx >= 0) arr[idx] = series[i];
  });
  return arr;
}

// ── 렌더 ──────────────────────────────────────────────────────────────────────

function renderImpact() {
  var hasActuals = (state.mappedData.actuals_monthly || []).length > 0;
  var hasPlan    = state.mappedData.plan_monthly.length > 0;

  if (!hasPlan && !hasActuals) {
    return "<section class=\"section-band\"><div class=\"section-header\"><h2>조정영향</h2>" +
      "<p>데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 선택해 주세요.</p></div></section>";
  }

  var hasMatAdj    = Object.keys(state.matSimAdj  || {}).length > 0;
  var hasExcessAdj = Object.keys(state.excessAdj  || {}).length > 0;

  var typeBtns = ["전체", "완제품", "상품"].map(function(t) {
    return "<button type=\"button\" class=\"imp-filter-btn" + (t === _impactType ? " active" : "") +
           "\" data-type=\"" + t + "\">" + t + "</button>";
  }).join("");

  function leg(cls, label) {
    return "<span class=\"imp-leg " + cls + "\">" + escapeHtml(label) + "</span>";
  }

  var legend1 = [
    leg("imp-leg-actual", "실적 재고금액"), leg("imp-leg-base", "원계획 재고금액"),
    leg("imp-leg-days-actual", "실적 재고일수"), leg("imp-leg-days-base", "원계획 재고일수"),
    hasMatAdj    ? leg("imp-leg-rtf",    "RTF조정후 재고일수") : "",
    hasExcessAdj ? leg("imp-leg-excess", "감축후 재고일수")    : "",
  ].filter(Boolean).join("");

  var legend2 = [
    leg("imp-leg-sales", "판매금액 (짙=실적, 연=전망)"),
    leg("imp-leg-supply", "공급금액 (짙=실적, 연=전망)"),
    hasMatAdj ? leg("imp-leg-rtf", "RTF조정후 공급") : "",
  ].filter(Boolean).join("");

  return "<div class=\"imp-screen\"><div class=\"imp-inner\">" +
    "<div class=\"imp-controls\"><div class=\"imp-filter-group\">" + typeBtns + "</div></div>" +
    "<div class=\"imp-chart-card\">" +
      "<div class=\"imp-chart-header\"><span class=\"imp-chart-title\">재고금액 · 재고일수</span>" +
      "<span class=\"imp-chart-note\">막대=재고금액(좌축) · 선=재고일수(우축)</span></div>" +
      "<div class=\"imp-chart-legend\">" + legend1 + "</div>" +
      "<div class=\"imp-chart-wrap\"><canvas id=\"impChart1\"></canvas></div>" +
    "</div>" +
    "<div class=\"imp-chart-card\">" +
      "<div class=\"imp-chart-header\"><span class=\"imp-chart-title\">판매금액 · 공급금액</span>" +
      "<span class=\"imp-chart-note\">막대=금액(억) · 실적=짙은색 · 전망=연한색</span></div>" +
      "<div class=\"imp-chart-legend\">" + legend2 + "</div>" +
      "<div class=\"imp-chart-wrap\"><canvas id=\"impChart2\"></canvas></div>" +
    "</div>" +
  "</div></div>";
}

// ── 바인딩 ────────────────────────────────────────────────────────────────────

function bindImpact() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;
  root.querySelectorAll("[data-type]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (_impactType === btn.dataset.type) return;
      _impactType = btn.dataset.type;
      render("impact");
    });
  });
  var base = _buildChartBase();
  _initChart1(base);
  _initChart2(base);
}

// ── Chart ①: 재고금액(막대) + 재고일수(선, 이중Y축) ──────────────────────────

function _initChart1(base) {
  var canvas = document.querySelector("#impChart1");
  if (!canvas || !window.Chart) return;
  if (_impactChart1Inst) { _impactChart1Inst.destroy(); _impactChart1Inst = null; }

  var allMonths = base.allMonths, rtfMonths = base.rtfMonths;
  var rtfItemsArr = base.rtfItemsArr, matAdjBomMap = base.matAdjBomMap;
  var lastActualIdx = base.lastActualIdx;

  // 실적
  var actInvAmt  = allMonths.map(function(m) { return rtfMonths.includes(m) ? null : _getActualsForMonth(m, _impactType, "invAmt");  });
  var actInvDays = allMonths.map(function(m) { return rtfMonths.includes(m) ? null : _getActualsForMonth(m, _impactType, "invDays"); });

  // 원계획
  var baseAmtS  = _getForecastSeries(_impactType, "invAmt",  "base", rtfItemsArr, null);
  var baseDaysS = _getForecastSeries(_impactType, "invDays", "base", rtfItemsArr, null);
  var baseAmtD  = _toFullArr(baseAmtS,  rtfMonths, allMonths, lastActualIdx, actInvAmt[lastActualIdx]);
  var baseDaysD = _toFullArr(baseDaysS, rtfMonths, allMonths, lastActualIdx, actInvDays[lastActualIdx]);

  var datasets = [
    { type:"bar",  label:"실적 재고금액",   yAxisID:"y",  data:actInvAmt,  backgroundColor:"rgba(37,99,235,0.82)",  borderColor:"transparent", borderRadius:3 },
    { type:"bar",  label:"원계획 재고금액", yAxisID:"y",  data:baseAmtD,   backgroundColor:"rgba(156,163,175,0.6)", borderColor:"transparent", borderRadius:3 },
    { type:"line", label:"실적 재고일수",   yAxisID:"y2", data:actInvDays,  borderColor:"#1d4ed8", backgroundColor:"transparent", borderWidth:2.5, pointRadius:4, tension:0.3, spanGaps:false },
    { type:"line", label:"원계획 재고일수", yAxisID:"y2", data:baseDaysD,   borderColor:"#9ca3af", backgroundColor:"transparent", borderDash:[6,3], borderWidth:2, pointRadius:3, tension:0.3, spanGaps:false },
  ];

  if (Object.keys(state.matSimAdj || {}).length > 0) {
    var rtfDaysS = _getForecastSeries(_impactType, "invDays", "rtf", rtfItemsArr, matAdjBomMap);
    datasets.push({ type:"line", label:"RTF조정후 재고일수", yAxisID:"y2",
      data: _toFullArr(rtfDaysS, rtfMonths, allMonths, lastActualIdx, actInvDays[lastActualIdx]),
      borderColor:"#f97316", backgroundColor:"transparent", borderDash:[4,4], borderWidth:2, pointRadius:3, tension:0.3, spanGaps:false });
  }
  if (Object.keys(state.excessAdj || {}).length > 0) {
    var excessDaysS = _getForecastSeries(_impactType, "invDays", "excess", rtfItemsArr, matAdjBomMap);
    datasets.push({ type:"line", label:"감축후 재고일수", yAxisID:"y2",
      data: _toFullArr(excessDaysS, rtfMonths, allMonths, lastActualIdx, actInvDays[lastActualIdx]),
      borderColor:"#16a34a", backgroundColor:"transparent", borderDash:[2,3], borderWidth:2, pointRadius:3, tension:0.3, spanGaps:false });
  }

  _impactChart1Inst = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels: allMonths.map(monthLabel), datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              if (ctx.raw === null) return null;
              return ctx.dataset.yAxisID === "y2"
                ? ctx.dataset.label + ": " + Math.round(ctx.raw) + "일"
                : ctx.dataset.label + ": " + Math.round(ctx.raw) + "억";
            },
          },
        },
      },
      scales: {
        x: { grid: { color: "#f3f4f6" } },
        y: {
          type:"linear", position:"left",
          title: { display:true, text:"재고금액 (억)", color:"#374151", font:{size:11} },
          grid: { color:"#f3f4f6" },
          ticks: { callback: function(v) { return Math.round(v) + "억"; } },
        },
        y2: {
          type:"linear", position:"right",
          title: { display:true, text:"재고일수 (일)", color:"#9ca3af", font:{size:11} },
          grid: { drawOnChartArea: false },
          ticks: { color:"#9ca3af", callback: function(v) { return Math.round(v) + "일"; } },
        },
      },
    },
  });
}

// ── Chart ②: 판매/공급(막대, per-point color) + RTF공급(선) ──────────────────

function _initChart2(base) {
  var canvas = document.querySelector("#impChart2");
  if (!canvas || !window.Chart) return;
  if (_impactChart2Inst) { _impactChart2Inst.destroy(); _impactChart2Inst = null; }

  var allMonths = base.allMonths, rtfMonths = base.rtfMonths;
  var rtfItemsArr = base.rtfItemsArr, matAdjBomMap = base.matAdjBomMap;
  var lastActualIdx = base.lastActualIdx;

  var salesFcst  = _getForecastSeries(_impactType, "salesAmt",  "base", rtfItemsArr, null);
  var supplyFcst = _getForecastSeries(_impactType, "supplyAmt", "base", rtfItemsArr, null);

  var salesData  = allMonths.map(function(m, i) {
    return rtfMonths.includes(m) ? salesFcst[rtfMonths.indexOf(m)]  : _getActualsForMonth(m, _impactType, "salesAmt");
  });
  var supplyData = allMonths.map(function(m, i) {
    return rtfMonths.includes(m) ? supplyFcst[rtfMonths.indexOf(m)] : _getActualsForMonth(m, _impactType, "supplyAmt");
  });

  var salesBg  = allMonths.map(function(m) { return rtfMonths.includes(m) ? "rgba(37,99,235,0.32)"  : "rgba(37,99,235,0.82)";  });
  var supplyBg = allMonths.map(function(m) { return rtfMonths.includes(m) ? "rgba(22,163,74,0.32)"  : "rgba(22,163,74,0.82)";  });

  var datasets = [
    { type:"bar", label:"판매금액", data:salesData,  backgroundColor:salesBg,  borderColor:"transparent", borderRadius:3 },
    { type:"bar", label:"공급금액", data:supplyData, backgroundColor:supplyBg, borderColor:"transparent", borderRadius:3 },
  ];

  if (Object.keys(state.matSimAdj || {}).length > 0) {
    var rtfSupS = _getForecastSeries(_impactType, "supplyAmt", "rtf", rtfItemsArr, matAdjBomMap);
    var actSup  = allMonths.map(function(m) { return rtfMonths.includes(m) ? null : _getActualsForMonth(m, _impactType, "supplyAmt"); });
    datasets.push({ type:"line", label:"RTF조정후 공급",
      data: _toFullArr(rtfSupS, rtfMonths, allMonths, lastActualIdx, actSup[lastActualIdx]),
      borderColor:"#f97316", backgroundColor:"transparent", borderDash:[4,4], borderWidth:2, pointRadius:3, tension:0.3, spanGaps:false });
  }

  _impactChart2Inst = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels: allMonths.map(monthLabel), datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return ctx.raw !== null ? ctx.dataset.label + ": " + Math.round(ctx.raw) + "억" : null;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: "#f3f4f6" } },
        y: {
          title: { display:true, text:"금액 (억)", color:"#374151", font:{size:11} },
          grid: { color:"#f3f4f6" },
          ticks: { callback: function(v) { return Math.round(v) + "억"; } },
        },
      },
    },
  });
}
