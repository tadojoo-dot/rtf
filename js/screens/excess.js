// ── 과잉감축 화면 (v300) ────────────────────────────────────────────────────

var MAT_TARGET_DAYS  = 180;
var _excessChartInst = null;

// ═══════════════════════════════════════════════════════════════════════════
// 1. PSI 롤링 계산 — excessAdj 반영 (완제품)
// ═══════════════════════════════════════════════════════════════════════════
function calcPsiRows(item, planMap, months) {
  var prevEnding     = item.baseQty || 0;
  var origPrevEnding = item.baseQty || 0;

  return months.map(function(month, mi) {
    var ms         = (item.monthlyStatus && item.monthlyStatus[mi]) || {};
    var salesQty   = ms.salesQty || 0;
    var origSupply = planMap.get(month) || 0;
    var adjKey     = item.itemCode + "|" + (item.plantCode || "") + "|" + month;
    var supplyQty  = (adjKey in state.excessAdj) ? state.excessAdj[adjKey] : origSupply;
    var dailySales = salesQty > 0 ? salesQty / monthDays(month) : 0;

    var endingQty     = prevEnding + supplyQty - salesQty;
    var days          = dailySales > 0 ? endingQty / dailySales : null;
    prevEnding        = Math.max(0, endingQty);

    var origEndingQty = origPrevEnding + origSupply - salesQty;
    var origDays      = dailySales > 0 ? origEndingQty / dailySales : null;
    origPrevEnding    = Math.max(0, origEndingQty);

    return {
      month, mi, salesQty, origSupply, supplyQty,
      adjKey, endingQty, days, origDays, origEndingQty,
      hasAdj: adjKey in state.excessAdj,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 자재 소비량 맵: "compCode|plant" → [qty per RTF month]
// ═══════════════════════════════════════════════════════════════════════════
function buildMatConsumptionMap(useExcessAdj) {
  var months        = getRtfMonths();
  var bomComponents = state.mappedData.bom_components || [];

  var bomByFg = new Map();
  bomComponents.forEach(function(b) {
    if (!b.componentCode || !(b.componentQty > 0)) return;
    var k = (cleanOptional(b.rootItemCode) || "") + "|" + (cleanOptional(b.plant) || "");
    if (!bomByFg.has(k)) bomByFg.set(k, []);
    bomByFg.get(k).push({ compCode: cleanOptional(b.componentCode), compQty: cleanNumber(b.componentQty) || 0 });
  });

  var fgPlan = new Map();
  (state.mappedData.plan_monthly || []).forEach(function(r) {
    var ic = cleanOptional(r.itemCode), pl = cleanOptional(r.plant) || "", mo = cleanOptional(r.month);
    if (!ic || !mo) return;
    var k = ic + "|" + pl + "|" + mo;
    fgPlan.set(k, (fgPlan.get(k) || 0) + (cleanNumber(r.supplyQty) || 0));
  });

  var rtfItems = computeRtfItems();
  var consMap  = new Map();

  rtfItems.forEach(function(item) {
    var bomKey = item.itemCode + "|" + (item.plantCode || "");
    var comps  = bomByFg.get(bomKey) || [];
    if (!comps.length) return;
    months.forEach(function(month, mi) {
      var planKey = item.itemCode + "|" + (item.plantCode || "") + "|" + month;
      var qty     = fgPlan.get(planKey) || 0;
      if (useExcessAdj) {
        var adjKey = item.itemCode + "|" + (item.plantCode || "") + "|" + month;
        if (adjKey in state.excessAdj) qty = state.excessAdj[adjKey];
      }
      comps.forEach(function(c) {
        var ck = c.compCode + "|" + (item.plantCode || "");
        if (!consMap.has(ck)) consMap.set(ck, new Array(months.length).fill(0));
        consMap.get(ck)[mi] += qty * c.compQty;
      });
    });
  });

  return consMap;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 3-시나리오 월별 집계 → Impact KPI + Chart 데이터 공유
// ═══════════════════════════════════════════════════════════════════════════
function calcExcessScenarios(excessFgItems, months, globalPlanMap, matAdjBomMap) {
  var byMonth = months.map(function() {
    return {
      origAmt: 0, rtfAmt: 0, exAmt: 0,
      origDaysSum: 0, origDaysCnt: 0,
      rtfDaysSum:  0, rtfDaysCnt:  0,
      exDaysSum:   0, exDaysCnt:   0,
    };
  });

  excessFgItems.forEach(function(item) {
    var hasCost = item.standardCost > 0;
    var planMap = new Map();
    months.forEach(function(month) {
      var k = item.itemCode + "|" + (item.plantCode || "") + "|" + month;
      planMap.set(month, globalPlanMap.get(k) || 0);
    });
    var psiOrig = calcPsiRows(item, planMap, months);
    var rtfData = computeAdjMonthly(item, matAdjBomMap);
    var exData  = computeExcessMonthly(item, matAdjBomMap);

    months.forEach(function(month, mi) {
      var d   = byMonth[mi];
      var r   = psiOrig[mi];
      var rtf = rtfData[mi];
      var ex  = exData[mi];

      if (hasCost) {
        d.origAmt += Math.max(0, r.origEndingQty || 0) * item.standardCost;
        d.rtfAmt  += rtf.endingAmount !== null ? rtf.endingAmount : Math.max(0, rtf.endingQty) * item.standardCost;
        d.exAmt   += ex.endingAmount  !== null ? ex.endingAmount  : Math.max(0, ex.endingQty)  * item.standardCost;
      }
      if (Number.isFinite(r.origDays)        && r.origDays        > 0) { d.origDaysSum += r.origDays;        d.origDaysCnt++; }
      if (Number.isFinite(rtf.inventoryDays) && rtf.inventoryDays > 0) { d.rtfDaysSum  += rtf.inventoryDays; d.rtfDaysCnt++;  }
      if (Number.isFinite(ex.inventoryDays)  && ex.inventoryDays  > 0) { d.exDaysSum   += ex.inventoryDays;  d.exDaysCnt++;   }
    });
  });

  return byMonth;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Impact KPI 바 — 현재계획 / RTF조정후 / 과잉감축후
// ═══════════════════════════════════════════════════════════════════════════
function renderExcessImpactKpi(byMonth, hasCostAny) {
  function totalAmt(key) { return byMonth.reduce(function(s, d) { return s + (d[key] || 0); }, 0); }
  function avgDays(sumK, cntK) {
    var t = 0, c = 0;
    byMonth.forEach(function(d) { if (d[cntK] > 0) { t += d[sumK] / d[cntK]; c++; } });
    return c > 0 ? Math.round(t / c) : null;
  }

  var origAmt = totalAmt("origAmt"), rtfAmt = totalAmt("rtfAmt"), exAmt = totalAmt("exAmt");
  var origDay = avgDays("origDaysSum","origDaysCnt");
  var rtfDay  = avgDays("rtfDaysSum", "rtfDaysCnt");
  var exDay   = avgDays("exDaysSum",  "exDaysCnt");
  var hasAdj  = Object.keys(state.excessAdj).length > 0;

  function fmtAmt(v) { return v > 0 ? formatMoney(v) : "—"; }
  function fmtDay(v) { return v !== null ? v + "일" : "—"; }

  function deltaTag(cur, base, positive_is_bad) {
    if (!hasCostAny || !base) return "";
    var d = cur - base;
    if (Math.abs(d) < 500000) return "";
    var isGood = positive_is_bad ? d < 0 : d > 0;
    var cls    = isGood ? "exc-kpi-delta-good" : "exc-kpi-delta-bad";
    var sign   = d < 0 ? "▼" : "▲";
    return "<span class='exc-kpi-delta " + cls + "'>" + sign + escapeHtml(formatMoney(Math.abs(d))) + "</span>";
  }

  var rtfSavings  = hasCostAny && origAmt > 0 ? origAmt - rtfAmt  : 0;
  var exSavings   = hasCostAny && origAmt > 0 ? origAmt - exAmt   : 0;
  var liveClass   = hasAdj ? "exc-kpi-live-active" : "exc-kpi-live-idle";
  var liveText    = hasAdj ? "● LIVE 반영 중" : "조정 전";

  return "<div class='exc-impact-bar'>" +
    "<div class='exc-kpi-card exc-kpi-orig'>" +
      "<div class='exc-kpi-label'>현재 계획</div>" +
      "<div class='exc-kpi-amt'>" + (hasCostAny ? escapeHtml(fmtAmt(origAmt)) : "원가 미연결") + "</div>" +
      "<div class='exc-kpi-sub'>" + escapeHtml(fmtDay(origDay)) + "<span class='exc-kpi-sub-lbl'>평균 재고일수</span></div>" +
    "</div>" +
    "<div class='exc-kpi-arrow-block'>" +
      "<div class='exc-kpi-arrow'>→</div>" +
      (rtfSavings > 0 ? "<div class='exc-kpi-delta-mid exc-kpi-delta-good'>▼" + escapeHtml(formatMoney(rtfSavings)) + " 절감</div>" : "<div class='exc-kpi-delta-mid'>RTF 반영</div>") +
    "</div>" +
    "<div class='exc-kpi-card exc-kpi-rtf'>" +
      "<div class='exc-kpi-label'>RTF 조정 후</div>" +
      "<div class='exc-kpi-amt'>" + (hasCostAny ? escapeHtml(fmtAmt(rtfAmt)) : "—") + "</div>" +
      "<div class='exc-kpi-sub'>" + escapeHtml(fmtDay(rtfDay)) + "<span class='exc-kpi-sub-lbl'>평균 재고일수</span></div>" +
    "</div>" +
    "<div class='exc-kpi-arrow-block'>" +
      "<div class='exc-kpi-arrow'>→</div>" +
      (exSavings > rtfSavings && hasCostAny ? "<div class='exc-kpi-delta-mid exc-kpi-delta-good'>▼" + escapeHtml(formatMoney(exSavings - rtfSavings)) + " 추가절감</div>" : "<div class='exc-kpi-delta-mid'>과잉감축</div>") +
    "</div>" +
    "<div class='exc-kpi-card exc-kpi-ex " + (hasAdj ? "exc-kpi-ex-active" : "") + "'>" +
      "<div class='exc-kpi-label'>과잉감축 후 <span class='" + liveClass + "'>" + liveText + "</span></div>" +
      "<div class='exc-kpi-amt " + (hasAdj ? "exc-kpi-amt-live" : "") + "'>" + (hasCostAny ? escapeHtml(fmtAmt(exAmt)) : "—") + "</div>" +
      "<div class='exc-kpi-sub'>" + escapeHtml(fmtDay(exDay)) + "<span class='exc-kpi-sub-lbl'>평균 재고일수</span></div>" +
      (exSavings > 0 && hasCostAny ? "<div class='exc-kpi-total-saving'>총 " + escapeHtml(formatMoney(exSavings)) + " 절감 예상</div>" : "") +
    "</div>" +
  "</div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Chart.js 바 차트 (3-시나리오 월별)
// ═══════════════════════════════════════════════════════════════════════════
function renderExcessChartBand() {
  return "<div class='exc-chart-band'>" +
    "<div class='exc-chart-hd'>" +
      "<span class='exc-chart-title'>재고금액 월간 시나리오 비교</span>" +
      "<div class='exc-chart-legend'>" +
        "<span class='exc-legend-dot' style='background:#94a3b8'></span><span>현재계획</span>" +
        "<span class='exc-legend-dot' style='background:#3b82f6'></span><span>RTF 조정후</span>" +
        "<span class='exc-legend-dot' style='background:#22c55e'></span><span>과잉감축후</span>" +
      "</div>" +
    "</div>" +
    "<div class='exc-chart-canvas-wrap'><canvas id='excessBarChart'></canvas></div>" +
  "</div>";
}

function initExcessChart(byMonth, months, hasCostAny) {
  var ctx = document.getElementById("excessBarChart");
  if (!ctx) return;
  if (_excessChartInst) { _excessChartInst.destroy(); _excessChartInst = null; }
  if (!hasCostAny) {
    ctx.closest(".exc-chart-band").querySelector(".exc-chart-title").textContent = "재고금액 시나리오 비교 (표준원가 미연결)";
    return;
  }
  var toAuk = function(v) { return v > 0 ? Math.round(v / 100000000 * 10) / 10 : 0; };

  _excessChartInst = new Chart(ctx.getContext("2d"), {
    type: "bar",
    data: {
      labels: months.map(monthLabel),
      datasets: [
        { label:"현재계획",   data: byMonth.map(function(d){ return toAuk(d.origAmt); }), backgroundColor:"#94a3b8", borderRadius:4 },
        { label:"RTF 조정후", data: byMonth.map(function(d){ return toAuk(d.rtfAmt);  }), backgroundColor:"#3b82f6", borderRadius:4 },
        { label:"과잉감축후", data: byMonth.map(function(d){ return toAuk(d.exAmt);   }), backgroundColor:"#22c55e", borderRadius:4 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(c) { return " " + c.dataset.label + ": " + c.parsed.y + "억원"; }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: function(v){ return v + "억"; }, font:{ size:12 } },
          grid:  { color:"#f1f5f9" },
        },
        x: { grid: { display: false }, ticks:{ font:{size:13, weight:"600"} } }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. AI 권장 섹션
// ═══════════════════════════════════════════════════════════════════════════
function renderAiSection(excessFgItems, months, globalPlanMap) {
  var top = excessFgItems.filter(function(i){ return i._excessAmt > 0; }).slice(0, 5);
  if (!top.length) return "";

  var cards = top.map(function(item, idx) {
    var planMap = new Map();
    months.forEach(function(month) {
      var k = item.itemCode + "|" + (item.plantCode || "") + "|" + month;
      planMap.set(month, globalPlanMap.get(k) || 0);
    });
    var psiRows = calcPsiRows(item, planMap, months);

    // 첫 번째 조정 가능 월 + 권장 감축 수량 계산
    var actionMonth = null, actionQty = 0;
    for (var i = 0; i < psiRows.length; i++) {
      var r  = psiRows[i];
      var ms = item.monthlyStatus[i];
      if (r.origSupply > 0 && Number.isFinite(r.days) && r.days > item._td) {
        var dailySales = (ms && ms.salesQty > 0) ? ms.salesQty / monthDays(r.month) : 0;
        actionMonth = r.month;
        actionQty   = dailySales > 0 ? Math.round((r.days - item._td) * dailySales) : 0;
        break;
      }
    }

    var curDays = item.monthlyStatus[0] ? item.monthlyStatus[0].inventoryDays : null;
    var tgtDays = item._td;
    var exDays  = curDays !== null ? Math.round(curDays - tgtDays) : null;

    var actionTxt = actionMonth
      ? monthLabel(actionMonth) + " 입고 " + formatNumber(actionQty) + "개 감축 검토"
      : "공급계획 전체 재검토 필요";

    var barPct = (curDays !== null && tgtDays > 0) ? Math.min(100, Math.round(curDays / tgtDays * 100)) : 0;
    var tgtPct = (curDays !== null && tgtDays > 0) ? Math.min(100, Math.round(tgtDays / Math.max(curDays, tgtDays) * 100)) : 50;

    return "<div class='exc-ai-card' data-ai-code='" + escapeHtml(item.itemCode) + "|" + escapeHtml(item.plantCode || "") + "'>" +
      "<div class='exc-ai-rank'>" + (idx + 1) + "</div>" +
      "<div class='exc-ai-main'>" +
        "<div class='exc-ai-name'>" + escapeHtml(item.itemName || item.itemCode) +
          "<span class='exc-ai-plant-tag'>" + escapeHtml(displayPlantName ? displayPlantName(item.plantCode || "") : (item.plantCode || "")) + "</span>" +
        "</div>" +
        "<div class='exc-ai-days-row'>" +
          "<span class='exc-ai-cur-days'>" + (curDays !== null ? Math.round(curDays) + "일" : "—") + "</span>" +
          "<span class='exc-ai-arrow-sm'>→</span>" +
          "<span class='exc-ai-tgt-days'>적정 " + Math.round(tgtDays) + "일</span>" +
          (exDays !== null ? "<span class='exc-ai-excess-badge'>+" + exDays + "일 초과</span>" : "") +
        "</div>" +
        "<div class='exc-ai-gauge'>" +
          "<div class='exc-ai-gauge-bar' style='width:" + barPct + "%;'></div>" +
          "<div class='exc-ai-gauge-tgt' style='left:" + tgtPct + "%;'></div>" +
        "</div>" +
        "<div class='exc-ai-action-txt'>▶ " + escapeHtml(actionTxt) + "</div>" +
      "</div>" +
      "<div class='exc-ai-right'>" +
        (item._excessAmt > 0
          ? "<div class='exc-ai-saving'>" + escapeHtml(formatMoney(item._excessAmt)) + "</div><div class='exc-ai-saving-lbl'>절감 가능</div>"
          : "") +
      "</div>" +
    "</div>";
  }).join("");

  return "<div class='exc-ai-section'>" +
    "<div class='exc-ai-hd'>" +
      "<span class='exc-ai-badge'>AI 분석</span>" +
      "<span class='exc-ai-title'>과잉재고 감축 우선 권장 대상</span>" +
      "<span class='exc-ai-desc'>초과금액 기준 상위 " + top.length + "개 · 카드 클릭 시 해당 품목으로 이동</span>" +
    "</div>" +
    "<div class='exc-ai-list'>" + cards + "</div>" +
  "</div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. 완제품 드릴다운 — 원부자재 서브테이블
// ═══════════════════════════════════════════════════════════════════════════
function renderFgMatSubTable(item, months) {
  var comps = (state.mappedData.bom_components || []).filter(function(b) {
    var rc = cleanOptional(b.rootItemCode), pl = cleanOptional(b.plant) || "";
    return rc === item.itemCode && pl === (item.plantCode || "");
  });

  if (!comps.length) {
    var hasBom = (state.mappedData.bom_components || []).length > 0;
    return "<div class='exc-mat-empty'>" +
      (hasBom ? "이 완제품의 BOM 정보가 없습니다" : "BOM 미전개 — 공급원인 화면에서 BOM 전개 후 확인") +
    "</div>";
  }

  var consMap = buildMatConsumptionMap(false);

  var rows = comps.slice(0, 30).map(function(comp) {
    var compCode = cleanOptional(comp.componentCode) || "";
    var compName = cleanOptional(comp.componentName) || compCode;
    var compQty  = cleanNumber(comp.componentQty) || 0;

    var matInv = (state.mappedData.inventory_base || []).find(function(m) {
      return cleanOptional(m.itemCode) === compCode;
    });
    var baseQty = matInv ? (matInv.baseQty || 0) : null;

    var ck      = compCode + "|" + (item.plantCode || "");
    var cons0   = (consMap.get(ck) || [])[0] || 0;
    var daily0  = cons0 > 0 ? cons0 / monthDays(months[0]) : 0;
    var days0   = (baseQty !== null && daily0 > 0) ? Math.round(baseQty / daily0) : null;

    var isOver  = days0 !== null && days0 > MAT_TARGET_DAYS;
    var dayCls  = isOver ? "exc-mat-sub-over" : (days0 !== null ? "exc-mat-sub-ok" : "");
    var statusTxt = days0 === null ? "—" : (isOver ? "초과" : "정상");

    return "<tr class='exc-mat-sub-row'>" +
      "<td class='exc-mat-sub-code'>" + escapeHtml(compCode) + "</td>" +
      "<td class='exc-mat-sub-name'>" + escapeHtml(compName) + "</td>" +
      "<td class='exc-mat-sub-num'>" + formatNumber(compQty) + "</td>" +
      "<td class='exc-mat-sub-num'>" + (baseQty !== null ? formatNumber(Math.round(baseQty)) : "—") + "</td>" +
      "<td class='exc-mat-sub-days " + dayCls + "'>" + (days0 !== null ? days0 + "일" : "—") + "</td>" +
      "<td class='exc-mat-sub-status " + dayCls + "'>" + escapeHtml(statusTxt) + "</td>" +
    "</tr>";
  }).join("");

  var overCount = comps.filter(function(comp) {
    var cc = cleanOptional(comp.componentCode) || "";
    var ck = cc + "|" + (item.plantCode || "");
    var cons0 = (consMap.get(ck) || [])[0] || 0;
    var daily0 = cons0 > 0 ? cons0 / monthDays(months[0]) : 0;
    var matInv = (state.mappedData.inventory_base || []).find(function(m){ return cleanOptional(m.itemCode) === cc; });
    var baseQty = matInv ? (matInv.baseQty || 0) : null;
    var days0 = (baseQty !== null && daily0 > 0) ? (baseQty / daily0) : null;
    return days0 !== null && days0 > MAT_TARGET_DAYS;
  }).length;

  return "<table class='exc-mat-sub-table'>" +
    "<thead><tr>" +
      "<th>자재코드</th><th>자재명</th><th>BOM수량</th><th>기초재고</th><th>재고일수</th>" +
      "<th><span style='color:" + (overCount > 0 ? "#b91c1c" : "#15803d") + "'>" + (overCount > 0 ? "⚠ " + overCount + "개 초과" : "✓ 정상") + "</span></th>" +
    "</tr></thead>" +
    "<tbody>" + rows + "</tbody>" +
  "</table>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. 완제품 드릴다운 — 탭 구조 (PSI 조정 | 원부자재)
// ═══════════════════════════════════════════════════════════════════════════
function renderFgDetailPanel(item, months, globalPlanMap) {
  var rowKey    = item.itemCode + "|" + (item.plantCode || "");
  var activeTab = (state.excessDrillTabMap && state.excessDrillTabMap[rowKey]) || "psi";

  // ── PSI 탭 내용 ──────────────────────────────────────────────────────────
  var planMap = new Map();
  months.forEach(function(month) {
    var k = item.itemCode + "|" + (item.plantCode || "") + "|" + month;
    planMap.set(month, globalPlanMap.get(k) || 0);
  });
  var psiRows = calcPsiRows(item, planMap, months);
  var hasAdj  = psiRows.some(function(r){ return r.hasAdj; });
  var allOk   = item._td !== null && psiRows.every(function(r){ return !Number.isFinite(r.days) || r.days <= item._td; });

  var monthRows = psiRows.map(function(r) {
    var tgt    = item._td || null;
    var isOver = tgt !== null && Number.isFinite(r.days) && r.days > tgt;
    var isOk   = tgt !== null && Number.isFinite(r.days) && r.days <= tgt;
    var dayCls = isOver ? "exc-days-over" : isOk ? "exc-days-ok" : "";
    var daysNum = Number.isFinite(r.days) ? Math.round(r.days) : null;

    var adjBadge = "";
    if (r.hasAdj && Number.isFinite(r.origDays) && Number.isFinite(r.days)) {
      var delta = r.origDays - r.days;
      if (delta > 0.5)       adjBadge = "<span class='rtf-adj-badge rtf-adj-improved'>▼" + Math.round(delta)  + "일</span>";
      else if (delta < -0.5) adjBadge = "<span class='rtf-adj-badge exc-adj-worse'>▲"   + Math.round(-delta) + "일</span>";
    }

    var gaugeHtml = "";
    if (daysNum !== null && tgt !== null && tgt > 0) {
      var pct    = Math.min(150, Math.round(daysNum / tgt * 100));
      var gColor = isOver ? "#fca5a5" : "#86efac";
      gaugeHtml  = "<div class='exc-gauge-wrap'>" +
        "<div class='exc-gauge-bar' style='width:" + Math.min(pct,100) + "%;background:" + gColor + ";'></div>" +
        "<div class='exc-gauge-tgt' style='left:100%;'></div></div>";
    }

    var inputEl = "<input type='number' class='exc-psi-input' " +
      "data-key='" + escapeHtml(r.adjKey) + "' data-orig='" + r.origSupply + "' " +
      "value='" + Math.round(r.supplyQty) + "' min='0' step='1'>";

    return "<tr class='exc-detail-row'>" +
      "<td class='exc-detail-month'>" + escapeHtml(monthLabel(r.month)) + "</td>" +
      "<td class='exc-detail-sales'>" + escapeHtml(formatNumber(Math.round(r.salesQty))) + "</td>" +
      "<td class='exc-detail-supply " + (r.hasAdj ? "exc-td-sup-adj" : "") + "'>" +
        "<span class='exc-orig-plan'>원: " + escapeHtml(formatNumber(Math.round(r.origSupply))) + "</span>" +
        inputEl +
      "</td>" +
      "<td class='exc-detail-days " + dayCls + "'>" +
        (daysNum !== null ? daysNum + "일" : "—") + adjBadge + gaugeHtml +
      "</td>" +
    "</tr>";
  }).join("");

  var tgtLabel = item._td !== null ? "적정: " + Math.round(item._td) + "일" : "적정재고 미설정";
  var resetBtn = hasAdj
    ? "<button class='exc-psi-reset' data-item-code='" + escapeHtml(item.itemCode) + "' data-plant='" + escapeHtml(item.plantCode || "") + "'>↺ 초기화</button>"
    : "";
  var okBadge = (allOk && hasAdj)
    ? "<span class='exc-detail-ok-badge'>✓ 적정재고 달성</span>"
    : "";

  var psiContent =
    "<div class='exc-psi-toolbar'>" + okBadge + resetBtn + "</div>" +
    "<table class='exc-detail-table'><thead><tr>" +
      "<th>월</th><th>판매계획</th><th>공급계획</th>" +
      "<th>재고일수 (" + escapeHtml(tgtLabel) + ")</th>" +
    "</tr></thead><tbody>" + monthRows + "</tbody></table>";

  // ── 자재 탭 내용 ──────────────────────────────────────────────────────────
  var matCount = (state.mappedData.bom_components || []).filter(function(b) {
    return cleanOptional(b.rootItemCode) === item.itemCode &&
           (cleanOptional(b.plant) || "") === (item.plantCode || "");
  }).length;

  var matContent = renderFgMatSubTable(item, months);

  // ── 탭 헤더 ───────────────────────────────────────────────────────────────
  var tabHtml =
    "<div class='exc-drill-tabs' data-row-key='" + escapeHtml(rowKey) + "'>" +
      "<button class='exc-drill-tab" + (activeTab === "psi" ? " exc-drill-tab-active" : "") + "' " +
        "data-tab='psi' data-row-key='" + escapeHtml(rowKey) + "'>" +
        "PSI 조정 <span class='exc-drill-tab-badge'>7개월</span>" +
      "</button>" +
      "<button class='exc-drill-tab" + (activeTab === "mat" ? " exc-drill-tab-active" : "") + "' " +
        "data-tab='mat' data-row-key='" + escapeHtml(rowKey) + "'>" +
        "원부자재 <span class='exc-drill-tab-badge" + (matCount > 0 ? " exc-drill-tab-badge-count" : "") + "'>" + matCount + "개</span>" +
      "</button>" +
      "<span class='exc-drill-tabs-hint'>수량 수정 → 재고일수 자동 반영</span>" +
    "</div>";

  return "<div class='exc-drill-panel'>" +
    tabHtml +
    "<div class='exc-drill-body'>" +
      "<div class='exc-drill-pane exc-drill-pane-psi'" + (activeTab !== "psi" ? " style='display:none'" : "") + ">" +
        psiContent +
      "</div>" +
      "<div class='exc-drill-pane exc-drill-pane-mat'" + (activeTab !== "mat" ? " style='display:none'" : "") + ">" +
        matContent +
      "</div>" +
    "</div>" +
  "</div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. 완제품 메인 테이블 (드릴다운 통합 — 전체/초과 품목 공용)
// ═══════════════════════════════════════════════════════════════════════════
function renderExcessFgTable(displayItems, months, globalPlanMap, hasTargetData) {
  if (!displayItems.length) {
    var msg = hasTargetData
      ? "이 조건에 해당하는 품목이 없습니다."
      : "품목이 없습니다. 데이터점검 화면에서 RAW 파일을 선택하세요.";
    return "<div class='exc-empty'>" + msg + "</div>";
  }

  var excessItems = displayItems.filter(function(i){ return i._isExcess; });
  var totalExcessAmt = excessItems.reduce(function(s, i){ return s + i._excessAmt; }, 0);
  var adjCount = displayItems.filter(function(i) {
    return months.some(function(m){ return (i.itemCode + "|" + (i.plantCode||"") + "|" + m) in state.excessAdj; });
  }).length;

  var hd = "<div class='exc-table-hd'>" +
    "<div class='exc-table-hd-left'>" +
      "<span class='exc-table-hd-title'>완제품 · 상품</span>" +
      "<span class='exc-table-hd-count'>" + displayItems.length + "개 품목</span>" +
      (excessItems.length > 0 ? "<span class='exc-table-hd-excess-count'>" + excessItems.length + "개 초과</span>" : "") +
      (totalExcessAmt > 0 ? "<span class='exc-table-hd-amt'>" + escapeHtml(formatMoney(totalExcessAmt)) + " 초과</span>" : "") +
      (adjCount ? "<span class='exc-table-hd-adj'>▼ " + adjCount + "개 감축 입력됨</span>" : "") +
    "</div>" +
    "<div class='exc-table-hd-right'>" +
      "<span class='exc-table-hd-hint'>▼ 버튼 클릭 → 월별 조정 · 원부자재 확인</span>" +
    "</div>" +
  "</div>";

  var rows = displayItems.map(function(item) {
    var ms0     = item.monthlyStatus && item.monthlyStatus[0];
    var curDays = ms0 && Number.isFinite(ms0.inventoryDays) ? Math.round(ms0.inventoryDays) : null;
    var tgtDays = item._td !== null ? Math.round(item._td) : null;
    var exDays  = (curDays !== null && tgtDays !== null) ? curDays - tgtDays : null;

    var isOpen = state.excessExpandedRows.has(item.itemCode + "|" + (item.plantCode || ""));
    var hasAdj = months.some(function(m){ return (item.itemCode + "|" + (item.plantCode||"") + "|" + m) in state.excessAdj; });
    var rowKey = item.itemCode + "|" + (item.plantCode || "");

    // 게이지 바
    var gaugeBar;
    if (curDays !== null && tgtDays !== null && tgtDays > 0) {
      var pct    = Math.min(200, Math.round(curDays / tgtDays * 100));
      var fill   = item._isExcess ? "#fca5a5" : "#86efac";
      var subTxt = item._isExcess
        ? "<span class='exc-gauge-sub exc-gauge-sub-over'>+" + (curDays - tgtDays) + "일 초과</span>"
        : "<span class='exc-gauge-sub exc-gauge-sub-ok'>정상</span>";
      gaugeBar = "<div class='exc-row-gauge'>" +
        "<div class='exc-row-gauge-fill' style='width:" + Math.min(pct,100) + "%;background:" + fill + ";'></div>" +
        "<div class='exc-row-gauge-tgt'></div>" +
        "<span class='exc-row-gauge-label'>" + curDays + "일 / " + tgtDays + "일</span>" +
      "</div>" + subTxt;
    } else {
      gaugeBar = "<div class='exc-row-gauge exc-row-gauge-nodata'>" +
        "<span class='exc-row-gauge-label'>" + (curDays !== null ? curDays + "일" : "—") +
          (tgtDays !== null ? " / " + tgtDays + "일" : " / 적정미설정") + "</span>" +
      "</div>";
    }

    // 품목명 태그
    var tag = item._isExcess
      ? "<span class='exc-row-excess-tag'>초과</span>"
      : (tgtDays !== null ? "<span class='exc-row-ok-tag'>정상</span>" : "");
    var adjDot = hasAdj ? "<span class='exc-row-adj-dot' title='조정 입력됨'>●</span>" : "";

    var rowCls = "exc-fg-row" +
      (item._isExcess ? " exc-fg-excess-row" : " exc-fg-ok-row") +
      (isOpen ? " exc-fg-open" : "") +
      (hasAdj ? " exc-psi-has-adj" : "");

    var itemRow = "<tr class='" + rowCls + "' data-row-key='" + escapeHtml(rowKey) + "'>" +
      "<td class='exc-row-expand'>" +
        "<button class='exc-expand-btn " + (isOpen ? "exc-expand-open" : "") + "' data-row-key='" + escapeHtml(rowKey) + "'>" +
          (isOpen ? "▲" : "▼") +
        "</button>" +
      "</td>" +
      "<td class='exc-row-name'>" +
        "<div class='exc-row-name-main'>" + escapeHtml(item.itemName || item.itemCode) + tag + adjDot + "</div>" +
        "<div class='exc-row-name-code'>" +
          escapeHtml(item.itemCode) + " · " +
          escapeHtml(displayPlantName ? displayPlantName(item.plantCode||"") : (item.plantCode||"")) +
          " · " + escapeHtml(item.typeGroup || "—") +
        "</div>" +
      "</td>" +
      "<td class='exc-row-gauge-cell'>" + gaugeBar + "</td>" +
      "<td class='exc-row-amt'>" + (item._excessAmt > 0 ? escapeHtml(formatMoney(item._excessAmt)) : "<span class='exc-amt-none'>—</span>") + "</td>" +
    "</tr>";

    var detailRow = isOpen
      ? "<tr class='exc-detail-wrap-row'><td colspan='4'>" +
          renderFgDetailPanel(item, months, globalPlanMap) +
        "</td></tr>"
      : "";

    return itemRow + detailRow;
  }).join("");

  return hd +
    "<div class='exc-fg-table-wrap'>" +
      "<table class='exc-fg-table'>" +
        "<thead><tr>" +
          "<th class='exc-th-expand'></th>" +
          "<th class='exc-th-name'>품목명</th>" +
          "<th class='exc-th-gauge'>재고일수 현황</th>" +
          "<th class='exc-th-examt'>초과금액</th>" +
        "</tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
      "</table>" +
    "</div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. 메인 렌더
// ═══════════════════════════════════════════════════════════════════════════
function renderExcessAdjustment() {
  try {
    return _renderExcessAdjustmentInner();
  } catch(e) {
    console.error("[과잉감축] 렌더 오류:", e);
    return "<section class='section-band'><div class='section-header'><h2>과잉감축 — 렌더 오류</h2>" +
      "<p style='color:#b91c1c;font-size:14px;'><strong>오류 내용:</strong> " + escapeHtml(String(e)) + "</p>" +
      "<p style='font-size:13px;color:#6b7280;'>F12 → Console 탭에서 상세 스택을 확인하세요.</p>" +
      "</div></section>";
  }
}

function _renderExcessAdjustmentInner() {
  if (!state.mappedData.plan_monthly.length) {
    return "<section class='section-band'><div class='section-header'><h2>과잉감축</h2>" +
      "<p>데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 선택하세요.</p></div></section>";
  }

  var rtfItems     = computeRtfItems();
  var months       = getRtfMonths();
  var plantFilter  = state.excessPlant    || "all";
  var showOnlyExcess = state.excessShowOnly === true; // 기본값: 전체 표시

  var targetMap = new Map();
  (state.mappedData.target_inv || []).forEach(function(r) {
    if (r.itemCode) targetMap.set(r.itemCode, r.targetDays);
  });
  var hasTargetData = targetMap.size > 0;

  var globalPlanMap = new Map();
  (state.mappedData.plan_monthly || []).forEach(function(r) {
    var ic = cleanOptional(r.itemCode), pl = cleanOptional(r.plant) || "", mo = cleanOptional(r.month);
    if (!ic || !mo) return;
    var k = ic + "|" + pl + "|" + mo;
    globalPlanMap.set(k, (globalPlanMap.get(k) || 0) + (cleanNumber(r.supplyQty) || 0));
  });

  var hasRtfAdj    = Object.keys(state.matSimAdj || {}).length > 0;
  var matAdjBomMap = hasRtfAdj ? buildBomMaxProducibleMap(state.matSimAdj) : null;

  // 전체 품목 + 초과 여부 플래그
  var allFgItems = rtfItems.filter(function(item) {
    if (plantFilter !== "all" && item.plantCode !== plantFilter) return false;
    return true;
  }).map(function(item) {
    var td  = targetMap.get(item.itemCode) || null;
    var ms0 = item.monthlyStatus && item.monthlyStatus[0];
    var isExcess = !!(td && ms0 && Number.isFinite(ms0.inventoryDays) && ms0.inventoryDays > td);
    var excessAmt = 0;
    if (isExcess && ms0 && item.hasCost && ms0.salesQty > 0) {
      var tgtAmt = (ms0.salesQty / monthDays(months[0])) * td * item.standardCost;
      excessAmt  = Math.max(0, (ms0.endingAmount || 0) - tgtAmt);
    }
    return Object.assign({}, item, { _td: td, _isExcess: isExcess, _excessAmt: excessAmt });
  });

  // 정렬: 초과품목(초과금액 내림차순) → 비초과품목(재고일수 내림차순)
  allFgItems.sort(function(a, b) {
    if (a._isExcess && !b._isExcess) return -1;
    if (!a._isExcess && b._isExcess) return 1;
    if (a._isExcess && b._isExcess) return b._excessAmt - a._excessAmt;
    var da = (a.monthlyStatus[0] && a.monthlyStatus[0].inventoryDays) || 0;
    var db = (b.monthlyStatus[0] && b.monthlyStatus[0].inventoryDays) || 0;
    return db - da;
  });

  var excessFgItems = allFgItems.filter(function(i) { return i._isExcess; });
  var displayItems  = showOnlyExcess ? excessFgItems : allFgItems;

  var hasCostAny = excessFgItems.some(function(i){ return i.standardCost > 0; });
  var byMonth    = calcExcessScenarios(excessFgItems, months, globalPlanMap, matAdjBomMap);

  // 플랜트 목록
  var plantSet  = new Set();
  rtfItems.forEach(function(i){ if (i.plantCode) plantSet.add(i.plantCode); });
  var plantList = Array.from(plantSet).sort();
  var plantOpts = "<option value='all'" + (plantFilter==="all"?" selected":"") + ">전체 플랜트</option>" +
    plantList.map(function(p){
      var label = displayPlantName ? displayPlantName(p) : p;
      return "<option value='" + escapeHtml(p) + "'" + (plantFilter===p?" selected":"") + ">" + escapeHtml(label) + "</option>";
    }).join("");

  var hasAnyAdj = Object.keys(state.excessAdj).length > 0;
  var targetWarn = !hasTargetData
    ? "<span class='exc-no-target-warn'>⚠ 적정재고 파일 미연결</span>"
    : "";

  // 최우선 감축 대상 — 초과금액 Top 3 한 줄 표시 (AI 섹션 대체)
  var priorityHtml = "";
  var topItems = excessFgItems.filter(function(i){ return i._excessAmt > 0; }).slice(0, 3);
  if (topItems.length) {
    priorityHtml = "<div class='exc-priority-strip'>" +
      "<span class='exc-priority-label'>최우선 감축</span>" +
      topItems.map(function(item, idx) {
        var rowKey = item.itemCode + "|" + (item.plantCode || "");
        return "<button class='exc-priority-chip' data-ai-code='" + escapeHtml(rowKey) + "'>" +
          "<span class='exc-priority-rank'>" + (idx + 1) + "</span>" +
          escapeHtml(item.itemName || item.itemCode) +
          (item._excessAmt > 0 ? "<span class='exc-priority-amt'>" + escapeHtml(formatMoney(item._excessAmt)) + "</span>" : "") +
        "</button>";
      }).join("") +
    "</div>";
  }

  var controls = "<div class='exc-controls'>" +
    "<div class='exc-show-toggle'>" +
      "<button class='exc-show-btn" + (!showOnlyExcess ? " exc-show-active" : "") + "' data-show='all'>전체 (" + allFgItems.length + ")</button>" +
      "<button class='exc-show-btn" + ( showOnlyExcess ? " exc-show-active" : "") + "' data-show='excess'>초과만 (" + excessFgItems.length + ")</button>" +
    "</div>" +
    "<select class='exc-plant-filter'>" + plantOpts + "</select>" +
    (hasAnyAdj ? "<button class='exc-reset-all-btn'>↺ 초기화</button>" : "") +
    targetWarn +
  "</div>";

  return "<div class='exc-screen'><div class='exc-inner'>" +
    renderExcessImpactKpi(byMonth, hasCostAny) +
    priorityHtml +
    controls +
    "<div class='exc-fg-area'>" +
      renderExcessFgTable(displayItems, months, globalPlanMap, hasTargetData) +
    "</div>" +
  "</div></div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. 이벤트 바인딩
// ═══════════════════════════════════════════════════════════════════════════
function bindExcessAdjustment() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;

  // Chart.js 초기화
  var rtfItems  = computeRtfItems();
  var months    = getRtfMonths();
  var targetMap = new Map();
  (state.mappedData.target_inv || []).forEach(function(r){ if(r.itemCode) targetMap.set(r.itemCode, r.targetDays); });
  var globalPlanMap = new Map();
  (state.mappedData.plan_monthly || []).forEach(function(r){
    var ic=cleanOptional(r.itemCode), pl=cleanOptional(r.plant)||"", mo=cleanOptional(r.month);
    if(!ic||!mo) return;
    var k=ic+"|"+pl+"|"+mo;
    globalPlanMap.set(k,(globalPlanMap.get(k)||0)+(cleanNumber(r.supplyQty)||0));
  });
  var plantFilter   = state.excessPlant || "all";
  var hasRtfAdj     = Object.keys(state.matSimAdj || {}).length > 0;
  var matAdjBomMap  = hasRtfAdj ? buildBomMaxProducibleMap(state.matSimAdj) : null;
  var excessFgItems = rtfItems.filter(function(item){
    var td=targetMap.get(item.itemCode), ms0=item.monthlyStatus&&item.monthlyStatus[0];
    if(!(td&&ms0&&Number.isFinite(ms0.inventoryDays)&&ms0.inventoryDays>td)) return false;
    if(plantFilter!=="all"&&item.plantCode!==plantFilter) return false;
    return true;
  }).map(function(item){
    var ms0=item.monthlyStatus[0], td=targetMap.get(item.itemCode), excessAmt=0;
    if(ms0&&item.hasCost&&ms0.salesQty>0){
      var tgtAmt=(ms0.salesQty/monthDays(months[0]))*td*item.standardCost;
      excessAmt=Math.max(0,(ms0.endingAmount||0)-tgtAmt);
    }
    return Object.assign({},item,{_excessAmt:excessAmt,_td:td});
  }).sort(function(a,b){ return b._excessAmt-a._excessAmt; });

  var hasCostAny = excessFgItems.some(function(i){ return i.standardCost>0; });
  var byMonth    = calcExcessScenarios(excessFgItems, months, globalPlanMap, matAdjBomMap);
  // 차트 제거됨 (v303 심플화)

  // 플랜트 필터
  var plantSel = root.querySelector(".exc-plant-filter");
  if (plantSel) {
    plantSel.addEventListener("change", function() {
      state.excessPlant = plantSel.value || "all";
      render("inventory-variance");
    });
  }

  // 전체 초기화
  var resetAllBtn = root.querySelector(".exc-reset-all-btn");
  if (resetAllBtn) {
    resetAllBtn.addEventListener("click", function() {
      state.excessAdj = {};
      state.excessExpandedRows = new Set();
      render("inventory-variance");
    });
  }

  // 드릴다운 탭 전환 (리렌더 없이 DOM 토글)
  root.querySelectorAll(".exc-drill-tab").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var tab    = btn.dataset.tab;
      var rowKey = btn.dataset.rowKey;
      var panel  = btn.closest(".exc-drill-panel");
      if (!panel || !tab) return;
      // 탭 버튼 active 전환
      panel.querySelectorAll(".exc-drill-tab").forEach(function(b) {
        b.classList.toggle("exc-drill-tab-active", b.dataset.tab === tab);
      });
      // 패널 show/hide
      panel.querySelectorAll(".exc-drill-pane").forEach(function(pane) {
        pane.style.display = pane.classList.contains("exc-drill-pane-" + tab) ? "" : "none";
      });
      // 상태 저장 (재렌더 시 탭 유지)
      if (!state.excessDrillTabMap) state.excessDrillTabMap = {};
      state.excessDrillTabMap[rowKey] = tab;
    });
  });

  // 전체/초과 토글
  root.querySelectorAll(".exc-show-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      state.excessShowOnly = (btn.dataset.show === "excess");
      render("inventory-variance");
    });
  });

  // 드릴다운 펼치기/닫기
  root.querySelectorAll(".exc-expand-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var key = btn.dataset.rowKey;
      if (!key) return;
      if (state.excessExpandedRows.has(key)) state.excessExpandedRows.delete(key);
      else state.excessExpandedRows.add(key);
      render("inventory-variance");
    });
  });

  // PSI 수량 입력
  root.querySelectorAll(".exc-psi-input").forEach(function(input) {
    input.addEventListener("change", function() {
      var key  = input.dataset.key;
      var val  = parseFloat(input.value);
      var orig = parseFloat(input.dataset.orig) || 0;
      if (!Number.isFinite(val) || val < 0) { input.value = 0; return; }
      if (Math.abs(val - orig) < 0.01) delete state.excessAdj[key];
      else state.excessAdj[key] = val;
      render("inventory-variance");
    });
  });

  // 행 단위 초기화
  root.querySelectorAll(".exc-psi-reset").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var code  = btn.dataset.itemCode;
      var plant = btn.dataset.plant || "";
      getRtfMonths().forEach(function(m) { delete state.excessAdj[code + "|" + plant + "|" + m]; });
      render("inventory-variance");
    });
  });

  // 최우선 감축 칩 클릭 → 해당 품목 펼치기 + 스크롤
  root.querySelectorAll(".exc-priority-chip").forEach(function(chip) {
    chip.addEventListener("click", function() {
      var key = chip.dataset.aiCode;
      if (!key) return;
      state.excessExpandedRows.add(key);
      state.excessShowOnly = false;
      render("inventory-variance");
      setTimeout(function() {
        var row = document.querySelector("[data-row-key='" + CSS.escape(key) + "']");
        if (row) row.scrollIntoView({ behavior:"smooth", block:"center" });
      }, 150);
    });
  });
}
