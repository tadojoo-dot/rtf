// ── 재고전망 화면 ─────────────────────────────────────────────────────────────

var INV_SECTION_OPTIONS = [
  { mode: "business", label: "사업부별" },
  { mode: "plant",    label: "플랜트별" },
  { mode: "type",     label: "유형별"   },
];

var _invGroupNodeIds = []; // 모두 펼치기용 캐시
var _invChartInst   = null; // Chart.js 인스턴스

// ── 계산 함수 ─────────────────────────────────────────────────────────────────

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
    var origSupply   = planMap.get(month) || 0;
    // 완제품 생산계획 조정(fgProdAdj) — RTF조정후 기준선에 반영 (늘리기만)
    var _fgpKey = item.itemCode + "|" + item.plantCode + "|" + month;
    if (state.fgProdAdj && (_fgpKey in state.fgProdAdj)) origSupply = state.fgProdAdj[_fgpKey];
    var rtfAdjSupply = origSupply;
    if (matAdjBomMap) {
      var maxProd = matAdjBomMap.get(item.itemCode + "|" + item.plantCode + "|" + month);
      if (maxProd !== undefined) rtfAdjSupply = Math.min(origSupply, maxProd);
    }
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
      month, origSupply, rtfAdjSupply, adjSupply, salesQty,
      endingQty, endingAmount, shortageQty, inventoryDays,
      isDanger:      shortageQty > 0,
      isRtfAdjusted: Math.abs(rtfAdjSupply - origSupply) > 0.01,
      isInvAdjusted: adjKey in state.invSupplyAdj,
      isAdjusted:    Math.abs(adjSupply - origSupply) > 0.01,
    };
  });
}

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
    var origSupply   = planMap.get(month) || 0;
    // 완제품 생산계획 조정(fgProdAdj) — RTF조정후 기준선에 반영 (늘리기만)
    var _fgpKey = item.itemCode + "|" + item.plantCode + "|" + month;
    if (state.fgProdAdj && (_fgpKey in state.fgProdAdj)) origSupply = state.fgProdAdj[_fgpKey];
    var rtfAdjSupply = origSupply;
    if (matAdjBomMap) {
      var maxProd = matAdjBomMap.get(item.itemCode + "|" + item.plantCode + "|" + month);
      if (maxProd !== undefined) rtfAdjSupply = Math.min(origSupply, maxProd);
    }
    var adjKey      = item.itemCode + "|" + item.plantCode + "|" + month;
    var finalSupply = (adjKey in state.excessAdj) ? state.excessAdj[adjKey] : rtfAdjSupply;
    var salesQty      = (item.monthlyStatus[mi] && item.monthlyStatus[mi].salesQty) ? item.monthlyStatus[mi].salesQty : 0;
    var available     = opening + finalSupply;
    var endingQty     = Math.max(0, available - salesQty);
    var shortageQty   = Math.max(0, salesQty - available);
    var endingAmount  = (item.hasCost && item.standardCost) ? endingQty * item.standardCost : null;
    var inventoryDays = salesQty > 0 ? endingQty / (salesQty / monthDays(month)) : null;
    opening = endingQty;
    return {
      month, origSupply, rtfAdjSupply, finalSupply, salesQty,
      endingQty, endingAmount, shortageQty, inventoryDays,
      isDanger:         shortageQty > 0,
      isRtfAdjusted:    Math.abs(rtfAdjSupply - origSupply) > 0.01,
      isExcessAdjusted: adjKey in state.excessAdj,
    };
  });
}

function getBaseMonthDays(item) {
  var ms = item.monthlyStatus && item.monthlyStatus[0];
  if (!ms) return null;
  return Number.isFinite(ms.inventoryDays) ? ms.inventoryDays : null;
}

function invDaysCls(days, targetDays) {
  if (targetDays === null || targetDays === undefined) return "inv-days-unset";
  if (!Number.isFinite(days)) return "";
  var ratio = days / targetDays;
  if (ratio > 1.3) return "inv-days-excess";
  if (ratio > 1.0) return "inv-days-warn";
  return "inv-days-ok";
}

// ── 계층 구조 빌드 ────────────────────────────────────────────────────────────

