// ── 재고전망 화면 ─────────────────────────────────────────────────────────────

// 월별 공급계획 조정 시뮬레이션
// matAdjBomMap: buildBomMaxProducibleMap(state.matSimAdj) 결과 — RTF 자재조정 반영
function computeAdjMonthly(item, matAdjBomMap) {
  var planMap = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    if (cleanOptional(r.itemCode) === item.itemCode &&
        cleanOptional(r.plant)     === item.plantCode) {
      var m = cleanOptional(r.month);
      if (m) planMap.set(m, (planMap.get(m) || 0) + (cleanNumber(r.supplyQty) || 0));
    }
  });

  var months  = getRtfMonths();
  var opening = (item.baseQty !== null && item.baseQty !== undefined) ? item.baseQty : 0;
  return months.map(function(month, mi) {
    var origSupply = planMap.get(month) || 0;

    // ① RTF 자재 조정 반영: BOM 제약으로 생산가능수량이 달라지면 공급 상한 적용
    var rtfAdjSupply = origSupply;
    if (matAdjBomMap) {
      var maxProd = matAdjBomMap.get(item.itemCode + "|" + item.plantCode + "|" + month);
      if (maxProd !== undefined) rtfAdjSupply = Math.min(origSupply, maxProd);
    }

    // ② 재고전망 직접 조정 (invSupplyAdj): RTF조정 후를 기준으로 추가 조정
    var adjKey    = item.itemCode + "|" + item.plantCode + "|" + month;
    var adjSupply = (adjKey in state.invSupplyAdj) ? state.invSupplyAdj[adjKey] : rtfAdjSupply;

    var salesQty      = (item.monthlyStatus[mi] && item.monthlyStatus[mi].salesQty) ? item.monthlyStatus[mi].salesQty : 0;
    var available     = opening + adjSupply;
    var endingQty     = Math.max(0, available - salesQty);
    var shortageQty   = Math.max(0, salesQty - available);
    var endingAmount  = (item.hasCost && item.standardCost) ? endingQty * item.standardCost : null;
    var inventoryDays = salesQty > 0 ? endingQty / (salesQty / monthDays(month)) : null;

    opening = endingQty;
    return {
      month:           month,
      origSupply:      origSupply,
      rtfAdjSupply:    rtfAdjSupply,   // RTF 자재조정 후 공급 (BOM 제약 반영)
      adjSupply:       adjSupply,       // 최종 공급 (invSupplyAdj 포함)
      salesQty:        salesQty,
      endingQty:       endingQty,
      endingAmount:    endingAmount,
      shortageQty:     shortageQty,
      inventoryDays:   inventoryDays,
      isDanger:        shortageQty > 0,
      isRtfAdjusted:   Math.abs(rtfAdjSupply - origSupply) > 0.01,  // RTF 조정으로 달라진 월
      isInvAdjusted:   adjKey in state.invSupplyAdj,                 // 재고화면 직접 조정된 월
      isAdjusted:      Math.abs(adjSupply - origSupply) > 0.01,
    };
  });
}

// 과잉감축 조정 반영 재고 계산 (RTF조정 위에 excessAdj 적용)
function computeExcessMonthly(item, matAdjBomMap) {
  var planMap = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    if (cleanOptional(r.itemCode) === item.itemCode &&
        cleanOptional(r.plant)     === item.plantCode) {
      var m = cleanOptional(r.month);
      if (m) planMap.set(m, (planMap.get(m) || 0) + (cleanNumber(r.supplyQty) || 0));
    }
  });

  var months  = getRtfMonths();
  var opening = (item.baseQty !== null && item.baseQty !== undefined) ? item.baseQty : 0;
  return months.map(function(month, mi) {
    var origSupply = planMap.get(month) || 0;

    var rtfAdjSupply = origSupply;
    if (matAdjBomMap) {
      var maxProd = matAdjBomMap.get(item.itemCode + "|" + item.plantCode + "|" + month);
      if (maxProd !== undefined) rtfAdjSupply = Math.min(origSupply, maxProd);
    }

    var adjKey      = item.itemCode + "|" + item.plantCode + "|" + month;
    var finalSupply = (adjKey in state.excessAdj) ? state.excessAdj[adjKey] : rtfAdjSupply;

    var salesQty     = (item.monthlyStatus[mi] && item.monthlyStatus[mi].salesQty) ? item.monthlyStatus[mi].salesQty : 0;
    var available    = opening + finalSupply;
    var endingQty    = Math.max(0, available - salesQty);
    var shortageQty  = Math.max(0, salesQty - available);
    var endingAmount = (item.hasCost && item.standardCost) ? endingQty * item.standardCost : null;
    var inventoryDays = salesQty > 0 ? endingQty / (salesQty / monthDays(month)) : null;

    opening = endingQty;
    return {
      month, origSupply, rtfAdjSupply, finalSupply,
      salesQty, endingQty, endingAmount, shortageQty, inventoryDays,
      isDanger:          shortageQty > 0,
      isRtfAdjusted:     Math.abs(rtfAdjSupply - origSupply) > 0.01,
      isExcessAdjusted:  adjKey in state.excessAdj,
    };
  });
}

