// ── 재고전망 화면 ─────────────────────────────────────────────────────────────

// 월별 공급계획 조정 시뮬레이션 (단일 item, 전체 월 롤링 계산)
function computeAdjMonthly(item) {
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
    var adjKey     = item.itemCode + "|" + item.plantCode + "|" + month;
    var adjSupply  = (adjKey in state.invSupplyAdj) ? state.invSupplyAdj[adjKey] : origSupply;
    var salesQty   = (item.monthlyStatus[mi] && item.monthlyStatus[mi].salesQty) ? item.monthlyStatus[mi].salesQty : 0;

    var available   = opening + adjSupply;
    var endingQty   = Math.max(0, available - salesQty);
    var shortageQty = Math.max(0, salesQty - available);
    var endingAmount  = (item.hasCost && item.standardCost) ? endingQty * item.standardCost : null;
    var inventoryDays = salesQty > 0 ? endingQty / (salesQty / monthDays(month)) : null;

    opening = endingQty;
    return {
      month:        month,
      origSupply:   origSupply,
      adjSupply:    adjSupply,
      salesQty:     salesQty,
      endingQty:    endingQty,
      endingAmount: endingAmount,
      shortageQty:  shortageQty,
      inventoryDays: inventoryDays,
      isDanger:     shortageQty > 0,
      isAdjusted:   Math.abs(adjSupply - origSupply) > 0.01,
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

  // 현재/조정후 monthly 데이터
  var hasAdj    = Object.keys(state.invSupplyAdj || {}).length > 0;
  var isAdj     = state.invViewMode === "adjusted" && hasAdj;
  if (!hasAdj && state.invViewMode === "adjusted") state.invViewMode = "current";

  // 요약 계산
  var totalCurrentAmt = 0, totalTargetAmt = 0, excessAmt = 0, excessCount = 0;
  rtfItems.forEach(function(item) {
    var ms0 = item.monthlyStatus && item.monthlyStatus[0];
    if (!ms0) return;
    var curEnd = isAdj ? computeAdjMonthly(item)[0].endingAmount : ms0.endingAmount;
    if (Number.isFinite(curEnd)) totalCurrentAmt += curEnd;

    var targetDays = targetMap.get(item.itemCode);
    if (targetDays && item.hasCost && ms0.salesQty > 0) {
      var tgtEnd   = (ms0.salesQty / monthDays(months[0])) * targetDays * item.standardCost;
      totalTargetAmt += tgtEnd;
    }

    var curDays = isAdj ? computeAdjMonthly(item)[0].inventoryDays : ms0.inventoryDays;
    if (targetDays && Number.isFinite(curDays) && curDays > targetDays) {
      excessCount++;
      if (Number.isFinite(curEnd) && item.hasCost && ms0.salesQty > 0) {
        var tgtEndAmt = (ms0.salesQty / monthDays(months[0])) * targetDays * item.standardCost;
        excessAmt += Math.max(0, curEnd - tgtEndAmt);
      }
    }
  });

  // 요약 카드
  var summaryHtml =
    "<div class=\"inv-summary-card\">" +
      "<div class=\"inv-summary-item\">" +
        "<div class=\"inv-summary-label\">현재 총재고금액 (" + escapeHtml(monthLabel(months[0])) + "말)</div>" +
        "<div class=\"inv-summary-value\">" + escapeHtml(formatMoney(totalCurrentAmt)) + "</div>" +
      "</div>" +
      "<div class=\"inv-summary-item\">" +
        "<div class=\"inv-summary-label\">적정재고 기준 금액</div>" +
        "<div class=\"inv-summary-value\">" + (totalTargetAmt > 0 ? escapeHtml(formatMoney(totalTargetAmt)) : "<span style=\"color:#9ca3af;font-size:13px;\">적정재고 미설정</span>") + "</div>" +
      "</div>" +
      "<div class=\"inv-summary-item\">" +
        "<div class=\"inv-summary-label\">과잉재고 금액</div>" +
        "<div class=\"inv-summary-value" + (excessAmt > 0 ? " excess" : "") + "\">" + (excessAmt > 0 ? escapeHtml(formatMoney(excessAmt)) : "-") + "</div>" +
      "</div>" +
      "<div class=\"inv-summary-item\">" +
        "<div class=\"inv-summary-label\">과잉 품목 수</div>" +
        "<div class=\"inv-summary-value" + (excessCount > 0 ? " excess" : "") + "\">" + escapeHtml(String(excessCount)) + "개</div>" +
      "</div>" +
    "</div>";

  // 컨트롤
  var adjCount  = Object.keys(state.invSupplyAdj || {}).length;
  var filterAll = state.invFilter !== "excess";
  var controlsHtml =
    "<div class=\"inv-controls\">" +
      "<div class=\"inv-view-toggle\">" +
        "<button type=\"button\" class=\"inv-view-btn" + (state.invViewMode === "current" ? " active" : "") + "\" data-inv-view=\"current\">현재 계획</button>" +
        "<button type=\"button\" class=\"inv-view-btn" + (state.invViewMode === "adjusted" ? " active" : "") + (hasAdj ? "" : " disabled") + "\"" +
          (hasAdj ? "" : " disabled title=\"재고전망 화면에서 공급계획을 조정한 후 사용 가능합니다\"") +
          " data-inv-view=\"adjusted\">조정 후" + (hasAdj ? " ●" + adjCount + "건" : "") + "</button>" +
      "</div>" +
      "<div style=\"display:flex;gap:4px;\">" +
        "<button type=\"button\" class=\"inv-filter-btn" + (filterAll ? " active" : "") + "\" data-inv-filter=\"all\">전체</button>" +
        "<button type=\"button\" class=\"inv-filter-btn" + (!filterAll ? " active" : "") + "\" data-inv-filter=\"excess\">과잉만</button>" +
      "</div>" +
    "</div>";

  // 테이블 헤더
  var monthHeads = months.map(function(m) {
    return "<th colspan=\"2\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHeads = months.map(function() {
    return "<th>재고일수</th><th>재고금액</th>";
  }).join("");

  // 표시할 items 필터링
  var displayItems = rtfItems.filter(function(item) {
    if (state.invFilter === "excess") {
      var targetDays = targetMap.get(item.itemCode);
      if (!targetDays) return false;
      var curDays = getBaseMonthDays(item);
      return Number.isFinite(curDays) && curDays > targetDays;
    }
    return true;
  });

  var rows = displayItems.map(function(item) {
    var adjMonthly  = (isAdj || state.invExpandedRows.has(item.itemCode + "|" + item.plantCode))
                      ? computeAdjMonthly(item) : null;
    var targetDays  = targetMap.get(item.itemCode);
    var isExpanded  = state.invExpandedRows.has(item.itemCode + "|" + item.plantCode);
    var rowKey      = escapeHtml(item.itemCode + "|" + item.plantCode);

    var monthlyCells = months.map(function(month, mi) {
      var ms       = item.monthlyStatus[mi];
      var useAdj   = isAdj && adjMonthly;
      var days     = useAdj ? adjMonthly[mi].inventoryDays : (ms ? ms.inventoryDays : null);
      var amt      = useAdj ? adjMonthly[mi].endingAmount  : (ms ? ms.endingAmount  : null);
      var danger   = useAdj && adjMonthly[mi].isDanger;
      var daysCls  = invDaysCls(days, targetDays);
      var daysDisp = Number.isFinite(days) ? Math.round(days) + "일" : "-";
      var amtDisp  = Number.isFinite(amt)  ? formatMoney(amt)         : "-";
      var dangerIcon = danger ? "<span class=\"inv-danger-icon\" title=\"RTF 부족 위험\">⚠</span>" : "";
      // 조정후 배지 (조정된 월)
      var adjBadge = "";
      if (isAdj && adjMonthly && adjMonthly[mi].isAdjusted) {
        adjBadge = "<span class=\"inv-adj-badge\">조정</span>";
      }
      return "<td class=\"" + daysCls + "\">" + escapeHtml(daysDisp) + dangerIcon + adjBadge + "</td>" +
             "<td>" + escapeHtml(amtDisp) + "</td>";
    }).join("");

    var targetDisp = (targetDays !== undefined && targetDays !== null)
      ? escapeHtml(Math.round(targetDays) + "일")
      : "<span class=\"inv-days-unset\">미설정</span>";

    var mainRow = "<tr class=\"inv-main-row\" data-row-key=\"" + rowKey + "\">" +
      "<td class=\"inv-row-name\">" +
        "<button type=\"button\" class=\"inv-row-toggle\" data-row-key=\"" + rowKey + "\" title=\"공급계획 조정\">" + (isExpanded ? "▼" : "▶") + "</button> " +
        escapeHtml(item.itemGroup || "-") +
      "</td>" +
      "<td class=\"inv-row-name\" title=\"" + escapeHtml(item.itemCode) + "\">" + escapeHtml(item.itemName || item.itemCode) + "</td>" +
      "<td>" + targetDisp + "</td>" +
      monthlyCells +
    "</tr>";

    var drillRow = "";
    if (isExpanded) {
      var adj = adjMonthly || computeAdjMonthly(item);
      var drillRows = months.map(function(month, mi) {
        var d          = adj[mi];
        var adjKey     = item.itemCode + "|" + item.plantCode + "|" + month;
        var isAdjusted = d.isAdjusted;
        var daysDisp2  = Number.isFinite(d.inventoryDays) ? Math.round(d.inventoryDays) + "일" : "-";
        var amtDisp2   = Number.isFinite(d.endingAmount)  ? formatMoney(d.endingAmount)         : "-";
        var dangerCls  = d.isDanger ? " inv-danger-cell" : "";
        var delta      = d.adjSupply - d.origSupply;
        var deltaDisp  = "";
        if (isAdjusted) {
          var sign = delta >= 0 ? "+" : "";
          deltaDisp = "<span class=\"" + (delta >= 0 ? "inv-adj-pos" : "inv-adj-neg") + "\">" +
            escapeHtml(sign + formatNumber(Math.round(delta))) + "</span>";
        }
        return "<tr>" +
          "<td>" + escapeHtml(monthLabel(month)) + "</td>" +
          "<td>" + escapeHtml(formatNumber(Math.round(d.origSupply))) + "</td>" +
          "<td><input type=\"number\" class=\"inv-supply-input" + (isAdjusted ? " adjusted" : "") + "\"" +
            " data-key=\"" + escapeHtml(adjKey) + "\" data-orig=\"" + d.origSupply + "\"" +
            " value=\"" + Math.round(d.adjSupply) + "\" min=\"0\" step=\"1\"></td>" +
          "<td>" + deltaDisp + "</td>" +
          "<td class=\"" + dangerCls + "\">" + escapeHtml(formatNumber(Math.round(d.endingQty))) +
            (d.isDanger ? " <span title=\"RTF 부족 위험\">⚠</span>" : "") + "</td>" +
          "<td class=\"" + dangerCls + "\">" + escapeHtml(daysDisp2) + "</td>" +
          "<td>" + escapeHtml(amtDisp2) + "</td>" +
        "</tr>";
      }).join("");

      drillRow = "<tr class=\"inv-drill-row\"><td colspan=\"" + (3 + months.length * 2) + "\">" +
        "<div class=\"inv-drill-inner\">" +
          "<div class=\"inv-drill-title\">" + escapeHtml(item.itemName || item.itemCode) + " · 공급계획 조정</div>" +
          "<div class=\"inv-table-wrap\"><table class=\"inv-drill-table\">" +
            "<thead><tr><th>월</th><th>원 공급계획</th><th>조정 공급계획</th><th>변동</th><th>기말재고(EA)</th><th>재고일수</th><th>재고금액</th></tr></thead>" +
            "<tbody>" + drillRows + "</tbody>" +
          "</table></div>" +
          "<div class=\"inv-drill-btns\">" +
            "<button class=\"inv-record-btn\" data-item-code=\"" + escapeHtml(item.itemCode) + "\" data-plant=\"" + escapeHtml(item.plantCode || "") + "\">결정사항 회의록에 기록</button>" +
            "<button class=\"inv-reset-btn\" data-item-code=\"" + escapeHtml(item.itemCode) + "\" data-plant=\"" + escapeHtml(item.plantCode || "") + "\">조정 초기화</button>" +
          "</div>" +
        "</div>" +
      "</td></tr>";
    }

    return mainRow + drillRow;
  }).join("");

  var noData = displayItems.length === 0
    ? "<tr><td colspan=\"" + (3 + months.length * 2) + "\" style=\"text-align:center;padding:20px;color:#9ca3af;\">표시할 품목이 없습니다.</td></tr>"
    : "";

  var tableHtml =
    "<div class=\"inv-table-wrap\">" +
    "<table class=\"inv-table\">" +
      "<thead>" +
        "<tr><th rowspan=\"2\" class=\"inv-row-name\">품목군</th><th rowspan=\"2\" class=\"inv-row-name\">품목명</th><th rowspan=\"2\">적정일수</th>" + monthHeads + "</tr>" +
        "<tr>" + subHeads + "</tr>" +
      "</thead>" +
      "<tbody>" + (rows || noData) + "</tbody>" +
    "</table></div>";

  return "<div class=\"inv-screen\">" +
    "<div class=\"inv-inner\">" +
      summaryHtml +
      controlsHtml +
      tableHtml +
    "</div>" +
  "</div>";
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

  // 행 펼치기/접기
  root.querySelectorAll(".inv-row-toggle").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var key = btn.dataset.rowKey;
      if (state.invExpandedRows.has(key)) state.invExpandedRows.delete(key);
      else                                 state.invExpandedRows.add(key);
      render("inventory-forecast");
    });
  });

  // 공급계획 조정 입력
  root.querySelectorAll(".inv-supply-input").forEach(function(input) {
    input.addEventListener("change", function() {
      var key  = input.dataset.key;
      var orig = parseFloat(input.dataset.orig) || 0;
      var val  = parseFloat(input.value);
      if (!Number.isFinite(val) || val < 0) { input.value = Math.round(orig); return; }
      if (Math.abs(val - orig) < 0.01) {
        delete state.invSupplyAdj[key];
      } else {
        state.invSupplyAdj[key] = val;
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

      var adjMonthly = computeAdjMonthly(item);
      var adjEntries = adjMonthly.filter(function(d) { return d.isAdjusted; }).map(function(d) {
        return {
          month:      d.month,
          origSupply: d.origSupply,
          adjSupply:  d.adjSupply,
          delta:      d.adjSupply - d.origSupply,
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
