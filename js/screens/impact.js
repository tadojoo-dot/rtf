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

// ═══════════════════════════════════════════════════════════════════════════
// 조정총괄 — 세부 조정을 품목/품목군/사업부로 총정리 (원래 → 조정후 재고·증감)
// 재고전망(월별 큰 그림)의 세부 버전. 기준월 = 전망 마지막 월(연말 착지 재고, 원가 기준)
// ═══════════════════════════════════════════════════════════════════════════
function renderImpact() {
  var hasPlan = state.mappedData.plan_monthly.length > 0;
  if (!hasPlan) {
    return "<section class=\"section-band\"><div class=\"section-header\"><h2>조정총괄</h2>" +
      "<p>데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 선택해 주세요.</p></div></section>";
  }

  var months = getRtfMonths();
  var refMi  = months.length - 1;              // 전망 마지막 월(연말 착지)
  var sc     = computeScenarioItemSets();
  var dim    = state.impactDim || "bu";         // bu | group | item
  var typeF  = _impactType || "전체";

  function keyOf(it) { return it.itemCode + "|" + (it.plantCode || ""); }
  var finalMap = new Map();
  sc.final.forEach(function(it) { finalMap.set(keyOf(it), it); });

  // 품목별 원래/조정후 기말재고금액(원가) + 조정 여부(어느 월이든 base≠final)
  var groups = new Map();
  var tot = { base: 0, adj: 0, cnt: 0, adjCnt: 0 };
  sc.base.forEach(function(bit) {
    if (bit.typeGroup !== "완제품" && bit.typeGroup !== "상품") return;
    if (typeF !== "전체" && bit.typeGroup !== typeF) return;
    var fit = finalMap.get(keyOf(bit));
    var bAmt = (bit.monthlyStatus[refMi] || {}).endingAmount;
    var fAmt = fit ? (fit.monthlyStatus[refMi] || {}).endingAmount : bAmt;
    if (!Number.isFinite(bAmt)) bAmt = 0;
    if (!Number.isFinite(fAmt)) fAmt = bAmt;

    var changed = false;
    if (fit) {
      for (var m = 0; m < months.length; m++) {
        var b0 = (bit.monthlyStatus[m] || {}).endingAmount;
        var f0 = (fit.monthlyStatus[m] || {}).endingAmount;
        if (Number.isFinite(b0) && Number.isFinite(f0) && Math.abs(b0 - f0) > 1) { changed = true; break; }
      }
    }

    var gkey = dim === "bu"    ? (bit.businessUnit || "미분류")
             : dim === "group" ? (bit.itemGroup   || "미분류")
             : keyOf(bit);
    var gname = dim === "item" ? (bit.itemName || bit.itemCode) : gkey;
    var g = groups.get(gkey);
    if (!g) { g = { name: gname, code: bit.itemCode, bu: bit.businessUnit || "", base: 0, adj: 0, cnt: 0, adjCnt: 0 }; groups.set(gkey, g); }
    g.base += bAmt; g.adj += fAmt; g.cnt++; if (changed) g.adjCnt++;
    tot.base += bAmt; tot.adj += fAmt; tot.cnt++; if (changed) tot.adjCnt++;
  });

  // 정렬: 증감(감축액) 큰 순
  var rows = Array.from(groups.values()).sort(function(a, b) {
    return (a.adj - a.base) - (b.adj - b.base);
  });
  // 품목 차원은 조정된 것만 (총괄이므로 변경분 집중), 그 외 전체
  if (dim === "item") rows = rows.filter(function(r) { return r.adjCnt > 0; });

  var dimBtns = [["bu", "사업부별"], ["group", "품목군별"], ["item", "품목별"]].map(function(d) {
    return "<button type=\"button\" class=\"imp-dim-btn" + (dim === d[0] ? " active" : "") + "\" data-dim=\"" + d[0] + "\">" + d[1] + "</button>";
  }).join("");
  var typeBtns = ["전체", "완제품", "상품"].map(function(t) {
    return "<button type=\"button\" class=\"imp-type-btn" + (typeF === t ? " active" : "") + "\" data-type=\"" + t + "\">" + t + "</button>";
  }).join("");

  function amtCell(v) { return "<td class=\"imp-num\">" + escapeHtml(formatMoney(v)) + "</td>"; }
  function deltaCell(base, adj) {
    var d = adj - base;
    if (Math.abs(d) < 0.5e8 && Math.round(d) === 0) return "<td class=\"imp-num imp-delta-zero\">-</td>";
    var cls = d < 0 ? "imp-delta-cut" : "imp-delta-up";
    return "<td class=\"imp-num " + cls + "\">" + (d < 0 ? "▼ " : "▲ +") + escapeHtml(formatMoney(Math.abs(d))) + "</td>";
  }

  var bodyRows = rows.map(function(r) {
    var nameCell = dim === "item"
      ? "<td class=\"imp-name\"><span class=\"imp-code\">" + escapeHtml(r.code) + "</span> " + escapeHtml(r.name) +
        (r.bu ? " <span class=\"imp-bu\">" + escapeHtml(r.bu) + "</span>" : "") + "</td>"
      : "<td class=\"imp-name\">" + escapeHtml(r.name) + "</td>";
    return "<tr>" + nameCell + amtCell(r.base) + amtCell(r.adj) + deltaCell(r.base, r.adj) +
      "<td class=\"imp-cnt\">" + (r.adjCnt > 0 ? "<b>" + r.adjCnt + "</b>/" + r.cnt : r.cnt) + "</td></tr>";
  }).join("");

  var totalRow = "<tr class=\"imp-total-row\">" +
    "<td class=\"imp-name\">전체 합계</td>" + amtCell(tot.base) + amtCell(tot.adj) + deltaCell(tot.base, tot.adj) +
    "<td class=\"imp-cnt\"><b>" + tot.adjCnt + "</b>/" + tot.cnt + "</td></tr>";

  var refLabel = escapeHtml(monthLabel(months[refMi])) + "말";

  return "<div class=\"imp-screen\"><div class=\"imp-inner\">" +
    "<div class=\"imp-head\">" +
      "<h2 class=\"imp-h2\">조정 총괄</h2>" +
      "<span class=\"imp-sub\">세부 조정을 차원별로 정리 — 원래 → 조정 후 재고금액 (" + refLabel + " 기준 · 원가)</span>" +
    "</div>" +
    "<div class=\"imp-controls\">" +
      "<div class=\"imp-dim-group\">" + dimBtns + "</div>" +
      "<div class=\"imp-type-group\">" + typeBtns + "</div>" +
    "</div>" +
    "<div class=\"imp-table-wrap\"><table class=\"imp-table\"><thead><tr>" +
      "<th class=\"imp-th-name\">" + (dim === "bu" ? "사업부" : dim === "group" ? "품목군" : "품목") + "</th>" +
      "<th>원래 재고</th><th>조정 후 재고</th><th>증감</th><th>조정품목</th>" +
    "</tr></thead><tbody>" + totalRow + bodyRows + "</tbody></table></div>" +
  "</div></div>";
}

// ── 바인딩 ────────────────────────────────────────────────────────────────────

function bindImpact() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;
  root.querySelectorAll("[data-dim]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (state.impactDim === btn.dataset.dim) return;
      state.impactDim = btn.dataset.dim;
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