// 기준월 재고일수 반환 (현재 계획 기준)
function getBaseMonthDays(item) {
  var ms = item.monthlyStatus && item.monthlyStatus[0];
  if (!ms) return null;
  return Number.isFinite(ms.inventoryDays) ? ms.inventoryDays : null;
}

// 재고일수 상태 클래스
function invDaysCls(days, targetDays) {
  if (targetDays === null || targetDays === undefined) return "inv-days-unset";
  if (!Number.isFinite(days)) return "";
  var ratio = days / targetDays;
  if (ratio > 1.3) return "inv-days-excess";
  if (ratio > 1.0) return "inv-days-warn";
  return "inv-days-ok";
}

// ── 그룹 집계 월별 셀 렌더 ────────────────────────────────────────────────────
function invMonthlyAggCells(items, months, adjCache, isAdj, rowCls) {
  return months.map(function(month, mi) {
    var totalEndQty = 0, totalEndAmt = 0, totalSalesQty = 0, hasAmt = false;
    items.forEach(function(item) {
      var key  = item.itemCode + "|" + item.plantCode;
      var data = (isAdj && adjCache) ? (adjCache.get(key) || [])[mi] : null;
      var ms   = item.monthlyStatus ? item.monthlyStatus[mi] : null;
      var endQty = data ? data.endingQty   : (ms ? ms.endingQty   : null);
      var endAmt = data ? data.endingAmount : (ms ? ms.endingAmount : null);
      if (Number.isFinite(endQty)) totalEndQty += endQty;
      if (Number.isFinite(endAmt)) { totalEndAmt += endAmt; hasAmt = true; }
      if (ms && Number.isFinite(ms.salesQty)) totalSalesQty += ms.salesQty;
    });
    var days     = (totalSalesQty > 0) ? totalEndQty / (totalSalesQty / monthDays(month)) : null;
    var daysDisp = Number.isFinite(days) ? Math.round(days) + "일" : "-";
    var amtDisp  = hasAmt ? formatMoney(totalEndAmt) : "-";
    return "<td class=\"" + rowCls + "\">" + escapeHtml(daysDisp) + "</td>" +
           "<td class=\"" + rowCls + "\">" + escapeHtml(amtDisp) + "</td>";
  }).join("");
}

// ── (구 계층 빌더 자리 — 아래는 삭제된 buildInvHierarchy stub) ────────────────
function buildInvHierarchy(items) {
  var groups = {};
  items.forEach(function(item) {
    var bu    = item.businessUnit || "(미분류)";
    var plant = item.plant        || "(미분류)";
    var type  = item.typeGroup    || "(기타)";
    if (!groups[bu])              groups[bu] = {};
    if (!groups[bu][plant])       groups[bu][plant] = {};
    if (!groups[bu][plant][type]) groups[bu][plant][type] = [];
    groups[bu][plant][type].push(item);
  });

  var nodes = [];
  var sortKo = function(a, b) { return a.localeCompare(b, "ko-KR"); };

  Object.keys(groups).sort(sortKo).forEach(function(bu) {
    var buId    = "bu|" + bu;
    var buItems = [];
    Object.values(groups[bu]).forEach(function(pm) {
      Object.values(pm).forEach(function(ti) { buItems = buItems.concat(ti); });
    });
    nodes.push({ id: buId, label: bu, level: 0, parentId: "", kind: "group", items: buItems });

    Object.keys(groups[bu]).sort(sortKo).forEach(function(plant) {
      var plantId    = buId + "|" + plant;
      var plantItems = [];
      Object.values(groups[bu][plant]).forEach(function(ti) { plantItems = plantItems.concat(ti); });
      nodes.push({ id: plantId, label: plant, level: 1, parentId: buId, kind: "group", items: plantItems });

      Object.keys(groups[bu][plant]).sort(sortKo).forEach(function(type) {
        var typeId    = plantId + "|" + type;
        var typeItems = groups[bu][plant][type];
        nodes.push({ id: typeId, label: type, level: 2, parentId: plantId, kind: "group", items: typeItems });

        typeItems.forEach(function(item) {
          nodes.push({
            id:       typeId + "|" + item.itemCode + "|" + item.plantCode,
            label:    item.itemName || item.itemCode,
            level:    3,
            parentId: typeId,
            kind:     "item",
            items:    [item],
          });
        });
      });
    });
  });
  return nodes;
}

