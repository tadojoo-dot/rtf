// ── 과잉감축 화면 ─────────────────────────────────────────────────────────────

function renderExcessAdjustment() {
  if (!state.mappedData.plan_monthly.length) {
    return "<section class=\"section-band\"><div class=\"section-header\"><h2>과잉감축</h2>" +
      "<p>데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 선택해 주세요.</p></div></section>";
  }

  var months   = getRtfMonths();
  var rtfItems = computeRtfItems();

  var targetMap = new Map();
  (state.mappedData.target_inv || []).forEach(function(r) {
    if (r.itemCode) targetMap.set(r.itemCode, r.targetDays);
  });

  var matAdjBomMap = Object.keys(state.matSimAdj || {}).length > 0
    ? buildBomMaxProducibleMap(state.matSimAdj) : null;

  // 과잉 품목 필터 (첫 달 기준, 적정재고 초과)
  var excessItems = rtfItems.filter(function(item) {
    var targetDays = targetMap.get(item.itemCode);
    if (!targetDays) return false;
    var ms0 = item.monthlyStatus && item.monthlyStatus[0];
    if (!ms0 || !Number.isFinite(ms0.inventoryDays)) return false;
    return ms0.inventoryDays > targetDays;
  });

  // 요약 집계
  var totalExcessAmt = 0, totalReductionAmt = 0;
  excessItems.forEach(function(item) {
    var ms0 = item.monthlyStatus && item.monthlyStatus[0];
    var targetDays = targetMap.get(item.itemCode);
    if (!ms0 || !targetDays || !item.hasCost || !ms0.salesQty) return;
    var tgtAmt = (ms0.salesQty / monthDays(months[0])) * targetDays * item.standardCost;
    var curAmt = ms0.endingAmount || 0;
    if (curAmt > tgtAmt) totalExcessAmt += curAmt - tgtAmt;

    var key0 = item.itemCode + "|" + item.plantCode + "|" + months[0];
    if (key0 in state.excessAdj) {
      var planMap = new Map();
      state.mappedData.plan_monthly.forEach(function(r) {
        if (cleanOptional(r.itemCode) === item.itemCode && cleanOptional(r.plant) === item.plantCode) {
          var m = cleanOptional(r.month);
          if (m) planMap.set(m, (planMap.get(m) || 0) + (cleanNumber(r.supplyQty) || 0));
        }
      });
      var origSupply = planMap.get(months[0]) || 0;
      var adjSupply  = state.excessAdj[key0];
      var delta      = origSupply - adjSupply;
      if (delta > 0 && item.hasCost) totalReductionAmt += delta * item.standardCost;
    }
  });

  var summaryHtml =
    "<div class=\"exc-summary\">" +
      "<div class=\"exc-summary-item\">" +
        "<div class=\"exc-summary-label\">과잉재고 금액 (적정 초과분)</div>" +
        "<div class=\"exc-summary-value exc-excess\">" + escapeHtml(formatMoney(totalExcessAmt)) + "</div>" +
      "</div>" +
      "<div class=\"exc-summary-item\">" +
        "<div class=\"exc-summary-label\">감축 입력된 재고금액 (1개월)</div>" +
        "<div class=\"exc-summary-value exc-reduction\">" + escapeHtml(formatMoney(totalReductionAmt)) + "</div>" +
      "</div>" +
      "<div class=\"exc-summary-item\">" +
        "<div class=\"exc-summary-label\">과잉 품목 수</div>" +
        "<div class=\"exc-summary-value\">" + excessItems.length + "개</div>" +
      "</div>" +
      "<div class=\"exc-summary-link\">" +
        "<button type=\"button\" class=\"exc-goto-inv\" data-menu=\"inventory-forecast\">재고전망 &gt; 감축후 탭에서 확인 →</button>" +
      "</div>" +
    "</div>";

  if (excessItems.length === 0) {
    return "<div class=\"exc-screen\"><div class=\"exc-inner\">" + summaryHtml +
      "<div class=\"exc-empty\">적정재고 초과 품목이 없습니다. 적정재고 RAW 파일이 연결되어 있는지 확인하세요.</div>" +
    "</div></div>";
  }

  // 테이블 헤더
  var monthHeads = months.map(function(m) {
    return "<th colspan=\"2\" class=\"exc-th-month\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHeads = months.map(function() {
    return "<th class=\"exc-th-sub\">원 공급계획</th><th class=\"exc-th-sub\">감축 입력</th>";
  }).join("");

  var bodyHtml = "";
  excessItems.forEach(function(item) {
    var ms0        = item.monthlyStatus && item.monthlyStatus[0];
    var targetDays = targetMap.get(item.itemCode);
    var curDays    = ms0 ? ms0.inventoryDays : null;
    var excessDays = (Number.isFinite(curDays) && targetDays) ? curDays - targetDays : null;
    var rowKey     = item.itemCode + "|" + item.plantCode;
    var isExp      = state.excessExpandedRows.has(rowKey);

    // 현재 기말재고 금액 vs 적정재고 금액
    var excessAmtItem = 0;
    if (ms0 && targetDays && item.hasCost && ms0.salesQty > 0) {
      var tgtAmt = (ms0.salesQty / monthDays(months[0])) * targetDays * item.standardCost;
      excessAmtItem = Math.max(0, (ms0.endingAmount || 0) - tgtAmt);
    }

    var planMap = new Map();
    state.mappedData.plan_monthly.forEach(function(r) {
      if (cleanOptional(r.itemCode) === item.itemCode && cleanOptional(r.plant) === item.plantCode) {
        var m = cleanOptional(r.month);
        if (m) planMap.set(m, (planMap.get(m) || 0) + (cleanNumber(r.supplyQty) || 0));
      }
    });

    var hasAnyAdj = months.some(function(m) {
      return (item.itemCode + "|" + item.plantCode + "|" + m) in state.excessAdj;
    });

    bodyHtml +=
      "<tr class=\"exc-item-row" + (hasAnyAdj ? " exc-item-adjusted" : "") + "\" data-row-key=\"" + escapeHtml(rowKey) + "\">" +
        "<td class=\"exc-name\">" +
          "<button type=\"button\" class=\"exc-toggle\" data-row-key=\"" + escapeHtml(rowKey) + "\">" + (isExp ? "▼" : "▶") + "</button> " +
          escapeHtml(item.itemName || item.itemCode) +
          "<div class=\"exc-code-sub\">" + escapeHtml(item.itemCode) + " · " + escapeHtml(item.businessUnit || "-") + "</div>" +
        "</td>" +
        "<td class=\"exc-days-target\">" + (targetDays ? Math.round(targetDays) + "일" : "-") + "</td>" +
        "<td class=\"exc-days-cur " + (excessDays > 0 ? "exc-days-excess" : "") + "\">" +
          (Number.isFinite(curDays) ? Math.round(curDays) + "일" : "-") + "</td>" +
        "<td class=\"exc-days-over\">" + (excessDays > 0 ? "+" + Math.round(excessDays) + "일" : "-") + "</td>" +
        "<td class=\"exc-excess-amt\">" + (excessAmtItem > 0 ? escapeHtml(formatMoney(excessAmtItem)) : "-") + "</td>" +
        "<td class=\"exc-adj-status\">" + (hasAnyAdj ? "<span class=\"exc-adj-badge\">감축 입력됨</span>" : "<span class=\"exc-adj-none\">미입력</span>") + "</td>" +
      "</tr>";

    if (isExp) {
      var drillRows = months.map(function(month, mi) {
        var adjKey     = item.itemCode + "|" + item.plantCode + "|" + month;
        var origSupply = planMap.get(month) || 0;
        var adjVal     = (adjKey in state.excessAdj) ? state.excessAdj[adjKey] : origSupply;
        var delta      = adjVal - origSupply;
        return "<tr class=\"exc-drill-month\">" +
          "<td>" + escapeHtml(monthLabel(month)) + "</td>" +
          "<td>" + escapeHtml(formatNumber(Math.round(origSupply))) + "</td>" +
          "<td><input type=\"number\" class=\"exc-supply-input\"" +
            " data-key=\"" + escapeHtml(adjKey) + "\" data-orig=\"" + origSupply + "\"" +
            " value=\"" + Math.round(adjVal) + "\" min=\"0\" step=\"1\"></td>" +
          "<td class=\"" + (delta < 0 ? "exc-delta-neg" : delta > 0 ? "exc-delta-pos" : "") + "\">" +
            (delta !== 0 ? escapeHtml((delta > 0 ? "+" : "") + formatNumber(Math.round(delta))) : "-") + "</td>" +
        "</tr>";
      }).join("");

      bodyHtml +=
        "<tr class=\"exc-drill-row\"><td colspan=\"6\">" +
          "<div class=\"exc-drill-inner\">" +
            "<div class=\"exc-drill-title\">" + escapeHtml(item.itemName || item.itemCode) + " · 월별 공급계획 감축 입력</div>" +
            "<div class=\"exc-drill-note\">공급계획을 줄이면 재고전망 &gt; 감축후 탭에 반영됩니다.</div>" +
            "<table class=\"exc-drill-table\">" +
              "<thead><tr><th>월</th><th>원 공급계획</th><th>감축 후 계획</th><th>변동</th></tr></thead>" +
              "<tbody>" + drillRows + "</tbody>" +
            "</table>" +
            "<div class=\"exc-drill-btns\">" +
              "<button class=\"exc-reset-btn\" data-item-code=\"" + escapeHtml(item.itemCode) + "\" data-plant=\"" + escapeHtml(item.plantCode || "") + "\">초기화</button>" +
              "<button class=\"exc-record-btn\" data-item-code=\"" + escapeHtml(item.itemCode) + "\" data-plant=\"" + escapeHtml(item.plantCode || "") + "\">회의록에 기록</button>" +
            "</div>" +
          "</div>" +
        "</td></tr>";
    }
  });

  var tableHtml =
    "<div class=\"exc-table-wrap\"><table class=\"exc-table\">" +
      "<thead>" +
        "<tr>" +
          "<th rowspan=\"2\" class=\"exc-th-name\">품목명</th>" +
          "<th rowspan=\"2\">적정일수</th>" +
          "<th rowspan=\"2\">현재일수</th>" +
          "<th rowspan=\"2\">초과일수</th>" +
          "<th rowspan=\"2\">과잉금액</th>" +
          "<th rowspan=\"2\">감축입력</th>" +
        "</tr>" +
        "<tr></tr>" +
      "</thead>" +
      "<tbody>" + bodyHtml + "</tbody>" +
    "</table></div>";

  return "<div class=\"exc-screen\"><div class=\"exc-inner\">" + summaryHtml + tableHtml + "</div></div>";
}

