// ── 조정영향 화면 ─────────────────────────────────────────────────────────────

var _impactChartInst = null;
var _impactMetric    = "invAmt";   // "invAmt" | "invDays"
var _impactType      = "전체";     // "전체" | "완제품" | "상품"

// ── 차트 데이터 계산 ──────────────────────────────────────────────────────────

function _getActualsForMonth(month, filterType, metric) {
  var rows = (state.mappedData.actuals_monthly || []).filter(function(r) {
    if (r.month !== month || r.plant !== "전체") return false;
    if (filterType === "전체") return r.type === "완제품" || r.type === "상품";
    return r.type === filterType;
  });
  if (!rows.length) return null;
  if (metric === "invAmt")    return rows.reduce(function(s, r) { return s + (r.invAmt    || 0); }, 0);
  if (metric === "salesAmt")  return rows.reduce(function(s, r) { return s + (r.salesAmt  || 0); }, 0);
  if (metric === "supplyAmt") return rows.reduce(function(s, r) { return s + (r.supplyAmt || 0); }, 0);
  if (metric === "invDays") {
    var vals = rows.filter(function(r) { return r.invDays !== null && Number.isFinite(r.invDays); });
    return vals.length ? vals.reduce(function(s, r) { return s + r.invDays; }, 0) / vals.length : null;
  }
  return null;
}

function _getForecastSeries(filterType, metric, mode, rtfItemsArr, matAdjBomMap) {
  var months = getRtfMonths();
  return months.map(function(month, mi) {
    var totalEndQty = 0, totalSalesQty = 0, totalAmt = 0;
    var hasAmt = false;

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
        var endQty  = adjData ? adjData.endingQty  : ms.endingQty;
        var salesQty = ms.salesQty || 0;
        if (Number.isFinite(endQty)) totalEndQty += endQty;
        if (salesQty > 0) totalSalesQty += salesQty / monthDays(month);
      } else if (metric === "salesAmt") {
        if (item.hasCost && item.standardCost && Number.isFinite(ms.salesQty)) {
          totalAmt += ms.salesQty * item.standardCost; hasAmt = true;
        }
      } else if (metric === "supplyAmt") {
        if (item.hasCost && item.standardCost) {
          var supQty = adjData
            ? (adjData.finalSupply !== undefined ? adjData.finalSupply : adjData.adjSupply)
            : (ms.supplyQty || 0);
          if (Number.isFinite(supQty)) { totalAmt += supQty * item.standardCost; hasAmt = true; }
        }
      }
    });

    if (metric === "invDays") return totalSalesQty > 0 ? totalEndQty / totalSalesQty : null;
    return hasAmt ? totalAmt / 100000000 : 0; // 원 → 억원
  });
}

// ── 렌더 ──────────────────────────────────────────────────────────────────────

function renderImpact() {
  var hasActuals   = (state.mappedData.actuals_monthly || []).length > 0;
  var hasPlan      = state.mappedData.plan_monthly.length > 0;

  if (!hasPlan && !hasActuals) {
    return "<section class=\"section-band\"><div class=\"section-header\"><h2>조정영향</h2>" +
      "<p>데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 선택해 주세요.</p></div></section>";
  }

  var hasMatAdj   = Object.keys(state.matSimAdj  || {}).length > 0;
  var hasExcessAdj = Object.keys(state.excessAdj || {}).length > 0;

  var metricBtns = [
    { id:"invAmt",    label:"재고금액"  },
    { id:"invDays",   label:"재고일수"  },
    { id:"salesAmt",  label:"판매금액"  },
    { id:"supplyAmt", label:"공급금액"  },
  ];
  var typeBtns = [
    { id:"전체",   label:"전체(완제품+상품)" },
    { id:"완제품", label:"완제품"            },
    { id:"상품",   label:"상품"              },
  ];

  function mkBtns(arr, active, attr) {
    return arr.map(function(b) {
      return "<button type=\"button\" class=\"imp-filter-btn" + (b.id === active ? " active" : "") + "\"" +
             " data-" + attr + "=\"" + escapeHtml(b.id) + "\">" + escapeHtml(b.label) + "</button>";
    }).join("");
  }

  var legendItems = [
    "<span class=\"imp-leg imp-leg-actual\">실적</span>",
    "<span class=\"imp-leg imp-leg-base\">원계획</span>",
    "<span class=\"imp-leg imp-leg-rtf" + (hasMatAdj ? "" : " imp-leg-disabled") + "\">RTF 조정후" + (hasMatAdj ? "" : " (조정없음)") + "</span>",
    "<span class=\"imp-leg imp-leg-excess" + (hasExcessAdj ? "" : " imp-leg-disabled") + "\">감축 후" + (hasExcessAdj ? "" : " (조정없음)") + "</span>",
  ].join("");

  return "<div class=\"imp-screen\"><div class=\"imp-inner\">" +
    "<div class=\"imp-controls\">" +
      "<div class=\"imp-filter-group\">" + mkBtns(metricBtns, _impactMetric, "metric") + "</div>" +
      "<div class=\"imp-filter-group\">" + mkBtns(typeBtns,   _impactType,   "type")   + "</div>" +
    "</div>" +
    "<div class=\"imp-chart-card\">" +
      "<div class=\"imp-chart-legend\">" + legendItems + "</div>" +
      "<div class=\"imp-chart-wrap\"><canvas id=\"impactChart\"></canvas></div>" +
      "<div class=\"imp-chart-note\">실선: 실적 | 파선: 전망 · 수직선 좌측 = 실적, 우측 = 전망</div>" +
    "</div>" +
  "</div></div>";
}

// ── 이벤트 바인딩 + 차트 초기화 ───────────────────────────────────────────────

