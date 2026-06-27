// ── 종합현황 차트 ─────────────────────────────────────────────────────────────

var _summaryChartInst = null;
var _summaryScenario  = "기존"; // "기존" | "RTF조정" | "과잉조정"

var FONT = "'Pretendard Variable', Pretendard, 'Apple SD Gothic Neo', sans-serif";

function _drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

function bindSummary() {
  if (!window.Chart) return;
  var canvas = document.querySelector("#sumInvChart");
  if (!canvas) return;
  if (_summaryChartInst) { _summaryChartInst.destroy(); _summaryChartInst = null; }

  var allMonths = [];
  for (var m = 1; m <= 12; m++) allMonths.push("2026-" + (m < 10 ? "0" + m : "" + m));
  var rtfMonths   = getRtfMonths();
  var rtfItemsArr = computeRtfItems(undefined, true);

  var hasRtfAdj    = Object.keys(state.matSimAdj  || {}).length > 0;
  var hasExcessAdj = Object.keys(state.excessAdj  || {}).length > 0;
  var matAdjBomMap = hasRtfAdj ? buildBomMaxProducibleMap(state.matSimAdj) : null;

  // ── 실적 값 조회 ──────────────────────────────────────────────────────────
  function getActuals(month, metric) {
    var rows = (state.mappedData.actuals_monthly || []).filter(function(r) {
      return r.month === month && r.plant === "전체";
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

  var lastActualIdx = -1;
  allMonths.forEach(function(m, i) {
    if ((state.mappedData.actuals_monthly || []).some(function(r) { return r.month === m && r.plant === "전체"; }))
      lastActualIdx = i;
  });

  // ── 기존 시나리오 데이터 ──────────────────────────────────────────────────
  var salesData = allMonths.map(function(m) {
    if (!rtfMonths.includes(m)) return getActuals(m, "salesAmt");
    var ri = rtfMonths.indexOf(m), total = 0, has = false;
    rtfItemsArr.forEach(function(item) {
      var ms = item.monthlyStatus[ri];
      if (ms && item.hasCost && Number.isFinite(ms.salesQty)) { total += ms.salesQty * item.standardCost; has = true; }
    });
    return has ? total / 100000000 : 0;
  });

  var supplyData = allMonths.map(function(m) {
    if (!rtfMonths.includes(m)) return getActuals(m, "supplyAmt");
    var ri = rtfMonths.indexOf(m), total = 0, has = false;
    rtfItemsArr.forEach(function(item) {
      var ms = item.monthlyStatus[ri];
      if (ms && item.hasCost && Number.isFinite(ms.supplyQty)) { total += ms.supplyQty * item.standardCost; has = true; }
    });
    return has ? total / 100000000 : 0;
  });

  var invActData = allMonths.map(function(m) {
    return rtfMonths.includes(m) ? null : getActuals(m, "invAmt");
  });
  var joinVal = lastActualIdx >= 0 ? invActData[lastActualIdx] : null;

  var invBaseData = allMonths.map(function() { return null; });
  if (lastActualIdx >= 0 && joinVal !== null) invBaseData[lastActualIdx] = joinVal;
  rtfMonths.forEach(function(m, ri) {
    var idx = allMonths.indexOf(m); if (idx < 0) return;
    var total = 0;
    rtfItemsArr.forEach(function(item) {
      var ms = item.monthlyStatus[ri];
      if (ms && Number.isFinite(ms.endingAmount)) total += ms.endingAmount;
    });
    invBaseData[idx] = total / 100000000;
  });

  var daysBaseData = allMonths.map(function(m) {
    if (!rtfMonths.includes(m)) return getActuals(m, "invDays");
    var ri = rtfMonths.indexOf(m), tQty = 0, tSales = 0;
    rtfItemsArr.forEach(function(item) {
      var ms = item.monthlyStatus[ri]; if (!ms) return;
      if (Number.isFinite(ms.endingQty)) tQty   += ms.endingQty;
      if (ms.salesQty > 0)               tSales += ms.salesQty / monthDays(m);
    });
    return tSales > 0 ? tQty / tSales : null;
  });

  // ── RTF조정 시나리오 데이터 ───────────────────────────────────────────────
  var rtfDeltaData = null, invRtfData = null, daysRtfData = null;

  if (hasRtfAdj && matAdjBomMap) {
    rtfDeltaData = allMonths.map(function(m) {
      if (!rtfMonths.includes(m)) return null;
      var ri = rtfMonths.indexOf(m), rtfTotal = 0, baseTotal = 0;
      rtfItemsArr.forEach(function(item) {
        var ms = item.monthlyStatus[ri]; if (!ms || !item.hasCost) return;
        var adj = computeAdjMonthly(item, matAdjBomMap)[ri];
        var rtfSup  = adj ? (adj.finalSupply !== undefined ? adj.finalSupply : (adj.adjSupply || 0)) : (ms.supplyQty || 0);
        rtfTotal  += rtfSup * item.standardCost;
        baseTotal += (ms.supplyQty || 0) * item.standardCost;
      });
      var delta = (rtfTotal - baseTotal) / 100000000;
      return delta > 0 ? delta : 0;
    });

    invRtfData = allMonths.map(function() { return null; });
    if (lastActualIdx >= 0 && joinVal !== null) invRtfData[lastActualIdx] = joinVal;
    rtfMonths.forEach(function(m, ri) {
      var idx = allMonths.indexOf(m); if (idx < 0) return;
      var total = 0;
      rtfItemsArr.forEach(function(item) {
        var adj = computeAdjMonthly(item, matAdjBomMap)[ri];
        var endAmt = adj ? adj.endingAmount : (item.monthlyStatus[ri] && item.monthlyStatus[ri].endingAmount);
        if (Number.isFinite(endAmt)) total += endAmt;
      });
      invRtfData[idx] = total / 100000000;
    });

    daysRtfData = allMonths.map(function(m) {
      if (!rtfMonths.includes(m)) return getActuals(m, "invDays");
      var ri = rtfMonths.indexOf(m), tQty = 0, tSales = 0;
      rtfItemsArr.forEach(function(item) {
        var adj = computeAdjMonthly(item, matAdjBomMap)[ri];
        var endQty = adj ? adj.endingQty : (item.monthlyStatus[ri] && item.monthlyStatus[ri].endingQty);
        var ms = item.monthlyStatus[ri];
        if (Number.isFinite(endQty)) tQty += endQty;
        if (ms && ms.salesQty > 0)   tSales += ms.salesQty / monthDays(m);
      });
      return tSales > 0 ? tQty / tSales : null;
    });
  }

  // ── 과잉조정 시나리오 데이터 ──────────────────────────────────────────────
  var invExcessData = null, daysExcessData = null;

  if (hasExcessAdj) {
    invExcessData = allMonths.map(function() { return null; });
    if (lastActualIdx >= 0 && joinVal !== null) invExcessData[lastActualIdx] = joinVal;
    rtfMonths.forEach(function(m, ri) {
      var idx = allMonths.indexOf(m); if (idx < 0) return;
      var total = 0;
      rtfItemsArr.forEach(function(item) {
        var ex = computeExcessMonthly(item, matAdjBomMap)[ri];
        var endAmt = ex ? ex.endingAmount : (item.monthlyStatus[ri] && item.monthlyStatus[ri].endingAmount);
        if (Number.isFinite(endAmt)) total += endAmt;
      });
      invExcessData[idx] = total / 100000000;
    });

    daysExcessData = allMonths.map(function(m) {
      if (!rtfMonths.includes(m)) return getActuals(m, "invDays");
      var ri = rtfMonths.indexOf(m), tQty = 0, tSales = 0;
      rtfItemsArr.forEach(function(item) {
        var ex = computeExcessMonthly(item, matAdjBomMap)[ri];
        var endQty = ex ? ex.endingQty : (item.monthlyStatus[ri] && item.monthlyStatus[ri].endingQty);
        var ms = item.monthlyStatus[ri];
        if (Number.isFinite(endQty)) tQty += endQty;
        if (ms && ms.salesQty > 0)   tSales += ms.salesQty / monthDays(m);
      });
      return tSales > 0 ? tQty / tSales : null;
    });
  }

  // ── 시나리오 버튼 연결 ────────────────────────────────────────────────────
  document.querySelectorAll("[data-scenario]").forEach(function(btn) {
    var sc = btn.dataset.scenario;
    var enabled = sc === "기존" || (sc === "RTF조정" && hasRtfAdj) || (sc === "과잉조정" && hasExcessAdj);
    btn.disabled = !enabled;
    btn.classList.toggle("active", sc === _summaryScenario);
    btn.onclick = function() {
      if (!enabled || sc === _summaryScenario) return;
      _summaryScenario = sc;
      bindSummary();
    };
  });

  // ── 시나리오별 datasets 구성 ──────────────────────────────────────────────
  var salesBg = allMonths.map(function(m) {
    return rtfMonths.includes(m) ? "rgba(30,58,138,0.28)" : "rgba(30,58,138,0.85)";
  });
  var supplyBgFull  = allMonths.map(function(m) { return rtfMonths.includes(m) ? "rgba(55,65,81,0.28)" : "rgba(55,65,81,0.85)"; });
  var supplyBgLight = allMonths.map(function(m) { return rtfMonths.includes(m) ? "rgba(55,65,81,0.15)" : "rgba(55,65,81,0.5)"; });
  var rtfDeltaBg    = allMonths.map(function(m) { return rtfMonths.includes(m) ? "rgba(59,130,246,0.7)" : "transparent"; });

  var sc = _summaryScenario;
  if (sc === "RTF조정" && !hasRtfAdj)    sc = "기존";
  if (sc === "과잉조정" && !hasExcessAdj) sc = hasRtfAdj ? "RTF조정" : "기존";

  var datasets, activeInvLineIdx, invActLineIdx, activeDaysData, activeInvData;

  if (sc === "기존") {
    datasets = [
      { label: "판매금액",       data: salesData,   backgroundColor: salesBg,     borderColor: "transparent", borderRadius: 3, order: 2 },
      { label: "공급금액",       data: supplyData,  backgroundColor: supplyBgFull, borderColor: "transparent", borderRadius: 3, order: 2 },
      { type:"line", label:"재고금액(실적)", data: invActData,  borderColor:"#1e3a8a", backgroundColor:"transparent", borderWidth:2.5, pointRadius:4, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(기존)", data: invBaseData, borderColor:"#9ca3af", backgroundColor:"transparent", borderWidth:2, borderDash:[6,3], pointRadius:3, tension:0.3, spanGaps:false, order:1 },
    ];
    invActLineIdx   = 2;
    activeInvLineIdx = 3;
    activeDaysData  = daysBaseData;
    activeInvData   = invBaseData;

  } else if (sc === "RTF조정") {
    datasets = [
      { label: "판매금액",       data: salesData,    backgroundColor: salesBg,      borderColor:"transparent", borderRadius:3, order:2 },
      { label: "공급금액(기존)", data: supplyData,   backgroundColor: supplyBgLight, borderColor:"transparent", borderRadius:3, order:2, stack:"sup" },
      { label: "RTF 증분",       data: rtfDeltaData, backgroundColor: rtfDeltaBg,    borderColor:"transparent", borderRadius:3, order:2, stack:"sup" },
      { type:"line", label:"재고금액(실적)",   data: invActData,  borderColor:"#1e3a8a", backgroundColor:"transparent", borderWidth:2.5, pointRadius:4, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(기존)",   data: invBaseData, borderColor:"#d1d5db", backgroundColor:"transparent", borderWidth:1.5, borderDash:[5,4], pointRadius:2, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(RTF조정)", data: invRtfData,  borderColor:"#1e3a8a", backgroundColor:"transparent", borderWidth:2.5, borderDash:[4,4], pointRadius:4, tension:0.3, spanGaps:false, order:1 },
    ];
    invActLineIdx   = 3;
    activeInvLineIdx = 5;
    activeDaysData  = daysRtfData;
    activeInvData   = invRtfData;

  } else { // 과잉조정
    datasets = [
      { label: "판매금액",        data: salesData,    backgroundColor: salesBg,      borderColor:"transparent", borderRadius:3, order:2 },
      { label: "공급금액(기존)",  data: supplyData,   backgroundColor: supplyBgLight, borderColor:"transparent", borderRadius:3, order:2, stack:"sup" },
      { label: "RTF 증분",        data: rtfDeltaData || allMonths.map(function(){return null;}), backgroundColor: rtfDeltaBg, borderColor:"transparent", borderRadius:3, order:2, stack:"sup" },
      { type:"line", label:"재고금액(실적)",    data: invActData,   borderColor:"#1e3a8a", backgroundColor:"transparent", borderWidth:2.5, pointRadius:4, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(기존)",    data: invBaseData,  borderColor:"#d1d5db", backgroundColor:"transparent", borderWidth:1.5, borderDash:[5,4], pointRadius:2, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(RTF조정)", data: invRtfData || invBaseData, borderColor:"#6b7280", backgroundColor:"transparent", borderWidth:1.5, borderDash:[4,4], pointRadius:2, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(과잉조정)", data: invExcessData, borderColor:"#16a34a", backgroundColor:"transparent", borderWidth:2.5, pointRadius:4, tension:0.3, spanGaps:false, order:1 },
    ];
    invActLineIdx   = 3;
    activeInvLineIdx = 6;
    activeDaysData  = daysExcessData;
    activeInvData   = invExcessData;
  }

  // ── 범례 업데이트 ─────────────────────────────────────────────────────────
  function leg(cls, label) {
    return "<span class=\"sum-leg " + cls + "\">" + label + "</span>";
  }
  var legendEl = document.querySelector("#sumChartLegend");
  if (legendEl) {
    var lgItems = [
      leg("sum-leg-sales-act",   "실적 판매"),
      leg("sum-leg-sales-fcst",  "전망 판매"),
      leg("sum-leg-supply-act",  "실적 공급"),
      leg("sum-leg-supply-fcst", "전망 공급"),
    ];
    if (sc !== "기존") lgItems.push(leg("sum-leg-rtf-delta", "RTF 증분"));
    lgItems.push(leg("sum-leg-inv-act",  "재고금액 실적"));
    if (sc === "기존")      lgItems.push(leg("sum-leg-inv-base",   "재고금액(기존)"));
    if (sc === "RTF조정")   lgItems.push(leg("sum-leg-inv-rtf",    "재고금액(RTF조정)"));
    if (sc === "과잉조정") { lgItems.push(leg("sum-leg-inv-rtf", "RTF조정")); lgItems.push(leg("sum-leg-inv-excess", "과잉조정")); }
    legendEl.innerHTML = lgItems.join("");
  }

  // ── 막대 숫자 레이블 플러그인 ─────────────────────────────────────────────
  var datalabelsPlugin = {
    afterDatasetsDraw: function(chart) {
      var ctx = chart.ctx;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      chart.data.datasets.forEach(function(ds, di) {
        if (ds.type === "line") return;
        var meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        meta.data.forEach(function(el, i) {
          var val = ds.data[i];
          if (!val || val <= 0) return;
          ctx.font = "bold 12px " + FONT;
          ctx.fillStyle = "#6b7280";
          ctx.fillText(Math.round(val).toLocaleString(), el.x, el.y - 4);
        });
      });
      ctx.restore();
    },
  };

  // ── 재고금액 레이블 + 재고일수 태그 플러그인 ─────────────────────────────
  var daysTagsPlugin = {
    afterDraw: function(chart) {
      var ctx = chart.ctx;
      var metaAct    = chart.getDatasetMeta(invActLineIdx);
      var metaActive = chart.getDatasetMeta(activeInvLineIdx);

      ctx.save();
      ctx.font = "bold 12px " + FONT;
      ctx.textAlign = "center";

      allMonths.forEach(function(m, i) {
        var isFcst   = rtfMonths.includes(m);
        var lineVal  = isFcst ? activeInvData[i] : invActData[i];
        if (lineVal === null || lineVal === undefined) return;

        var meta = isFcst ? metaActive : metaAct;
        var el   = meta.data[i];
        if (!el) return;

        // 재고금액 레이블 (선 위)
        ctx.font         = "bold 12px " + FONT;
        ctx.fillStyle    = isFcst ? (sc === "기존" ? "#9ca3af" : "#1e3a8a") : "#1e3a8a";
        ctx.textBaseline = "bottom";
        ctx.fillText(Math.round(lineVal).toLocaleString(), el.x, el.y - 8);

        // 재고일수 태그 (선 아래)
        var dv = activeDaysData ? activeDaysData[i] : null;
        if (dv === null || dv === undefined) return;
        var text = Math.round(dv) + "일";
        ctx.font = "bold 12px " + FONT;
        var tw   = ctx.measureText(text).width + 12;
        var th   = 18;
        var tx   = el.x - tw / 2;
        var ty   = el.y + 5;
        if (ty + th > chart.chartArea.bottom - 2) return;

        var isFcstColor = isFcst && sc !== "기존";
        ctx.fillStyle = isFcstColor ? "rgba(30,58,138,0.08)" : "rgba(30,58,138,0.08)";
        if (sc === "과잉조정" && isFcst) ctx.fillStyle = "rgba(22,163,74,0.08)";
        _drawRoundRect(ctx, tx, ty, tw, th, 4);
        ctx.fill();

        ctx.strokeStyle = sc === "과잉조정" && isFcst ? "rgba(22,163,74,0.3)" : "rgba(30,58,138,0.2)";
        ctx.lineWidth   = 0.8;
        _drawRoundRect(ctx, tx, ty, tw, th, 4);
        ctx.stroke();

        ctx.fillStyle    = sc === "과잉조정" && isFcst ? "#16a34a" : (isFcst && sc === "기존" ? "#9ca3af" : "#1e3a8a");
        ctx.textBaseline = "middle";
        ctx.fillText(text, el.x, ty + th / 2);
      });

      ctx.restore();
    },
  };

  // ── 차트 생성 ─────────────────────────────────────────────────────────────
  _summaryChartInst = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels: allMonths.map(monthLabel), datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 20 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              if (ctx.raw === null || ctx.raw === undefined) return null;
              return ctx.dataset.label + ": " + Math.round(ctx.raw).toLocaleString() + "억";
            },
          },
        },
      },
      scales: {
        x: { grid: { color: "#f3f4f6" }, ticks: { font: { family: FONT, size: 13 } } },
        y: {
          grid: { color: "#f3f4f6" },
          ticks: { font: { family: FONT, size: 13 }, callback: function(v) { return Math.round(v).toLocaleString() + "억"; } },
        },
      },
    },
    plugins: [datalabelsPlugin, daysTagsPlugin],
  });
}