// ── 이벤트 바인딩 ──────────────────────────────────────────────────────────────
function bindExcessAdjustment() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;

  // 재고전망 이동 버튼
  root.querySelectorAll(".exc-goto-inv").forEach(function(btn) {
    btn.addEventListener("click", function() {
      state.invViewMode = "excess";
      render("inventory-forecast");
    });
  });

  // 드릴다운 토글
  root.querySelectorAll(".exc-toggle").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var key = btn.dataset.rowKey;
      if (state.excessExpandedRows.has(key)) state.excessExpandedRows.delete(key);
      else                                    state.excessExpandedRows.add(key);
      render("inventory-variance");
    });
  });

  // 공급계획 감축 입력
  root.querySelectorAll(".exc-supply-input").forEach(function(input) {
    input.addEventListener("change", function() {
      var key  = input.dataset.key;
      var orig = parseFloat(input.dataset.orig) || 0;
      var val  = parseFloat(input.value);
      if (!Number.isFinite(val) || val < 0) { input.value = Math.round(orig); return; }
      if (Math.abs(val - orig) < 0.01) {
        delete state.excessAdj[key];
      } else {
        state.excessAdj[key] = val;
      }
      render("inventory-variance");
    });
  });

  // 초기화
  root.querySelectorAll(".exc-reset-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var itemCode = btn.dataset.itemCode;
      var plant    = btn.dataset.plant || "";
      var months   = getRtfMonths();
      months.forEach(function(m) {
        delete state.excessAdj[itemCode + "|" + plant + "|" + m];
      });
      render("inventory-variance");
    });
  });

  // 회의록 기록
  root.querySelectorAll(".exc-record-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var itemCode = btn.dataset.itemCode;
      var plant    = btn.dataset.plant || "";
      var months   = getRtfMonths();
      var rtfItems = computeRtfItems();
      var item     = rtfItems.find(function(it) { return it.itemCode === itemCode && it.plantCode === plant; });
      if (!item) return;

      var planMap = new Map();
      state.mappedData.plan_monthly.forEach(function(r) {
        if (cleanOptional(r.itemCode) === itemCode && cleanOptional(r.plant) === plant) {
          var m = cleanOptional(r.month);
          if (m) planMap.set(m, (planMap.get(m) || 0) + (cleanNumber(r.supplyQty) || 0));
        }
      });

      var entries = months.filter(function(m) {
        return (itemCode + "|" + plant + "|" + m) in state.excessAdj;
      }).map(function(m) {
        var orig = planMap.get(m) || 0;
        var adj  = state.excessAdj[itemCode + "|" + plant + "|" + m];
        return { month: m, origSupply: orig, adjSupply: adj, delta: adj - orig };
      });

      if (!entries.length) { alert("감축 입력된 내역이 없습니다."); return; }

      if (!state.minutesLog) state.minutesLog = [];
      state.minutesLog.push({
        id:        Date.now(),
        timestamp: new Date(),
        type:      "excess_adj",
        title:     (item.itemName || itemCode) + " 과잉감축 조정",
        itemCode:  itemCode,
        entries:   entries,
      });
      alert("회의록에 기록되었습니다.");
    });
  });
}