function bindImpact() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;

  root.querySelectorAll("[data-metric]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (_impactMetric === btn.dataset.metric) return;
      _impactMetric = btn.dataset.metric;
      render("impact");
    });
  });

  root.querySelectorAll("[data-type]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (_impactType === btn.dataset.type) return;
      _impactType = btn.dataset.type;
      render("impact");
    });
  });

  _initImpactChart();
}

function _initImpactChart() {
  var canvas = document.querySelector("#impactChart");
  if (!canvas || !window.Chart) return;

  if (_impactChartInst) { _impactChartInst.destroy(); _impactChartInst = null; }

  // X축: 2026-01 ~ 2026-12
  var allMonths = [];
  for (var m = 1; m <= 12; m++) allMonths.push("2026-" + (m < 10 ? "0" + m : "" + m));
  var rtfMonths    = getRtfMonths(); // 6~12월
  var rtfItemsArr  = computeRtfItems();
  var matAdjBomMap = Object.keys(state.matSimAdj || {}).length > 0
    ? buildBomMaxProducibleMap(state.matSimAdj) : null;

  // 실적 데이터 (actuals에 값 있는 월만)
  var actualsRaw = allMonths.map(function(month) {
    return _getActualsForMonth(month, _impactType, _impactMetric);
  });
  var lastActualIdx = -1;
  actualsRaw.forEach(function(v, i) { if (v !== null) lastActualIdx = i; });

  // 전망 시리즈 (rtfMonths 기준)
  var baseSeries   = _getForecastSeries(_impactType, _impactMetric, "base",   rtfItemsArr, null);
  var rtfSeries    = Object.keys(state.matSimAdj || {}).length > 0
    ? _getForecastSeries(_impactType, _impactMetric, "rtf",    rtfItemsArr, matAdjBomMap) : null;
  var excessSeries = Object.keys(state.excessAdj || {}).length > 0
    ? _getForecastSeries(_impactType, _impactMetric, "excess", rtfItemsArr, matAdjBomMap) : null;

  // 전체 월 기준 배열로 변환 (실적 월 = null, 전망 월 = 값)
  function toFullArray(series, rtfMonths, allMonths, joinIdx) {
    var arr = allMonths.map(function() { return null; });
    if (joinIdx >= 0) arr[joinIdx] = actualsRaw[joinIdx]; // 연결점
    rtfMonths.forEach(function(m, i) {
      var idx = allMonths.indexOf(m);
      if (idx >= 0) arr[idx] = series[i];
    });
    return arr;
  }

  var joinIdx      = lastActualIdx >= 0 ? lastActualIdx : -1;
  var baseData     = toFullArray(baseSeries,   rtfMonths, allMonths, joinIdx);
  var rtfData      = rtfSeries    ? toFullArray(rtfSeries,    rtfMonths, allMonths, joinIdx) : null;
  var excessData   = excessSeries ? toFullArray(excessSeries, rtfMonths, allMonths, joinIdx) : null;

  // 실적 배열 (전망 월 = null)
  var actualsData = allMonths.map(function(m, i) {
    return rtfMonths.includes(m) ? null : actualsRaw[i];
  });
  if (joinIdx >= 0) actualsData[joinIdx] = actualsRaw[joinIdx]; // 연결점

  var yLabel = { invAmt:"재고금액 (억원)", invDays:"재고일수 (일)", salesAmt:"판매금액 (억원)", supplyAmt:"공급금액 (억원)" }[_impactMetric] || "";

  var datasets = [
    {
      label: "실적",
      data: actualsData,
      borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,0.07)",
      borderWidth: 2.5, pointRadius: 4, tension: 0.3,
      fill: true, spanGaps: false,
    },
    {
      label: "원계획",
      data: baseData,
      borderColor: "#9ca3af", borderDash: [6, 3],
      borderWidth: 2, pointRadius: 3, tension: 0.3,
      fill: false, spanGaps: false,
    },
  ];
  if (rtfData) datasets.push({
    label: "RTF 조정후",
    data: rtfData,
    borderColor: "#f97316", borderDash: [4, 4],
    borderWidth: 2, pointRadius: 3, tension: 0.3,
    fill: false, spanGaps: false,
  });
  if (excessData) datasets.push({
    label: "감축 후",
    data: excessData,
    borderColor: "#16a34a", borderDash: [2, 3],
    borderWidth: 2, pointRadius: 3, tension: 0.3,
    fill: false, spanGaps: false,
  });

  var splitX   = lastActualIdx >= 0 ? allMonths[lastActualIdx] : null;

  _impactChartInst = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: allMonths.map(monthLabel), datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              var v = ctx.raw;
              if (v === null) return null;
              if (_impactMetric === "invDays") return ctx.dataset.label + ": " + Math.round(v) + "일";
              return ctx.dataset.label + ": " + v.toFixed(1) + "억";
            },
          },
        },
        annotation: splitX ? {
          annotations: {
            splitLine: {
              type: "line", xMin: monthLabel(splitX), xMax: monthLabel(splitX),
              borderColor: "#d1d5db", borderWidth: 1, borderDash: [4, 2],
              label: { display: true, content: "실적 | 전망", position: "start", color: "#9ca3af", font: { size: 10 } },
            },
          },
        } : {},
      },
      scales: {
        x: { grid: { color: "#f3f4f6" } },
        y: {
          title: { display: true, text: yLabel, color: "#6b7280", font: { size: 11 } },
          grid: { color: "#f3f4f6" },
          ticks: {
            callback: function(v) {
              return _impactMetric === "invDays" ? Math.round(v) + "일" : v.toFixed(1) + "억";
            },
          },
        },
      },
    },
  });
}