function invNodeVisible(node, nodes) {
  if (node.level === 0) return true;
  if (!state.invExpandedGroups.has(node.parentId)) return false;
  var parent = null;
  for (var i = 0; i < nodes.length; i++) { if (nodes[i].id === node.parentId) { parent = nodes[i]; break; } }
  return parent ? invNodeVisible(parent, nodes) : true;
}

function invAggMonth(groupItems, mi, adjCache) {
  var months        = getRtfMonths();
  var totalEndQty   = 0, totalEndAmt = 0, totalSalesQty = 0;
  var hasQty = false, hasAmt = false, hasDanger = false;
  groupItems.forEach(function(item) {
    var key  = item.itemCode + "|" + item.plantCode;
    var data = adjCache ? (adjCache.get(key) || [])[mi] : null;
    var ms   = item.monthlyStatus ? item.monthlyStatus[mi] : null;
    var endQty = adjCache && data ? data.endingQty   : (ms ? ms.endingQty   : null);
    var endAmt = adjCache && data ? data.endingAmount : (ms ? ms.endingAmount : null);
    if (Number.isFinite(endQty)) { totalEndQty += endQty; hasQty = true; }
    if (Number.isFinite(endAmt)) { totalEndAmt += endAmt; hasAmt = true; }
    if (ms && Number.isFinite(ms.salesQty)) totalSalesQty += ms.salesQty;
    if (adjCache && data && data.isDanger) hasDanger = true;
  });
  var month = months[mi];
  var inventoryDays = (hasQty && totalSalesQty > 0)
    ? totalEndQty / (totalSalesQty / monthDays(month)) : null;
  return {
    endingAmount:  hasAmt ? totalEndAmt : null,
    inventoryDays: inventoryDays,
    hasDanger:     hasDanger,
  };
}