function buildInvHierarchy(items, mode) {
  var nodes = [];
  var sortKoFn = function(a, b) { return String(a).localeCompare(String(b), "ko-KR"); };
  function uniqSorted(arr, key) {
    return [...new Set(arr.map(function(i) { return i[key]; }))].filter(Boolean).sort(sortKoFn);
  }
  // colVals: [col0값, col1값, col2값] — 병합 알고리즘용 덧붙이는 조상 레이블
  function mk(id, level, kind, label, nodeItems, colVals) {
    return { id: id, level: level, kind: kind, label: label, items: nodeItems, colVals: colVals || [] };
  }

  nodes.push(mk("inv_total", -1, "total", "전체 합계", items, []));

  if (mode === "business") {
    uniqSorted(items, "businessUnit").forEach(function(bu) {
      var buItems = items.filter(function(i) { return i.businessUnit === bu; });
      nodes.push(mk("b|" + bu, 0, "group", bu, buItems, [bu, "", ""]));
      uniqSorted(buItems, "typeGroup").forEach(function(type) {
        var typeItems = buItems.filter(function(i) { return i.typeGroup === type; });
        nodes.push(mk("b|" + bu + "|t|" + type, 1, "group", type, typeItems, [bu, type, ""]));
        uniqSorted(typeItems, "itemGroup").forEach(function(group) {
          var groupItems = typeItems.filter(function(i) { return i.itemGroup === group; });
          nodes.push(mk("b|" + bu + "|t|" + type + "|g|" + group, 2, "itemGroup", group, groupItems, [bu, type, group]));
        });
      });
    });
  } else if (mode === "plant") {
    uniqSorted(items, "plant").forEach(function(plant) {
      var plantItems = items.filter(function(i) { return i.plant === plant; });
      nodes.push(mk("p|" + plant, 0, "group", plant, plantItems, [plant, "", ""]));
      uniqSorted(plantItems, "typeGroup").forEach(function(type) {
        var typeItems = plantItems.filter(function(i) { return i.typeGroup === type; });
        nodes.push(mk("p|" + plant + "|t|" + type, 1, "group", type, typeItems, [plant, type, ""]));
        uniqSorted(typeItems, "itemGroup").forEach(function(group) {
          var groupItems = typeItems.filter(function(i) { return i.itemGroup === group; });
          nodes.push(mk("p|" + plant + "|t|" + type + "|g|" + group, 2, "itemGroup", group, groupItems, [plant, type, group]));
        });
      });
    });
  } else {
    uniqSorted(items, "typeGroup").forEach(function(type) {
      var typeItems = items.filter(function(i) { return i.typeGroup === type; });
      nodes.push(mk("t|" + type, 0, "group", type, typeItems, [type, "", ""]));
      uniqSorted(typeItems, "businessUnit").forEach(function(bu) {
        var buItems = typeItems.filter(function(i) { return i.businessUnit === bu; });
        nodes.push(mk("t|" + type + "|b|" + bu, 1, "group", bu, buItems, [type, bu, ""]));
        uniqSorted(buItems, "plant").forEach(function(plant) {
          var plantItems = buItems.filter(function(i) { return i.plant === plant; });
          nodes.push(mk("t|" + type + "|b|" + bu + "|p|" + plant, 2, "itemGroup", plant, plantItems, [type, bu, plant]));
        });
      });
    });
  }
  return nodes;
}

// ── 셀 병합 맵 계산 ──────────────────────────────────────────────────────────

function buildInvRowspanMap(nodes) {
  var spans = new Map();
  var skip  = new Set();
  var vis   = nodes.filter(function(n) { return n.kind !== "total" && n.kind !== "item"; });

  for (var ci = 0; ci < 3; ci++) {
    var i = 0;
    while (i < vis.length) {
      var val = (vis[i].colVals || [])[ci] || "";
      if (!val) { i++; continue; }
      var span = 1;
      while (i + span < vis.length && ((vis[i + span].colVals || [])[ci] || "") === val) span++;
      if (span > 1) {
        spans.set(vis[i].id + "|" + ci, span);
        for (var off = 1; off < span; off++) skip.add(vis[i + off].id + "|" + ci);
      }
      i += span;
    }
  }
  return { spans: spans, skip: skip };
}

// ── 노드 집계 ─────────────────────────────────────────────────────────────────

function invNodeAgg(nodeItems, mi, adjCache) {
  var month = getRtfMonths()[mi];
  var totalEndQty = 0, totalEndAmt = 0, totalSalesQty = 0, hasAmt = false;
  nodeItems.forEach(function(item) {
    var key  = item.itemCode + "|" + item.plantCode;
    var data = adjCache ? (adjCache.get(key) || [])[mi] : null;
    var ms   = item.monthlyStatus ? item.monthlyStatus[mi] : null;
    var endQty = data ? data.endingQty   : (ms ? ms.endingQty   : null);
    var endAmt = data ? data.endingAmount : (ms ? ms.endingAmount : null);
    if (Number.isFinite(endQty)) totalEndQty += endQty;
    if (Number.isFinite(endAmt)) { totalEndAmt += endAmt; hasAmt = true; }
    if (ms && Number.isFinite(ms.salesQty)) totalSalesQty += ms.salesQty;
  });
  var inventoryDays = totalSalesQty > 0 ? totalEndQty / (totalSalesQty / monthDays(month)) : null;
  return {
    inventoryDays: Number.isFinite(inventoryDays) ? inventoryDays : null,
    endingAmount:  hasAmt ? totalEndAmt : null,
  };
}

// ── 좌측 컬럼 정의 ───────────────────────────────────────────────────────────

function getInvLeftColDefs(mode) {
  var defs;
  if (mode === "plant") {
    defs = [
      { key: "col0", label: "플랜트", width: 120, align: "left" },
      { key: "col1", label: "유형",   width: 100, align: "left" },
      { key: "col2", label: "품목군", width: 160, align: "left" },
    ];
  } else if (mode === "type") {
    defs = [
      { key: "col0", label: "유형",   width: 100, align: "left" },
      { key: "col1", label: "사업부", width: 120, align: "left" },
      { key: "col2", label: "플랜트", width: 130, align: "left" },
    ];
  } else { // business
    defs = [
      { key: "col0", label: "사업부", width: 130, align: "left" },
      { key: "col1", label: "유형",   width: 100, align: "left" },
      { key: "col2", label: "품목군", width: 160, align: "left" },
    ];
  }
  defs[defs.length - 1].isLast = true;
  var left = 0;
  return defs.map(function(d) { var r = Object.assign({}, d, { left: left }); left += d.width; return r; });
}

// ── 드릴다운 행 (공급계획 조정 input) ─────────────────────────────────────────

