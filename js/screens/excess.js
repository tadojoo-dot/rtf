// ── 과잉감축 화면 (v300) ────────────────────────────────────────────────────

var MAT_TARGET_DAYS  = 180;
// 자재 재고일수 상식 상한 (초과 시 단위·데이터 정합 의심 → 과잉관리·AI·KPI 반영 제외)
// 예: 계획수량이 정(TB)인데 단위라벨 KG인 반제품 → 일수 수백만일로 튐
var MAT_SANITY_DAYS  = 1800;
var _excessChartInst = null;

// ═══════════════════════════════════════════════════════════════════════════
// 성능 측정(임시) — 병목 진단용. 콘솔에서 EXC_PROF=false 로 끄고, 배포 시 이 블록 제거.
// 렌더마다 F12 콘솔에 구간별 ms + 무거운 함수 호출횟수를 한 줄(접힌 그룹)로 출력.
// ═══════════════════════════════════════════════════════════════════════════
var EXC_PROF = false;   // true 로 켜면 F12 콘솔에 구간별 ms·호출횟수 출력 (배포 시 이 블록 제거)
var _excProfRows = [];
var _excCallCnt = {};
function excProf(label, fn) {
  if (!EXC_PROF) return fn();
  var t = performance.now();
  var r = fn();
  _excProfRows.push([label, +(performance.now() - t).toFixed(1)]);
  return r;
}
function excCount(name) {
  if (EXC_PROF) _excCallCnt[name] = (_excCallCnt[name] || 0) + 1;
}
function excProfReset() { _excProfRows = []; _excCallCnt = {}; }
function excProfFlush(totalMs, bindMs) {
  if (!EXC_PROF) return;
  var seg = {};
  _excProfRows.forEach(function(x) { seg[x[0]] = x[1] + " ms"; });
  console.groupCollapsed("[과잉감축] 렌더 " + totalMs.toFixed(1) + "ms" +
    (bindMs != null ? " + bind " + bindMs.toFixed(1) + "ms" : "") +
    "  (tab=" + (state.excessTab === "mat" ? "원부자재" : "제·상품") + ")");
  console.table(seg);
  console.table(_excCallCnt);   // 함수 호출 횟수 — 중복 계산 확인용
  console.groupEnd();
  excProfReset();
}

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
  excCount("buildMatConsumptionMap");
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
  excProfReset();
  var _t0 = performance.now();
  try {
    var _html = _renderExcessAdjustmentInner();
    var _now = performance.now();
    window._excRenderMs = _now - _t0;  // 계산+문자열 생성 시간
    window._excRenderEndTs = _now;     // bind 시작 시각과의 차 = 브라우저 innerHTML 반영 비용
    return _html;
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

  var rtfItems     = excProf("computeRtfItems(직접호출)", function(){ return computeRtfItems(); });
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
  // 완제품 생산계획 조정(fgProdAdj) — 과잉감축의 기준선(RTF조정후)에 반영
  Object.keys(state.fgProdAdj || {}).forEach(function(k) {
    if (globalPlanMap.has(k)) globalPlanMap.set(k, state.fgProdAdj[k]);
  });

  var hasRtfAdj    = Object.keys(state.matSimAdj || {}).length > 0 ||
                     (typeof hasFgProdAdj === "function" && hasFgProdAdj());
  var matAdjBomMap = hasRtfAdj ? buildBomMaxProducibleMap(state.matSimAdj, state.fgProdAdj) : null;

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
  var bannerHtml = excProf("KPI배너(scenario+matFlow)", function(){
    return (typeof renderScenarioKpiBanner === "function") ? renderScenarioKpiBanner() : "";
  });

  // AI 과잉재고 진단 패널 — 원인 분류 + 액션(오너)별 아코디언, 섹션별 권장안 적용 (제·상품 탭 전용)
  var aiHtml = excProf("AI진단패널(classify)", function(){
    return state.excessTab === "mat" ? "" : renderAiDiagPanel(hasTargetData);
  });

  // 탭: 제·상품 (적정재고 기준) | 원부자재 (180일 기준)
  var excessTab = state.excessTab === "mat" ? "mat" : "fg";
  var tabBar = "<div class='exc-tabbar'>" +
    "<button class='exc-tab-btn" + (excessTab === "fg"  ? " exc-tab-active" : "") + "' data-extab='fg'>제·상품 <span class='exc-tab-sub'>적정재고 기준</span></button>" +
    "<button class='exc-tab-btn" + (excessTab === "mat" ? " exc-tab-active" : "") + "' data-extab='mat'>원부자재 <span class='exc-tab-sub'>" + MAT_TARGET_DAYS + "일 기준</span></button>" +
  "</div>";

  // 진단 패널은 탭별로 — 제·상품 진단(fg) / 원부자재 진단(mat)
  var bodyHtml = excessTab === "fg"
    ? renderExcWalkBar() + aiHtml + priorityHtml + controls +
      "<div class='exc-fg-area'>" + excProf("FG테이블생성", function(){ return renderExcessFgFlatTable(displayItems, months, globalPlanMap); }) + "</div>"
    : excProf("원부자재진단패널", function(){ return renderMatDiagPanel(); }) +
      "<div class='exc-fg-area'>" + excProf("원부자재테이블", function(){ return renderExcessMatTable(months); }) + "</div>";

  return "<div class='exc-screen'><div class='exc-inner'>" +
    bannerHtml +
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
    var itemCutQty = 0, itemCutAmt = 0, itemKeys = [], itemPlanVals = {}, itemCutByKey = {};
    var origSupplyArr = supply.slice(), origEndingArr = ending.slice();
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
      itemCutByKey[planKey] = cut;
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
        keys: itemKeys, planVals: itemPlanVals, cutByKey: itemCutByKey,
        planAvgSales: validLen ? salesSum / validLen : 0,
        unitInvValue: Number.isFinite(item.unitInvValue) ? item.unitInvValue : null,
        // 진단 팝업 차트용 월별 흐름 (유효 구간)
        months: months.slice(0, validLen), salesArr: sales.slice(),
        origSupplyArr: origSupplyArr, cutSupplyArr: supply.slice(),
        origEndingArr: origEndingArr, cutEndingArr: ending.slice(),
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
  noplan:     { label: "계획누락", cls: "noplan" },
  stopped:    { label: "판매중단", cls: "stopped" },
  dormant:    { label: "장기불용", cls: "dormant" },
  unknown:    { label: "이력미상", cls: "unknown" },
};