// ── 메인 렌더 ─────────────────────────────────────────────────────────────────
function renderInventoryForecast() {
  if (!state.mappedData.plan_monthly.length) {
    return "<section class=\"section-band\"><div class=\"section-header\"><h2>재고전망</h2>" +
      "<p>데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 선택해 주세요.</p></div></section>";
  }

  var months   = getRtfMonths();
  var rtfItems = computeRtfItems();

  // 적정재고 맵
  var targetMap = new Map();
  (state.mappedData.target_inv || []).forEach(function(r) {
    if (r.itemCode) targetMap.set(r.itemCode, r.targetDays);
  });

  // 조정 가능 여부
  var hasMatAdj   = Object.keys(state.matSimAdj  || {}).length > 0;
  var hasExcessAdj = Object.keys(state.excessAdj || {}).length > 0;

  // invViewMode 유효성 보정
  if (state.invViewMode === "rtf"    && !hasMatAdj)    state.invViewMode = "current";
  if (state.invViewMode === "excess" && !hasExcessAdj) state.invViewMode = "current";
  // 레거시 "adjusted" 값 보정
  if (state.invViewMode === "adjusted") state.invViewMode = hasMatAdj ? "rtf" : "current";

  var activeMode = state.invViewMode; // "current" | "rtf" | "excess"

  // RTF 자재조정 BOM 맵 (한 번만 계산, RTF/excess 모드 공통)
  var matAdjBomMap = hasMatAdj ? buildBomMaxProducibleMap(state.matSimAdj) : null;

  // ── 3-패널 요약 계산 ──────────────────────────────────────────────────────
  var totalBaseAmt = 0, totalRtfAmt = 0, totalExcessAmt = 0;
  var totalTargetAmt = 0, excessCount = 0;
  var baseHasAmt = false, rtfHasAmt = false, excessHasAmt = false;

  rtfItems.forEach(function(item) {
    var ms0 = item.monthlyStatus && item.monthlyStatus[0];
    if (!ms0) return;

    // 원계획
    if (Number.isFinite(ms0.endingAmount)) { totalBaseAmt += ms0.endingAmount; baseHasAmt = true; }

    // RTF조정후
    var rtf0 = computeAdjMonthly(item, matAdjBomMap)[0];
    if (Number.isFinite(rtf0.endingAmount)) { totalRtfAmt += rtf0.endingAmount; rtfHasAmt = true; }

    // 감축후
    var ex0 = computeExcessMonthly(item, matAdjBomMap)[0];
    if (Number.isFinite(ex0.endingAmount)) { totalExcessAmt += ex0.endingAmount; excessHasAmt = true; }

    // 적정재고 / 과잉 카운트
    var targetDays = targetMap.get(item.itemCode);
    if (targetDays && item.hasCost && ms0.salesQty > 0) {
      totalTargetAmt += (ms0.salesQty / monthDays(months[0])) * targetDays * item.standardCost;
    }
    var curDays = ms0.inventoryDays;
    if (targetDays && Number.isFinite(curDays) && curDays > targetDays) excessCount++;
  });

  function fmtPanel(amt, hasAmt) { return hasAmt ? escapeHtml(formatMoney(amt)) : "<span class=\"inv-panel-nodata\">-</span>"; }
  function fmtDelta(delta) {
    if (delta === null) return "";
    var pos = delta >= 0;
    return "<div class=\"inv-panel-delta " + (pos ? "inv-delta-pos" : "inv-delta-neg") + "\">" +
      escapeHtml((pos ? "△+" : "△") + formatMoney(Math.abs(delta))) + "</div>";
  }

  var rtfDelta    = (hasMatAdj && rtfHasAmt && baseHasAmt)   ? totalRtfAmt    - totalBaseAmt  : null;
  var excessDelta = (hasExcessAdj && excessHasAmt && rtfHasAmt) ? totalExcessAmt - totalRtfAmt : null;
  var netDelta    = (rtfDelta !== null || excessDelta !== null)
    ? ((excessHasAmt ? totalExcessAmt : (rtfHasAmt ? totalRtfAmt : totalBaseAmt)) - totalBaseAmt)
    : null;

  var m0Label = escapeHtml(monthLabel(months[0])) + "말 기준";
  var summaryHtml =
    "<div class=\"inv-3panel\">" +
      "<div class=\"inv-panel" + (activeMode === "current" ? " inv-panel-active" : "") + "\">" +
        "<div class=\"inv-panel-title\">원계획</div>" +
        "<div class=\"inv-panel-sub\">" + m0Label + "</div>" +
        "<div class=\"inv-panel-value\">" + fmtPanel(totalBaseAmt, baseHasAmt) + "</div>" +
        "<div class=\"inv-panel-meta\">적정재고 " + (totalTargetAmt > 0 ? escapeHtml(formatMoney(totalTargetAmt)) : "미설정") + " · 과잉 " + excessCount + "개</div>" +
      "</div>" +
      "<div class=\"inv-panel-arrow\">→</div>" +
      "<div class=\"inv-panel" + (activeMode === "rtf" ? " inv-panel-active" : "") + (hasMatAdj ? "" : " inv-panel-disabled") + "\">" +
        "<div class=\"inv-panel-title\">RTF 조정후" + (hasMatAdj ? "" : " <span class=\"inv-panel-need\">(조정없음)</span>") + "</div>" +
        "<div class=\"inv-panel-sub\">" + m0Label + "</div>" +
        "<div class=\"inv-panel-value\">" + (hasMatAdj ? fmtPanel(totalRtfAmt, rtfHasAmt) : "<span class=\"inv-panel-nodata\">-</span>") + "</div>" +
        (rtfDelta !== null ? fmtDelta(rtfDelta) : "<div class=\"inv-panel-delta inv-panel-nodata\">조정 없음</div>") +
      "</div>" +
      "<div class=\"inv-panel-arrow\">→</div>" +
      "<div class=\"inv-panel" + (activeMode === "excess" ? " inv-panel-active" : "") + (hasExcessAdj ? "" : " inv-panel-disabled") + "\">" +
        "<div class=\"inv-panel-title\">감축 후" + (hasExcessAdj ? "" : " <span class=\"inv-panel-need\">(과잉감축 탭에서 입력)</span>") + "</div>" +
        "<div class=\"inv-panel-sub\">" + m0Label + "</div>" +
        "<div class=\"inv-panel-value\">" + (hasExcessAdj ? fmtPanel(totalExcessAmt, excessHasAmt) : "<span class=\"inv-panel-nodata\">-</span>") + "</div>" +
        (excessDelta !== null ? fmtDelta(excessDelta) : "<div class=\"inv-panel-delta inv-panel-nodata\">감축 입력 필요</div>") +
        (netDelta !== null ? "<div class=\"inv-panel-net\">순효과 " + escapeHtml((netDelta >= 0 ? "+" : "") + formatMoney(netDelta)) + "</div>" : "") +
      "</div>" +
    "</div>";

  // ── 컨트롤 ──────────────────────────────────────────────────────────────
  var filterAll    = state.invFilter !== "excess";
  var controlsHtml =
    "<div class=\"inv-controls\">" +
      "<div class=\"inv-view-toggle\">" +
        "<button type=\"button\" class=\"inv-view-btn" + (activeMode === "current" ? " active" : "") + "\" data-inv-view=\"current\">원계획</button>" +
        "<button type=\"button\" class=\"inv-view-btn" + (activeMode === "rtf" ? " active" : "") + (hasMatAdj ? "" : " disabled") + "\"" +
          (hasMatAdj ? "" : " disabled title=\"공급원인 화면에서 자재 입고 조정 후 활성화됩니다\"") +
          " data-inv-view=\"rtf\">RTF 조정후</button>" +
        "<button type=\"button\" class=\"inv-view-btn" + (activeMode === "excess" ? " active" : "") + (hasExcessAdj ? "" : " disabled") + "\"" +
          (hasExcessAdj ? "" : " disabled title=\"과잉감축 탭에서 조정 입력 후 활성화됩니다\"") +
          " data-inv-view=\"excess\">감축 후</button>" +
      "</div>" +
      "<div style=\"display:flex;gap:4px;\">" +
        "<button type=\"button\" class=\"inv-filter-btn" + (filterAll ? " active" : "") + "\" data-inv-filter=\"all\">전체</button>" +
        "<button type=\"button\" class=\"inv-filter-btn" + (!filterAll ? " active" : "") + "\" data-inv-filter=\"excess\">과잉만</button>" +
      "</div>" +
    "</div>";

  // ── 조정 캐시 (activeMode에 따라 계산함수 선택) ──────────────────────────
  var isAdj    = activeMode !== "current";
  var adjCache = null;
  if (activeMode === "rtf") {
    adjCache = new Map();
    rtfItems.forEach(function(item) {
      adjCache.set(item.itemCode + "|" + item.plantCode, computeAdjMonthly(item, matAdjBomMap));
    });
  } else if (activeMode === "excess") {
    adjCache = new Map();
    rtfItems.forEach(function(item) {
      adjCache.set(item.itemCode + "|" + item.plantCode, computeExcessMonthly(item, matAdjBomMap));
    });
  }

  // 필터링
  var displayItems = rtfItems.filter(function(item) {
    if (state.invFilter !== "excess") return true;
    var td = targetMap.get(item.itemCode);
    if (!td) return false;
    var d = getBaseMonthDays(item);
    return Number.isFinite(d) && d > td;
  });

  // 총 컬럼 수: 사업부 + 플랜트 + 유형 + 품목명 + 적정일수 + 월별(재고일수+재고금액)
  var totalCols = 5 + months.length * 2;

  // ── 그룹 구조 빌드 ──
  var sortKo  = function(a, b) { return a.localeCompare(b, "ko-KR"); };
  var buGroups = {};
  displayItems.forEach(function(item) {
    var bu = item.businessUnit || "(미분류)";
    var pl = item.plant        || "(미분류)";
    var ty = item.typeGroup    || "(기타)";
    if (!buGroups[bu])         buGroups[bu] = {};
    if (!buGroups[bu][pl])     buGroups[bu][pl] = {};
    if (!buGroups[bu][pl][ty]) buGroups[bu][pl][ty] = [];
    buGroups[bu][pl][ty].push(item);
  });

  // ── 드릴다운 행 렌더 헬퍼 ──
  function makeDrillRow(item, adjMonthly) {
    var adj = adjMonthly || computeAdjMonthly(item, matAdjBomMap);
    // RTF 조정이 있는 월이 하나라도 있으면 RTF조정 컬럼 표시
    var showRtfCol = adj.some(function(d) { return d.isRtfAdjusted; });
    var colCount   = showRtfCol ? 8 : 7;

    var drillBody = months.map(function(month, mi) {
      var d         = adj[mi];
      var adjKey    = item.itemCode + "|" + item.plantCode + "|" + month;
      var daysDisp  = Number.isFinite(d.inventoryDays) ? Math.round(d.inventoryDays) + "일" : "-";
      var amtDisp   = Number.isFinite(d.endingAmount)  ? formatMoney(d.endingAmount)        : "-";
      var dangerCls = d.isDanger ? " inv-danger-cell" : "";

      // 변동: 최종 vs RTF조정 후 기준
      var delta     = d.adjSupply - d.rtfAdjSupply;
      var deltaHtml = d.isInvAdjusted
        ? "<span class=\"" + (delta >= 0 ? "inv-adj-pos" : "inv-adj-neg") + "\">" +
          escapeHtml((delta >= 0 ? "+" : "") + formatNumber(Math.round(delta))) + "</span>"
        : "";

      var rtfCell = showRtfCol
        ? "<td class=\"" + (d.isRtfAdjusted ? "inv-rtf-cell" : "") + "\">" +
          escapeHtml(formatNumber(Math.round(d.rtfAdjSupply))) +
          (d.isRtfAdjusted ? "<span class=\"inv-rtf-badge\">RTF</span>" : "") + "</td>"
        : "";

      // input의 data-orig = rtfAdjSupply (재고직접조정의 기준점)
      return "<tr>" +
        "<td>" + escapeHtml(monthLabel(month)) + "</td>" +
        "<td>" + escapeHtml(formatNumber(Math.round(d.origSupply))) + "</td>" +
        rtfCell +
        "<td><input type=\"number\" class=\"inv-supply-input" + (d.isInvAdjusted ? " adjusted" : "") + "\"" +
          " data-key=\"" + escapeHtml(adjKey) + "\" data-orig=\"" + d.rtfAdjSupply + "\"" +
          " value=\"" + Math.round(d.adjSupply) + "\" min=\"0\" step=\"1\"></td>" +
        "<td>" + deltaHtml + "</td>" +
        "<td class=\"" + dangerCls + "\">" + escapeHtml(formatNumber(Math.round(d.endingQty))) +
          (d.isDanger ? "<span class=\"inv-danger-icon\">⚠</span>" : "") + "</td>" +
        "<td class=\"" + dangerCls + "\">" + escapeHtml(daysDisp) + "</td>" +
        "<td>" + escapeHtml(amtDisp) + "</td>" +
      "</tr>";
    }).join("");

    var rtfTh = showRtfCol ? "<th>RTF조정 후</th>" : "";
    return "<tr class=\"inv-drill-row\"><td colspan=\"" + totalCols + "\">" +
      "<div class=\"inv-drill-inner\">" +
        "<div class=\"inv-drill-title\">" + escapeHtml(item.itemName || item.itemCode) + " · 공급계획 조정</div>" +
        (showRtfCol ? "<div class=\"inv-drill-note\">RTF 자재조정이 반영된 공급을 기준으로 추가 조정합니다.</div>" : "") +
        "<div class=\"inv-table-wrap\"><table class=\"inv-drill-table\">" +
          "<thead><tr><th>월</th><th>원 공급계획</th>" + rtfTh + "<th>재고 직접조정</th><th>변동</th><th>기말재고(EA)</th><th>재고일수</th><th>재고금액</th></tr></thead>" +
          "<tbody>" + drillBody + "</tbody>" +
        "</table></div>" +
        "<div class=\"inv-drill-btns\">" +
          "<button class=\"inv-record-btn\" data-item-code=\"" + escapeHtml(item.itemCode) + "\" data-plant=\"" + escapeHtml(item.plantCode || "") + "\">결정사항 회의록에 기록</button>" +
          "<button class=\"inv-reset-btn\"  data-item-code=\"" + escapeHtml(item.itemCode) + "\" data-plant=\"" + escapeHtml(item.plantCode || "") + "\">조정 초기화</button>" +
        "</div>" +
      "</div>" +
    "</td></tr>";
  }

  // ── 행 렌더링 ──
  var bodyHtml  = "";
  var allItems  = []; // 총합계용
  var CONT = "<td class=\"inv-gc inv-gc-cont\"></td>"; // 시각적 병합 연속 셀

  Object.keys(buGroups).sort(sortKo).forEach(function(bu) {
    var buAllItems   = [];
    var isFirstBuRow = true;

    Object.keys(buGroups[bu]).sort(sortKo).forEach(function(plant) {
      var plantAllItems   = [];
      var isFirstPlantRow = true;

      Object.keys(buGroups[bu][plant]).sort(sortKo).forEach(function(type) {
        var typeItems = buGroups[bu][plant][type];

        typeItems.forEach(function(item, itemIdx) {
          var rowKey     = item.itemCode + "|" + item.plantCode;
          var isExpDrill = state.invExpandedRows.has(rowKey);
          var adjMonthly = adjCache ? adjCache.get(rowKey) : (isExpDrill ? computeAdjMonthly(item, matAdjBomMap) : null);
          var targetDays = targetMap.get(item.itemCode);

          // 병합 셀: 그룹이 바뀔 때만 내용 표시, 이후엔 빈 연속 셀
          var buCell    = isFirstBuRow
            ? "<td class=\"inv-gc inv-gc-bu\">" + escapeHtml(bu) + "</td>" : CONT;
          var plantCell = isFirstPlantRow
            ? "<td class=\"inv-gc inv-gc-pl\">" + escapeHtml(plant) + "</td>" : CONT;
          var typeCell  = (itemIdx === 0)
            ? "<td class=\"inv-gc inv-gc-ty\">" + escapeHtml(type) + "</td>" : CONT;

          // 구분선 클래스
          var sepCls = isFirstBuRow ? " inv-sep-bu" : (isFirstPlantRow ? " inv-sep-pl" : (itemIdx === 0 ? " inv-sep-ty" : ""));

          // 월별 셀
          var monthCells = months.map(function(month, mi) {
            var ms     = item.monthlyStatus[mi];
            var useAdj = isAdj && adjMonthly;
            var days   = useAdj ? adjMonthly[mi].inventoryDays : (ms ? ms.inventoryDays : null);
            var amt    = useAdj ? adjMonthly[mi].endingAmount  : (ms ? ms.endingAmount  : null);
            var danger = useAdj && adjMonthly[mi].isDanger;
            var cls    = invDaysCls(days, targetDays);
            var dDisp  = Number.isFinite(days) ? Math.round(days) + "일" : "-";
            var aDisp  = Number.isFinite(amt)  ? formatMoney(amt)        : "-";
            var icon      = danger ? "<span class=\"inv-danger-icon\">⚠</span>" : "";
            var rtfBadge  = (isAdj && adjMonthly && adjMonthly[mi].isRtfAdjusted)  ? "<span class=\"inv-rtf-badge\">RTF</span>"  : "";
            var invBadge  = (isAdj && adjMonthly && adjMonthly[mi].isInvAdjusted)  ? "<span class=\"inv-adj-badge\">조정</span>" : "";
            return "<td class=\"" + cls + "\">" + escapeHtml(dDisp) + icon + rtfBadge + invBadge + "</td>" +
                   "<td>" + escapeHtml(aDisp) + "</td>";
          }).join("");

          var targetDisp = (targetDays !== undefined && targetDays !== null)
            ? escapeHtml(Math.round(targetDays) + "일")
            : "<span class=\"inv-days-unset\">미설정</span>";

          bodyHtml +=
            "<tr class=\"inv-item-row" + sepCls + "\" data-row-key=\"" + escapeHtml(rowKey) + "\">" +
              buCell + plantCell + typeCell +
              "<td class=\"inv-item-name\" title=\"" + escapeHtml(item.itemCode) + "\">" +
                "<button type=\"button\" class=\"inv-row-toggle\" data-row-key=\"" + escapeHtml(rowKey) + "\">" +
                  (isExpDrill ? "▼" : "▶") + "</button> " +
                escapeHtml(item.itemName || item.itemCode) +
              "</td>" +
              "<td>" + targetDisp + "</td>" +
              monthCells +
            "</tr>";

          if (isExpDrill) bodyHtml += makeDrillRow(item, adjMonthly);

          isFirstBuRow    = false;
          isFirstPlantRow = false;
        }); // items

        // 유형 소계
        bodyHtml +=
          "<tr class=\"inv-subtotal-row inv-st-type\">" +
            CONT + CONT +
            "<td colspan=\"2\" class=\"inv-st-label\">" + escapeHtml(type) + " 소계</td>" +
            "<td class=\"inv-st-dash\">-</td>" +
            invMonthlyAggCells(typeItems, months, adjCache, isAdj, "inv-st-cell") +
          "</tr>";

        plantAllItems = plantAllItems.concat(typeItems);
      }); // types

      // 플랜트 소계
      bodyHtml +=
        "<tr class=\"inv-subtotal-row inv-st-plant\">" +
          CONT +
          "<td colspan=\"3\" class=\"inv-st-label\">" + escapeHtml(plant) + " 소계</td>" +
          "<td class=\"inv-st-dash\">-</td>" +
          invMonthlyAggCells(plantAllItems, months, adjCache, isAdj, "inv-st-cell") +
        "</tr>";

      buAllItems = buAllItems.concat(plantAllItems);
    }); // plants

    // 사업부 소계
    bodyHtml +=
      "<tr class=\"inv-subtotal-row inv-st-bu\">" +
        "<td colspan=\"4\" class=\"inv-st-label\">" + escapeHtml(bu) + " 소계</td>" +
        "<td class=\"inv-st-dash\">-</td>" +
        invMonthlyAggCells(buAllItems, months, adjCache, isAdj, "inv-st-cell") +
      "</tr>";

    allItems = allItems.concat(buAllItems);
  }); // bus

  // 총합계
  if (allItems.length > 0) {
    bodyHtml +=
      "<tr class=\"inv-subtotal-row inv-grand-total\">" +
        "<td colspan=\"4\" class=\"inv-st-label\">총합계</td>" +
        "<td class=\"inv-st-dash\">-</td>" +
        invMonthlyAggCells(allItems, months, adjCache, isAdj, "inv-gt-cell") +
      "</tr>";
  }

  var noData = displayItems.length === 0
    ? "<tr><td colspan=\"" + totalCols + "\" style=\"text-align:center;padding:24px;color:#9ca3af;\">표시할 품목이 없습니다.</td></tr>"
    : "";

  // 테이블 헤더
  var monthHeads = months.map(function(m) {
    return "<th colspan=\"2\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHeads = months.map(function() {
    return "<th>재고일수</th><th>재고금액</th>";
  }).join("");

  var tableHtml =
    "<div class=\"inv-table-wrap\"><table class=\"inv-table\">" +
      "<thead>" +
        "<tr>" +
          "<th rowspan=\"2\" class=\"inv-th-gc\">사업부</th>" +
          "<th rowspan=\"2\" class=\"inv-th-gc\">플랜트</th>" +
          "<th rowspan=\"2\" class=\"inv-th-gc\">유형</th>" +
          "<th rowspan=\"2\" class=\"inv-th-name\">품목명</th>" +
          "<th rowspan=\"2\">적정일수</th>" +
          monthHeads +
        "</tr>" +
        "<tr>" + subHeads + "</tr>" +
      "</thead>" +
      "<tbody>" + (bodyHtml || noData) + "</tbody>" +
    "</table></div>";

  return "<div class=\"inv-screen\"><div class=\"inv-inner\">" +
    summaryHtml + controlsHtml + tableHtml +
  "</div></div>";
}

