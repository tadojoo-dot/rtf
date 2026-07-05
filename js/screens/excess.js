// ── 과잉감축 화면 (v300) ────────────────────────────────────────────────────

var MAT_TARGET_DAYS  = 180;
// 자재 재고일수 상식 상한 (초과 시 단위·데이터 정합 의심 → 과잉관리·AI·KPI 반영 제외)
// 예: 계획수량이 정(TB)인데 단위라벨 KG인 반제품 → 일수 수백만일로 튐
var MAT_SANITY_DAYS  = 1800;
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
  var _seenBom = new Set();
  bomComponents.forEach(function(b) {
    if (!b.componentCode || !(b.componentQty > 0)) return;
    // 기본 BOM만 사용 (constraint-engine과 동일) — 대체 BOM 포함 시 중복합산됨
    var alt = cleanOptional(b.alternativeBom);
    if (alt !== "" && alt !== "1") return;
    // 완전 중복행 제거 (constraint-engine과 동일)
    var dupKey = b.rootItemCode + "|" + b.componentCode + "|" + b.componentQty + "|" + b.baseQty + "|" + b.plant;
    if (_seenBom.has(dupKey)) return;
    _seenBom.add(dupKey);
    var k = (cleanOptional(b.rootItemCode) || "") + "|" + (cleanOptional(b.plant) || "");
    if (!bomByFg.has(k)) bomByFg.set(k, []);
    // 소요계수 = 구성요소수량 ÷ 기준수량 (constraint-engine과 동일). 기준수량이
    // 1이 아닌 배치단위(예: 80000)일 때 나눠주지 않으면 소요량이 수만배 부풀려진다.
    var compQty = cleanNumber(b.componentQty) || 0;
    var baseQty = cleanNumber(b.baseQty);
    var ratio   = (baseQty && baseQty > 0) ? compQty / baseQty : compQty;
    bomByFg.get(k).push({ compCode: cleanOptional(b.componentCode), compQty: ratio });
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

  // 3시나리오 KPI 배너 (RTF·공급원인과 동일 기준: 전체재고·공시·관리, RTF/감축 delta 분해)
  var bannerHtml = (typeof renderScenarioKpiBanner === "function") ? renderScenarioKpiBanner() : "";

  // AI 과잉재고 진단 패널 — 원인 분류 + 액션(오너)별 아코디언, 섹션별 권장안 적용
  var aiHtml = renderAiDiagPanel(hasTargetData);

  // 탭: 제·상품 (적정재고 기준) | 원부자재 (180일 기준)
  var excessTab = state.excessTab === "mat" ? "mat" : "fg";
  var tabBar = "<div class='exc-tabbar'>" +
    "<button class='exc-tab-btn" + (excessTab === "fg"  ? " exc-tab-active" : "") + "' data-extab='fg'>제·상품 <span class='exc-tab-sub'>적정재고 기준</span></button>" +
    "<button class='exc-tab-btn" + (excessTab === "mat" ? " exc-tab-active" : "") + "' data-extab='mat'>원부자재 <span class='exc-tab-sub'>" + MAT_TARGET_DAYS + "일 기준</span></button>" +
  "</div>";

  var bodyHtml = excessTab === "fg"
    ? priorityHtml + controls +
      "<div class='exc-fg-area'>" + renderExcessFgFlatTable(displayItems, months, globalPlanMap) + "</div>"
    : "<div class='exc-fg-area'>" + renderExcessMatTable(months) + "</div>";

  return "<div class='exc-screen'><div class='exc-inner'>" +
    bannerHtml +
    aiHtml +
    tabBar +
    bodyHtml +
  "</div></div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// AI 감축 선제안 — 품목별 재고일수가 적정일수에 수렴하도록 공급계획 자동 차감
// 제약: 감축 후에도 모든 미래 월 기말재고 ≥ 0 (품절 0건 보장), 해당 월 공급량 한도
// ═══════════════════════════════════════════════════════════════════════════
function computeAiExcessPlan() {
  var months = getRtfMonths();
  var targetMap = new Map();
  (state.mappedData.target_inv || []).forEach(function(r) {
    if (r.itemCode) targetMap.set(r.itemCode, r.targetDays);
  });
  if (!targetMap.size) return { plan: {}, totalCutAmt: 0, itemCnt: 0 };

  // 기준 = RTF조정후 시나리오의 실제 재고 흐름 (BOM 제약·상품입고 조정 반영된 endingQty).
  // 감축 한도를 "이후 모든 월의 실제 기말재고 최솟값"으로 잡으므로 품절이 새로 생길 수 없음
  // (공급을 줄여도 기말재고는 최대 감축량만큼만 내려가기 때문).
  var baseItems = (typeof computeScenarioItemSets === "function")
    ? computeScenarioItemSets().rtfAdj
    : computeRtfItems();

  var plan = {}, totalCutAmt = 0, itemCnt = 0, aiItems = [];
  baseItems.forEach(function(item) {
    var td = targetMap.get(item.itemCode);
    if (!td || !item.hasInventory) return;

    // 유효 구간: 계획·재고가 이어진 앞부분까지만 (이후는 판단 불가 → 감축 제외)
    var sales = [], supply = [], ending = [], validLen = 0;
    for (var i = 0; i < months.length; i++) {
      var ms = item.monthlyStatus && item.monthlyStatus[i];
      if (!ms || !Number.isFinite(ms.endingQty) || !Number.isFinite(ms.supplyQty)) break;
      sales.push(ms.salesQty || 0);
      supply.push(ms.supplyQty);
      ending.push(ms.endingQty);
      validLen++;
    }
    if (!validLen) return;

    var changed = false;
    var itemCutQty = 0, itemCutAmt = 0, itemKeys = [], itemPlanVals = {};
    for (var mi = 0; mi < validLen; mi++) {
      var dailySales = sales[mi] > 0 ? sales[mi] / monthDays(months[mi]) : 0;
      if (dailySales <= 0) continue;
      var excess = ending[mi] - td * dailySales; // 적정재고 초과분
      if (excess <= 0) continue;
      // 안전 한도: 이 달 공급 감축은 이후 모든 월 기말을 같이 낮춤 → 최소 미래기말까지만
      var minFuture = Infinity;
      for (var k2 = mi; k2 < validLen; k2++) minFuture = Math.min(minFuture, ending[k2]);
      var cut = Math.floor(Math.min(excess, supply[mi], Math.max(0, minFuture)));
      if (cut <= 0) continue;
      supply[mi] -= cut;
      for (var k3 = mi; k3 < validLen; k3++) ending[k3] -= cut;
      var planKey = item.itemCode + "|" + (item.plantCode || "") + "|" + months[mi];
      plan[planKey] = supply[mi];
      itemKeys.push(planKey);
      itemPlanVals[planKey] = supply[mi];
      itemCutQty += cut;
      if (Number.isFinite(item.unitInvValue)) {
        totalCutAmt += cut * item.unitInvValue;
        itemCutAmt  += cut * item.unitInvValue;
      }
      changed = true;
    }
    if (changed) {
      itemCnt++;
      var salesSum = 0;
      for (var si = 0; si < validLen; si++) salesSum += sales[si];
      aiItems.push({
        itemCode: item.itemCode, itemName: item.itemName || item.itemCode,
        plantCode: item.plantCode || "", targetDays: td,
        cutQty: itemCutQty, cutAmt: itemCutAmt,
        keys: itemKeys, planVals: itemPlanVals,
        planAvgSales: validLen ? salesSum / validLen : 0,
      });
    }
  });
  return { plan: plan, totalCutAmt: totalCutAmt, itemCnt: itemCnt, items: aiItems };
}

// ═══════════════════════════════════════════════════════════════════════════
// AI 과잉재고 진단 — 원인 분류 + 액션(오너)별 권장안 그룹핑
// 근거 데이터: 적정재고_RAW의 25년 월별 출고실적 · 26년 출고실적 · S/F 예측 · MOQ
// ═══════════════════════════════════════════════════════════════════════════
var AI_ACH_LOW     = 0.8;  // S/F 대비 실적 달성률 — 미만이면 판매부진
var AI_PLAN_HIGH   = 1.3;  // 계획 월평균 ÷ 실적 월평균 — 초과면 계획과대
var AI_PLAN_LOW    = 0.7;  // 미만이면 수요감소 (계획은 이미 낮췄으나 기존 재고 잔류)
var AI_UNIT_SUSPECT = 20;  // 계획/실적 비율이 이 배수 밖이면 단위불일치 의심 → 교차비교 제외

var AI_CAUSE_META = {
  under:      { label: "판매부진", cls: "under" },
  overplan:   { label: "계획과대", cls: "overplan" },
  demanddown: { label: "수요감소", cls: "down" },
  overbase:   { label: "기준초과", cls: "base" },
  moq:        { label: "MOQ구조", cls: "moq" },
  noplan:     { label: "계획누락", cls: "noplan" },
  stopped:    { label: "판매중단", cls: "stopped" },
  dormant:    { label: "장기불용", cls: "dormant" },
  unknown:    { label: "이력미상", cls: "unknown" },
};

// AI 감축안의 각 품목을 원인 분류 → 액션 섹션(공급감축/계획보정/정책개선)으로 배분
function classifyAiExcess() {
  var ai = computeAiExcessPlan();
  var tiMap = new Map();
  (state.mappedData.target_inv || []).forEach(function(r) { if (r.itemCode) tiMap.set(r.itemCode, r); });

  var sections = {
    supply:  { items: [], totalAmt: 0 },
    planfix: { items: [], totalAmt: 0 },
    policy:  { items: [], totalAmt: 0 },
  };
  (ai.items || []).forEach(function(it) {
    var ti = tiMap.get(it.itemCode) || {};
    var sf = ti.sfByMonth || {}, o26 = ti.outCurYear || {}, o25 = ti.outPrevYear || {};

    // S/F 대비 달성률 (예측·실적이 둘 다 있는 월끼리만)
    var sfSum = 0, actSum = 0, bothCnt = 0;
    Object.keys(sf).forEach(function(m) {
      if (o26[m] !== undefined) { sfSum += sf[m]; actSum += o26[m]; bothCnt++; }
    });
    var ach = bothCnt > 0 && sfSum > 0 ? actSum / sfSum : null;

    // 실적 run-rate: 26년 월평균 → 25년 월평균 → 12개월 평균 출고 순 폴백
    var vals26 = Object.keys(o26).map(function(m) { return o26[m]; });
    var vals25 = Object.keys(o25).map(function(m) { return o25[m]; });
    var runRate = null;
    if (vals26.length && vals26.some(function(v) { return v > 0; }))
      runRate = vals26.reduce(function(a, b) { return a + b; }, 0) / vals26.length;
    else if (vals25.length && vals25.some(function(v) { return v > 0; }))
      runRate = vals25.reduce(function(a, b) { return a + b; }, 0) / vals25.length;
    else if (Number.isFinite(ti.avg12OutQty) && ti.avg12OutQty > 0)
      runRate = ti.avg12OutQty;

    // 계획/실적 비율 (단위불일치 의심 시 교차비교 사용 안 함)
    var ratio = runRate > 0 && it.planAvgSales > 0 ? it.planAvgSales / runRate : null;
    if (ratio !== null && (ratio > AI_UNIT_SUSPECT || ratio < 1 / AI_UNIT_SUSPECT)) ratio = null;

    var secId;
    if (Number.isFinite(ti.moq) && ti.moq > 0 && it.cutQty <= ti.moq) {
      it.cause = "moq"; secId = "policy";
      it.evidence = "권장 감축 " + formatNumber(Math.round(it.cutQty)) + " ≤ MOQ " +
        formatNumber(Math.round(ti.moq)) + " — 발주단위 협의 필요";
    } else if (ach !== null && ach < AI_ACH_LOW) {
      it.cause = "under"; secId = "supply";
      it.evidence = "S/F 대비 달성 " + Math.round(ach * 100) + "% (26년 " + bothCnt + "개월: 예측 " +
        formatNumber(Math.round(sfSum)) + " vs 실적 " + formatNumber(Math.round(actSum)) + ")";
    } else if (ratio !== null && ratio > AI_PLAN_HIGH) {
      it.cause = "overplan"; secId = "planfix";
      it.evidence = "계획 월평균 " + formatNumber(Math.round(it.planAvgSales)) + " = 실적 월평균 " +
        formatNumber(Math.round(runRate)) + "의 " + ratio.toFixed(1) + "배";
    } else if (ratio !== null && ratio < AI_PLAN_LOW) {
      it.cause = "demanddown"; secId = "supply";
      it.evidence = "향후 계획이 실적 월평균의 " + Math.round(ratio * 100) + "% — 수요 축소분 재고 잔류";
    } else {
      it.cause = "overbase"; secId = "supply";
      it.evidence = "적정 " + Math.round(it.targetDays) + "일 대비 재고일수 초과";
    }
    sections[secId].items.push(it);
    sections[secId].totalAmt += it.cutAmt;
  });
  Object.keys(sections).forEach(function(k) {
    sections[k].items.sort(function(a, b) { return b.cutAmt - a.cutAmt; });
  });
  return { sections: sections, noPlan: computeNoPlanInventory(), ai: ai };
}

// 판매계획에 아예 없는 제·상품 재고 → 소진요청(마케팅) / 처분검토(사업부) 후보
// 범위: 판매계획 파일에 등장하는 사업부의 품목만 (타 사업부 재고는 이 회의 범위 밖 → 제외 집계)
function computeNoPlanInventory() {
  var planned = new Set();
  (state.mappedData.plan_monthly || []).forEach(function(r) { if (r.itemCode) planned.add(r.itemCode); });
  if (!planned.size) return { sellout: [], disposal: [], excludedCnt: 0, excludedAmt: 0 };
  var tiMap = new Map();
  (state.mappedData.target_inv || []).forEach(function(r) { if (r.itemCode) tiMap.set(r.itemCode, r); });
  var buMap = new Map();
  (state.mappedData.item_master || []).forEach(function(r) {
    if (r.itemCode && r.businessUnit) buMap.set(r.itemCode, r.businessUnit);
  });
  var planBUs = new Set();
  planned.forEach(function(code) {
    var bu = buMap.get(code);
    if (bu) planBUs.add(bu);
  });

  var agg = new Map();
  (state.mappedData.inventory_base || []).forEach(function(r) {
    var t = String(r.itemType || "");
    if (t.indexOf("완제품") < 0 && t.indexOf("상품") < 0) return;
    if (!r.itemCode || planned.has(r.itemCode)) return;
    var qty = Number.isFinite(r.baseQty) ? r.baseQty : 0;
    var amt = Number.isFinite(r.baseAmount) ? r.baseAmount : 0;
    if (qty <= 0 && amt <= 0) return;
    var a = agg.get(r.itemCode);
    if (!a) { a = { itemCode: r.itemCode, itemName: r.itemName || "", itemType: t, qty: 0, amt: 0 }; agg.set(r.itemCode, a); }
    a.qty += qty; a.amt += amt;
    if (!a.itemName && r.itemName) a.itemName = r.itemName;
  });

  var firstPlanMonth = parseInt((getRtfMonths()[0] || "").slice(5), 10) || "";
  var sellout = [], disposal = [], excludedCnt = 0, excludedAmt = 0;
  agg.forEach(function(a) {
    var ti = tiMap.get(a.itemCode);
    var bu = buMap.get(a.itemCode) || (ti ? ti.businessUnit : null);
    if (planBUs.size && (!bu || !planBUs.has(bu))) { excludedCnt++; excludedAmt += a.amt; return; }
    a.bu = bu;
    var o26 = ti ? ti.outCurYear || {} : {};
    var o25 = ti ? ti.outPrevYear || {} : {};
    var s26 = 0, last26 = null;
    Object.keys(o26).sort().forEach(function(m) { s26 += o26[m]; if (o26[m] > 0) last26 = m; });
    var s25 = Object.keys(o25).reduce(function(s, m) { return s + o25[m]; }, 0);
    if (s26 > 0) {
      a.cause = "noplan";
      a.evidence = "26년 출고 " + formatNumber(Math.round(s26)) +
        (last26 ? " (최근 " + last26.slice(2).replace("-", ".") + ")" : "") +
        " — " + firstPlanMonth + "월 이후 판매계획 없음";
      sellout.push(a);
    } else if (s25 > 0) {
      a.cause = "stopped";
      a.evidence = "25년 출고 " + formatNumber(Math.round(s25)) + " 이후 26년 출고 0 — 판매중단 추정";
      disposal.push(a);
    } else if (ti) {
      a.cause = "dormant";
      a.evidence = "25~26년 출고 이력 없음";
      disposal.push(a);
    } else {
      a.cause = "unknown";
      a.evidence = "적정재고·실적 파일에 없는 품목 — 이력 확인 필요";
      disposal.push(a);
    }
  });
  var byAmt = function(x, y) { return y.amt - x.amt; };
  sellout.sort(byAmt);
  disposal.sort(byAmt);
  return { sellout: sellout, disposal: disposal, excludedCnt: excludedCnt, excludedAmt: excludedAmt };
}

// AI 진단 패널 (아코디언) — 닫힌 상태에서도 섹션별 요약·적용 버튼 노출
var AI_SECTION_DEFS = [
  { id: "supply",   no: "①", title: "공급 감축",     owner: "공장·구매",     desc: "입고 취소·연기·생산 축소 — 감축 시나리오 KPI에 반영됩니다." },
  { id: "planfix",  no: "②", title: "판매계획 보정", owner: "마케팅·영업",   desc: "실적 대비 과대한 판매계획 — 계획 하향 검토 요청 + 해당 공급 감축." },
  { id: "sellout",  no: "③", title: "소진 촉진",     owner: "마케팅",        desc: "최근까지 출고되던 품목인데 판매계획 누락 — 계획 반영 또는 소진 요청. (실행 주체가 마케팅이므로 KPI 미반영, 액션아이템)" },
  { id: "disposal", no: "④", title: "처분 검토",     owner: "사업부",        desc: "판매중단·장기불용 재고 — 폐기/할인처분 검토. (손실 인식 수반 — 감축 성과와 분리 집계)" },
  { id: "policy",   no: "⑤", title: "발주정책 개선", owner: "구매·생산기획", desc: "MOQ·발주단위 제약으로 미세 감축이 불가한 품목 — 발주정책 재협상 안건. (감축 적용 보류)" },
];

function renderAiDiagPanel(hasTargetData) {
  if (!hasTargetData) return "";
  var cls   = classifyAiExcess();
  var aiMat = computeAiMatExcessPlan(Object.assign({}, state.excessAdj || {}, cls.ai.plan));
  state.aiSecApplied = state.aiSecApplied || {};
  state.aiDiagOpen   = state.aiDiagOpen   || {};
  var S = cls.sections, np = cls.noPlan;

  var fgCnt    = S.supply.items.length + S.planfix.items.length + S.policy.items.length;
  var cutTotal = S.supply.totalAmt + S.planfix.totalAmt + (aiMat.totalCutAmt || 0);
  var identAmt = np.sellout.concat(np.disposal).reduce(function(s, a) { return s + a.amt; }, 0);
  if (!fgCnt && !aiMat.itemCnt && !np.sellout.length && !np.disposal.length) return "";

  var anyApplied = Object.keys(state.aiExcessKeys || {}).length > 0 ||
                   Object.keys(state.aiMatKeys || {}).length > 0;
  var allApplied = !!(state.aiSecApplied.supply && state.aiSecApplied.planfix);

  function chip(cause) {
    var meta = AI_CAUSE_META[cause] || AI_CAUSE_META.overbase;
    return "<span class='exc-ai-chip exc-ai-chip-" + meta.cls + "'>" + meta.label + "</span>";
  }
  function nameCell(code, name, plant) {
    var pl = plant && typeof displayPlantName === "function" ? displayPlantName(plant) : (plant || "");
    return "<td class='exc-ai-nm'>" + escapeHtml(name || code) +
      " <span class='exc-ai-code'>" + escapeHtml(code) + (pl ? "·" + escapeHtml(pl) : "") + "</span></td>";
  }
  var MAXR = 100;
  function cutRows(items) {
    if (!items.length) return "<div class='exc-aisec-empty'>해당 품목 없음</div>";
    var html = "<table class='exc-ai-table'><tbody>" + items.slice(0, MAXR).map(function(it) {
      return "<tr>" + nameCell(it.itemCode, it.itemName, it.plantCode) +
        "<td class='exc-ai-chipcell'>" + chip(it.cause) + "</td>" +
        "<td class='exc-ai-evid'>" + escapeHtml(it.evidence) + "</td>" +
        "<td class='exc-ai-cut'>-" + formatNumber(Math.round(it.cutQty)) +
          " <span class='exc-ai-amt'>-" + escapeHtml(formatMoney(it.cutAmt)) + "</span></td></tr>";
    }).join("") + "</tbody></table>";
    if (items.length > MAXR) html += "<div class='exc-aisec-more'>외 " + (items.length - MAXR) + "품목</div>";
    return html;
  }
  function invRows(items) {
    if (!items.length) return "<div class='exc-aisec-empty'>해당 품목 없음</div>";
    var html = "<table class='exc-ai-table'><tbody>" + items.slice(0, MAXR).map(function(a) {
      return "<tr><td class='exc-ai-nm'>" + escapeHtml(a.itemName || a.itemCode) +
        " <span class='exc-ai-code'>" + escapeHtml(a.itemCode) + (a.bu ? "·" + escapeHtml(a.bu) : "") + "</span></td>" +
        "<td class='exc-ai-chipcell'>" + chip(a.cause) + "</td>" +
        "<td class='exc-ai-evid'>" + escapeHtml(a.evidence) + "</td>" +
        "<td class='exc-ai-cut'>재고 " + formatNumber(Math.round(a.qty)) +
          " <span class='exc-ai-amt'>" + escapeHtml(formatMoney(a.amt)) + "</span></td></tr>";
    }).join("") + "</tbody></table>";
    if (items.length > MAXR) html += "<div class='exc-aisec-more'>외 " + (items.length - MAXR) + "품목</div>";
    return html;
  }
  function applyBtn(secId, hasContent) {
    if (!hasContent) return "";
    var on = !!state.aiSecApplied[secId];
    return "<button class='exc-aisec-apply" + (on ? " exc-aisec-apply-on" : "") + "' data-sec='" + secId + "'>" +
      (on ? "적용 해제" : "권장안 적용") + "</button>";
  }
  function secBlock(def, sumHtml, bodyHtml, btnHtml) {
    var isOpen  = !!state.aiDiagOpen[def.id];
    var applied = !!state.aiSecApplied[def.id];
    return "<div class='exc-aisec" + (applied ? " exc-aisec-on" : "") + "'>" +
      "<div class='exc-aisec-head' data-sec='" + def.id + "'>" +
        "<span class='exc-aisec-chev'>" + (isOpen ? "▾" : "▸") + "</span>" +
        "<span class='exc-aisec-no'>" + def.no + "</span>" +
        "<span class='exc-aisec-title'>" + def.title + "</span>" +
        "<span class='exc-aisec-owner'>" + def.owner + "</span>" +
        (applied ? "<span class='exc-aisec-badge'>✓ 적용됨</span>" : "") +
        "<span class='exc-aisec-sum'>" + sumHtml + "</span>" + btnHtml +
      "</div>" +
      "<div class='exc-aisec-body'" + (isOpen ? "" : " hidden") + ">" +
        "<div class='exc-aisec-desc'>" + def.desc + "</div>" + bodyHtml +
      "</div></div>";
  }

  var matLine = aiMat.itemCnt > 0
    ? "<div class='exc-aisec-mat'>원부자재 <strong>" + aiMat.itemCnt + "종 -" + escapeHtml(formatMoney(aiMat.totalCutAmt)) +
      "</strong> — 입고 취소·연기 권장 (상세: 원부자재 탭, 공급 감축 적용 시 함께 반영)</div>"
    : "";

  var sumOf = {
    supply: (S.supply.items.length ? "제·상품 " + S.supply.items.length + "품목 <strong>-" + escapeHtml(formatMoney(S.supply.totalAmt)) + "</strong>" : "") +
            (aiMat.itemCnt > 0 ? (S.supply.items.length ? " · " : "") + "자재 " + aiMat.itemCnt + "종 <strong>-" + escapeHtml(formatMoney(aiMat.totalCutAmt)) + "</strong>" : "") ||
            "<span class='exc-aisec-none'>해당 없음</span>",
    planfix: S.planfix.items.length ? S.planfix.items.length + "품목 <strong>-" + escapeHtml(formatMoney(S.planfix.totalAmt)) + "</strong>" : "<span class='exc-aisec-none'>해당 없음</span>",
    sellout: np.sellout.length ? np.sellout.length + "품목 재고 <strong>" + escapeHtml(formatMoney(np.sellout.reduce(function(s, a) { return s + a.amt; }, 0))) + "</strong>" : "<span class='exc-aisec-none'>해당 없음</span>",
    disposal: np.disposal.length ? np.disposal.length + "품목 재고 <strong>" + escapeHtml(formatMoney(np.disposal.reduce(function(s, a) { return s + a.amt; }, 0))) + "</strong>" : "<span class='exc-aisec-none'>해당 없음</span>",
    policy: S.policy.items.length ? S.policy.items.length + "품목 (감축 보류 " + escapeHtml(formatMoney(S.policy.totalAmt)) + ")" : "<span class='exc-aisec-none'>해당 없음</span>",
  };
  var excludedNote = np.excludedCnt > 0
    ? "<div class='exc-aisec-more'>※ 판매계획 파일 범위 밖 사업부·미분류 " + np.excludedCnt + "품목(" +
      escapeHtml(formatMoney(np.excludedAmt)) + ")은 이 회의 대상에서 제외</div>"
    : "";
  var bodyOf = {
    supply:   matLine + cutRows(S.supply.items),
    planfix:  cutRows(S.planfix.items),
    sellout:  invRows(np.sellout),
    disposal: invRows(np.disposal) + excludedNote,
    policy:   cutRows(S.policy.items),
  };
  var btnOf = {
    supply:  applyBtn("supply", S.supply.items.length > 0 || aiMat.itemCnt > 0),
    planfix: applyBtn("planfix", S.planfix.items.length > 0),
    sellout: "", disposal: "", policy: "",
  };

  var headBtns = (!allApplied ? "<button class='exc-ai-apply'>권장안 전체적용</button>" : "") +
                 (anyApplied ? "<button class='exc-ai-clear'>전체해제</button>" : "");
  var head = "<div class='exc-ai-panel-head'>" +
    "<span class='exc-ai-icon'>🤖</span>" +
    "<span class='exc-ai-text'><strong>AI 과잉재고 진단</strong> — 원인 분석 " + fgCnt + "품목 · 액션 5분류 · 감축 가능 <strong>-" +
      escapeHtml(formatMoney(cutTotal)) + "</strong> (품절 0 유지)" +
      (identAmt > 0 ? " · 소진·처분 식별 <strong>" + escapeHtml(formatMoney(identAmt)) + "</strong>" : "") +
    "</span>" + headBtns + "</div>";

  return "<div class='exc-ai-panel'>" + head +
    AI_SECTION_DEFS.map(function(def) { return secBlock(def, sumOf[def.id], bodyOf[def.id], btnOf[def.id]); }).join("") +
    "</div>";
}

// 섹션 단위 권장안 적용/해제 — 확정 상태는 aiSecApplied, 적용 키는 aiExcessKeys로 추적
function toggleAiSection(secId) {
  var cls = classifyAiExcess();
  var s = cls.sections[secId];
  if (!s) return;
  state.aiSecApplied = state.aiSecApplied || {};
  state.aiExcessKeys = state.aiExcessKeys || {};
  var applied = !!state.aiSecApplied[secId];
  s.items.forEach(function(it) {
    it.keys.forEach(function(k) {
      if (applied) { delete state.excessAdj[k]; delete state.aiExcessKeys[k]; }
      else { state.excessAdj[k] = it.planVals[k]; state.aiExcessKeys[k] = true; }
    });
  });
  state.aiSecApplied[secId] = !applied;
  syncAiMatPlan();
  render("inventory-variance");
}

// 자재 권장안을 현재 적용된 제·상품 감축과 정합하게 재산출 (공급감축 섹션에 종속)
function syncAiMatPlan() {
  Object.keys(state.aiMatKeys || {}).forEach(function(k) { delete state.matExcessAdj[k]; });
  state.aiMatKeys = {};
  if (state.aiSecApplied && state.aiSecApplied.supply) {
    var aiMat = computeAiMatExcessPlan(Object.assign({}, state.excessAdj || {}));
    Object.keys(aiMat.plan).forEach(function(k) {
      state.matExcessAdj[k] = aiMat.plan[k];
      state.aiMatKeys[k] = true;
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 원부자재 과잉 관리 (180일 기준) — BOM matFlows 기반
// ═══════════════════════════════════════════════════════════════════════════
// 자재 월별 흐름 계산: 소비(BOM 소요, 제상품 감축 비례 반영) / 입고(matExcessAdj 반영)
function calcMatFlowRows(fgAdj, matAdj) {
  if (!(typeof BOM_STATUS !== "undefined" && state.bomStatus === BOM_STATUS.DONE &&
        state.bomResult && state.bomResult.matFlows)) return null;
  var months = getRtfMonths();
  var rows = [];
  state.bomResult.matFlows.forEach(function(f) {
    if (f.baseQty === null) return; // 현재고 미연결 → 계산 불가
    if (f.unitOk === false) return; // 단위 불일치(BOM/재고/입고계획) → 흐름 계산 불가
    // 소비량: 부모 완제품 생산(공급)계획 비례 — 제상품 감축 시 소요도 비례 감소
    var cons = months.map(function(m) {
      var total = 0;
      f.parents.forEach(function(p) {
        var pm = p.monthly[m];
        if (!pm) return;
        var req = pm.reqQty;
        if (fgAdj && pm.prodQty > 0) {
          var k = p.code + "|" + p.plant + "|" + m;
          if (k in fgAdj) req = pm.reqQty * (fgAdj[k] / pm.prodQty);
        }
        total += req;
      });
      return total;
    });
    var origIntake = months.map(function(m) { return f.intakeByMonth[m] || 0; });
    var intake = months.map(function(m, mi) {
      var k = f.componentCode + "|" + f.plant + "|" + m;
      return (matAdj && k in matAdj) ? matAdj[k] : origIntake[mi];
    });
    var ending = [], days = [], prev = f.baseQty;
    months.forEach(function(m, mi) {
      prev = prev + intake[mi] - cons[mi];
      ending.push(prev);
      var daily = cons[mi] > 0 ? cons[mi] / monthDays(m) : 0;
      days.push(daily > 0 ? prev / daily : null);
    });
    // 정합성: 소비 실체가 있고, 일수가 상식 범위(≤ MAT_SANITY_DAYS)여야 관리 대상
    var sane = days.some(function(v) { return v !== null; }) &&
               days.every(function(v) { return v === null || v <= MAT_SANITY_DAYS; });
    rows.push({ flow: f, cons: cons, intake: intake, origIntake: origIntake, ending: ending, days: days, sane: sane });
  });
  return rows;
}

// 배너용: 감축(제상품+자재) 시나리오의 자재 재고 변동 (원, 월별) — 원계획 대비
// 완제품 감축 → 소비 감소 → 자재 쌓임(+) 반작용까지 포함해 정직하게 집계
function computeMatScenarioDeltas(months) {
  var hasAny = Object.keys(state.excessAdj || {}).length > 0 ||
               Object.keys(state.matExcessAdj || {}).length > 0;
  if (!hasAny) return null;
  var adj  = calcMatFlowRows(state.excessAdj, state.matExcessAdj);
  if (!adj) return null;
  var base = calcMatFlowRows(null, null);
  var deltas = months.map(function() { return 0; });
  adj.forEach(function(r, i) {
    var b = base[i];
    if (!r.sane && !b.sane) return; // 정합 의심 자재는 KPI 반영 제외
    if (!Number.isFinite(r.flow.unitVal)) return;
    months.forEach(function(_, mi) {
      // 물리 재고는 0 미만 불가 → 클램프 후 차이
      deltas[mi] += (Math.max(0, r.ending[mi]) - Math.max(0, b.ending[mi])) * r.flow.unitVal;
    });
  });
  return deltas;
}

// AI 자재 감축 선제안 — fgAdj(제상품 감축안) 적용 가정 하에 180일 초과 입고 취소
// 한도 = min(초과분, 당월 입고, 이후 모든 월 최소 기말재고) → 자재 부족(생산 차질) 불가
function computeAiMatExcessPlan(fgAdj) {
  var rows = calcMatFlowRows(fgAdj || state.excessAdj, null);
  if (!rows) return { plan: {}, totalCutAmt: 0, itemCnt: 0 };
  var months = getRtfMonths();
  var plan = {}, totalCutAmt = 0, itemCnt = 0;
  rows.forEach(function(r) {
    if (!r.sane) return; // 정합 의심 자재는 AI 제외
    if (!Number.isFinite(r.flow.unitVal)) return;
    var ending = r.ending.slice(), intake = r.intake.slice();
    var changed = false;
    for (var mi = 0; mi < months.length; mi++) {
      var daily = r.cons[mi] > 0 ? r.cons[mi] / monthDays(months[mi]) : 0;
      if (daily <= 0) continue;
      var excess = ending[mi] - MAT_TARGET_DAYS * daily;
      if (excess <= 0) continue;
      var minFuture = Infinity;
      for (var k = mi; k < months.length; k++) minFuture = Math.min(minFuture, ending[k]);
      var cut = Math.floor(Math.min(excess, intake[mi], Math.max(0, minFuture)));
      if (cut <= 0) continue;
      intake[mi] -= cut;
      for (var k2 = mi; k2 < months.length; k2++) ending[k2] -= cut;
      plan[r.flow.componentCode + "|" + r.flow.plant + "|" + months[mi]] = intake[mi];
      totalCutAmt += cut * r.flow.unitVal;
      changed = true;
    }
    if (changed) itemCnt++;
  });
  return { plan: plan, totalCutAmt: totalCutAmt, itemCnt: itemCnt };
}

// 제·상품 탭 평면 테이블 — 원부자재 탭과 동일 양식 (드릴다운 없이 인라인 조정)
// 컬럼: 품목 | 적정일수 | ↺ | 월별 [판매 | 공급(입력) | 일수]
function renderExcessFgFlatTable(displayItems, months, globalPlanMap) {
  var monthHd = months.map(function(m) {
    return "<th colspan='3' class='exc-mat-mo-hd'>" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHd = months.map(function() {
    return "<th class='exc-mat-sub'>판매</th><th class='exc-mat-sub'>공급</th><th class='exc-mat-sub'>일수</th>";
  }).join("");

  var body = displayItems.map(function(item) {
    var planMap = new Map();
    months.forEach(function(month) {
      planMap.set(month, globalPlanMap.get(item.itemCode + "|" + (item.plantCode || "") + "|" + month) || 0);
    });
    var psi = calcPsiRows(item, planMap, months);
    var td = item._td;
    var rowHasAdj = psi.some(function(r) { return r.hasAdj; });
    var rowKey = item.itemCode + "|" + (item.plantCode || "");

    var cells = psi.map(function(r) {
      var dayCls = "", dayTxt = "—";
      if (r.endingQty < 0) { dayCls = " exc-mat-day-danger"; dayTxt = "부족!"; }
      else if (r.days !== null) {
        dayTxt = Math.round(r.days) + "일";
        dayCls = (td && r.days > td) ? " exc-mat-day-over" : " exc-mat-day-ok";
      }
      return "<td class='exc-mat-cons'>" + escapeHtml(Math.round(r.salesQty).toLocaleString("ko-KR")) + "</td>" +
        "<td class='exc-mat-in'><input type='number' class='exc-psi-input exc-psi-flat" + (r.hasAdj ? " exc-mat-input-edited" : "") + "' " +
          "value='" + Math.round(r.supplyQty) + "' data-key='" + escapeHtml(r.adjKey) + "' data-orig='" + r.origSupply + "' min='0'>" +
          (r.hasAdj ? "<div class='exc-mat-orig'>원: " + escapeHtml(Math.round(r.origSupply).toLocaleString("ko-KR")) + "</div>" : "") +
        "</td>" +
        "<td class='exc-mat-day" + dayCls + "'>" + escapeHtml(dayTxt) + "</td>";
    }).join("");

    return "<tr data-row-key='" + escapeHtml(rowKey) + "' class='" + (rowHasAdj ? "exc-mat-row-adj" : "") + "'>" +
      "<td class='exc-mat-name'><span class='exc-mat-code'>" + escapeHtml(item.itemCode) + "</span> " +
        escapeHtml(item.itemName || item.itemCode) +
        "<span class='exc-mat-cat'>" + escapeHtml(item.itemGroup && item.itemGroup !== NEED_MASTER ? item.itemGroup : (item.typeGroup || "")) + " · " + escapeHtml(item.plant || "") +
        (item._isExcess && item._excessAmt > 0 ? " · 초과 " + formatMoney(item._excessAmt) : "") + "</span></td>" +
      "<td class='exc-fgflat-td'>" + (td ? Math.round(td) + "일" : "<span class='exc-fgflat-notd'>—</span>") + "</td>" +
      "<td class='exc-mat-reset-td'><button class='exc-psi-reset' data-item-code='" + escapeHtml(item.itemCode) + "' data-plant='" + escapeHtml(item.plantCode || "") + "' title='행 초기화'>↺</button></td>" +
      cells + "</tr>";
  }).join("");

  if (!displayItems.length) {
    return "<div class='exc-mat-empty'>표시할 품목이 없습니다.</div>";
  }
  return "<div class='exc-mat-scroll'><table class='exc-mat-table'>" +
    "<thead><tr><th rowspan='2' class='exc-mat-name-hd'>품목</th><th rowspan='2'>적정<br>일수</th><th rowspan='2'></th>" + monthHd + "</tr>" +
    "<tr>" + subHd + "</tr></thead>" +
    "<tbody>" + body + "</tbody></table></div>";
}

// 원부자재 탭 테이블
function renderExcessMatTable(months) {
  var rows = calcMatFlowRows(state.excessAdj, state.matExcessAdj);
  if (!rows) {
    return "<div class='exc-mat-empty'>BOM 전개가 필요합니다 — 공급원인 화면에서 BOM 전개를 먼저 실행하세요.</div>";
  }
  // 표시 대상: 정합 OK + (첫 월 180일 초과 or 조정 존재). 정합 의심 건수는 별도 안내
  var insaneCnt = rows.filter(function(r) { return !r.sane; }).length;
  var shown = rows.filter(function(r) { return r.sane; }).map(function(r) {
    var over = Number.isFinite(r.days[0]) && r.days[0] > MAT_TARGET_DAYS;
    var hasAdj = months.some(function(m) {
      return (r.flow.componentCode + "|" + r.flow.plant + "|" + m) in state.matExcessAdj;
    });
    var daily0 = r.cons[0] > 0 ? r.cons[0] / monthDays(months[0]) : 0;
    var overAmt = (over && Number.isFinite(r.flow.unitVal) && daily0 > 0)
      ? Math.max(0, (r.ending[0] - MAT_TARGET_DAYS * daily0)) * r.flow.unitVal : 0;
    return Object.assign({ _over: over, _hasAdj: hasAdj, _overAmt: overAmt }, r);
  }).filter(function(r) { return r._over || r._hasAdj; })
    .sort(function(a, b) { return b._overAmt - a._overAmt; });

  var totalOverAmt = shown.reduce(function(s, r) { return s + r._overAmt; }, 0);

  var monthHd = months.map(function(m) {
    return "<th colspan='3' class='exc-mat-mo-hd'>" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHd = months.map(function() {
    return "<th class='exc-mat-sub'>소비</th><th class='exc-mat-sub'>입고</th><th class='exc-mat-sub'>일수</th>";
  }).join("");

  var body = shown.map(function(r) {
    var f = r.flow;
    var cells = months.map(function(m, mi) {
      var key = f.componentCode + "|" + f.plant + "|" + m;
      var edited = key in state.matExcessAdj;
      var dayVal = r.days[mi];
      var dayCls = dayVal === null ? "" :
        dayVal < 0 ? " exc-mat-day-danger" :
        dayVal > MAT_TARGET_DAYS ? " exc-mat-day-over" : " exc-mat-day-ok";
      var dayTxt = dayVal === null ? "—" : (r.ending[mi] < 0 ? "부족!" : Math.round(dayVal) + "일");
      return "<td class='exc-mat-cons'>" + escapeHtml(Math.round(r.cons[mi]).toLocaleString("ko-KR")) + "</td>" +
        "<td class='exc-mat-in'><input type='number' class='exc-mat-input" + (edited ? " exc-mat-input-edited" : "") + "' " +
          "value='" + Math.round(r.intake[mi]) + "' data-key='" + escapeHtml(key) + "' data-orig='" + r.origIntake[mi] + "' min='0'>" +
          (edited ? "<div class='exc-mat-orig'>원: " + escapeHtml(Math.round(r.origIntake[mi]).toLocaleString("ko-KR")) + "</div>" : "") +
        "</td>" +
        "<td class='exc-mat-day" + dayCls + "'>" + escapeHtml(dayTxt) + "</td>";
    }).join("");
    return "<tr class='" + (r._hasAdj ? "exc-mat-row-adj" : "") + "'>" +
      "<td class='exc-mat-name'><span class='exc-mat-code'>" + escapeHtml(f.componentCode) + "</span> " +
        escapeHtml(f.componentName) +
        "<span class='exc-mat-cat'>" + escapeHtml(f.category || "") + " · " + escapeHtml(displayPlantName ? displayPlantName(f.plant) : f.plant) + "</span></td>" +
      "<td class='exc-mat-reset-td'><button class='exc-mat-reset' data-code='" + escapeHtml(f.componentCode) + "' data-plant='" + escapeHtml(f.plant) + "' title='행 초기화'>↺</button></td>" +
      cells + "</tr>";
  }).join("");

  var hd = "<div class='exc-table-hd'><div class='exc-table-hd-left'>" +
    "<span class='exc-table-title'>원부자재 " + MAT_TARGET_DAYS + "일 초과 <strong>" + shown.filter(function(r){ return r._over; }).length + "개</strong></span>" +
    (totalOverAmt > 0 ? "<span class='exc-table-sub'>초과금액 " + escapeHtml(formatMoney(totalOverAmt)) + "</span>" : "") +
    (insaneCnt > 0 ? "<span class='exc-table-sub' title='재고일수가 " + MAT_SANITY_DAYS + "일을 넘어 단위·데이터 정합 확인이 필요한 자재 (관리 대상 제외)'>⚠ 정합확인 " + insaneCnt + "건 제외</span>" : "") +
    "</div><span class='exc-table-hd-hint'>입고 칸 수정 = 입고 취소·축소 (소비는 BOM 연동 자동계산)</span></div>";

  if (!shown.length) {
    return hd + "<div class='exc-mat-empty'>" + MAT_TARGET_DAYS + "일 초과 자재가 없습니다.</div>";
  }
  return hd +
    "<div class='exc-mat-scroll'><table class='exc-mat-table'>" +
    "<thead><tr><th rowspan='2' class='exc-mat-name-hd'>자재</th><th rowspan='2'></th>" + monthHd + "</tr>" +
    "<tr>" + subHd + "</tr></thead>" +
    "<tbody>" + body + "</tbody></table></div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. 이벤트 바인딩
// ═══════════════════════════════════════════════════════════════════════════
function bindExcessAdjustment() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;

  // AI 진단 — 전체적용(공급감축+계획보정, MOQ구조·소진·처분 제외) / 전체해제
  var aiApplyBtn = root.querySelector(".exc-ai-apply");
  if (aiApplyBtn) {
    aiApplyBtn.addEventListener("click", function() {
      var cls = classifyAiExcess();
      state.aiSecApplied = state.aiSecApplied || {};
      state.aiExcessKeys = state.aiExcessKeys || {};
      ["supply", "planfix"].forEach(function(secId) {
        var s = cls.sections[secId];
        if (!s.items.length && !(secId === "supply")) return;
        s.items.forEach(function(it) {
          it.keys.forEach(function(k) {
            state.excessAdj[k]    = it.planVals[k];
            state.aiExcessKeys[k] = true;
          });
        });
        state.aiSecApplied[secId] = true;
      });
      syncAiMatPlan();
      render("inventory-variance");
    });
  }
  var aiClearBtn = root.querySelector(".exc-ai-clear");
  if (aiClearBtn) {
    aiClearBtn.addEventListener("click", function() {
      Object.keys(state.aiExcessKeys || {}).forEach(function(k) { delete state.excessAdj[k]; });
      Object.keys(state.aiMatKeys    || {}).forEach(function(k) { delete state.matExcessAdj[k]; });
      state.aiExcessKeys = {};
      state.aiMatKeys    = {};
      state.aiSecApplied = {};
      render("inventory-variance");
    });
  }

  // AI 진단 — 섹션 아코디언 펼침/접기 (리렌더 없이 DOM 토글)
  root.querySelectorAll(".exc-aisec-head").forEach(function(head) {
    head.addEventListener("click", function(e) {
      if (e.target.closest(".exc-aisec-apply")) return;
      var sec = head.dataset.sec;
      state.aiDiagOpen = state.aiDiagOpen || {};
      state.aiDiagOpen[sec] = !state.aiDiagOpen[sec];
      var body = head.parentElement.querySelector(".exc-aisec-body");
      if (body) body.hidden = !state.aiDiagOpen[sec];
      var chev = head.querySelector(".exc-aisec-chev");
      if (chev) chev.textContent = state.aiDiagOpen[sec] ? "▾" : "▸";
    });
  });

  // AI 진단 — 섹션별 권장안 적용/해제
  root.querySelectorAll(".exc-aisec-apply").forEach(function(btn) {
    btn.addEventListener("click", function() { toggleAiSection(btn.dataset.sec); });
  });

  // 제·상품 / 원부자재 탭 전환
  root.querySelectorAll(".exc-tab-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      state.excessTab = btn.dataset.extab === "mat" ? "mat" : "fg";
      render("inventory-variance");
    });
  });

  // 자재 입고 조정 입력
  root.querySelectorAll(".exc-mat-input").forEach(function(input) {
    input.addEventListener("change", function() {
      var key  = input.dataset.key;
      var val  = parseFloat(input.value);
      var orig = parseFloat(input.dataset.orig) || 0;
      if (!Number.isFinite(val) || val < 0) { input.value = 0; return; }
      if (Math.abs(val - orig) < 0.01) delete state.matExcessAdj[key];
      else state.matExcessAdj[key] = val;
      render("inventory-variance");
    });
  });

  // 자재 행 초기화
  root.querySelectorAll(".exc-mat-reset").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var code = btn.dataset.code, plant = btn.dataset.plant || "";
      getRtfMonths().forEach(function(m) { delete state.matExcessAdj[code + "|" + plant + "|" + m]; });
      render("inventory-variance");
    });
  });

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
      state.matExcessAdj = {};
      state.aiExcessKeys = {};
      state.aiMatKeys = {};
      state.aiSecApplied = {};
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