function makeDrillRow(item, adjMonthly, totalCols, matAdjBomMapArg) {
  var months = getRtfMonths();
  var adj    = adjMonthly || computeAdjMonthly(item, matAdjBomMapArg || null);
  var showRtfCol = adj.some(function(d) { return d.isRtfAdjusted; });

  var drillBody = months.map(function(month, mi) {
    var d        = adj[mi];
    var adjKey   = item.itemCode + "|" + item.plantCode + "|" + month;
    var daysDisp = Number.isFinite(d.inventoryDays) ? Math.round(d.inventoryDays) + "일" : "-";
    var amtDisp  = Number.isFinite(d.endingAmount)  ? formatMoney(d.endingAmount)        : "-";
    var dangerCls = d.isDanger ? " inv-danger-cell" : "";
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

// ── 행 렌더 ──────────────────────────────────────────────────────────────────

function renderInvRow(node, leftColDefs, adjCache, allMonths, rtfMonths, actualSet, rowspanMap) {
  if (node.kind === "item") return "";
  var isTotal = node.kind === "total";

  var metricCells = allMonths.map(function(month) {
    var isActual    = actualSet.has(month);
    var isFirstFcst = month === rtfMonths[0];
    var sepCls      = isFirstFcst ? " inv-fcst-sep" : "";

    function daysCls(d) {
      if (!Number.isFinite(d)) return " inv-days-unset";
      return d > 120 ? " inv-days-excess" : d >= 90 ? " inv-days-warn" : " inv-days-ok";
    }

    if (isActual) {
      if (isTotal) {
        var rows = (state.mappedData.actuals_monthly || []).filter(function(r) {
          return r.month === month && r.plant === "전체";
        });
        var invAmt  = rows.reduce(function(s, r) { return s + (r.invAmt  || 0); }, 0);
        var invDays = rows.length ? rows.reduce(function(s, r) { return s + (r.invDays || 0); }, 0) / rows.length : null;
        var daysDisp = (rows.length && Number.isFinite(invDays)) ? Math.round(invDays) + "일" : "-";
        var amtDisp  = (rows.length && invAmt > 0) ? formatMoney(invAmt) : "-";
        return "<td class=\"inv-mc inv-mc-days inv-act-cell" + sepCls + daysCls(invDays) + "\">" + escapeHtml(daysDisp) + "</td>" +
               "<td class=\"inv-mc inv-mc-amt inv-act-cell\">" + escapeHtml(amtDisp) + "</td>";
      }
      return "<td class=\"inv-mc inv-act-cell inv-act-empty" + sepCls + "\">-</td>" +
             "<td class=\"inv-mc inv-act-cell inv-act-empty\">-</td>";
    }

    var rtfMi    = rtfMonths.indexOf(month);
    var agg      = invNodeAgg(node.items, rtfMi, adjCache);
    var days     = agg.inventoryDays;
    var amt      = agg.endingAmount;
    var daysDisp = Number.isFinite(days) ? Math.round(days) + "일" : "-";
    var amtDisp  = Number.isFinite(amt)  ? formatMoney(amt)        : "-";
    return "<td class=\"inv-mc inv-mc-days" + sepCls + daysCls(days) + "\">" + escapeHtml(daysDisp) + "</td>" +
           "<td class=\"inv-mc inv-mc-amt\">" + escapeHtml(amtDisp) + "</td>";
  }).join("");

  var leftCells;
  if (isTotal) {
    var totalW = leftColDefs.reduce(function(s, c) { return s + c.width; }, 0);
    leftCells = "<td class=\"inv-sticky inv-lc-total\" colspan=\"" + leftColDefs.length + "\" style=\"left:0;width:" + totalW + "px;\">전체 합계</td>";
  } else {
    leftCells = leftColDefs.map(function(col, ci) {
      var cellKey = node.id + "|" + ci;
      if (rowspanMap && rowspanMap.skip.has(cellKey)) return "";
      var value     = (node.colVals && node.colVals[ci]) || "";
      var shadowCls = col.isLast ? " inv-col-last-sticky" : "";
      var rsAttr    = (rowspanMap && rowspanMap.spans.has(cellKey))
        ? " rowspan=\"" + rowspanMap.spans.get(cellKey) + "\"" : "";
      return "<td class=\"inv-sticky inv-cell-center" + shadowCls + "\"" + rsAttr + " style=\"left:" + col.left + "px;width:" + col.width + "px;\">" +
        escapeHtml(value) + "</td>";
    }).join("");
  }

  var kindCls = isTotal ? "is-total" : (node.kind === "itemGroup" ? "is-itemgroup" : "is-group");
  return "<tr class=\"inv-h-row level-" + node.level + " " + kindCls + "\">" +
    leftCells + metricCells + "</tr>";
}

// ── 섹션 렌더 ────────────────────────────────────────────────────────────────

function renderInvSection(mode, displayItems, adjCache) {
  var leftColDefs = getInvLeftColDefs(mode);
  var rtfMonths   = getRtfMonths();

  // 과거 실적 월 표시 제거 — 전망(계획) 구간만 (2026-07-09 사용자 지시)
  var actualMonths = [];
  var actualSet = new Set(actualMonths);
  var allMonths = actualMonths.concat(rtfMonths);

  var leftW    = leftColDefs.reduce(function(s, c) { return s + c.width; }, 0);
  var minWidth = leftW + allMonths.length * 140;

  // ── 헤더 ────────────────────────────────────────────────────────────────
  var leftHeaders = leftColDefs.map(function(col) {
    var shadowCls = col.isLast ? " inv-col-last-sticky" : "";
    return "<th class=\"inv-sticky inv-th" + shadowCls + "\" style=\"left:" + col.left + "px;width:" + col.width + "px;\" rowspan=\"3\">" + escapeHtml(col.label) + "</th>";
  }).join("");

  // 슈퍼 헤더 (실적 / 전망 구분)
  var superHeader = "";
  if (actualMonths.length) {
    superHeader += "<th class=\"inv-mh inv-mh-actual\" colspan=\"" + (actualMonths.length * 2) + "\">실적</th>";
  }
  superHeader += "<th class=\"inv-mh inv-fcst-sep\" colspan=\"" + (rtfMonths.length * 2) + "\">전망</th>";

  var monthHeader = allMonths.map(function(m) {
    var sepCls = (m === rtfMonths[0]) ? " inv-fcst-sep" : "";
    return "<th class=\"inv-mh" + sepCls + "\" colspan=\"2\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");

  var subHeader = allMonths.map(function(m) {
    var sepCls = (m === rtfMonths[0]) ? " inv-fcst-sep" : "";
    return "<th class=\"inv-sh" + sepCls + "\">재고일수</th>" +
           "<th class=\"inv-sh inv-sh-amt\">재고금액</th>";
  }).join("");

  // ── 바디 ─────────────────────────────────────────────────────────────────
  var nodes       = buildInvHierarchy(displayItems, mode);
  var rowspanMap  = buildInvRowspanMap(nodes);
  var bodyHtml    = nodes.map(function(node) {
    return renderInvRow(node, leftColDefs, adjCache, allMonths, rtfMonths, actualSet, rowspanMap);
  }).join("");

  if (!bodyHtml.trim()) {
    var totalCols = leftColDefs.length + allMonths.length * 2;
    bodyHtml = "<tr><td colspan=\"" + totalCols + "\" style=\"text-align:center;padding:20px;color:#9ca3af;\">표시할 품목이 없습니다.</td></tr>";
  }

  var modeLabel = mode === "plant" ? "플랜트별" : mode === "type" ? "유형별" : "사업부별";
  return "<div class=\"inv-section-hd\"><span>월별 재고현황 · " + modeLabel + "</span><span class=\"inv-section-unit\">단위: 억원, 일 &nbsp;|&nbsp; 재고일수 기준: 120일↑ 과잉, 90일↑ 주의</span></div>" +
  "<div class=\"inv-table-wrap\"><table class=\"inv-h-table\" style=\"min-width:" + minWidth + "px;\">" +
    "<thead>" +
      "<tr>" + leftHeaders + superHeader + "</tr>" +
      "<tr>" + monthHeader + "</tr>" +
      "<tr>" + subHeader + "</tr>" +
    "</thead>" +
    "<tbody>" + bodyHtml + "</tbody>" +
    "</table></div>";
}

// ── 메인 렌더 ─────────────────────────────────────────────────────────────────

function renderInventoryForecast() {
  if (!state.mappedData.plan_monthly.length) {
    return "<section class=\"section-band\"><div class=\"section-header\"><h2>재고전망</h2>" +
      "<p>데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 선택해 주세요.</p></div></section>";
  }

  var months   = getRtfMonths();
  var rtfItems = computeRtfItems();

  var targetMap = new Map();
  (state.mappedData.target_inv || []).forEach(function(r) {
    if (r.itemCode) targetMap.set(r.itemCode, r.targetDays);
  });

  var hasMatAdj    = Object.keys(state.matSimAdj  || {}).length > 0 ||
                     (typeof hasFgProdAdj === "function" && hasFgProdAdj());
  var hasExcessAdj = Object.keys(state.excessAdj  || {}).length > 0;
  if (state.invViewMode === "rtf"      && !hasMatAdj)    state.invViewMode = "current";
  if (state.invViewMode === "excess"   && !hasExcessAdj) state.invViewMode = "current";
  if (state.invViewMode === "adjusted") state.invViewMode = hasMatAdj ? "rtf" : "current";
  var activeMode = state.invViewMode;

  var matAdjBomMap = hasMatAdj ? buildBomMaxProducibleMap(state.matSimAdj, state.fgProdAdj) : null;

  // ── 3패널 요약 — 공급원인·과잉감축 KPI 배너와 동일 기준(전체재고: 결산 앵커+델타) ──
  // 기존 품목별 computeAdjMonthly/computeExcessMonthly 전량 재계산 제거(성능) —
  // computeScenarioItemSets는 렌더당 1회 메모이즈, rtfHeadlineInv는 배너와 같은 함수라 수치 일치
  var sc        = computeScenarioItemSets();
  var matDeltas = (typeof computeMatScenarioDeltas === "function") ? computeMatScenarioDeltas(months) : null;
  function headlineAmt(items, mi, addMatDelta) {
    var v = rtfHeadlineInv(items, mi).amount;
    if (addMatDelta && matDeltas && Number.isFinite(v)) v += (matDeltas[mi] || 0);
    return v;
  }
  var totalBaseAmt   = headlineAmt(sc.base, 0, false);
  var totalRtfAmt    = sc.hasRtfAdj ? headlineAmt(sc.rtfAdj, 0, false) : null;
  var totalExcessAmt = (sc.hasExcess || (matDeltas && matDeltas[0])) ? headlineAmt(sc.final, 0, true) : null;
  var baseHasAmt   = Number.isFinite(totalBaseAmt);
  var rtfHasAmt    = Number.isFinite(totalRtfAmt);
  var excessHasAmt = Number.isFinite(totalExcessAmt);

  // 과잉 품목 수·적정재고 총액 (가벼운 집계 — 조정 시나리오 재계산 없음)
  var totalTargetAmt = 0, excessCount = 0;
  rtfItems.forEach(function(item) {
    var ms0 = item.monthlyStatus && item.monthlyStatus[0];
    if (!ms0) return;
    var targetDays = targetMap.get(item.itemCode);
    if (targetDays && item.hasCost && ms0.salesQty > 0)
      totalTargetAmt += (ms0.salesQty / monthDays(months[0])) * targetDays * item.standardCost;
    var curDays = ms0.inventoryDays;
    if (targetDays && Number.isFinite(curDays) && curDays > targetDays) excessCount++;
  });

  function fmtAmt(amt, has) { return has ? escapeHtml(formatMoney(amt)) : "-"; }
  var rtfDelta    = (hasMatAdj && rtfHasAmt && baseHasAmt) ? totalRtfAmt - totalBaseAmt : null;
  var excessDelta = (excessHasAmt && baseHasAmt)
    ? totalExcessAmt - (rtfHasAmt ? totalRtfAmt : totalBaseAmt) : null;
  var m0Label     = escapeHtml(monthLabel(months[0])) + "말";

  function kpiItem(label, valStr, sub, deltaVal, isActive, isDisabled) {
    var activeCls   = isActive   ? " inv-kpi-active"   : "";
    var disabledCls = isDisabled ? " inv-kpi-disabled"  : "";
    var deltaHtml   = "";
    if (deltaVal !== null) {
      var neg = deltaVal < 0;
      deltaHtml = " <span class=\"inv-kpi-delta " + (neg ? "inv-kd-neg" : "inv-kd-pos") + "\">" +
        escapeHtml((neg ? "▽" : "△+") + formatMoney(Math.abs(deltaVal))) + "</span>";
    }
    return "<div class=\"inv-kpi-item" + activeCls + disabledCls + "\">" +
      "<div class=\"inv-kpi-lbl\">" + label + "</div>" +
      "<div class=\"inv-kpi-val\">" + valStr + deltaHtml + "</div>" +
      "<div class=\"inv-kpi-sub\">" + sub + "</div>" +
    "</div>";
  }

  var kpiBase   = kpiItem("원계획",    fmtAmt(totalBaseAmt, baseHasAmt),
    m0Label + " · 과잉 " + excessCount + "개 · 적정 " + (totalTargetAmt > 0 ? escapeHtml(formatMoney(totalTargetAmt)) : "미설정"),
    null, activeMode === "current", false);
  var kpiRtf    = kpiItem("RTF 조정후", hasMatAdj ? fmtAmt(totalRtfAmt, rtfHasAmt) : "-",
    hasMatAdj ? m0Label : "공급원인에서 조정 후 반영",
    rtfDelta, activeMode === "rtf", !hasMatAdj);
  var kpiExcess = kpiItem("감축 후",   hasExcessAdj ? fmtAmt(totalExcessAmt, excessHasAmt) : "-",
    hasExcessAdj ? m0Label : "과잉감축 탭에서 입력",
    excessDelta, activeMode === "excess", !hasExcessAdj);

  // ── adjCache ──────────────────────────────────────────────────────────────
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

  // ── 필터 ─────────────────────────────────────────────────────────────────
  var displayItems = rtfItems.filter(function(item) {
    if (state.invFilter !== "excess") return true;
    var td = targetMap.get(item.itemCode);
    if (!td) return false;
    var d = getBaseMonthDays(item);
    return Number.isFinite(d) && d > td;
  });

  // ── 컨트롤 ───────────────────────────────────────────────────────────────
  var viewBtns = [
    { m: "current", label: "원계획",    disabled: false },
    { m: "rtf",     label: "RTF 조정후",disabled: !hasMatAdj },
    { m: "excess",  label: "감축 후",   disabled: !hasExcessAdj },
  ].map(function(v) {
    return "<button type=\"button\" class=\"inv-view-btn" + (activeMode === v.m ? " active" : "") + (v.disabled ? " disabled" : "") + "\"" +
      (v.disabled ? " disabled" : "") + " data-inv-view=\"" + v.m + "\">" + v.label + "</button>";
  }).join("");

  var sectionBtns = INV_SECTION_OPTIONS.map(function(opt) {
    return "<button type=\"button\" class=\"inv-section-btn" + (state.invSectionMode === opt.mode ? " active" : "") + "\" data-inv-section=\"" + opt.mode + "\">" + opt.label + "</button>";
  }).join("");

  var controlsHtml =
    "<div class=\"inv-toolbar\">" +
      "<div class=\"inv-view-toggle\">" + viewBtns + "</div>" +
      "<div class=\"inv-section-tabs\">" + sectionBtns + "</div>" +
      "<div class=\"inv-toolbar-right\">" +
        "<button type=\"button\" class=\"inv-filter-btn" + (state.invFilter !== "excess" ? " active" : "") + "\" data-inv-filter=\"all\">전체</button>" +
        "<button type=\"button\" class=\"inv-filter-btn" + (state.invFilter === "excess" ? " active" : "") + "\" data-inv-filter=\"excess\">과잉만</button>" +
      "</div>" +
    "</div>";

  var sectionHtml = renderInvSection(state.invSectionMode, displayItems, adjCache);

  var comboHtml =
    "<div class=\"inv-combo-card\">" +
      "<div class=\"inv-kpi-strip\">" +
        kpiBase +
        "<div class=\"inv-kpi-arr\">→</div>" +
        kpiRtf +
        "<div class=\"inv-kpi-arr\">→</div>" +
        kpiExcess +
      "</div>" +
    "</div>" +
    "<div class=\"inv-chart-section\"><canvas id=\"invForecastChart\"></canvas></div>" +
    "<div class=\"inv-basis-note\">※ 상단 KPI·차트 = 전체재고(결산 기준 — RTF판정·공급원인·과잉감축 화면과 동일 수치) · 아래 표 = 제·상품 품목별 상세(원가 기준)</div>";

  return "<div class=\"inv-screen\"><div class=\"inv-inner\">" +
    comboHtml + renderInvClosing() + controlsHtml + sectionHtml +
    "</div></div>";
}

// ── 오늘의 결정 요약 (클로징) — 판정·조정 기록의 자동 집계, 읽기 전용 ─────────
function renderInvClosing() {
  var decisions = state.aiDecisions || {};
  var decKeys   = Object.keys(decisions);
  var hasRtfAdj = Object.keys(state.matSimAdj || {}).length > 0 ||
                  (typeof hasFgProdAdj === "function" && hasFgProdAdj());
  if (!decKeys.length && !hasRtfAdj) {
    return "<section class=\"inv-closing inv-closing-empty\">" +
      "<span class=\"inv-closing-title\">오늘의 결정 요약</span>" +
      "<span class=\"inv-closing-hint\">공급원인·과잉감축에서 조정/판정이 기록되면 여기에 자동 집계됩니다.</span>" +
      "</section>";
  }

  // ── 판정 집계 + 부서(액션)별 확정 — classifyAiExcess 품목과 매칭 ──
  var cls = null;
  try { cls = (decKeys.length && typeof classifyAiExcess === "function") ? classifyAiExcess() : null; } catch (e) {}
  var itemByKey = new Map();
  if (cls) {
    ["supply", "planfix"].forEach(function(secId) {
      (((cls.sections || {})[secId] || {}).items || []).forEach(function(it) {
        itemByKey.set(it.itemCode + "|" + (it.plantCode || ""), { it: it, secId: secId });
      });
    });
    ["sellout", "disposal"].forEach(function(secId) {
      (((cls.noPlan || {})[secId]) || []).forEach(function(it) {
        itemByKey.set(it.itemCode + "|" + (it.plantCode || ""), { it: it, secId: secId });
      });
    });
  }
  var stCnt = { accept: 0, adjust: 0, reject: 0, hold: 0 };
  var confirmedAmt = 0; // 확정 감축액 — KPI 반영 섹션(①②)의 수용·조정분만
  var bySec = {};       // secId → { cnt, amt } (수용+조정만)
  decKeys.forEach(function(k) {
    var d = decisions[k];
    if (!d || !stCnt.hasOwnProperty(d.status)) return;
    stCnt[d.status]++;
    if (d.status !== "accept" && d.status !== "adjust") return;
    var hit = itemByKey.get(k);
    var secId = (hit && hit.secId) || d.sec || "";
    var amt = 0;
    if (hit && (secId === "supply" || secId === "planfix")) {
      var it = hit.it;
      amt = d.status === "accept" ? (it.cutAmt || 0)
          : (it.cutQty > 0 ? (it.cutAmt || 0) * Math.min(1, (Number(d.qty) || 0) / it.cutQty) : 0);
      confirmedAmt += amt;
    }
    if (!bySec[secId]) bySec[secId] = { cnt: 0, amt: 0 };
    bySec[secId].cnt++;
    bySec[secId].amt += amt;
  });

  // ── RTF 조정 요약 — 생산계획·자재입고 조정 건수 + 품절 위험 변화 ──
  var fgAdjItems = new Set(), matAdjItems = new Set();
  Object.keys(state.fgProdAdj || {}).forEach(function(k) {
    var p = k.split("|"); fgAdjItems.add(p[0] + "|" + p[1]);
  });
  Object.keys(state.matSimAdj || {}).forEach(function(k) {
    var p = k.split("|"); matAdjItems.add(p[0] + "|" + p[1]);
  });
  var shortTxt = "";
  try {
    var h = (typeof computeHeadlineTriple === "function") ? computeHeadlineTriple() : null;
    if (h && h.base && h.rtf && h.base.shortCnt !== h.rtf.shortCnt)
      shortTxt = " · 품절위험 <b>" + h.base.shortCnt + "</b>→<b class=\"inv-cl-good\">" + h.rtf.shortCnt + "</b>품목";
    else if (h && h.base) shortTxt = " · 품절위험 <b>" + h.base.shortCnt + "</b>품목";
  } catch (e) {}

  var SEC_OWNERS = [
    { id: "supply",   label: "공장·구매 (입고·생산축소)" },
    { id: "planfix",  label: "마케팅·영업 (판매계획 현실화)" },
    { id: "sellout",  label: "마케팅 (재고 소진)" },
    { id: "disposal", label: "사업부 (재고 처분)" },
  ];
  var ownerChips = SEC_OWNERS.map(function(s) {
    var v = bySec[s.id];
    if (!v || !v.cnt) return "";
    return "<span class=\"inv-cl-chip\">" + escapeHtml(s.label) + " <b>" + v.cnt + "건</b>" +
      (v.amt > 0 ? " <b class=\"inv-cl-good\">-" + escapeHtml(formatMoney(v.amt)) + "</b>" : "") + "</span>";
  }).join("");

  var decLine = decKeys.length
    ? "<div class=\"inv-cl-row\"><span class=\"inv-cl-lbl\">판정</span>" +
      "✅ 수용 <b>" + stCnt.accept + "</b> · 🔶 조정 <b>" + stCnt.adjust + "</b> · ❌ 불가 <b>" + stCnt.reject + "</b> · ⏸ 보류 <b>" + stCnt.hold + "</b>" +
      (confirmedAmt > 0 ? " &nbsp;→&nbsp; 확정 감축 <b class=\"inv-cl-good\">-" + escapeHtml(formatMoney(confirmedAmt)) + "</b>" : "") +
      "</div>"
    : "";
  var rtfLine = hasRtfAdj
    ? "<div class=\"inv-cl-row\"><span class=\"inv-cl-lbl\">RTF 조정</span>" +
      "생산계획 조정 <b>" + fgAdjItems.size + "</b>품목 · 자재입고 조정 <b>" + matAdjItems.size + "</b>자재" + shortTxt +
      "</div>"
    : "";
  var ownerLine = ownerChips
    ? "<div class=\"inv-cl-row\"><span class=\"inv-cl-lbl\">부서별 약속</span>" + ownerChips + "</div>"
    : "";

  return "<section class=\"inv-closing\">" +
    "<span class=\"inv-closing-title\">오늘의 결정 요약</span>" +
    "<div class=\"inv-cl-body\">" + decLine + rtfLine + ownerLine + "</div>" +
    "</section>";
}

// ── 이벤트 바인딩 ──────────────────────────────────────────────────────────────

function bindInventoryForecast() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;

  root.querySelectorAll("[data-inv-view]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (btn.disabled || state.invViewMode === btn.dataset.invView) return;
      state.invViewMode = btn.dataset.invView;
      render("inventory-forecast");
    });
  });

  root.querySelectorAll("[data-inv-section]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (state.invSectionMode === btn.dataset.invSection) return;
      state.invSectionMode = btn.dataset.invSection;
      render("inventory-forecast");
    });
  });

  root.querySelectorAll("[data-inv-filter]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (state.invFilter === btn.dataset.invFilter) return;
      state.invFilter = btn.dataset.invFilter;
      render("inventory-forecast");
    });
  });

  bindInvChart();
}