// AI 감축안의 각 품목을 원인 분류 → 액션 섹션(공급감축/계획보정/정책개선)으로 배분
function classifyAiExcess() {
  excCount("classifyAiExcess");
  var ai = computeAiExcessPlan();
  var tiMap = new Map();
  (state.mappedData.target_inv || []).forEach(function(r) { if (r.itemCode) tiMap.set(r.itemCode, r); });

  var sections = {
    supply:  { items: [], totalAmt: 0 },
    planfix: { items: [], totalAmt: 0 },
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
    if (ach !== null && ach < AI_ACH_LOW) {
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
    // 진단 팝업(차트·소견)용 근거 수치 보관
    it.diag = { ach: ach, sfSum: sfSum, actSum: actSum, bothCnt: bothCnt,
                runRate: runRate, ratio: ratio,
                moq: Number.isFinite(ti.moq) ? ti.moq : null, ti: ti };
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
    a.ti = ti || null; // 진단 팝업 실적 차트용
    var o26 = ti ? ti.outCurYear || {} : {};
    var o25 = ti ? ti.outPrevYear || {} : {};
    var s26 = 0, last26 = null;
    Object.keys(o26).sort().forEach(function(m) { s26 += o26[m]; if (o26[m] > 0) last26 = m; });
    var s25 = Object.keys(o25).reduce(function(s, m) { return s + o25[m]; }, 0);
    if (s26 > 0) {
      a.cause = "noplan";
      a.s26 = s26; a.last26 = last26; a.planFromMonth = firstPlanMonth;
      a.evidence = "26년 출고 " + formatNumber(Math.round(s26)) +
        (last26 ? " (최근 " + last26.slice(2).replace("-", ".") + ")" : "") +
        " — " + firstPlanMonth + "월 이후 판매계획 없음";
      sellout.push(a);
    } else if (s25 > 0) {
      a.cause = "stopped";
      a.s25 = s25;
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
// 골격: 과잉재고 대응은 두 방향 — 들어올 것을 줄이거나(①②), 있는 것을 내보내거나(③④)
// 뱃지·설명의 기준 수치는 임계값 상수(AI_ACH_LOW 등)에서 조립 — 상수를 바꾸면 문구도 자동 반영
var AI_SECTION_DEFS = [
  { id: "supply",   no: "①", title: "입고·생산 축소",  owner: "재고가 품목별 적정일수 초과", group: "들어올 것을 줄인다",
    desc: "기준: 월별 기말재고 > 품목별 적정재고일수(적정재고 파일). 원인 칩 — 판매부진: 26년 출고가 S/F 예측의 " +
      Math.round(AI_ACH_LOW * 100) + "% 미만 / 수요감소: 향후 계획이 실적 월평균의 " +
      Math.round(AI_PLAN_LOW * 100) + "% 미만 / 기준초과: 수요 이상신호 없이 적정일수만 초과. " +
      "담당: 공장·구매 — 입고·생산 취소·연기." },
  { id: "planfix",  no: "②", title: "판매계획 현실화", owner: "계획이 실적의 " + AI_PLAN_HIGH + "배 이상",
    desc: "기준: 향후 판매계획 월평균 ≥ 최근 출고실적 월평균(26년, 없으면 25년) × " + AI_PLAN_HIGH +
      ". 담당: 마케팅·영업 — 계획 하향 검토. 계획을 낮추면 소요·발주가 연쇄로 줄어듭니다." },
  { id: "sellout",  no: "③", title: "재고 소진",       owner: "출고 지속 중 + 판매계획 0",   group: "있는 것을 내보낸다",
    desc: "기준: 26년 출고 실적 있음 + 향후 판매계획 없음(0). 담당: 마케팅 — 계획 반영 또는 소진 요청. (실행 주체가 마케팅 → KPI 미반영 액션아이템)" },
  { id: "disposal", no: "④", title: "재고 처분",       owner: "26년 출고 0 + 판매계획 0",
    desc: "기준: 판매계획 없음 + 26년 출고 0 — 25년 출고 있으면 '판매중단', 25~26년 모두 0이면 '장기불용', 실적 파일에 없으면 '이력미상'. " +
      "담당: 사업부 — 폐기·할인 처분 검토. (손실 인식 수반 → 감축 성과와 분리 집계)" },
];

// ═══════════════════════════════════════════════════════════════════════════
// AI 소견 (경영 보고용 서술문) — 전부 엔진 수치에서 템플릿으로 조립 (외부 API 없음)
// 추정에는 "~가능성이 높습니다", 데이터 사실에는 단정 어투를 사용
// ═══════════════════════════════════════════════════════════════════════════
function aiMonthSpan(keys) {
  var ms = keys.map(function(k) { return k.split("|")[2]; }).filter(Boolean).sort();
  if (!ms.length) return "";
  var lab = function(m) { return monthLabel(m); };
  return ms.length === 1 ? lab(ms[0]) : lab(ms[0]) + "~" + lab(ms[ms.length - 1]);
}
function buildAiOpinion(it) {
  var d = it.diag || {};
  var span = aiMonthSpan(it.keys || []);
  var cutTxt = formatNumber(Math.round(it.cutQty)) + "개(" + formatMoney(it.cutAmt) + ")";
  var tdTxt = Math.round(it.targetDays) + "일";
  switch (it.cause) {
    case "under":
      return "이 품목은 26년 " + d.bothCnt + "개월 누적 출고가 S/F 예측의 " + Math.round(d.ach * 100) + "% 수준에 그쳤습니다" +
        "(예측 " + formatNumber(Math.round(d.sfSum)) + " vs 실적 " + formatNumber(Math.round(d.actSum)) + "). " +
        "예측 수준으로 편성된 공급이 유지되면서 재고가 누적되었을 가능성이 높습니다. " +
        span + " 공급을 " + cutTxt + " 줄여 적정 " + tdTxt + " 수준으로 수렴시키는 것을 권장합니다. " +
        "감축 한도를 이후 모든 월의 최소 기말재고 이내로 제한해 품절이 발생하지 않도록 설계된 제안입니다.";
    case "overplan":
      return "향후 판매계획(월평균 " + formatNumber(Math.round(it.planAvgSales)) + ")이 최근 출고 실적(월평균 " +
        formatNumber(Math.round(d.runRate)) + ")의 " + d.ratio.toFixed(1) + "배로 편성되어 있습니다. " +
        "계획이 실현되지 않으면 이 공급이 그대로 재고로 남을 가능성이 높습니다. " +
        "판매계획의 현실성 재검토를 마케팅·영업에 요청하고, 병행하여 " + span + " 공급 " + cutTxt + " 감축을 권장합니다.";
    case "demanddown":
      return "향후 판매계획(월평균 " + formatNumber(Math.round(it.planAvgSales)) + ")이 최근 실적의 " +
        Math.round(d.ratio * 100) + "% 수준으로, 수요 하향은 계획에 이미 반영되어 있습니다. " +
        "다만 과거 수요 기준으로 확보된 재고가 남아 적정 " + tdTxt + "을 초과한 상태입니다. " +
        "신규 공급을 " + cutTxt + " 줄여 기존 재고 소진을 우선하는 것을 권장합니다.";
    default: // overbase
      return "재고일수가 적정 " + tdTxt + "을 초과하고 있으나, 최근 실적·예측상 뚜렷한 수요 이상 신호는 없습니다. " +
        "공급 일정 조정만으로 적정 수준 복귀가 가능한 품목으로 판단됩니다. " +
        span + " 공급 " + cutTxt + " 감축을 권장합니다.";
  }
}
function buildNoPlanOpinion(a) {
  var invTxt = formatNumber(Math.round(a.qty)) + "개(" + formatMoney(a.amt) + ")";
  switch (a.cause) {
    case "noplan":
      return "이 품목은 26년에도 출고가 이어졌으나(누적 " + formatNumber(Math.round(a.s26 || 0)) +
        (a.last26 ? ", 최근 " + a.last26.slice(2).replace("-", ".") : "") + "), " +
        (a.planFromMonth || "") + "월 이후 판매계획이 없습니다. " +
        "판매계획 누락 또는 운영 전환 품목일 가능성이 높습니다. " +
        "판매계획 반영 여부를 먼저 확인하고, 미판매 방침이라면 보유 재고 " + invTxt + "의 소진 방안(프로모션·채널 확대)을 마케팅에 요청하는 것을 권장합니다.";
    case "stopped":
      return "25년까지 출고된 후 26년 출고가 없어 판매중단으로 추정됩니다. " +
        "보유 재고 " + invTxt + "의 소진 가능성을 먼저 확인하고, 소진이 어렵다면 처분(폐기·할인)을 검토하는 것을 권장합니다. " +
        "처분은 손실 인식이 수반되므로 감축 성과와 분리해 보고해야 합니다.";
    case "dormant":
      return "25~26년 출고 이력이 없는 장기 부동재고입니다. " +
        "보유 재고 " + invTxt + "에 대해 유효기간·품질 상태 확인 후 처분 여부를 결정하는 것을 권장합니다.";
    default: // unknown
      return "적정재고·실적 관리 대상에 포함되지 않은 품목으로, 출고 이력을 확인할 수 없습니다. " +
        "보유 재고 " + invTxt + "의 성격(수출 대기·수탁·단종 등)을 담당 부서에서 확인하는 것이 선행되어야 합니다.";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 판정(협의 결과) 레이어 — AI 제안에 대한 회의 확정: 수용/조정/불가/보류
// 반영 규칙: 명시 판정 > 섹션 일괄적용. 확정(수용·조정)만 KPI에 반영
// ═══════════════════════════════════════════════════════════════════════════
var AI_DECISION_LABELS = { accept: "수용", adjust: "조정 수용", reject: "불가", hold: "보류" };

function aiDecisionKey(it) { return it.itemCode + "|" + (it.plantCode || ""); }
function getAiDecision(it) { return (state.aiDecisions || {})[aiDecisionKey(it)] || null; }

// 품목의 유효 감축 모드: "full" | "none" | 숫자(조정 감축 총량)
function decideAiMode(it, secApplied) {
  var d = getAiDecision(it);
  if (d) {
    if (d.status === "accept") return "full";
    if (d.status === "adjust") return Math.max(0, Math.min(it.cutQty, Number(d.qty) || 0));
    return "none"; // reject | hold
  }
  return secApplied ? "full" : "none";
}
function effectiveCutOf(it, secApplied) {
  var mode = decideAiMode(it, secApplied);
  if (mode === "none") return { qty: 0, amt: 0 };
  if (mode === "full") return { qty: it.cutQty, amt: it.cutAmt };
  var f = it.cutQty > 0 ? mode / it.cutQty : 0;
  return { qty: mode, amt: it.cutAmt * f };
}

// AI 관리 감축 키 전체 재구성 — 섹션 적용 + 품목 판정의 단일 반영 지점
function syncAiFgAdj(clsArg) {
  var _P = EXC_PROF ? performance.now() : 0;                       // [측정] 적용 경로(렌더 前)
  var _c0 = EXC_PROF ? Object.assign({}, _excCallCnt) : null;
  var cls = clsArg || classifyAiExcess();
  Object.keys(state.aiExcessKeys || {}).forEach(function(k) { delete state.excessAdj[k]; });
  state.aiExcessKeys = {};
  state.aiSecApplied = state.aiSecApplied || {};
  ["supply", "planfix"].forEach(function(secId) {
    var secApplied = !!state.aiSecApplied[secId];
    cls.sections[secId].items.forEach(function(it) {
      var mode = decideAiMode(it, secApplied);
      if (mode === "none") return;
      var f = mode === "full" ? 1 : (it.cutQty > 0 ? mode / it.cutQty : 0);
      it.keys.forEach(function(k) {
        var origSupply = it.planVals[k] + (it.cutByKey[k] || 0);
        var cut = Math.floor((it.cutByKey[k] || 0) * f);
        state.excessAdj[k] = origSupply - cut;
        state.aiExcessKeys[k] = true;
      });
    });
  });
  var _tMat = EXC_PROF ? performance.now() : 0;
  syncAiMatPlan();
  var _tSave = EXC_PROF ? performance.now() : 0;
  saveAiSession();
  if (EXC_PROF) {
    var _end = performance.now(), d = {};
    Object.keys(_excCallCnt).forEach(function(k) { var n = _excCallCnt[k] - (_c0[k] || 0); if (n) d[k] = n; });
    console.log("[과잉감축] syncAiFgAdj 총 " + (_end - _P).toFixed(1) + "ms" +
      " (classify+분배 " + (_tMat - _P).toFixed(1) +
      " / syncAiMatPlan " + (_tSave - _tMat).toFixed(1) +
      " / saveSession " + (_end - _tSave).toFixed(1) + ")", d);
  }
}

function setAiDecision(secId, it, status, qty, reason) {
  state.aiDecisions = state.aiDecisions || {};
  var key = aiDecisionKey(it);
  if (!status) delete state.aiDecisions[key];
  else state.aiDecisions[key] = { status: status, qty: qty || null, reason: reason || "", sec: secId, ts: new Date().toISOString() };
  if (status) recordAiDecisionMinutes(secId, it, status, qty, reason);
  if (secId === "supply" || secId === "planfix" || secId === "matcut") syncAiFgAdj();
  else saveAiSession();
  render("inventory-variance");
}

// 판정 시 회의록 자동 기록 (minutes.js가 type: "aiDecision" 분기 렌더)
function recordAiDecisionMinutes(secId, it, status, qty, reason) {
  var def = typeof findAiSecDef === "function" ? findAiSecDef(secId) : null;
  state.minutesLog = state.minutesLog || [];
  state.minutesLog.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    timestamp: new Date(),
    type: "aiDecision",
    title: (def ? def.no + " " + def.title : "AI 진단") + " 판정 — " + (it.itemName || it.itemCode),
    decision: {
      itemCode: it.itemCode, itemName: it.itemName || "", plant: it.plantCode || "",
      section: def ? def.title : secId,
      status: AI_DECISION_LABELS[status] || status,
      aiCutQty: it.cutQty || null,
      finalQty: status === "adjust" ? (Number(qty) || 0) : (status === "accept" ? (it.cutQty || null) : 0),
      aiCutAmt: it.cutAmt || null,
      reason: reason || "",
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 세션 저장 — 판정·조정·회의록을 localStorage에 자동 보존 (새로고침 복원)
// ═══════════════════════════════════════════════════════════════════════════
var AI_SESSION_LS_KEY = "rtfAiSession.v1";
function saveAiSession() {
  try {
    localStorage.setItem(AI_SESSION_LS_KEY, JSON.stringify({
      aiDecisions:  state.aiDecisions  || {},
      aiSecApplied: state.aiSecApplied || {},
      excessAdj:    state.excessAdj    || {},
      matExcessAdj: state.matExcessAdj || {},
      aiExcessKeys: state.aiExcessKeys || {},
      aiMatKeys:    state.aiMatKeys    || {},
      minutesLog:   (state.minutesLog || []).map(function(e) {
        return Object.assign({}, e, { timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : e.timestamp });
      }),
      excWalkIdx:   state.excWalkIdx || 0,
      savedAt: new Date().toISOString(),
    }));
  } catch (e) { /* 저장 실패는 치명적이지 않음 (프라이빗 모드 등) */ }
}
function loadAiSession() {
  try {
    var raw = localStorage.getItem(AI_SESSION_LS_KEY);
    if (!raw) return;
    var s = JSON.parse(raw);
    state.aiDecisions  = s.aiDecisions  || {};
    state.aiSecApplied = s.aiSecApplied || {};
    state.aiExcessKeys = s.aiExcessKeys || {};
    state.aiMatKeys    = s.aiMatKeys    || {};
    state.excWalkIdx   = s.excWalkIdx   || 0;
    Object.assign(state.excessAdj,    s.excessAdj    || {});
    Object.assign(state.matExcessAdj, s.matExcessAdj || {});
    if (Array.isArray(s.minutesLog) && s.minutesLog.length) {
      state.minutesLog = s.minutesLog.map(function(e) {
        var t = new Date(e.timestamp);
        return Object.assign({}, e, { timestamp: isNaN(t.getTime()) ? e.timestamp : t });
      });
    }
  } catch (e) { /* 손상된 저장분은 무시 */ }
}
function clearAiSession() {
  try { localStorage.removeItem(AI_SESSION_LS_KEY); } catch (e) {}
}

var _aiDiagCache = null; // 렌더 시점의 분류 결과 — 행 클릭→팝업에서 재사용

// ── 회의 진행 바 (AI 진단 품목 순차 점검) — 판정(aiDecisions)이 곧 진행 카운트 ──
function buildExcWalkQueue() {
  if (!_aiDiagCache || !_aiDiagCache.cls) return [];
  var cls = _aiDiagCache.cls, q = [];
  ["supply", "planfix"].forEach(function(secId) {
    (((cls.sections || {})[secId] || {}).items || []).forEach(function(it, i) {
      q.push({ secId: secId, srcIdx: i, it: it, amt: it.cutAmt || 0 });
    });
  });
  ["sellout", "disposal"].forEach(function(secId) {
    (((cls.noPlan || {})[secId]) || []).forEach(function(it, i) {
      q.push({ secId: secId, srcIdx: i, it: it, amt: it.amt || 0 });
    });
  });
  var order = { supply: 0, planfix: 1, sellout: 2, disposal: 3 };
  q.sort(function(a, b) { return (order[a.secId] - order[b.secId]) || (b.amt - a.amt); });
  return q;
}

function excWalkBarInner() {
  var q = buildExcWalkQueue();
  if (!q.length) return "";
  var idx = Math.max(0, Math.min(state.excWalkIdx || 0, q.length - 1));
  state.excWalkIdx = idx;
  var cur  = q[idx];
  var done = q.filter(function(e) { return getAiDecision(e.it); }).length;
  var def  = findAiSecDef(cur.secId);
  var d    = getAiDecision(cur.it);
  return "<span class=\"walkbar-title\">▶ 품목 점검</span>" +
    "<span class=\"walkbar-count\"><b>" + done + "</b>/" + q.length + "</span>" +
    "<span class=\"walkbar-cur\">" +
      (def ? "<span class=\"walkbar-plant\">" + def.no + " " + escapeHtml(def.title) + "</span> " : "") +
      "<b>" + escapeHtml(cur.it.itemCode) + "</b> " + escapeHtml(cur.it.itemName || cur.it.itemCode) +
      (d ? " <span class=\"walkbar-donechip\">" + (AI_DECISION_LABELS[d.status] || d.status) + "</span>" : "") +
    "</span>" +
    "<button type=\"button\" class=\"walkbar-btn\" id=\"excWalkPrev\"" + (idx <= 0 ? " disabled" : "") + ">← 이전</button>" +
    "<button type=\"button\" class=\"walkbar-btn\" id=\"excWalkNext\"" + (idx >= q.length - 1 ? " disabled" : "") + ">다음 →</button>" +
    "<button type=\"button\" class=\"walkbar-btn walkbar-btn-done\" id=\"excWalkOpen\">품목 열기</button>";
}

function renderExcWalkBar() {
  var inner = excWalkBarInner();
  return inner ? "<div class=\"walkbar\" id=\"excWalkBar\">" + inner + "</div>" : "";
}

function excWalkGo(idx) {
  var q = buildExcWalkQueue();
  if (!q.length) return;
  idx = Math.max(0, Math.min(idx, q.length - 1));
  state.excWalkIdx = idx;
  saveAiSession();
  var e = q[idx];
  openAiDiagPopup(e.secId, e.srcIdx);
  var bar = document.getElementById("excWalkBar");
  if (bar) { bar.innerHTML = excWalkBarInner(); bindExcWalkBar(); }
}

function bindExcWalkBar() {
  var prev = document.getElementById("excWalkPrev");
  var next = document.getElementById("excWalkNext");
  var open = document.getElementById("excWalkOpen");
  if (prev) prev.addEventListener("click", function() { excWalkGo((state.excWalkIdx || 0) - 1); });
  if (next) next.addEventListener("click", function() { excWalkGo((state.excWalkIdx || 0) + 1); });
  if (open) open.addEventListener("click", function() { excWalkGo(state.excWalkIdx || 0); });
}

function renderAiDiagPanel(hasTargetData) {
  if (!hasTargetData) return "";
  var cls = classifyAiExcess();
  _aiDiagCache = { cls: cls };
  state.aiSecApplied = state.aiSecApplied || {};
  state.aiDiagOpen   = state.aiDiagOpen   || {};
  var S = cls.sections, np = cls.noPlan;

  // 섹션별 확정(판정 반영) 현황
  function secConfirm(secId) {
    var secApplied = !!state.aiSecApplied[secId];
    var conf = 0, counts = { accept: 0, adjust: 0, reject: 0, hold: 0 }, anyDec = false;
    S[secId].items.forEach(function(it) {
      var d = getAiDecision(it);
      if (d) { anyDec = true; counts[d.status] = (counts[d.status] || 0) + 1; }
      conf += effectiveCutOf(it, secApplied).amt;
    });
    return { conf: conf, counts: counts, anyDec: anyDec, secApplied: secApplied };
  }

  var fgCnt    = S.supply.items.length + S.planfix.items.length;
  var cutTotal = S.supply.totalAmt + S.planfix.totalAmt;
  var identAmt = np.sellout.concat(np.disposal).reduce(function(s, a) { return s + a.amt; }, 0);
  if (!fgCnt && !np.sellout.length && !np.disposal.length) return "";

  var anyApplied = Object.keys(state.aiExcessKeys || {}).length > 0 ||
                   Object.keys(state.aiMatKeys || {}).length > 0;
  var allApplied = !!(state.aiSecApplied.supply && state.aiSecApplied.planfix);

  function chip(cause) {
    var meta = AI_CAUSE_META[cause] || AI_CAUSE_META.overbase;
    return "<span class='exc-ai-chip exc-ai-chip-" + meta.cls + "'>" + meta.label + "</span>";
  }
  // 품목코드를 앞에 — 담당자가 코드로 찾아볼 수 있도록
  function nameCell(code, name, plant) {
    var pl = plant && typeof displayPlantName === "function" ? displayPlantName(plant) : (plant || "");
    return "<td class='exc-ai-nm'><span class='exc-ai-codehead'>" + escapeHtml(code) + "</span> " +
      escapeHtml(name || code) +
      (pl ? " <span class='exc-ai-code'>" + escapeHtml(pl) + "</span>" : "") + "</td>";
  }
  var MAXR = 100;
  function dChip(it) {
    var d = getAiDecision(it);
    if (!d) return "";
    return " <span class='exc-ai-dchip exc-ai-dchip-" + d.status + "'>" + (AI_DECISION_LABELS[d.status] || d.status) + "</span>";
  }
  function cutRows(items, secId) {
    if (!items.length) return "<div class='exc-aisec-empty'>해당 품목 없음</div>";
    var html = "<table class='exc-ai-table'><tbody>" + items.slice(0, MAXR).map(function(it, idx) {
      return "<tr class='exc-ai-row' data-sec='" + secId + "' data-idx='" + idx + "' title='클릭하면 진단 카드(차트·AI 소견·판정)가 열립니다'>" +
        nameCell(it.itemCode, it.itemName, it.plantCode) +
        "<td class='exc-ai-chipcell'>" + chip(it.cause) + dChip(it) + "</td>" +
        "<td class='exc-ai-evid'>" + escapeHtml(it.evidence) + "</td>" +
        "<td class='exc-ai-cut'>-" + formatNumber(Math.round(it.cutQty)) +
          " <span class='exc-ai-amt'>-" + escapeHtml(formatMoney(it.cutAmt)) + "</span></td></tr>";
    }).join("") + "</tbody></table>";
    if (items.length > MAXR) html += "<div class='exc-aisec-more'>외 " + (items.length - MAXR) + "품목</div>";
    return html;
  }
  function invRows(items, secId) {
    if (!items.length) return "<div class='exc-aisec-empty'>해당 품목 없음</div>";
    var html = "<table class='exc-ai-table'><tbody>" + items.slice(0, MAXR).map(function(a, idx) {
      return "<tr class='exc-ai-row' data-sec='" + secId + "' data-idx='" + idx + "' title='클릭하면 진단 카드(차트·AI 소견·판정)가 열립니다'>" +
        "<td class='exc-ai-nm'><span class='exc-ai-codehead'>" + escapeHtml(a.itemCode) + "</span> " +
        escapeHtml(a.itemName || a.itemCode) +
        (a.bu ? " <span class='exc-ai-code'>" + escapeHtml(a.bu) + "</span>" : "") + "</td>" +
        "<td class='exc-ai-chipcell'>" + chip(a.cause) + dChip(a) + "</td>" +
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
    var focusable = (def.id === "supply" || def.id === "planfix");
    return "<div class='exc-aisec" + (applied ? " exc-aisec-on" : "") + "'>" +
      "<div class='exc-aisec-head' data-sec='" + def.id + "'" +
        (focusable ? " title='클릭하면 이 원인의 품목이 아래 시뮬레이션 표에서 강조됩니다'" : "") + ">" +
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

  // 판정 현황 요약 (닫힌 헤더에서도 확정/제안 분해가 보이도록)
  function decisionSum(secId, baseHtml) {
    var c = secConfirm(secId);
    if (!c.anyDec && !c.secApplied) return baseHtml;
    var chips = [];
    if (c.counts.accept) chips.push("✅" + c.counts.accept);
    if (c.counts.adjust) chips.push("🔶" + c.counts.adjust);
    if (c.counts.reject) chips.push("❌" + c.counts.reject);
    if (c.counts.hold)   chips.push("⏸" + c.counts.hold);
    return "확정 <strong>-" + escapeHtml(formatMoney(c.conf)) + "</strong> / 제안 -" +
      escapeHtml(formatMoney(S[secId].totalAmt)) + (chips.length ? " · " + chips.join(" ") : "");
  }
  var sumOf = {
    supply: decisionSum("supply",
      S.supply.items.length ? S.supply.items.length + "품목 <strong>-" + escapeHtml(formatMoney(S.supply.totalAmt)) + "</strong>" : "<span class='exc-aisec-none'>해당 없음</span>"),
    planfix: decisionSum("planfix",
      S.planfix.items.length ? S.planfix.items.length + "품목 <strong>-" + escapeHtml(formatMoney(S.planfix.totalAmt)) + "</strong>" : "<span class='exc-aisec-none'>해당 없음</span>"),
    sellout: np.sellout.length ? np.sellout.length + "품목 재고 <strong>" + escapeHtml(formatMoney(np.sellout.reduce(function(s, a) { return s + a.amt; }, 0))) + "</strong>" : "<span class='exc-aisec-none'>해당 없음</span>",
    disposal: np.disposal.length ? np.disposal.length + "품목 재고 <strong>" + escapeHtml(formatMoney(np.disposal.reduce(function(s, a) { return s + a.amt; }, 0))) + "</strong>" : "<span class='exc-aisec-none'>해당 없음</span>",
  };
  var excludedNote = np.excludedCnt > 0
    ? "<div class='exc-aisec-more'>※ 판매계획 파일 범위 밖 사업부·미분류 " + np.excludedCnt + "품목(" +
      escapeHtml(formatMoney(np.excludedAmt)) + ")은 이 회의 대상에서 제외</div>"
    : "";
  var bodyOf = {
    supply:   cutRows(S.supply.items, "supply"),
    planfix:  cutRows(S.planfix.items, "planfix"),
    sellout:  invRows(np.sellout, "sellout"),
    disposal: invRows(np.disposal, "disposal") + excludedNote,
  };
  var btnOf = {
    supply:  applyBtn("supply", S.supply.items.length > 0),
    planfix: applyBtn("planfix", S.planfix.items.length > 0),
    sellout: "", disposal: "",
  };

  // 확정(판정·적용 반영) 총액 — 확정이 하나라도 있으면 헤드에 노출 (제·상품 기준)
  var confTotal = secConfirm("supply").conf + secConfirm("planfix").conf;
  var headBtns = (!allApplied ? "<button class='exc-ai-apply'>권장안 전체적용</button>" : "") +
                 (anyApplied ? "<button class='exc-ai-clear'>전체해제</button>" : "");
  var head = "<div class='exc-ai-panel-head'>" +
    "<span class='exc-ai-icon'>🤖</span>" +
    "<span class='exc-ai-text'><strong>AI 과잉재고 진단</strong> — 완제품 " + fgCnt + "품목 원인 규명 완료 ➜ 권장안 적용 시 <strong class='exc-ai-good'>-" +
      escapeHtml(formatMoney(cutTotal)) + "</strong> 감축 (품절 0 유지)" +
      (identAmt > 0 ? " · 잠자는 재고 <strong class='exc-ai-good'>" + escapeHtml(formatMoney(identAmt)) + "</strong> 소진·처분 발굴" : "") +
      (confTotal > 0 ? " · <span class='exc-ai-conf'>협의 확정 -" + escapeHtml(formatMoney(confTotal)) + "</span>" : "") +
    "</span>" + headBtns + "</div>";

  return "<div class='exc-ai-panel'>" + head +
    AI_SECTION_DEFS.map(function(def) {
      var kicker = def.group ? "<div class='exc-aisec-group'>" + def.group + "</div>" : "";
      return kicker + secBlock(def, sumOf[def.id], bodyOf[def.id], btnOf[def.id]);
    }).join("") +
    "</div>";
}

// 섹션 단위 권장안 적용/해제 — 플래그만 바꾸고 반영은 syncAiFgAdj가 일원화
// (품목별 명시 판정은 섹션 플래그보다 우선 유지됨)
function toggleAiSection(secId) {
  state.aiSecApplied = state.aiSecApplied || {};
  state.aiSecApplied[secId] = !state.aiSecApplied[secId];
  syncAiFgAdj();
  render("inventory-variance");
}

// 자재 권장안 반영 — 원부자재 진단(matcut 섹션 적용 + 품목 판정)의 단일 반영 지점
// 제·상품 감축이 바뀌면 소요가 변하므로 항상 현재 excessAdj 기준으로 재산출
function syncAiMatPlan() {
  Object.keys(state.aiMatKeys || {}).forEach(function(k) { delete state.matExcessAdj[k]; });
  state.aiMatKeys = {};
  state.aiSecApplied = state.aiSecApplied || {};
  var secApplied = !!state.aiSecApplied.matcut;
  var det = computeAiMatExcessPlan(Object.assign({}, state.excessAdj || {}));
  (det.items || []).forEach(function(it) {
    var mode = decideAiMode(it, secApplied);
    if (mode === "none") return;
    var f = mode === "full" ? 1 : (it.cutQty > 0 ? mode / it.cutQty : 0);
    it.keys.forEach(function(k) {
      var origIntake = it.planVals[k] + (it.cutByKey[k] || 0);
      var cut = Math.floor((it.cutByKey[k] || 0) * f);
      state.matExcessAdj[k] = origIntake - cut;
      state.aiMatKeys[k] = true;
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 진단 카드 팝업 — 차트 A(수요: 왜 쌓였나) + 차트 B(재고: 감축하면 어떻게 되나)
// + AI 소견 서술문 + 협의 판정(수용/조정/불가/보류)
// ═══════════════════════════════════════════════════════════════════════════
var _aiPopupCharts = [];

// 수요변동률(CV = 과거 월별 출고 표준편차 ÷ 평균) — 판정어 없이 숫자만.
// 출고 0인 달이 40% 이상이면 간헐 수요라 %가 왜곡되므로 숫자 대신 "간헐" 표기.
function computeDemandCv(ti) {
  if (!ti) return null;
  var vals = [];
  [ti.outPrevYear, ti.outCurYear].forEach(function(m) {
    if (m) Object.keys(m).forEach(function(k) { vals.push(Number(m[k]) || 0); });
  });
  if (vals.length < 3) return null;
  var zeros = vals.filter(function(v) { return v <= 0; }).length;
  var mean = vals.reduce(function(a, b) { return a + b; }, 0) / vals.length;
  if (zeros / vals.length >= 0.4 || mean <= 0) return { intermittent: true };
  var varc = vals.reduce(function(a, b) { return a + (b - mean) * (b - mean); }, 0) / vals.length;
  return { intermittent: false, cv: Math.sqrt(varc) / mean };
}
function buildCvChip(ti) {
  var r = computeDemandCv(ti);
  if (!r) return "";
  if (r.intermittent) return "<span class='exc-diag-cvchip exc-diag-cvchip-int' title='출고 없는 달이 많아 변동률 산정 제외'>수요변동 —<small> 간헐</small></span>";
  return "<span class='exc-diag-cvchip' title='과거 월별 출고 표준편차 ÷ 평균'>수요변동 " + Math.round(r.cv * 100) + "%</span>";
}
// 적정재고일수 칩 — 감축 제안의 기준점(며칠까지 맞추나). it.targetDays 우선, 없으면 ti.targetDays
function buildTargetChip(it, ti) {
  var td = it && Number.isFinite(it.targetDays) ? it.targetDays
         : (ti && Number.isFinite(ti.targetDays) ? ti.targetDays : null);
  if (td === null) return "<span class='exc-diag-tgtchip exc-diag-tgtchip-none'>적정 미등록</span>";
  return "<span class='exc-diag-tgtchip' title='적정재고 기준일수'>적정 " + Math.round(td) + "일</span>";
}

function closeAiDiagPopup() {
  _aiPopupCharts.forEach(function(c) { try { c.destroy(); } catch (e) {} });
  _aiPopupCharts = [];
  var ov = document.querySelector(".exc-diag-overlay");
  if (ov && ov.parentElement) ov.parentElement.removeChild(ov);
}

function openAiDiagPopup(secId, idx) {
  if (secId === "matcut" || secId === "matunused") return openMatDiagPopup(secId, idx);
  // 재고일수 구간 목록 → 정보성 진단 카드 (감축안 없음)
  if (secId === "mat180x" || secId === "mat150" || secId === "mat120" || secId === "mat90") {
    var band = _matDiagCache && _matDiagCache.bands && _matDiagCache.bands[secId] && _matDiagCache.bands[secId][idx];
    if (band) {
      var bit = buildMatInfoItem(band.itemCode, band.plantCode);
      if (bit) openInfoDiagPopup(bit, true);
    }
    return;
  }
  if (!_aiDiagCache) return;
  var isCut = secId === "supply" || secId === "planfix";
  var it = isCut
    ? _aiDiagCache.cls.sections[secId].items[idx]
    : _aiDiagCache.cls.noPlan[secId === "sellout" ? "sellout" : "disposal"][idx];
  if (!it) return;
  closeAiDiagPopup();

  var meta = AI_CAUSE_META[it.cause] || AI_CAUSE_META.overbase;
  var def = findAiSecDef(secId);
  var d = getAiDecision(it);
  var opinion = isCut ? buildAiOpinion(it) : buildNoPlanOpinion(it);
  var plantLabel = it.plantCode && typeof displayPlantName === "function" ? displayPlantName(it.plantCode) : (it.plantCode || "");

  var proposalTxt = isCut
    ? "감축 제안 <strong>-" + formatNumber(Math.round(it.cutQty)) + "개 · -" + escapeHtml(formatMoney(it.cutAmt)) + "</strong>"
    : "보유 재고 <strong>" + formatNumber(Math.round(it.qty)) + "개 · " + escapeHtml(formatMoney(it.amt)) + "</strong>";

  // 판정 UI — KPI 반영 섹션은 조정 입력 지원, 나머지는 진행/불가/보류 기록
  var canAdjust = secId === "supply" || secId === "planfix";
  var decBtns =
    "<button class='exc-diag-dec' data-status='accept'>✅ 수용</button>" +
    (canAdjust ? "<button class='exc-diag-dec' data-status='adjust'>🔶 조정 수용</button>" : "") +
    "<button class='exc-diag-dec' data-status='reject'>❌ 불가</button>" +
    "<button class='exc-diag-dec' data-status='hold'>⏸ 보류</button>";
  var curDec = d
    ? "<span class='exc-ai-dchip exc-ai-dchip-" + d.status + "'>" + (AI_DECISION_LABELS[d.status] || d.status) + "</span>" +
      (d.qty ? " 확정 -" + formatNumber(Math.round(d.qty)) + "개" : "") +
      (d.reason ? " · " + escapeHtml(d.reason) : "") +
      " <button class='exc-diag-dec-clear'>판정 취소</button>"
    : "<span class='exc-diag-nodec'>미판정</span>";

  var ov = document.createElement("div");
  ov.className = "exc-diag-overlay";
  ov.innerHTML =
    "<div class='exc-diag-card'>" +
      "<div class='exc-diag-head'>" +
        "<div class='exc-diag-titles'>" +
          "<div class='exc-diag-name'><span class='exc-ai-codehead'>" + escapeHtml(it.itemCode) + "</span> " +
            escapeHtml(it.itemName || it.itemCode) +
            "<span class='exc-ai-code'>" +
            (plantLabel ? " " + escapeHtml(plantLabel) : "") + (it.bu ? "·" + escapeHtml(it.bu) : "") + "</span></div>" +
          "<div class='exc-diag-sub'>" +
            (def ? "<span class='exc-aisec-owner'>" + def.no + " " + def.title + " · " + def.owner + "</span> " : "") +
            "<span class='exc-ai-chip exc-ai-chip-" + meta.cls + "'>" + meta.label + "</span> " +
            "<span class='exc-diag-proposal'>" + proposalTxt + "</span> " +
            buildCvChip(isCut ? (it.diag && it.diag.ti) : it.ti) + " " +
            buildTargetChip(it, isCut ? (it.diag && it.diag.ti) : it.ti) +
          "</div>" +
        "</div>" +
        "<button class='exc-diag-close' title='닫기'>×</button>" +
      "</div>" +
      "<div class='exc-diag-opinion'><span class='exc-diag-opinion-tag'>🤖 AI 소견</span>" + escapeHtml(opinion) + "</div>" +
      "<div class='exc-diag-charts'>" +
        "<div class='exc-diag-chartbox'>" +
          "<div class='exc-diag-chart-title'>수요 흐름 — 왜 쌓였나 <span class='exc-diag-chart-sub'>출고실적·입고계획(막대) vs 판매계획(선)</span></div>" +
          "<div class='exc-diag-canvas-wrap'><canvas class='exc-diag-chart-a'></canvas></div>" +
        "</div>" +
        (isCut
          ? "<div class='exc-diag-chartbox'>" +
              "<div class='exc-diag-chart-title'>재고 전망 — 감축하면 어떻게 되나 <span class='exc-diag-chart-sub'>기말재고 vs 적정재고 수준 vs 감축 적용 후</span></div>" +
              "<div class='exc-diag-canvas-wrap'><canvas class='exc-diag-chart-b'></canvas></div>" +
            "</div>"
          : "") +
      "</div>" +
      (isCut ? buildCutPlanStrip(it) : "") +
      "<div class='exc-diag-decide'>" +
        "<span class='exc-diag-decide-label'>협의 결과</span>" + decBtns +
        "<span class='exc-diag-cur'>" + curDec + "</span>" +
      "</div>" +
      "<div class='exc-diag-inputs' hidden>" +
        "<span class='exc-diag-input-qty' hidden>확정 감축량 <input type='number' class='exc-diag-qty' min='0'" +
          (isCut ? " max='" + Math.round(it.cutQty) + "' value='" + Math.round(it.cutQty) + "'" : "") + "> 개</span>" +
        "<span class='exc-diag-input-reason'>사유 <input type='text' class='exc-diag-reason' placeholder='예: 전략비축 / 최소운영재고 / 프로모션 예정'></span>" +
        "<button class='exc-diag-save'>판정 기록</button>" +
      "</div>" +
    "</div>";
  document.body.appendChild(ov);

  // 닫기
  ov.addEventListener("click", function(e) { if (e.target === ov) closeAiDiagPopup(); });
  ov.querySelector(".exc-diag-close").addEventListener("click", closeAiDiagPopup);

  // 판정 흐름: 상태 버튼 클릭 → 입력영역 노출 → [판정 기록]
  var selStatus = null;
  var inputs = ov.querySelector(".exc-diag-inputs");
  var qtyWrap = ov.querySelector(".exc-diag-input-qty");
  ov.querySelectorAll(".exc-diag-dec").forEach(function(btn) {
    btn.addEventListener("click", function() {
      selStatus = btn.dataset.status;
      ov.querySelectorAll(".exc-diag-dec").forEach(function(b) {
        b.classList.toggle("exc-diag-dec-sel", b === btn);
      });
      inputs.hidden = false;
      qtyWrap.hidden = selStatus !== "adjust";
    });
  });
  var saveBtn = ov.querySelector(".exc-diag-save");
  if (saveBtn) saveBtn.addEventListener("click", function() {
    if (!selStatus) return;
    var qty = selStatus === "adjust" ? Number(ov.querySelector(".exc-diag-qty").value) || 0 : null;
    var reason = (ov.querySelector(".exc-diag-reason").value || "").trim();
    closeAiDiagPopup();
    setAiDecision(secId, it, selStatus, qty, reason);
  });
  var clearBtn = ov.querySelector(".exc-diag-dec-clear");
  if (clearBtn) clearBtn.addEventListener("click", function() {
    closeAiDiagPopup();
    setAiDecision(secId, it, null);
  });

  renderAiDiagCharts(it, isCut, ov);
}

// 월별 감축 지시 스트립 — 실행 담당이 "몇 월에 몇 개"를 바로 읽도록, 감축 발생 월만 칩으로
// (완제품=공급계획 감축, 원부자재=입고 취소 — 키 구조가 같아 공용)
function buildCutPlanStrip(it) {
  if (!it || !it.cutByKey || !it.months || !(it.cutQty > 0)) return "";
  var chips = [];
  it.months.forEach(function(m) {
    var cut = it.cutByKey[it.itemCode + "|" + (it.plantCode || "") + "|" + m];
    if (!cut) return;
    chips.push("<span class='exc-diag-cut-chip'>" + escapeHtml(monthLabel(m)) +
      " <b>-" + formatNumber(cut) + "</b></span>");
  });
  if (!chips.length) return "";
  return "<div class='exc-diag-cutplan'><span class='exc-diag-cutplan-lbl'>✂ 감축 제안</span>" +
    chips.join("") +
    "<span class='exc-diag-cutplan-sum'>합계 -" + formatNumber(Math.round(it.cutQty)) + "개 · -" +
    escapeHtml(formatMoney(it.cutAmt)) + "</span></div>";
}

// 팝업 차트 2종 — Chart.js 전역이 있을 때만 (없으면 카드 텍스트만으로도 성립)
function renderAiDiagCharts(it, isCut, ov) {
  if (typeof Chart === "undefined") return;
  var shortM = function(m) { return m.slice(2).replace("-", "."); };
  var ti = isCut ? (it.diag && it.diag.ti) : it.ti;
  // 수량 축약 표기 (라벨·y축용): 123.5만 / 1.2억 — 팝업 내 모든 축 단위 통일
  var fmtC = function(v) {
    if (v === null || v === undefined) return "";
    var av = Math.abs(v);
    if (av >= 1e8) return (Math.round(v / 1e7) / 10).toLocaleString() + "억";
    if (av >= 1e4) return (Math.round(v / 1e3) / 10).toLocaleString() + "만";
    return Math.round(v).toLocaleString();
  };

  // 차트 A: 과거 실적(막대) + 판매계획(실선) — 과거 판매계획은 적정재고 RAW의 S/F(1~6월),
  // 미래는 판매계획 RAW(7~12월). 같은 "판매계획"이라 한 보라선·단일 범례로 이음.
  var hist = [], histVals = [];
  if (ti) {
    var histMap = {};
    Object.keys(ti.outPrevYear || {}).forEach(function(m) { histMap[m] = ti.outPrevYear[m]; });
    Object.keys(ti.outCurYear || {}).forEach(function(m) { histMap[m] = ti.outCurYear[m]; });
    hist = Object.keys(histMap).sort();
    histVals = hist.map(function(m) { return histMap[m]; });
  }
  var future = isCut && it.months ? it.months : [];
  var labels = hist.concat(future);
  var canvasA = ov.querySelector(".exc-diag-chart-a");
  if (canvasA && labels.length) {
    var histData = histVals.concat(future.map(function() { return null; }));
    // 판매계획 단일 라인: 미래는 판매계획 RAW(salesArr), 과거는 그 시점 판매계획(=적정재고 S/F)
    var planData = labels.map(function(m) {
      var i = future.indexOf(m);
      if (i >= 0) return it.salesArr ? it.salesArr[i] : null;
      var v = ti && ti.sfByMonth ? ti.sfByMonth[m] : undefined;
      return v === undefined ? null : v;
    });
    // 미래 입고(공급)계획 — 감축 제안이 취소하려는 바로 그 입고. 감축 제안 있는 품목은 항상 존재(cut≤공급).
    var supplyData = labels.map(function(m) {
      var i = future.indexOf(m);
      return i < 0 ? null : (it.origSupplyArr ? it.origSupplyArr[i] : null);
    });
    _aiPopupCharts.push(new Chart(canvasA.getContext("2d"), {
      type: "bar",
      data: {
        labels: labels.map(shortM),
        datasets: [
          { type: "bar", label: "출고 실적", data: histData, order: 2,
            backgroundColor: labels.map(function(m) { return m < "2026" ? "#cbd5e1" : "#93c5fd"; }) },
          { type: "bar", label: "입고(공급)계획", data: supplyData, order: 2,
            backgroundColor: "#fb923c" },
          { type: "line", label: "판매계획", data: planData, borderColor: "#4f46e5",
            borderWidth: 2.5, pointRadius: 2.5, spanGaps: true, order: 0 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        // S/F 라인은 점이 없어 개별 히트 불가 → 월 단위로 세 시리즈 동시 툴팁
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: true, position: "top", labels: { boxWidth: 14, font: { size: 13.5 } } },
          tooltip: { filter: function(item) { return item.raw !== null && item.raw !== undefined; },
            callbacks: { label: function(c) {
            return c.raw === null || c.raw === undefined ? null : c.dataset.label + ": " + Math.round(c.raw).toLocaleString() + "개";
          } } } },
        scales: {
          x: { grid: { color: "#f3f4f6" }, ticks: { font: { size: 13 }, maxRotation: 0, autoSkip: true } },
          y: { grid: { color: "#f3f4f6" }, ticks: { font: { size: 13 }, callback: function(v) { return fmtC(v); } } },
        },
      },
    }));
  }

  // 차트 B: 기말재고(현재 계획) vs 감축 적용 후 vs 적정재고 수준
  var canvasB = ov.querySelector(".exc-diag-chart-b");
  if (canvasB && isCut && it.months && it.months.length) {
    var tgtLine = it.months.map(function(m, i) {
      var daily = it.salesArr[i] > 0 ? it.salesArr[i] / monthDays(m) : 0;
      return daily > 0 ? it.targetDays * daily : null;
    });
    // 데이터 라벨: 현재계획=점 위(회색), 감축후=점 아래(초록, 값이 같아진 월은 생략),
    // 적정선=우측 끝 1개만, 직전 라벨·태그와 겹치는 것은 자동 스킵 — 라벨 과밀로 화면이 깨지지 않게 하는 규칙
    // + 재고일수 태그 2줄 (하단: 감축 전 회색 / 감축 후 초록, 글자색=적정 판정)
    var fgDaysAfter = it.months.map(function(m, i) {
      var daily = it.salesArr[i] > 0 ? it.salesArr[i] / monthDays(m) : 0;
      return daily > 0 ? it.cutEndingArr[i] / daily : null;
    });
    var fgDaysBefore = it.months.map(function(m, i) {
      var daily = it.salesArr[i] > 0 ? it.salesArr[i] / monthDays(m) : 0;
      return daily > 0 ? it.origEndingArr[i] / daily : null;
    });
    // 제목 옆 효과 칩 — 마지막 유효 월 기준 "감축 전 → 후" 일수 한 줄 요약
    var effIdx = -1;
    for (var ei = it.months.length - 1; ei >= 0; ei--) {
      if (Number.isFinite(fgDaysBefore[ei]) && Number.isFinite(fgDaysAfter[ei])) { effIdx = ei; break; }
    }
    var titleElB = canvasB.closest(".exc-diag-chartbox").querySelector(".exc-diag-chart-title");
    if (effIdx >= 0 && titleElB && !titleElB.querySelector(".exc-diag-eff-chip")) {
      var effB = Math.round(fgDaysBefore[effIdx]), effA = Math.round(fgDaysAfter[effIdx]);
      var effChip = document.createElement("span");
      effChip.className = "exc-diag-eff-chip";
      effChip.innerHTML = escapeHtml(shortM(it.months[effIdx])) +
        " <b class='" + (Number.isFinite(it.targetDays) && effB > it.targetDays ? "exc-eff-over" : "exc-eff-ok") + "'>" + effB + "일</b> → <b class='" +
        (Number.isFinite(it.targetDays) && effA > it.targetDays ? "exc-eff-over" : "exc-eff-ok") + "'>" + effA + "일</b>";
      titleElB.appendChild(effChip);
    }
    var diagLabelsPlugin = {
      id: "diagLabels",
      afterDatasetsDraw: function(chart) {
        var c = chart.ctx, area = chart.chartArea;
        var clampX = function(x) { return Math.min(Math.max(x, area.left + 16), area.right - 16); };
        var m0 = chart.getDatasetMeta(0), m1 = chart.getDatasetMeta(1), m2 = chart.getDatasetMeta(2);
        var d0 = chart.data.datasets[0].data, d1 = chart.data.datasets[1].data, d2 = chart.data.datasets[2].data;
        c.save();
        c.textAlign = "center";
        var lastR0 = -Infinity, lastR1 = -Infinity;
        m0.data.forEach(function(el, i) {
          var v0 = d0[i], v1 = d1[i];
          if (v0 === null || v0 === undefined) return;
          var same = v1 !== null && v1 !== undefined && Math.abs(v0 - v1) < Math.max(1, Math.abs(v0) * 0.005);
          c.font = "600 12.5px Pretendard, sans-serif";
          var t0 = fmtC(v0), x0 = clampX(el.x), w0 = c.measureText(t0).width;
          if (x0 - w0 / 2 > lastR0 + 4) {
            c.fillStyle = "#64748b";
            c.textBaseline = "bottom";
            c.fillText(t0, x0, el.y - 5);
            lastR0 = x0 + w0 / 2;
          }
          if (!same && m1.data[i] && v1 !== null && v1 !== undefined) {
            c.font = "800 13px Pretendard, sans-serif";
            var t1 = fmtC(v1), x1 = clampX(m1.data[i].x), w1 = c.measureText(t1).width;
            if (x1 - w1 / 2 > lastR1 + 4) {
              c.fillStyle = "#15803d";
              c.textBaseline = "top";
              c.fillText(t1, x1, m1.data[i].y + 5);
              lastR1 = x1 + w1 / 2;
            }
          }
        });
        // 적정선 라벨 — 차트 밖 우측 여백에 선 높이 맞춰 표기(플롯 영역 비우기). 일수는 범례·헤더에 있어 수량만.
        var lastIdx = -1;
        for (var i2 = d2.length - 1; i2 >= 0; i2--) {
          if (d2[i2] !== null && d2[i2] !== undefined) { lastIdx = i2; break; }
        }
        if (lastIdx >= 0 && m2.data[lastIdx]) {
          c.font = "700 12px Pretendard, sans-serif";
          c.fillStyle = "#dc2626";
          c.textAlign = "left";
          c.textBaseline = "middle";
          var ly = Math.min(Math.max(m2.data[lastIdx].y, area.top + 8), area.bottom - 8);
          c.fillText("적정 " + fmtC(d2[lastIdx]), area.right + 6, ly);
        }
        // 재고일수 태그 2줄 — 윗줄 감축 전(회색=라인색) / 아랫줄 감축 후(초록=라인색).
        // 배경·테두리=시리즈 색, 글자=적정 판정(초과 빨강). 전후 동일 월은 아랫줄 생략, 줄별 겹침 스킵.
        c.textAlign = "center";
        var th = 22;
        var pillRow = function(daysArr, ty, bg, border, okColor, skipSame) {
          var lastR = -Infinity;
          m1.data.forEach(function(el, i) {
            var dv = daysArr[i];
            if (dv === null || !isFinite(dv)) return;
            if (skipSame && Number.isFinite(fgDaysBefore[i]) && Math.round(fgDaysBefore[i]) === Math.round(dv)) return;
            var text = Math.round(dv) + "일";
            c.font = "800 12px Pretendard, sans-serif";
            var tw = c.measureText(text).width + 14;
            var tx = clampX(el.x) - tw / 2;
            if (tx < lastR + 4) return;
            lastR = tx + tw;
            var over = Number.isFinite(it.targetDays) && dv > it.targetDays;
            c.fillStyle = bg;
            _excRoundRect(c, tx, ty, tw, th, 5); c.fill();
            c.strokeStyle = border; c.lineWidth = 1;
            _excRoundRect(c, tx, ty, tw, th, 5); c.stroke();
            c.fillStyle = over ? "#dc2626" : okColor;
            c.textBaseline = "middle";
            c.fillText(text, clampX(el.x), ty + th / 2);
          });
        };
        pillRow(fgDaysBefore, area.bottom - th * 2 - 8, "rgba(148,163,184,0.16)", "rgba(100,116,139,0.45)", "#475569", false);
        pillRow(fgDaysAfter,  area.bottom - th - 4,     "rgba(22,163,74,0.10)",  "rgba(22,163,74,0.40)",  "#15803d", true);
        c.restore();
      },
    };
    _aiPopupCharts.push(new Chart(canvasB.getContext("2d"), {
      type: "line",
      data: {
        labels: it.months.map(shortM),
        datasets: [
          { label: "기말재고 (현재 계획)", data: it.origEndingArr, borderColor: "#94a3b8",
            backgroundColor: "rgba(148,163,184,0.14)", fill: true, borderWidth: 2, pointRadius: 2.5 },
          { label: "감축 적용 후", data: it.cutEndingArr, borderColor: "#16a34a",
            borderDash: [6, 4], borderWidth: 2.5, pointRadius: 2.5 },
          { label: "적정재고 수준" + (Number.isFinite(it.targetDays) ? " (" + Math.round(it.targetDays) + "일)" : ""), data: tgtLine, borderColor: "#dc2626",
            borderDash: [2, 3], borderWidth: 1.8, pointRadius: 0, spanGaps: true },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 18, bottom: 8, right: 64 } },
        plugins: { legend: { display: true, position: "top", labels: { boxWidth: 14, font: { size: 13.5 } } },
          tooltip: { callbacks: { label: function(c) {
            return c.raw === null || c.raw === undefined ? null : c.dataset.label + ": " + Math.round(c.raw).toLocaleString() + "개";
          } } } },
        scales: {
          x: { grid: { color: "#f3f4f6" }, ticks: { font: { size: 13 } } },
          y: { grid: { color: "#f3f4f6" }, ticks: { font: { size: 13 }, callback: function(v) { return fmtC(v); } } },
        },
      },
      plugins: [diagLabelsPlugin],
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 원부자재 과잉 관리 (180일 기준) — BOM matFlows 기반
// ═══════════════════════════════════════════════════════════════════════════
// 자재 월별 흐름 계산: 소비(BOM 소요, 제상품 감축 비례 반영) / 입고(matExcessAdj 반영)
var _baseMatFlowCache = null, _baseMatFlowRef = null; // 무조정(base) 자재흐름 — BOM 안 바뀌면 재사용
function calcMatFlowRows(fgAdj, matAdj) {
  excCount("calcMatFlowRows");
  if (!(typeof BOM_STATUS !== "undefined" && state.bomStatus === BOM_STATUS.DONE &&
        state.bomResult && state.bomResult.matFlows)) return null;
  // base 시나리오(조정 없음)는 bomResult가 그대로면 값이 동일 → 캐시 재사용
  var isBase = !fgAdj && !matAdj;
  if (isBase && _baseMatFlowCache && _baseMatFlowRef === state.bomResult) return _baseMatFlowCache;
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
  if (isBase) { _baseMatFlowCache = rows; _baseMatFlowRef = state.bomResult; }
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
  if (!rows) return { plan: {}, totalCutAmt: 0, itemCnt: 0, items: [] };
  var months = getRtfMonths();
  var plan = {}, totalCutAmt = 0, itemCnt = 0, aiItems = [];
  rows.forEach(function(r) {
    if (!r.sane) return; // 정합 의심 자재는 AI 제외
    if (!Number.isFinite(r.flow.unitVal)) return;
    var ending = r.ending.slice(), intake = r.intake.slice();
    var changed = false;
    var itemCutQty = 0, itemCutAmt = 0, itemKeys = [], itemPlanVals = {}, itemCutByKey = {};
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
      var planKey = r.flow.componentCode + "|" + r.flow.plant + "|" + months[mi];
      plan[planKey] = intake[mi];
      itemKeys.push(planKey);
      itemPlanVals[planKey] = intake[mi];
      itemCutByKey[planKey] = cut;
      itemCutQty += cut;
      itemCutAmt += cut * r.flow.unitVal;
      totalCutAmt += cut * r.flow.unitVal;
      changed = true;
    }
    if (changed) {
      itemCnt++;
      var dvals = r.days.filter(function(v) { return v !== null; });
      aiItems.push({
        itemCode: r.flow.componentCode, itemName: r.flow.componentName || r.flow.componentCode,
        plantCode: r.flow.plant || "", unitVal: r.flow.unitVal,
        cutQty: itemCutQty, cutAmt: itemCutAmt,
        keys: itemKeys, planVals: itemPlanVals, cutByKey: itemCutByKey,
        maxDays: dvals.length ? Math.max.apply(null, dvals) : null,
        // 진단 팝업 차트용 (유효 전 구간)
        months: months.slice(), consArr: r.cons.slice(),
        origIntakeArr: r.intake.slice(), cutIntakeArr: intake.slice(),
        origEndingArr: r.ending.slice(), cutEndingArr: ending.slice(),
        parents: r.flow.parents,
      });
    }
  });
  aiItems.sort(function(a, b) { return b.cutAmt - a.cutAmt; });
  return { plan: plan, totalCutAmt: totalCutAmt, itemCnt: itemCnt, items: aiItems };
}

// ═══════════════════════════════════════════════════════════════════════════
// 원부자재 AI 진단 — 두 줄 원칙: "너무 많이 쌓였거나(180일↑), 아예 안 쓰거나(소요 0)"
// 원인 설명은 팝업(진단 카드) 안에서만 — 목록은 심각도·금액만
// ═══════════════════════════════════════════════════════════════════════════
var MAT_SECTION_DEFS = [
  { id: "matcut",    no: "①", title: MAT_TARGET_DAYS + "일 이상 — 즉시 감축", owner: "AI 감축안 적용 대상", group: "너무 많이 쌓인 재고 — 재고일수 구간",
    desc: "기준: 향후 소요 대비 재고일수 최대치가 " + MAT_TARGET_DAYS + "일 초과. 담당: 구매·공장 — 입고 취소·연기, 감축 시나리오 KPI 반영. (입고가 없어 감축 여지가 없는 자재는 목록 하단 별도 표기)" },
  { id: "mat150",    no: "②", title: "150~" + MAT_TARGET_DAYS + "일 — 감축 검토", owner: "다음 사이클 후보",
    desc: "기준선(" + MAT_TARGET_DAYS + "일)에 근접한 자재 — 소요·입고 추이를 확인하고 다음 사이클 감축 후보로 관리. (참고 목록, KPI 미반영)" },
  { id: "mat120",    no: "③", title: "120~150일 — 관찰", owner: "참고 목록",
    desc: "재고일수 120~150일 자재 — 추세 관찰 대상. (참고 목록, KPI 미반영)" },
  { id: "mat90",     no: "④", title: "90~120일 — 관찰", owner: "참고 목록",
    desc: "재고일수 90~120일 자재 — 추세 관찰 대상. (참고 목록, KPI 미반영)" },
  { id: "matunused", no: "⑤", title: "아예 안 쓰는 재고",   owner: "이번 계획 소요 0", group: "아예 안 쓰는 재고",
    desc: "기준: 재고는 있으나 이번 계획 기간에 소요(BOM 전개)가 전혀 없음 — BOM 미등록 포함. 담당: 구매·사업부 — 반품·전용·폐기 검토. (KPI 미반영 액션아이템)" },
];
function findAiSecDef(secId) {
  var hit = null;
  AI_SECTION_DEFS.concat(MAT_SECTION_DEFS).forEach(function(d) { if (d.id === secId) hit = d; });
  return hit;
}

var _matDiagCache = null;
var _fgCauseCache = null; // 자재 소견의 부모 완제품 원인 상속용

function _fgCauseOf(code, plant) {
  if (!_fgCauseCache) {
    _fgCauseCache = new Map();
    try {
      var cls = classifyAiExcess();
      ["supply", "planfix"].forEach(function(s) {
        cls.sections[s].items.forEach(function(x) {
          _fgCauseCache.set(x.itemCode + "|" + (x.plantCode || ""), (AI_CAUSE_META[x.cause] || {}).label || x.cause);
        });
      });
    } catch (e) {}
  }
  return _fgCauseCache.get(code + "|" + (plant || "")) || null;
}

// 소요 없는 자재 스캔 — 사업부 범위(판매계획 파일에 등장하는 사업부) 밖은 제외 집계
function computeMatUnused() {
  var mf = (state.bomResult && state.bomResult.matFlows) || [];
  var consumed = new Set();
  var months = getRtfMonths();
  mf.forEach(function(f) {
    var s = 0;
    f.parents.forEach(function(p) { months.forEach(function(m) { var pm = p.monthly[m]; if (pm) s += pm.reqQty || 0; }); });
    if (s > 0) consumed.add(f.componentCode);
  });
  var bomSet = new Set();
  var rootsByComp = new Map();
  (state.mappedData.bom_components || []).forEach(function(r) {
    if (!r.componentCode) return;
    bomSet.add(r.componentCode);
    var set = rootsByComp.get(r.componentCode);
    if (!set) { set = new Set(); rootsByComp.set(r.componentCode, set); }
    if (r.rootItemCode) set.add(r.rootItemCode);
  });
  var buMap = new Map();
  (state.mappedData.item_master || []).forEach(function(r) { if (r.itemCode && r.businessUnit) buMap.set(r.itemCode, r.businessUnit); });
  var planBUs = new Set();
  (state.mappedData.plan_monthly || []).forEach(function(r) {
    if (!r.itemCode) return;
    var bu = buMap.get(r.itemCode);
    if (bu) planBUs.add(bu);
  });
  var inScope = function(code) {
    if (!planBUs.size) return true;
    var bu = buMap.get(code);
    if (bu) return planBUs.has(bu);
    // 자재는 기준정보에 사업부가 없는 경우가 많음 → BOM 부모들의 최빈 사업부로 귀속
    // ("하나라도 일치" 규칙은 공용 반제품 때문에 타 사업부 자재가 새어 들어옴)
    var roots = rootsByComp.get(code);
    if (roots) {
      var counts = {}, bestBu = null, bestN = 0;
      roots.forEach(function(rc) {
        var rb = buMap.get(rc);
        if (rb) counts[rb] = (counts[rb] || 0) + 1;
      });
      Object.keys(counts).forEach(function(b) {
        if (counts[b] > bestN) { bestN = counts[b]; bestBu = b; }
      });
      if (bestBu) return planBUs.has(bestBu);
    }
    return false; // 사업부를 알 수 없으면 범위 외로
  };

  var agg = new Map();
  (state.mappedData.inventory_base || []).forEach(function(r) {
    var t = String(r.itemType || "");
    if (t.indexOf("완제품") >= 0 || t.indexOf("상품") >= 0 || t.indexOf("재공품") >= 0 || t.indexOf("판촉물") >= 0) return;
    if (!r.itemCode || consumed.has(r.itemCode)) return;
    var qty = Number.isFinite(r.baseQty) ? r.baseQty : 0;
    var amt = Number.isFinite(r.baseAmount) ? r.baseAmount : 0;
    if (qty <= 0 && amt <= 0) return;
    var a = agg.get(r.itemCode);
    if (!a) { a = { itemCode: r.itemCode, itemName: r.itemName || "", plantCode: "", itemType: t, qty: 0, amt: 0 }; agg.set(r.itemCode, a); }
    a.qty += qty; a.amt += amt;
    if (!a.itemName && r.itemName) a.itemName = r.itemName;
  });
  var items = [], scopeCnt = 0, scopeAmt = 0;
  agg.forEach(function(a) {
    if (!inScope(a.itemCode)) { scopeCnt++; scopeAmt += a.amt; return; }
    a.cause = bomSet.has(a.itemCode) ? "dormant" : "unknown"; // 소요없음 / BOM 미등록
    items.push(a);
  });
  items.sort(function(x, y) { return y.amt - x.amt; });
  return { items: items, scopeCnt: scopeCnt, scopeAmt: scopeAmt };
}

function renderMatDiagPanel() {
  if (!(typeof BOM_STATUS !== "undefined" && state.bomStatus === BOM_STATUS.DONE && state.bomResult)) return "";
  _fgCauseCache = null;
  _rootsPlanCache = null;
  var aiMat = computeAiMatExcessPlan(Object.assign({}, state.excessAdj || {}));
  var unused = computeMatUnused();
  // 정합 의심(단위) 자재 수 — 각주 표기용
  var flowRows = calcMatFlowRows(state.excessAdj, null) || [];
  var insaneCnt = flowRows.filter(function(r) { return !r.sane; }).length;

  // 재고일수 구간(150/120/90) + 180↑인데 입고가 없어 감축 불가한 자재
  var aiCutSet = new Set();
  aiMat.items.forEach(function(it) { aiCutSet.add(it.itemCode + "|" + (it.plantCode || "")); });
  var bands = { mat180x: [], mat150: [], mat120: [], mat90: [] };
  flowRows.forEach(function(r) {
    if (!r.sane) return;
    var dvals = r.days.filter(function(v) { return v !== null; });
    if (!dvals.length) return;
    var maxD = Math.max.apply(null, dvals);
    if (maxD < 90) return;
    var key = r.flow.componentCode + "|" + (r.flow.plant || "");
    var unitVal = Number.isFinite(r.flow.unitVal) ? r.flow.unitVal : 0;
    var consSum = 0, consCnt = 0;
    r.cons.forEach(function(v) { if (v > 0) { consSum += v; consCnt++; } });
    var entry = {
      itemCode: r.flow.componentCode, itemName: r.flow.componentName || r.flow.componentCode,
      plantCode: r.flow.plant || "", maxDays: maxD,
      invAmt: Math.max(0, r.ending[0] || 0) * unitVal,
      avgCons: consCnt ? consSum / consCnt : 0,
    };
    if (maxD >= MAT_TARGET_DAYS) { if (!aiCutSet.has(key)) bands.mat180x.push(entry); }
    else if (maxD >= 150) bands.mat150.push(entry);
    else if (maxD >= 120) bands.mat120.push(entry);
    else bands.mat90.push(entry);
  });
  Object.keys(bands).forEach(function(k) { bands[k].sort(function(a, b) { return b.invAmt - a.invAmt; }); });

  _matDiagCache = { aiMat: aiMat, unused: unused, bands: bands };
  state.aiSecApplied = state.aiSecApplied || {};
  state.aiDiagOpen   = state.aiDiagOpen   || {};
  var bandCnt = bands.mat180x.length + bands.mat150.length + bands.mat120.length + bands.mat90.length;
  if (!aiMat.itemCnt && !unused.items.length && !bandCnt) return "";

  var matApplied = !!state.aiSecApplied.matcut;
  var conf = 0, counts = { accept: 0, adjust: 0, reject: 0, hold: 0 }, anyDec = false;
  aiMat.items.forEach(function(it) {
    var d = getAiDecision(it);
    if (d) { anyDec = true; counts[d.status] = (counts[d.status] || 0) + 1; }
    conf += effectiveCutOf(it, matApplied).amt;
  });
  var cutSum;
  if (anyDec || matApplied) {
    var chips = [];
    if (counts.accept) chips.push("✅" + counts.accept);
    if (counts.adjust) chips.push("🔶" + counts.adjust);
    if (counts.reject) chips.push("❌" + counts.reject);
    if (counts.hold)   chips.push("⏸" + counts.hold);
    cutSum = "확정 <strong>-" + escapeHtml(formatMoney(conf)) + "</strong> / 제안 -" +
      escapeHtml(formatMoney(aiMat.totalCutAmt)) + (chips.length ? " · " + chips.join(" ") : "");
  } else {
    cutSum = aiMat.itemCnt
      ? aiMat.itemCnt + "종 · 감축 가능 <strong>-" + escapeHtml(formatMoney(aiMat.totalCutAmt)) + "</strong>"
      : "<span class='exc-aisec-none'>해당 없음</span>";
  }
  var unusedAmt = unused.items.reduce(function(s, a) { return s + a.amt; }, 0);
  var unusedSum = unused.items.length
    ? unused.items.length + "종 재고 <strong>" + escapeHtml(formatMoney(unusedAmt)) + "</strong>"
    : "<span class='exc-aisec-none'>해당 없음</span>";

  var MAXR = 100;
  function dChipM(it) {
    var d = getAiDecision(it);
    if (!d) return "";
    return " <span class='exc-ai-dchip exc-ai-dchip-" + d.status + "'>" + (AI_DECISION_LABELS[d.status] || d.status) + "</span>";
  }
  function matCutRows(items) {
    if (!items.length) return "<div class='exc-aisec-empty'>해당 자재 없음</div>";
    var html = "<table class='exc-ai-table'><tbody>" + items.slice(0, MAXR).map(function(it, idx) {
      var pl = it.plantCode && typeof displayPlantName === "function" ? displayPlantName(it.plantCode) : (it.plantCode || "");
      return "<tr class='exc-ai-row' data-sec='matcut' data-idx='" + idx + "' title='클릭하면 진단 카드(차트·AI 소견·판정)가 열립니다'>" +
        "<td class='exc-ai-nm'><span class='exc-ai-codehead'>" + escapeHtml(it.itemCode) + "</span> " +
          escapeHtml(it.itemName) + (pl ? " <span class='exc-ai-code'>" + escapeHtml(pl) + "</span>" : "") + "</td>" +
        "<td class='exc-ai-chipcell'><span class='exc-ai-chip exc-ai-chip-under'>" +
          (it.maxDays !== null ? "최대 " + Math.round(it.maxDays) + "일" : "일수 —") + "</span>" + dChipM(it) + "</td>" +
        "<td class='exc-ai-evid'>입고 취소·연기로 " + MAT_TARGET_DAYS + "일 이내 수렴 가능</td>" +
        "<td class='exc-ai-cut'>-" + formatNumber(Math.round(it.cutQty)) +
          " <span class='exc-ai-amt'>-" + escapeHtml(formatMoney(it.cutAmt)) + "</span></td></tr>";
    }).join("") + "</tbody></table>";
    if (items.length > MAXR) html += "<div class='exc-aisec-more'>외 " + (items.length - MAXR) + "종</div>";
    return html;
  }
  function matUnusedRows(items) {
    if (!items.length) return "<div class='exc-aisec-empty'>해당 자재 없음</div>";
    var html = "<table class='exc-ai-table'><tbody>" + items.slice(0, MAXR).map(function(a, idx) {
      var meta = a.cause === "unknown" ? { cls: "unknown", label: "BOM 미등록" } : { cls: "dormant", label: "소요없음" };
      return "<tr class='exc-ai-row' data-sec='matunused' data-idx='" + idx + "' title='클릭하면 진단 카드가 열립니다'>" +
        "<td class='exc-ai-nm'><span class='exc-ai-codehead'>" + escapeHtml(a.itemCode) + "</span> " +
          escapeHtml(a.itemName || a.itemCode) + " <span class='exc-ai-code'>" + escapeHtml(a.itemType || "") + "</span></td>" +
        "<td class='exc-ai-chipcell'><span class='exc-ai-chip exc-ai-chip-" + meta.cls + "'>" + meta.label + "</span>" + dChipM(a) + "</td>" +
        "<td class='exc-ai-evid'>기초재고 " + formatNumber(Math.round(a.qty)) + " — 이번 계획 소요 없음</td>" +
        "<td class='exc-ai-cut'><span class='exc-ai-amt'>" + escapeHtml(formatMoney(a.amt)) + "</span></td></tr>";
    }).join("") + "</tbody></table>";
    if (items.length > MAXR) html += "<div class='exc-aisec-more'>외 " + (items.length - MAXR) + "종</div>";
    return html;
  }
  function secBlockM(def, sumHtml, bodyHtml, btnHtml) {
    var isOpen  = !!state.aiDiagOpen[def.id];
    var applied = !!state.aiSecApplied[def.id];
    var focusable = (def.id === "supply" || def.id === "planfix");
    return "<div class='exc-aisec" + (applied ? " exc-aisec-on" : "") + "'>" +
      "<div class='exc-aisec-head' data-sec='" + def.id + "'" +
        (focusable ? " title='클릭하면 이 원인의 품목이 아래 시뮬레이션 표에서 강조됩니다'" : "") + ">" +
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
  // 재고일수 구간 목록 (참고용 — 클릭 시 정보성 진단 카드)
  var tierChipCls = { mat180x: "under", mat150: "overplan", mat120: "noplan", mat90: "base" };
  function tierRows(items, secId) {
    if (!items.length) return "<div class='exc-aisec-empty'>해당 자재 없음</div>";
    var html = "<table class='exc-ai-table'><tbody>" + items.slice(0, MAXR).map(function(a, idx) {
      var pl = a.plantCode && typeof displayPlantName === "function" ? displayPlantName(a.plantCode) : (a.plantCode || "");
      return "<tr class='exc-ai-row' data-sec='" + secId + "' data-idx='" + idx + "' title='클릭하면 진단 카드가 열립니다'>" +
        "<td class='exc-ai-nm'><span class='exc-ai-codehead'>" + escapeHtml(a.itemCode) + "</span> " +
          escapeHtml(a.itemName) + (pl ? " <span class='exc-ai-code'>" + escapeHtml(pl) + "</span>" : "") + "</td>" +
        "<td class='exc-ai-chipcell'><span class='exc-ai-chip exc-ai-chip-" + tierChipCls[secId] + "'>최대 " + Math.round(a.maxDays) + "일</span></td>" +
        "<td class='exc-ai-evid'>" + (secId === "mat180x" ? "입고계획이 없어 감축 불가 — 소진·반품 검토" : "월평균 소요 " + formatNumber(Math.round(a.avgCons))) + "</td>" +
        "<td class='exc-ai-cut'><span class='exc-ai-amt'>" + escapeHtml(formatMoney(a.invAmt)) + "</span></td></tr>";
    }).join("") + "</tbody></table>";
    if (items.length > MAXR) html += "<div class='exc-aisec-more'>외 " + (items.length - MAXR) + "종</div>";
    return html;
  }
  function tierSum(items) {
    if (!items.length) return "<span class='exc-aisec-none'>해당 없음</span>";
    var amt = items.reduce(function(s, a) { return s + a.invAmt; }, 0);
    return items.length + "종 재고 <strong>" + escapeHtml(formatMoney(amt)) + "</strong>";
  }

  var cutBtn = aiMat.itemCnt
    ? "<button class='exc-aisec-apply" + (matApplied ? " exc-aisec-apply-on" : "") + "' data-sec='matcut'>" +
      (matApplied ? "적용 해제" : "권장안 적용") + "</button>"
    : "";
  var cutBody = matCutRows(aiMat.items) +
    (bands.mat180x.length
      ? "<div class='exc-aisec-desc' style='padding-top:10px;'>▼ " + MAT_TARGET_DAYS + "일 초과이나 입고계획이 없어 감축 불가 — 소진·반품 검토 대상</div>" +
        tierRows(bands.mat180x, "mat180x")
      : "");
  var foot = [];
  if (insaneCnt) foot.push("단위 정합 확인 " + insaneCnt + "종");
  if (unused.scopeCnt) foot.push("회의 범위 외 " + unused.scopeCnt + "종(" + formatMoney(unused.scopeAmt) + ")");
  var footHtml = foot.length ? "<div class='exc-aisec-group'>※ " + foot.join(" · ") + " 제외</div>" : "";

  var sumOf = {
    matcut: cutSum, mat150: tierSum(bands.mat150), mat120: tierSum(bands.mat120),
    mat90: tierSum(bands.mat90), matunused: unusedSum,
  };
  var bodyOf = {
    matcut: cutBody, mat150: tierRows(bands.mat150, "mat150"), mat120: tierRows(bands.mat120, "mat120"),
    mat90: tierRows(bands.mat90, "mat90"), matunused: matUnusedRows(unused.items),
  };
  var btnOf = { matcut: cutBtn, mat150: "", mat120: "", mat90: "", matunused: "" };

  return "<div class='exc-ai-panel'>" +
    "<div class='exc-ai-panel-head'><span class='exc-ai-icon'>🤖</span>" +
    "<span class='exc-ai-text'><strong>AI 원부자재 진단</strong> — 전 자재 재고일수 전수 스캔(90~" + MAT_TARGET_DAYS + "일 4구간) ➜ 감축 가능 <strong class='exc-ai-good'>-" +
    escapeHtml(formatMoney(aiMat.totalCutAmt)) + "</strong>" +
    (unusedAmt > 0 ? " · 미사용 재고 <strong class='exc-ai-good'>" + escapeHtml(formatMoney(unusedAmt)) + "</strong> 발굴" : "") +
    "</span></div>" +
    MAT_SECTION_DEFS.map(function(def) {
      var kicker = def.group ? "<div class='exc-aisec-group'>" + def.group + "</div>" : "";
      return kicker + secBlockM(def, sumOf[def.id], bodyOf[def.id], btnOf[def.id]);
    }).join("") +
    footHtml +
    "</div>";
}

// 진단 차트 라벨용 둥근 사각형
function _excRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 자재의 "계획 외 완제품 사용처" 수 — 공용자재 감축 오판 방지 경고용
var _rootsPlanCache = null;
function _outPlanFgRootCnt(code) {
  if (!_rootsPlanCache) {
    var roots = new Map();
    (state.mappedData.bom_components || []).forEach(function(r) {
      if (!r.componentCode || !r.rootItemCode) return;
      var s = roots.get(r.componentCode);
      if (!s) { s = new Set(); roots.set(r.componentCode, s); }
      s.add(r.rootItemCode);
    });
    var plan = new Set();
    (state.mappedData.plan_monthly || []).forEach(function(r) { if (r.itemCode) plan.add(r.itemCode); });
    _rootsPlanCache = { roots: roots, plan: plan };
  }
  var s = _rootsPlanCache.roots.get(code);
  if (!s) return 0;
  var n = 0;
  s.forEach(function(rc) { if (String(rc).charAt(0) === "9" && !_rootsPlanCache.plan.has(rc)) n++; });
  return n;
}

// 자재 소견 — 부모 완제품 원인 상속 포함
function buildMatOpinion(it) {
  var tot = 0, best = null;
  (it.parents || []).forEach(function(p) {
    var s = 0;
    Object.keys(p.monthly || {}).forEach(function(m) { s += (p.monthly[m].reqQty || 0); });
    tot += s;
    if (!best || s > best.s) best = { p: p, s: s };
  });
  var txt = "이 자재의 재고일수가 최대 " + (it.maxDays !== null ? Math.round(it.maxDays) : "-") +
    "일로 관리 기준 " + MAT_TARGET_DAYS + "일을 초과했습니다. ";
  if (best && tot > 0 && best.s > 0) {
    var share = Math.round(best.s / tot * 100);
    var pName = best.p.name;
    if (!pName) {
      (state.mappedData.item_master || []).some(function(r) {
        if (r.itemCode === best.p.code && r.itemName) { pName = r.itemName; return true; }
        return false;
      });
    }
    txt += "소요의 " + share + "%가 [" + (pName || best.p.code) + "]에서 발생하는데";
    var cause = _fgCauseOf(best.p.code, best.p.plant);
    txt += cause
      ? ", 해당 완제품이 '" + cause + "' 판정이라 소요 감소로 재고가 쌓였을 가능성이 높습니다. "
      : ", 현 생산계획 대비 입고·기초재고가 많은 상태입니다. ";
  }
  txt += "입고 " + formatNumber(Math.round(it.cutQty)) + "개(" + formatMoney(it.cutAmt) +
    ")를 취소·연기해 " + MAT_TARGET_DAYS + "일 이내로 수렴시키는 것을 권장합니다. " +
    "감축 후에도 모든 월 기말재고가 0 이상으로 설계되어 생산 차질은 없습니다.";
  var outCnt = _outPlanFgRootCnt(it.itemCode);
  if (outCnt > 0) {
    txt += " ⚠ 이 자재는 이번 계획에 없는 완제품 " + outCnt +
      "종의 BOM에도 등록되어 있습니다(해당 소요 미반영) — 감축 확정 전 그 제품들의 생산 예정 여부를 확인하세요.";
  }
  return txt;
}
function buildMatUnusedOpinion(a) {
  var invTxt = formatNumber(Math.round(a.qty)) + "개(" + formatMoney(a.amt) + ")";
  if (a.cause === "unknown") {
    return "BOM이 등록되어 있지 않아 소요를 산정할 수 없는 자재입니다. 보유 재고 " + invTxt +
      " — 용도(수탁·신제품 대기·BOM 정비 누락)를 먼저 확인하고, 사용처가 없다면 반품·전용·폐기를 검토하는 것을 권장합니다.";
  }
  return "BOM은 등록되어 있으나 이번 계획 기간에 이 자재를 사용하는 완제품의 생산계획이 없습니다. 보유 재고 " + invTxt +
    " — 향후 생산 재개 여부를 확인하고, 재개 계획이 없다면 반품·전용·폐기를 검토하는 것을 권장합니다.";
}

// 자재 진단 카드 팝업 — 차트 A′(소요 vs 입고) + B′(재고 vs 기준선 vs 감축후)
function openMatDiagPopup(secId, idx) {
  if (!_matDiagCache) return;
  var isCut = secId === "matcut";
  var it = isCut ? _matDiagCache.aiMat.items[idx] : _matDiagCache.unused.items[idx];
  if (!it) return;
  closeAiDiagPopup();

  var def = findAiSecDef(secId);
  var d = getAiDecision(it);
  var opinion = isCut ? buildMatOpinion(it) : buildMatUnusedOpinion(it);
  var pl = it.plantCode && typeof displayPlantName === "function" ? displayPlantName(it.plantCode) : (it.plantCode || "");
  var chipHtml = isCut
    ? "<span class='exc-ai-chip exc-ai-chip-under'>" + (it.maxDays !== null ? "최대 " + Math.round(it.maxDays) + "일" : "일수 —") + "</span>"
    : "<span class='exc-ai-chip exc-ai-chip-" + (it.cause === "unknown" ? "unknown'>BOM 미등록" : "dormant'>소요없음") + "</span>";
  var proposalTxt = isCut
    ? "입고 감축 제안 <strong>-" + formatNumber(Math.round(it.cutQty)) + "개 · -" + escapeHtml(formatMoney(it.cutAmt)) + "</strong>"
    : "보유 재고 <strong>" + formatNumber(Math.round(it.qty)) + "개 · " + escapeHtml(formatMoney(it.amt)) + "</strong>";
  var decBtns =
    "<button class='exc-diag-dec' data-status='accept'>✅ 수용</button>" +
    (isCut ? "<button class='exc-diag-dec' data-status='adjust'>🔶 조정 수용</button>" : "") +
    "<button class='exc-diag-dec' data-status='reject'>❌ 불가</button>" +
    "<button class='exc-diag-dec' data-status='hold'>⏸ 보류</button>";
  var curDec = d
    ? "<span class='exc-ai-dchip exc-ai-dchip-" + d.status + "'>" + (AI_DECISION_LABELS[d.status] || d.status) + "</span>" +
      (d.qty ? " 확정 -" + formatNumber(Math.round(d.qty)) + "개" : "") +
      (d.reason ? " · " + escapeHtml(d.reason) : "") +
      " <button class='exc-diag-dec-clear'>판정 취소</button>"
    : "<span class='exc-diag-nodec'>미판정</span>";

  var ov = document.createElement("div");
  ov.className = "exc-diag-overlay";
  ov.innerHTML =
    "<div class='exc-diag-card'>" +
      "<div class='exc-diag-head'>" +
        "<div class='exc-diag-titles'>" +
          "<div class='exc-diag-name'><span class='exc-ai-codehead'>" + escapeHtml(it.itemCode) + "</span> " +
            escapeHtml(it.itemName || it.itemCode) +
            "<span class='exc-ai-code'>" + (pl ? " " + escapeHtml(pl) : "") + (it.itemType ? "·" + escapeHtml(it.itemType) : "") + "</span></div>" +
          "<div class='exc-diag-sub'>" +
            (def ? "<span class='exc-aisec-owner'>" + def.no + " " + def.title + "</span> " : "") +
            chipHtml + " <span class='exc-diag-proposal'>" + proposalTxt + "</span>" +
          "</div>" +
        "</div>" +
        "<button class='exc-diag-close' title='닫기'>×</button>" +
      "</div>" +
      "<div class='exc-diag-opinion'><span class='exc-diag-opinion-tag'>🤖 AI 소견</span>" + escapeHtml(opinion) + "</div>" +
      (isCut
        ? "<div class='exc-diag-charts'>" +
            "<div class='exc-diag-chartbox'>" +
              "<div class='exc-diag-chart-title'>소요 vs 입고 — 왜 쌓이나 <span class='exc-diag-chart-sub'>월별 BOM 소요량 vs 입고계획</span></div>" +
              "<div class='exc-diag-canvas-wrap'><canvas class='exc-diag-chart-a'></canvas></div>" +
            "</div>" +
            "<div class='exc-diag-chartbox'>" +
              "<div class='exc-diag-chart-title'>재고 전망 — 감축하면 어떻게 되나 <span class='exc-diag-chart-sub'>기말재고 vs " + MAT_TARGET_DAYS + "일 기준 vs 감축 적용 후</span></div>" +
              "<div class='exc-diag-canvas-wrap'><canvas class='exc-diag-chart-b'></canvas></div>" +
            "</div>" +
          "</div>"
        : "") +
      (isCut ? buildCutPlanStrip(it) : "") +
      "<div class='exc-diag-decide'>" +
        "<span class='exc-diag-decide-label'>협의 결과</span>" + decBtns +
        "<span class='exc-diag-cur'>" + curDec + "</span>" +
      "</div>" +
      "<div class='exc-diag-inputs' hidden>" +
        "<span class='exc-diag-input-qty' hidden>확정 감축량 <input type='number' class='exc-diag-qty' min='0'" +
          (isCut ? " max='" + Math.round(it.cutQty) + "' value='" + Math.round(it.cutQty) + "'" : "") + "> 개</span>" +
        "<span class='exc-diag-input-reason'>사유 <input type='text' class='exc-diag-reason' placeholder='예: 발주 확정분 취소 불가 / 공급사 협의 필요'></span>" +
        "<button class='exc-diag-save'>판정 기록</button>" +
      "</div>" +
    "</div>";
  document.body.appendChild(ov);

  ov.addEventListener("click", function(e) { if (e.target === ov) closeAiDiagPopup(); });
  ov.querySelector(".exc-diag-close").addEventListener("click", closeAiDiagPopup);
  var selStatus = null;
  var inputs = ov.querySelector(".exc-diag-inputs");
  var qtyWrap = ov.querySelector(".exc-diag-input-qty");
  ov.querySelectorAll(".exc-diag-dec").forEach(function(btn) {
    btn.addEventListener("click", function() {
      selStatus = btn.dataset.status;
      ov.querySelectorAll(".exc-diag-dec").forEach(function(b) { b.classList.toggle("exc-diag-dec-sel", b === btn); });
      inputs.hidden = false;
      qtyWrap.hidden = selStatus !== "adjust";
    });
  });
  var saveBtn = ov.querySelector(".exc-diag-save");
  if (saveBtn) saveBtn.addEventListener("click", function() {
    if (!selStatus) return;
    var qty = selStatus === "adjust" ? Number(ov.querySelector(".exc-diag-qty").value) || 0 : null;
    var reason = (ov.querySelector(".exc-diag-reason").value || "").trim();
    closeAiDiagPopup();
    setAiDecision(secId, it, selStatus, qty, reason);
  });
  var clearBtn = ov.querySelector(".exc-diag-dec-clear");
  if (clearBtn) clearBtn.addEventListener("click", function() {
    closeAiDiagPopup();
    setAiDecision(secId, it, null);
  });

  renderMatDiagCharts(it, isCut, ov);
}

function renderMatDiagCharts(it, isCut, ov) {
  if (typeof Chart === "undefined" || !isCut) return;
  var shortM = function(m) { return m.slice(2).replace("-", "."); };
  var fmtC = function(v) {
    if (v === null || v === undefined) return "";
    var av = Math.abs(v);
    if (av >= 1e8) return (Math.round(v / 1e7) / 10).toLocaleString() + "억";
    if (av >= 1e4) return (Math.round(v / 1e3) / 10).toLocaleString() + "만";
    return Math.round(v).toLocaleString();
  };
  var canvasA = ov.querySelector(".exc-diag-chart-a");
  if (canvasA) {
    // 막대 값 라벨 — 소요(파랑)·입고(주황), 0은 생략
    var barLabelsPlugin = {
      id: "matBarLabels",
      afterDatasetsDraw: function(chart) {
        var c = chart.ctx;
        c.save();
        c.textAlign = "center";
        c.textBaseline = "bottom";
        [0, 1].forEach(function(di) {
          var meta = chart.getDatasetMeta(di), data = chart.data.datasets[di].data;
          c.font = "700 12px Pretendard, sans-serif";
          c.fillStyle = di === 0 ? "#1d4ed8" : "#b45309";
          meta.data.forEach(function(el, i) {
            var v = data[i];
            if (v === null || v === undefined || Math.round(v) === 0) return;
            c.fillText(fmtC(v), el.x, el.y - 3);
          });
        });
        c.restore();
      },
    };
    _aiPopupCharts.push(new Chart(canvasA.getContext("2d"), {
      type: "bar",
      data: {
        labels: it.months.map(shortM),
        datasets: [
          { type: "bar", label: "소요량 (BOM 전개)", data: it.consArr, backgroundColor: "#93c5fd", order: 2 },
          { type: "bar", label: "입고계획", data: it.origIntakeArr, backgroundColor: "#fbbf24", order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 16 } },
        plugins: { legend: { display: true, position: "top", labels: { boxWidth: 14, font: { size: 13.5 } } },
          tooltip: { callbacks: { label: function(c) {
            return c.raw === null || c.raw === undefined ? null : c.dataset.label + ": " + Math.round(c.raw).toLocaleString();
          } } } },
        scales: {
          x: { grid: { color: "#f3f4f6" }, ticks: { font: { size: 13 } } },
          y: { grid: { color: "#f3f4f6" }, ticks: { font: { size: 13 }, callback: function(v) { return fmtC(v); } } },
        },
      },
      plugins: [barLabelsPlugin],
    }));
  }
  var canvasB = ov.querySelector(".exc-diag-chart-b");
  if (canvasB) {
    var tgtLine = it.months.map(function(m, i) {
      var daily = it.consArr[i] > 0 ? it.consArr[i] / monthDays(m) : 0;
      return daily > 0 ? MAT_TARGET_DAYS * daily : null;
    });
    // 재고일수 태그 2줄용 — 감축 전/후 (배경=시리즈 색, 글자=기준 판정)
    var daysAfter = it.months.map(function(m, i) {
      var daily = it.consArr[i] > 0 ? it.consArr[i] / monthDays(m) : 0;
      return daily > 0 ? it.cutEndingArr[i] / daily : null;
    });
    var daysBefore = it.months.map(function(m, i) {
      var daily = it.consArr[i] > 0 ? it.consArr[i] / monthDays(m) : 0;
      return daily > 0 ? it.origEndingArr[i] / daily : null;
    });
    // 제목 옆 효과 칩 — 마지막 유효 월 기준 "감축 전 → 후" 일수 한 줄 요약
    var effIdx = -1;
    for (var ei = it.months.length - 1; ei >= 0; ei--) {
      if (Number.isFinite(daysBefore[ei]) && Number.isFinite(daysAfter[ei])) { effIdx = ei; break; }
    }
    var titleElB = canvasB.closest(".exc-diag-chartbox").querySelector(".exc-diag-chart-title");
    if (effIdx >= 0 && titleElB && !titleElB.querySelector(".exc-diag-eff-chip")) {
      var effB = Math.round(daysBefore[effIdx]), effA = Math.round(daysAfter[effIdx]);
      var effChip = document.createElement("span");
      effChip.className = "exc-diag-eff-chip";
      effChip.innerHTML = escapeHtml(shortM(it.months[effIdx])) +
        " <b class='" + (effB > MAT_TARGET_DAYS ? "exc-eff-over" : "exc-eff-ok") + "'>" + effB + "일</b> → <b class='" +
        (effA > MAT_TARGET_DAYS ? "exc-eff-over" : "exc-eff-ok") + "'>" + effA + "일</b>";
      titleElB.appendChild(effChip);
    }
    var diagLabelsPlugin = {
      id: "matDiagLabels",
      afterDatasetsDraw: function(chart) {
        var c = chart.ctx, area = chart.chartArea;
        var clampX = function(x) { return Math.min(Math.max(x, area.left + 16), area.right - 16); };
        var m0 = chart.getDatasetMeta(0), m1 = chart.getDatasetMeta(1);
        var d0 = chart.data.datasets[0].data, d1 = chart.data.datasets[1].data;
        c.save();
        c.textAlign = "center";
        var lastR0 = -Infinity, lastR1 = -Infinity;
        m0.data.forEach(function(el, i) {
          var v0 = d0[i], v1 = d1[i];
          if (v0 === null || v0 === undefined) return;
          var same = v1 !== null && v1 !== undefined && Math.abs(v0 - v1) < Math.max(1, Math.abs(v0) * 0.005);
          c.font = "600 12.5px Pretendard, sans-serif";
          var t0 = fmtC(v0), x0 = clampX(el.x), w0 = c.measureText(t0).width;
          if (x0 - w0 / 2 > lastR0 + 4) {
            c.fillStyle = "#64748b";
            c.textBaseline = "bottom";
            c.fillText(t0, x0, el.y - 5);
            lastR0 = x0 + w0 / 2;
          }
          if (!same && m1.data[i] && v1 !== null && v1 !== undefined) {
            c.font = "800 13px Pretendard, sans-serif";
            var t1 = fmtC(v1), x1 = clampX(m1.data[i].x), w1 = c.measureText(t1).width;
            if (x1 - w1 / 2 > lastR1 + 4) {
              c.fillStyle = "#15803d";
              c.textBaseline = "top";
              c.fillText(t1, x1, m1.data[i].y + 5);
              lastR1 = x1 + w1 / 2;
            }
          }
        });
        var th = 22;
        var pillRow = function(daysArr, ty, bg, border, okColor, skipSame) {
          var lastR = -Infinity;
          m1.data.forEach(function(el, i) {
            var dv = daysArr[i];
            if (dv === null || !isFinite(dv)) return;
            if (skipSame && Number.isFinite(daysBefore[i]) && Math.round(daysBefore[i]) === Math.round(dv)) return;
            var text = Math.round(dv) + "일";
            c.font = "800 12px Pretendard, sans-serif";
            var tw = c.measureText(text).width + 14;
            var tx = clampX(el.x) - tw / 2;
            if (tx < lastR + 4) return;
            lastR = tx + tw;
            var over = dv > MAT_TARGET_DAYS;
            c.fillStyle = bg;
            _excRoundRect(c, tx, ty, tw, th, 5); c.fill();
            c.strokeStyle = border; c.lineWidth = 1;
            _excRoundRect(c, tx, ty, tw, th, 5); c.stroke();
            c.fillStyle = over ? "#dc2626" : okColor;
            c.textBaseline = "middle";
            c.fillText(text, clampX(el.x), ty + th / 2);
          });
        };
        pillRow(daysBefore, area.bottom - th * 2 - 8, "rgba(148,163,184,0.16)", "rgba(100,116,139,0.45)", "#475569", false);
        pillRow(daysAfter,  area.bottom - th - 4,     "rgba(22,163,74,0.10)",  "rgba(22,163,74,0.40)",  "#15803d", true);
        c.restore();
      },
    };
    _aiPopupCharts.push(new Chart(canvasB.getContext("2d"), {
      type: "line",
      data: {
        labels: it.months.map(shortM),
        datasets: [
          { label: "기말재고 (현재 계획)", data: it.origEndingArr, borderColor: "#94a3b8",
            backgroundColor: "rgba(148,163,184,0.14)", fill: true, borderWidth: 2, pointRadius: 2.5 },
          { label: "감축 적용 후", data: it.cutEndingArr, borderColor: "#16a34a",
            borderDash: [6, 4], borderWidth: 2.5, pointRadius: 2.5 },
          { label: MAT_TARGET_DAYS + "일 기준", data: tgtLine, borderColor: "#dc2626",
            borderDash: [2, 3], borderWidth: 1.8, pointRadius: 0, spanGaps: true },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 18, bottom: 8 } },
        plugins: { legend: { display: true, position: "top", labels: { boxWidth: 14, font: { size: 13.5 } } },
          tooltip: { callbacks: { label: function(c) {
            return c.raw === null || c.raw === undefined ? null : c.dataset.label + ": " + Math.round(c.raw).toLocaleString();
          } } } },
        scales: {
          x: { grid: { color: "#f3f4f6" }, ticks: { font: { size: 13 } } },
          y: { grid: { color: "#f3f4f6" }, ticks: { font: { size: 13 }, callback: function(v) { return fmtC(v); } } },
        },
      },
      plugins: [diagLabelsPlugin],
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 조정 테이블 → 진단 카드 연결 — AI 제안 품목이면 판정 가능한 정식 카드,
// 아니면 차트·소견만 있는 정보성 카드
// ═══════════════════════════════════════════════════════════════════════════
function openFgTableDiag(code, plant) {
  var cls = _aiDiagCache && _aiDiagCache.cls;
  if (!cls) {
    try { cls = classifyAiExcess(); _aiDiagCache = { cls: cls }; } catch (e) { cls = null; }
  }
  if (cls) {
    var found = null;
    ["supply", "planfix"].forEach(function(sec) {
      if (found) return;
      cls.sections[sec].items.forEach(function(x, i) {
        if (!found && x.itemCode === code && (x.plantCode || "") === (plant || "")) found = { sec: sec, idx: i };
      });
    });
    if (found) return openAiDiagPopup(found.sec, found.idx);
  }
  var it = buildFgInfoItem(code, plant);
  if (it) openInfoDiagPopup(it, false);
}

function buildFgInfoItem(code, plant) {
  var months = getRtfMonths();
  var baseItems = (typeof computeScenarioItemSets === "function")
    ? computeScenarioItemSets().rtfAdj
    : computeRtfItems();
  var item = null;
  baseItems.forEach(function(x) {
    if (!item && x.itemCode === code && (x.plantCode || "") === (plant || "")) item = x;
  });
  if (!item) return null;
  // 시뮬레이션(조정 테이블)과 완전히 동일한 계산 — 같은 calcPsiRows(기초재고+공급계획-판매, excessAdj 반영)
  var planMap = new Map();
  (state.mappedData.plan_monthly || []).forEach(function(r) {
    var ic = cleanOptional(r.itemCode), pl = cleanOptional(r.plant) || "", mo = cleanOptional(r.month);
    if (ic === code && pl === (plant || "")) planMap.set(mo, (planMap.get(mo) || 0) + (cleanNumber(r.supplyQty) || 0));
  });
  var psi = calcPsiRows(item, planMap, months);
  // 유효 구간: 계획·재고가 이어진 앞부분까지만 (테이블 표시 범위와 동일)
  var validLen = 0;
  for (var i = 0; i < months.length; i++) {
    var ms = item.monthlyStatus && item.monthlyStatus[i];
    if (!ms || !Number.isFinite(ms.endingQty) || !Number.isFinite(ms.supplyQty)) break;
    validLen++;
  }
  if (!validLen) return null;
  var ti = null;
  (state.mappedData.target_inv || []).some(function(r) {
    if (r.itemCode === code) { ti = r; return true; }
    return false;
  });
  var v = psi.slice(0, validLen);
  var sales = v.map(function(r) { return r.salesQty; });
  return {
    itemCode: code, itemName: item.itemName || code, plantCode: plant || "",
    targetDays: ti && Number.isFinite(ti.targetDays) ? ti.targetDays : null,
    cutQty: 0, cutAmt: 0, keys: [], planVals: {}, cutByKey: {},
    planAvgSales: sales.reduce(function(a, b) { return a + b; }, 0) / (sales.length || 1),
    months: months.slice(0, validLen), salesArr: sales,
    origSupplyArr: v.map(function(r) { return r.origSupply; }),
    cutSupplyArr:  v.map(function(r) { return r.supplyQty; }),
    origEndingArr: v.map(function(r) { return r.origEndingQty; }),
    cutEndingArr:  v.map(function(r) { return r.endingQty; }),
    diag: { ti: ti },
  };
}

function openMatTableDiag(code, plant) {
  var det = _matDiagCache && _matDiagCache.aiMat;
  if (!det) {
    try { det = computeAiMatExcessPlan(Object.assign({}, state.excessAdj || {})); } catch (e) { det = null; }
  }
  if (det) {
    var idx = -1;
    det.items.forEach(function(x, i) {
      if (idx < 0 && x.itemCode === code && (x.plantCode || "") === (plant || "")) idx = i;
    });
    if (idx >= 0) {
      if (!_matDiagCache) _matDiagCache = { aiMat: det, unused: { items: [] } };
      return openMatDiagPopup("matcut", idx);
    }
  }
  var it = buildMatInfoItem(code, plant);
  if (it) openInfoDiagPopup(it, true);
}

function buildMatInfoItem(code, plant) {
  var rows = calcMatFlowRows(state.excessAdj, state.matExcessAdj);
  if (!rows) return null;
  var r = null;
  rows.forEach(function(x) {
    if (!r && x.flow.componentCode === code && (x.flow.plant || "") === (plant || "")) r = x;
  });
  if (!r) return null;
  var dvals = r.days.filter(function(v) { return v !== null; });
  return {
    itemCode: code, itemName: r.flow.componentName || code, plantCode: plant || "",
    cutQty: 0, cutAmt: 0, keys: [], planVals: {}, cutByKey: {},
    maxDays: dvals.length ? Math.max.apply(null, dvals) : null,
    months: getRtfMonths().slice(), consArr: r.cons.slice(),
    origIntakeArr: r.intake.slice(), cutIntakeArr: r.intake.slice(),
    origEndingArr: r.ending.slice(), cutEndingArr: r.ending.slice(),
    parents: r.flow.parents,
  };
}

// 정보성 진단 카드 — AI 제안이 없는 품목: 차트·소견만, 판정 없음
function openInfoDiagPopup(it, isMat) {
  closeAiDiagPopup();
  var pl = it.plantCode && typeof displayPlantName === "function" ? displayPlantName(it.plantCode) : (it.plantCode || "");
  var opinion = isMat
    ? "이 자재는 현재 계획 기준으로 AI 감축 제안이 없습니다" +
      (it.maxDays !== null ? " (재고일수 최대 " + Math.round(it.maxDays) + "일)" : "") +
      ". 아래 소요·재고 흐름을 참고하세요."
    : "이 품목은 현재 계획 기준으로 AI 감축 제안이 없습니다" +
      (Number.isFinite(it.targetDays) ? " (적정 " + Math.round(it.targetDays) + "일 기준 초과분 없음 또는 감축 여지 없음)" : " (적정재고 기준 미등록)") +
      ". 아래 수요·재고 흐름을 참고하세요.";
  var ov = document.createElement("div");
  ov.className = "exc-diag-overlay";
  ov.innerHTML =
    "<div class='exc-diag-card'>" +
      "<div class='exc-diag-head'>" +
        "<div class='exc-diag-titles'>" +
          "<div class='exc-diag-name'><span class='exc-ai-codehead'>" + escapeHtml(it.itemCode) + "</span> " +
            escapeHtml(it.itemName || it.itemCode) +
            "<span class='exc-ai-code'>" + (pl ? " " + escapeHtml(pl) : "") + "</span></div>" +
          "<div class='exc-diag-sub'><span class='exc-ai-chip exc-ai-chip-base'>AI 감축 제안 없음</span>" +
            "<span class='exc-diag-proposal'>재고 흐름 참고용</span> " +
            (!isMat ? buildCvChip(it.diag && it.diag.ti) + " " + buildTargetChip(it, it.diag && it.diag.ti) : "") + "</div>" +
        "</div>" +
        "<button class='exc-diag-close' title='닫기'>×</button>" +
      "</div>" +
      "<div class='exc-diag-opinion'><span class='exc-diag-opinion-tag'>🤖 AI 소견</span>" + escapeHtml(opinion) + "</div>" +
      "<div class='exc-diag-charts'>" +
        "<div class='exc-diag-chartbox'>" +
          "<div class='exc-diag-chart-title'>" + (isMat ? "소요 vs 입고" : "수요 흐름") +
            " <span class='exc-diag-chart-sub'>" + (isMat ? "월별 BOM 소요량 vs 입고계획" : "출고실적·입고계획(막대) vs 판매계획(선)") + "</span></div>" +
          "<div class='exc-diag-canvas-wrap'><canvas class='exc-diag-chart-a'></canvas></div>" +
        "</div>" +
        "<div class='exc-diag-chartbox'>" +
          "<div class='exc-diag-chart-title'>재고 전망 <span class='exc-diag-chart-sub'>" +
            (isMat ? MAT_TARGET_DAYS + "일 기준" : "적정재고 수준") + " 대비</span></div>" +
          "<div class='exc-diag-canvas-wrap'><canvas class='exc-diag-chart-b'></canvas></div>" +
        "</div>" +
      "</div>" +
    "</div>";
  document.body.appendChild(ov);
  ov.addEventListener("click", function(e) { if (e.target === ov) closeAiDiagPopup(); });
  ov.querySelector(".exc-diag-close").addEventListener("click", closeAiDiagPopup);
  if (isMat) renderMatDiagCharts(it, true, ov);
  else renderAiDiagCharts(it, true, ov);
}

// 제·상품 탭 평면 테이블 — 원부자재 탭과 동일 양식 (드릴다운 없이 인라인 조정)
// 컬럼: 품목 | 적정일수 | ↺ | 월별 [판매 | 공급(입력) | 일수]
function renderExcessFgFlatTable(displayItems, months, globalPlanMap) {
  // 헤더 클릭 정렬: 품목명 / 적정일수 / 월별 재고일수 — 기본은 초과금액 내림차순 (3회 클릭 시 복귀)
  var sort = state.excessFgSort || null;
  if (sort && sort.key) {
    var sVal = function(item) {
      if (sort.key === "name") return String(item.itemName || item.itemCode);
      if (sort.key === "td") return Number.isFinite(item._td) ? item._td : -1;
      if (sort.key.indexOf("day:") === 0) {
        var mo = sort.key.slice(4);
        var pm = new Map();
        months.forEach(function(m) { pm.set(m, globalPlanMap.get(item.itemCode + "|" + (item.plantCode || "") + "|" + m) || 0); });
        var r = calcPsiRows(item, pm, months)[months.indexOf(mo)];
        return r && r.days !== null ? r.days : -1;
      }
      return item._excessAmt || 0;
    };
    var sVals = new Map();
    displayItems.forEach(function(x) { sVals.set(x, sVal(x)); });
    displayItems = displayItems.slice().sort(function(a, b) {
      var va = sVals.get(a), vb = sVals.get(b);
      if (typeof va === "string") return sort.dir * String(va).localeCompare(String(vb), "ko");
      return sort.dir * (va - vb);
    });
  }
  var arrow = function(key) {
    return sort && sort.key === key ? (sort.dir > 0 ? " ▲" : " ▼") : "";
  };
  var monthHd = months.map(function(m) {
    return "<th colspan='3' class='exc-mat-mo-hd'>" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHd = months.map(function(m) {
    return "<th class='exc-mat-sub'>판매</th><th class='exc-mat-sub'>공급</th>" +
      "<th class='exc-mat-sub exc-sort-th' data-sorttab='fg' data-sort='day:" + m + "' title='이 월 재고일수로 정렬'>일수" + arrow("day:" + m) + "</th>";
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
      "<td class='exc-mat-name exc-nm-click' title='클릭하면 진단 카드(차트·AI 소견)가 열립니다'><span class='exc-mat-code'>" + escapeHtml(item.itemCode) + "</span> " +
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
    "<thead><tr><th rowspan='2' class='exc-mat-name-hd exc-sort-th' data-sorttab='fg' data-sort='name' title='품목명 정렬'>품목" + arrow("name") + "</th>" +
    "<th rowspan='2' class='exc-sort-th' data-sorttab='fg' data-sort='td' title='적정일수 정렬'>적정<br>일수" + arrow("td") + "</th><th rowspan='2'></th>" + monthHd + "</tr>" +
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

  // 헤더 클릭 정렬: 자재명 / 월별 재고일수 — 기본은 초과금액 내림차순
  var msort = state.excessMatSort || null;
  if (msort && msort.key) {
    var mVal = function(r) {
      if (msort.key === "name") return String(r.flow.componentName || r.flow.componentCode);
      if (msort.key.indexOf("day:") === 0) {
        var mi = months.indexOf(msort.key.slice(4));
        return r.days[mi] === null ? -1 : r.days[mi];
      }
      return r._overAmt;
    };
    shown = shown.slice().sort(function(a, b) {
      var va = mVal(a), vb = mVal(b);
      if (typeof va === "string") return msort.dir * String(va).localeCompare(String(vb), "ko");
      return msort.dir * (va - vb);
    });
  }
  var mArrow = function(key) {
    return msort && msort.key === key ? (msort.dir > 0 ? " ▲" : " ▼") : "";
  };

  var totalOverAmt = shown.reduce(function(s, r) { return s + r._overAmt; }, 0);

  var monthHd = months.map(function(m) {
    return "<th colspan='3' class='exc-mat-mo-hd'>" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHd = months.map(function(m) {
    return "<th class='exc-mat-sub'>소비</th><th class='exc-mat-sub'>입고</th>" +
      "<th class='exc-mat-sub exc-sort-th' data-sorttab='mat' data-sort='day:" + m + "' title='이 월 재고일수로 정렬'>일수" + mArrow("day:" + m) + "</th>";
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
    return "<tr data-mat-code='" + escapeHtml(f.componentCode) + "' data-mat-plant='" + escapeHtml(f.plant || "") + "' class='" + (r._hasAdj ? "exc-mat-row-adj" : "") + "'>" +
      "<td class='exc-mat-name exc-nm-click' title='클릭하면 진단 카드(차트·AI 소견)가 열립니다'><span class='exc-mat-code'>" + escapeHtml(f.componentCode) + "</span> " +
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
    "<thead><tr><th rowspan='2' class='exc-mat-name-hd exc-sort-th' data-sorttab='mat' data-sort='name' title='자재명 정렬'>자재" + mArrow("name") + "</th><th rowspan='2'></th>" + monthHd + "</tr>" +
    "<tr>" + subHd + "</tr></thead>" +
    "<tbody>" + body + "</tbody></table></div>";
}

// AI 진단 섹션을 클릭(펼침)하면 그 원인의 품목을 시뮬(조정) 표에서 강조하고 나머지는 흐리게.
// 상태만 state.aiFocusSec에 두고, 매 렌더 후 bindExcessAdjustment 끝에서 다시 호출해 강조를 복원한다.
// (①supply·②planfix만 시뮬 표에 대응 — ③소진·④처분은 판매계획 없는 품목이라 시뮬 대상 아님)
function applyAiSecFocus(root) {
  root = root || document.querySelector("#screenRoot");
  if (!root) return;
  // 이전 강조 해제 — 전체 행 순회 없이 컨테이너 클래스 + 소수의 focus 행만 제거
  root.querySelectorAll(".exc-mat-table.exc-mat-focusing").forEach(function(t) { t.classList.remove("exc-mat-focusing"); });
  root.querySelectorAll(".exc-mat-row-focus").forEach(function(tr) { tr.classList.remove("exc-mat-row-focus"); });
  root.querySelectorAll(".exc-aisec-head.exc-aisec-focus").forEach(function(h) { h.classList.remove("exc-aisec-focus"); });
  var sec = state.aiFocusSec;
  if (!sec || !_aiDiagCache || !_aiDiagCache.cls) return;
  var head = root.querySelector(".exc-aisec-head[data-sec='" + sec + "']");
  if (head) head.classList.add("exc-aisec-focus");
  var secObj = _aiDiagCache.cls.sections[sec];
  var items = (secObj && secObj.items) || [];
  var tables = root.querySelectorAll(".exc-mat-table");
  if (!items.length || !tables.length) return;
  var keys = {};
  items.forEach(function(it) { keys[it.itemCode + "|" + (it.plantCode || "")] = 1; });
  // 흐림은 컨테이너 클래스 1개로 CSS가 처리 → 매칭 행에만 focus write (개별 dim write·트랜지션 없음)
  tables.forEach(function(t) { t.classList.add("exc-mat-focusing"); });
  root.querySelectorAll(".exc-mat-table tr[data-row-key]").forEach(function(tr) {
    if (keys[tr.dataset.rowKey]) tr.classList.add("exc-mat-row-focus");
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. 이벤트 바인딩
// ═══════════════════════════════════════════════════════════════════════════
function bindExcessAdjustment() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;
  var _bindT0 = performance.now();
  // 렌더 문자열 반환 시각 ~ bind 시작 = 브라우저가 innerHTML을 실제 DOM으로 반영한 비용
  var _injectMs = (EXC_PROF && window._excRenderEndTs != null) ? (_bindT0 - window._excRenderEndTs) : null;

  // 회의 진행 바 — 이전/다음/품목 열기
  bindExcWalkBar();

  // AI 진단 — 전체적용(①②, MOQ구조·소진·처분 제외) / 전체해제 (명시 판정은 유지됨)
  var aiApplyBtn = root.querySelector(".exc-ai-apply");
  if (aiApplyBtn) {
    aiApplyBtn.addEventListener("click", function() {
      state.aiSecApplied = state.aiSecApplied || {};
      state.aiSecApplied.supply  = true;
      state.aiSecApplied.planfix = true;
      syncAiFgAdj();
      render("inventory-variance");
    });
  }
  var aiClearBtn = root.querySelector(".exc-ai-clear");
  if (aiClearBtn) {
    aiClearBtn.addEventListener("click", function() {
      state.aiSecApplied = {};
      syncAiFgAdj(); // 명시 판정(수용·조정)분은 확정사항이라 유지됨
      render("inventory-variance");
    });
  }

  // AI 진단 — 품목 행 클릭 → 진단 카드 팝업 (차트·소견·판정)
  root.querySelectorAll(".exc-ai-row").forEach(function(tr) {
    tr.addEventListener("click", function() {
      openAiDiagPopup(tr.dataset.sec, parseInt(tr.dataset.idx, 10));
    });
  });

  // 조정 테이블 — 헤더 클릭 정렬 (없음→내림차순→오름차순→기본 복귀)
  root.querySelectorAll(".exc-sort-th").forEach(function(th) {
    th.addEventListener("click", function() {
      var key = th.dataset.sort;
      var prop = th.dataset.sorttab === "mat" ? "excessMatSort" : "excessFgSort";
      var cur = state[prop];
      var firstDir = key === "name" ? 1 : -1;
      if (!cur || cur.key !== key) state[prop] = { key: key, dir: firstDir };
      else if (cur.dir === firstDir) state[prop] = { key: key, dir: -firstDir };
      else state[prop] = null; // 기본 정렬(초과금액) 복귀
      render("inventory-variance");
    });
  });

  // 조정 테이블 — 품목명 클릭 → 진단 카드 (AI 제안 품목이면 판정 가능 카드)
  root.querySelectorAll(".exc-nm-click").forEach(function(td) {
    td.addEventListener("click", function() {
      var tr = td.closest("tr");
      if (!tr) return;
      if (tr.dataset.matCode !== undefined) {
        openMatTableDiag(tr.dataset.matCode, tr.dataset.matPlant || "");
      } else if (tr.dataset.rowKey) {
        var parts = tr.dataset.rowKey.split("|");
        openFgTableDiag(parts[0], parts[1] || "");
      }
    });
  });

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
      // 섹션을 펼치면 그 원인의 품목을 아래 시뮬 표에서 부각 (시뮬 대상인 ①입고·생산축소·②판매계획현실화만 해당)
      var focusable = (sec === "supply" || sec === "planfix");
      state.aiFocusSec = (state.aiDiagOpen[sec] && focusable) ? sec : null;
      applyAiSecFocus(root);
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
      state.aiDecisions = {};
      clearAiSession();
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

  // 렌더 직후 — 선택된 AI 진단 섹션이 있으면 시뮬 표 강조를 복원
  applyAiSecFocus(root);

  // 성능 측정 출력 — 계산(구간별) + innerHTML 반영 + 이벤트 바인딩
  if (EXC_PROF) {
    var _bindMs = performance.now() - _bindT0;
    if (_injectMs != null) _excProfRows.push(["innerHTML 반영(브라우저)", +_injectMs.toFixed(1)]);
    excProfFlush(window._excRenderMs || 0, _bindMs);
  }
}

// ── 세션 복원 — 판정·조정·회의록을 localStorage에서 복구 (core.js 로드 이후 실행) ──
loadAiSession();