// ── 이벤트 바인딩 ──────────────────────────────────────────────────────────────
function bindInventoryForecast() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;

  // 전후 토글
  root.querySelectorAll("[data-inv-view]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (btn.disabled) return;
      if (state.invViewMode === btn.dataset.invView) return;
      state.invViewMode = btn.dataset.invView;
      render("inventory-forecast");
    });
  });

  // 필터
  root.querySelectorAll("[data-inv-filter]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (state.invFilter === btn.dataset.invFilter) return;
      state.invFilter = btn.dataset.invFilter;
      render("inventory-forecast");
    });
  });

  // 품목 드릴다운 펼치기/접기
  root.querySelectorAll(".inv-row-toggle").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var key = btn.dataset.rowKey;
      if (state.invExpandedRows.has(key)) state.invExpandedRows.delete(key);
      else                                 state.invExpandedRows.add(key);
      render("inventory-forecast");
    });
  });

  // 공급계획 조정 입력 — 조정 즉시 "조정 후" 모드로 전환해 소계/총합계에 반영
  root.querySelectorAll(".inv-supply-input").forEach(function(input) {
    input.addEventListener("change", function() {
      var key  = input.dataset.key;
      var orig = parseFloat(input.dataset.orig) || 0;
      var val  = parseFloat(input.value);
      if (!Number.isFinite(val) || val < 0) { input.value = Math.round(orig); return; }
      if (Math.abs(val - orig) < 0.01) {
        delete state.invSupplyAdj[key];
        if (!Object.keys(state.invSupplyAdj).length && !Object.keys(state.matSimAdj || {}).length) {
          state.invViewMode = "current";
        }
      } else {
        state.invSupplyAdj[key] = val;
        state.invViewMode = "rtf";
      }
      render("inventory-forecast");
    });
  });

  // 회의록 기록
  root.querySelectorAll(".inv-record-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var itemCode = btn.dataset.itemCode;
      var plant    = btn.dataset.plant || "";
      var months   = getRtfMonths();
      var rtfItems = computeRtfItems();
      var item     = rtfItems.find(function(it) { return it.itemCode === itemCode && it.plantCode === plant; });
      if (!item) return;

      var matAdjBomMap2 = Object.keys(state.matSimAdj || {}).length > 0
        ? buildBomMaxProducibleMap(state.matSimAdj) : null;
      var adjMonthly = computeAdjMonthly(item, matAdjBomMap2);
      var adjEntries = adjMonthly.filter(function(d) { return d.isAdjusted; }).map(function(d) {
        return {
          month:        d.month,
          origSupply:   d.origSupply,
          rtfAdjSupply: d.rtfAdjSupply,
          adjSupply:    d.adjSupply,
          delta:        d.adjSupply - d.origSupply,
        };
      });
      if (!adjEntries.length) { alert("조정된 내역이 없습니다."); return; }

      if (!state.minutesLog) state.minutesLog = [];
      state.minutesLog.push({
        id:        Date.now(),
        timestamp: new Date(),
        type:      "inv_adjust",
        title:     (item.itemName || item.itemCode) + " 공급계획 조정",
        itemCode:  itemCode,
        entries:   adjEntries.map(function(e) {
          return {
            matCode: itemCode,
            matName: item.itemName || itemCode,
            month:   e.month,
            orig:    e.origSupply,
            adj:     e.adjSupply,
            delta:   e.delta,
            addlEA:  0,
          };
        }),
      });
      alert("회의록에 기록했습니다.");
      render("minutes");
    });
  });

  // 조정 초기화
  root.querySelectorAll(".inv-reset-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var itemCode = btn.dataset.itemCode;
      var plant    = btn.dataset.plant || "";
      var months   = getRtfMonths();
      months.forEach(function(month) {
        delete state.invSupplyAdj[itemCode + "|" + plant + "|" + month];
      });
      render("inventory-forecast");
    });
  });
}