// ── 재고전망 차트 ──────────────────────────────────────────────────────────────

function bindInvChart() {
  if (!window.Chart) return;
  var canvas = document.querySelector("#invForecastChart");
  if (!canvas) return;
  if (_invChartInst) { _invChartInst.destroy(); _invChartInst = null; }

  // 전망(계획) 구간만 표시 — 과거 실적 제거 (2026-07-09 사용자 지시)
  var rtfMonths    = getRtfMonths();
  var allMonths    = rtfMonths.slice();
  // 시리즈 = 공급원인·과잉감축 KPI 배너와 동일 기준(rtfHeadlineInv: 전체재고 = 결산 앵커+델타)
  // 기존 품목별 computeAdjMonthly/computeExcessMonthly 월×품목 전량 재계산 제거 — 성능 개선 핵심
  var sc        = computeScenarioItemSets();
  var matDeltas = (typeof computeMatScenarioDeltas === "function") ? computeMatScenarioDeltas(rtfMonths) : null;
  var hasRtfAdj    = sc.hasRtfAdj;
  var hasExcessAdj = sc.hasExcess || !!(matDeltas && matDeltas.some(function(v) { return v; }));

  function seriesOf(items, addMatDelta) {
    return rtfMonths.map(function(m, mi) {
      var v = rtfHeadlineInv(items, mi).amount;
      if (addMatDelta && matDeltas && Number.isFinite(v)) v += (matDeltas[mi] || 0);
      return Number.isFinite(v) ? Math.round(v / 1e8) : null;
    });
  }
  var baseData   = seriesOf(sc.base, false);
  var rtfData    = hasRtfAdj    ? seriesOf(sc.rtfAdj, false) : null;
  var excessData = hasExcessAdj ? seriesOf(sc.final, true)   : null;
  var hasAdjLine = !!(rtfData || excessData);

  // 전망 시작 수직선 — 실적 구간이 없으므로 표시 안 함
  var todayAnnotation = -1;

  var datasets = [];
  datasets.push({
    label: "원계획",
    data: baseData,
    borderColor: hasAdjLine ? "#94a3b8" : "#475569",
    backgroundColor: "rgba(100,116,139,0.08)",
    fill: !hasAdjLine,
    borderWidth: hasAdjLine ? 2 : 3.5,
    borderDash: hasAdjLine ? [6, 4] : [],
    pointRadius: hasAdjLine ? 3 : 5,
    pointHoverRadius: 7,
    tension: 0.3,
    spanGaps: true,
  });
  if (rtfData) {
    datasets.push({
      label: "RTF 조정후",
      data: rtfData,
      borderColor: "#28278f",
      backgroundColor: "rgba(40,39,143,0.07)",
      fill: !excessData,
      borderWidth: 3,
      pointRadius: 5,
      pointHoverRadius: 7,
      tension: 0.3,
      spanGaps: true,
    });
  }
  if (excessData) {
    datasets.push({
      label: "감축후",
      data: excessData,
      borderColor: "#15803d",
      backgroundColor: "rgba(21,128,61,0.10)",
      fill: true,
      borderWidth: 3.5,
      pointRadius: 5,
      pointHoverRadius: 7,
      tension: 0.3,
      spanGaps: true,
    });
  }

  // ── 주 시나리오(가장 최종 조정) — 억 라벨·재고일수 배지 기준 (배너와 동일 일수) ──
  var primaryDsIdx = datasets.length - 1;
  var primaryColor = datasets[primaryDsIdx].borderColor;
  var primaryItems = hasExcessAdj ? sc.final : (hasRtfAdj ? sc.rtfAdj : sc.base);
  var primaryDays  = rtfMonths.map(function(m, mi) {
    var d = rtfHeadlineInv(primaryItems, mi).days;
    return Number.isFinite(d) ? Math.round(d) : null;
  });

  // ── 캔버스 플러그인: 억 레이블 + 재고일수 배지 ───────────────────────────
  var INV_FONT = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

  function drawRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
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

  var labelsPlugin = {
    id: "invLabels",
    afterDraw: function(chart) {
      var ctx = chart.ctx;
      var meta = chart.getDatasetMeta(primaryDsIdx);
      if (!meta || meta.hidden) return;
      ctx.save();

      allMonths.forEach(function(month, i) {
        var isFcst = rtfMonths.includes(month);
        var el = meta.data[i];
        if (!el) return;

        var val = datasets[primaryDsIdx].data[i];
        if (val === null || val === undefined) return;

        // 억 레이블 (선 위)
        ctx.font         = "bold 15px " + INV_FONT;
        ctx.fillStyle    = isFcst ? primaryColor : "#1e3a8a";
        ctx.textAlign    = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(val + "억", el.x, el.y - 6);

        // 재고일수 배지 (선 아래) — 전망 구간만
        if (!isFcst) return;
        var dv = primaryDays[i];
        if (dv === null || dv === undefined) return;
        var text = dv + "일";
        ctx.font = "bold 14px " + INV_FONT;
        var tw = ctx.measureText(text).width + 16;
        var th = 24;
        var tx = el.x - tw / 2;
        var ty = el.y + 8;
        if (ty + th > chart.chartArea.bottom - 2) return;

        ctx.fillStyle = hasExcessAdj
          ? "rgba(21,128,61,0.10)" : hasRtfAdj
          ? "rgba(40,39,143,0.10)" : "rgba(15,118,110,0.10)";
        drawRoundRect(ctx, tx, ty, tw, th, 5);
        ctx.fill();

        ctx.strokeStyle = hasExcessAdj
          ? "rgba(21,128,61,0.35)" : hasRtfAdj
          ? "rgba(40,39,143,0.35)" : "rgba(15,118,110,0.35)";
        ctx.lineWidth = 1;
        drawRoundRect(ctx, tx, ty, tw, th, 5);
        ctx.stroke();

        ctx.fillStyle    = hasExcessAdj ? "#15803d" : hasRtfAdj ? "#28278f" : "#0f766e";
        ctx.textBaseline = "middle";
        ctx.fillText(text, el.x, ty + th / 2);
      });

      ctx.restore();
    }
  };

  // ── 전망시작 수직선 플러그인 ───────────────────────────────────────────────
  var fcstLinePlugin = {
    id: "fcstLine",
    afterDraw: function(chart) {
      if (todayAnnotation < 0) return;
      var meta = chart.getDatasetMeta(0);
      var el = meta && meta.data[todayAnnotation];
      if (!el) return;
      var ctx = chart.ctx;
      var ca  = chart.chartArea;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "rgba(100,116,139,0.5)";
      ctx.lineWidth   = 1.5;
      ctx.moveTo(el.x, ca.top);
      ctx.lineTo(el.x, ca.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font      = "bold 11px Pretendard";
      ctx.fillStyle = "#94a3b8";
      ctx.textAlign = "center";
      ctx.fillText("▶ 전망", el.x, ca.top - 4);
      ctx.restore();
    }
  };

  _invChartInst = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: allMonths.map(monthLabel), datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 28, bottom: 6, left: 8, right: 16 } },
      plugins: {
        legend: {
          position: "top",
          align: "end",
          labels: {
            font: { size: 15, family: "Pretendard", weight: "700" },
            padding: 20,
            usePointStyle: true,
            pointStyleWidth: 18,
          },
        },
        tooltip: {
          backgroundColor: "rgba(15,23,42,0.85)",
          titleFont: { size: 13, family: "Pretendard" },
          bodyFont:  { size: 13, family: "Pretendard" },
          padding: 10,
          callbacks: {
            label: function(ctx) {
              var v = ctx.parsed.y;
              return "  " + ctx.dataset.label + ": " + (v !== null ? v + "억" : "-");
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: "rgba(0,0,0,0.06)", drawBorder: false },
          ticks: { font: { size: 14.5, family: "Pretendard", weight: "700" }, color: "#374151" },
          border: { display: false },
        },
        y: {
          grid: { color: "rgba(0,0,0,0.06)", drawBorder: false },
          ticks: {
            font: { size: 13, family: "Pretendard" },
            color: "#6b7280",
            callback: function(v) { return v + "억"; },
            maxTicksLimit: 6,
          },
          border: { display: false },
          beginAtZero: false,
        }
      }
    },
    plugins: [labelsPlugin, fcstLinePlugin],
  });
}
