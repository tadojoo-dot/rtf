// ── 완제품 카드 렌더 ───────────────────────────────────────────────────────────
function renderFgCards(fgGroups, months) {
  if (!fgGroups.length) return "";

  var simAdj = state.matSimAdj || {};

  var cards = fgGroups.map(function(fg) {
    var shortMonthCount = fg.shortageMonthIdxSet.size;
    var shortMonthLabels = months
      .filter(function(m, mi) { return fg.shortageMonthIdxSet.has(mi); })
      .map(monthLabel).join(" · ");

    // 월별 점 스트립
    var dotHtml = months.map(function(m, mi) {
      var isShort = fg.shortageMonthIdxSet.has(mi);
      return "<span class=\"cst-fg-dot " + (isShort ? "shortage" : "ok") + "\" title=\"" + escapeHtml(monthLabel(m)) + "\"></span>" +
             "<span class=\"cst-fg-dot-label\">" + escapeHtml(monthLabel(m)) + "</span>";
    }).join("");

    // 월별 컬럼 헤더
    var monthColHeads = months.map(function(m, mi) {
      var isShort = fg.shortageMonthIdxSet.has(mi);
      return "<th class=\"cst-fg-mh" + (isShort ? " shortage" : "") + "\">" + escapeHtml(monthLabel(m)) + "</th>";
    }).join("");

    // 자재 행 — 월별 부족량 + 월별 조정 입력
    var matRows = fg.materials.map(function(mat) {
      var dec = _cstDecByUnit(mat.unit);
      var sharedBadge = mat.isShared ? "<span class=\"cst-fg-shared-badge\">공용</span>" : "";

      var monthlyCells = months.map(function(m, mi) {
        var md = mat.monthlyData[mi] || {};
        var shortage = md.shortageQty;
        var isShortMonth = shortage !== null && shortage > 0;
        var simKey = mat.code + "|" + mat.plant + "|" + m;
        var adjVal = simKey in simAdj ? simAdj[simKey] : "";
        var isAdj  = adjVal !== "" && Math.abs(Number(adjVal)) > 0;

        // 조정 후 부족 계산
        var adjShortage = null;
        if (isAdj && md.availableQty !== null && md.requiredQty !== null) {
          adjShortage = Math.max(0, md.requiredQty - (md.availableQty + Number(adjVal)));
        }

        var shortDisp = isShortMonth ? escapeHtml(_cstFmtVal(shortage, dec, "")) : "-";
        var adjTag = isAdj
          ? "<span class=\"cst-fg-adj-result " + (adjShortage !== null && adjShortage <= 0 ? "resolved" : "partial") + "\">" +
            (adjShortage !== null && adjShortage <= 0 ? "✓" : "△") + "</span>"
          : "";

        var inputHtml = isShortMonth
          ? "<input type=\"number\" class=\"cst-fg-adj-input\" " +
            "data-key=\"" + escapeHtml(simKey) + "\" " +
            "placeholder=\"조정\" step=\"1\" min=\"0\" " +
            (adjVal !== "" ? "value=\"" + Number(adjVal) + "\"" : "") + " />" + adjTag
          : "<span class=\"cst-fg-no-shortage\">-</span>";

        return "<td class=\"cst-fg-month-cell" + (isShortMonth ? " shortage" : "") + "\">" +
          "<div class=\"cst-fg-mc-short\">" + shortDisp + "</div>" +
          "<div class=\"cst-fg-mc-input\">" + inputHtml + "</div>" +
          "</td>";
      }).join("");

      return "<tr>" +
        "<td class=\"cst-fg-mat-name\">" + escapeHtml(mat.name) + sharedBadge +
          "<div class=\"cst-fg-mat-unit\">" + escapeHtml(mat.unit || "") + "</div>" +
        "</td>" +
        monthlyCells +
        "</tr>";
    }).join("");

    var hasAnyAdj = fg.materials.some(function(mat) {
      return months.some(function(m) {
        var k = mat.code + "|" + mat.plant + "|" + m;
        return k in simAdj;
      });
    });

    return "<div class=\"cst-fg-card\">" +
      "<div class=\"cst-fg-card-header\">" +
        "<div class=\"cst-fg-card-title-wrap\">" +
          "<span class=\"cst-fg-card-title\">" + escapeHtml(fg.name) + "</span>" +
          "<span class=\"cst-fg-card-code\">" + escapeHtml(fg.code) + "</span>" +
        "</div>" +
        "<span class=\"cst-fg-shortage-badge\">" + shortMonthCount + "개월 부족</span>" +
      "</div>" +
      "<div class=\"cst-fg-month-strip\">" + dotHtml +
        "<span class=\"cst-fg-month-note\">" + escapeHtml(shortMonthLabels) + " 부족</span>" +
      "</div>" +
      "<div class=\"cst-fg-mat-section\"><div class=\"cst-fg-mat-scroll\">" +
        "<table class=\"cst-fg-mat-table\">" +
          "<thead><tr>" +
            "<th class=\"cst-fg-name-h\">원인 자재</th>" +
            monthColHeads +
          "</tr></thead>" +
          "<tbody>" + matRows + "</tbody>" +
        "</table>" +
      "</div></div>" +
      (hasAnyAdj ? "<div class=\"cst-fg-card-footer\">✓ 조정 반영 시 RTF 실시간 갱신됩니다</div>" : "") +
      "</div>";
  }).join("");

  var totalFg = fgGroups.length;
  var shortMonthSet = new Set();
  fgGroups.forEach(function(fg) { fg.shortageMonthIdxSet.forEach(function(mi) { shortMonthSet.add(mi); }); });

  var headerHtml = "<div class=\"cst-fg-section-header\">" +
    "<span class=\"cst-fg-section-title\">공급부족 완제품 · 조정 현황</span>" +
    "<span class=\"cst-fg-section-count\">부족 " + totalFg + "품목 · " + shortMonthSet.size + "개월</span>" +
    "</div>";

  return "<div class=\"cst-fg-cards-wrap\">" + headerHtml + cards + "</div>";
}

// ── 정렬 ─────────────────────────────────────────────────────────────────────
function sortConstraintItems(items) {
  // 영향품목수 기준 정렬 (toggleable)
  if (state.constraintImpactSort !== 0) {
    var dir = state.constraintImpactSort;
    return items.slice().sort(function(a, b) { return dir * (b.parentItems.length - a.parentItems.length); });
  }
  function priority(item) {
    if (item.hasAnyShortage && item.isShared)  return 0;
    if (item.hasAnyShortage && !item.isShared) return 1;
    if (item.unitMismatch)                     return 2;
    if (item.needsProvenanceCheck)             return 3;
    if (!item.hasInventory && !item.hasSupplyPlan) return 4;
    if (!item.hasInventory)                    return 5;
    if (!item.hasSupplyPlan)                   return 6;
    if (item.needsMaster || item.categoryUnknown) return 7;
    return 8;
  }
  return items.slice().sort(function(a, b) {
    var pd = priority(a) - priority(b);
    if (pd !== 0) return pd;
    // 부족 그룹 내: 부족 합계 큰 순
    if (a.hasAnyShortage && b.hasAnyShortage) return b.totalShortage - a.totalShortage;
    // 나머지 그룹 내: 영향품목수 큰 순
    return b.parentItems.length - a.parentItems.length;
  });
}

// ── 필터 ─────────────────────────────────────────────────────────────────────
function filterConstraintItems(items) {
  var d = state.cstDrilldown;

  // ── 드릴다운 필터 우선 적용 ──────────────────────────────────────────────
  if (d && !d.isAggregate && d.itemCode) {
    return items.filter(function(item) {
      return item.parentItems.some(function(p) {
        return p.code === d.itemCode && (!d.plant || p.plant === d.plant);
      });
    });
  }
  if (d && d.isAggregate && d.itemCodes && d.itemCodes.length) {
    var codeSet = new Set(d.itemCodes);
    return items.filter(function(item) {
      return item.parentItems.some(function(p) {
        return codeSet.has(p.code) && (!d.plant || p.plant === d.plant);
      });
    });
  }

  // ── 일반 필터 ────────────────────────────────────────────────────────────
  var filter = state.constraintFilter || "all";
  var search = ((state.constraintSearch || "")).toLowerCase().trim();
  var filtered = items;
  if      (filter === "shortage")      filtered = items.filter(function(i) { return i.hasAnyShortage; });
  else if (filter === "shared")        filtered = items.filter(function(i) { return i.isShared && i.hasAnyShortage; });
  else if (filter === "dedicated")     filtered = items.filter(function(i) { return !i.isShared && i.hasAnyShortage; });
  else if (filter === "indeterminate") filtered = items.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan || i.unitMismatch; });
  else if (filter === "need-data")     filtered = items.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan; });
  else if (filter === "provenance")    filtered = items.filter(function(i) { return i.needsProvenanceCheck; });
  else if (filter === "need-master")   filtered = items.filter(function(i) { return i.needsMaster || i.categoryUnknown; });
  if (search) {
    filtered = filtered.filter(function(i) {
      return i.componentCode.toLowerCase().includes(search) ||
             i.componentName.toLowerCase().includes(search) ||
             i.parentItems.some(function(p) {
               return p.code.toLowerCase().includes(search) || p.name.toLowerCase().includes(search);
             });
    });
  }
  return filtered;
}

// ── 드릴다운 배너 ─────────────────────────────────────────────────────────────
function renderCstDrilldownBanner(d) {
  var parts = ["RTF(공급가능성 판정)"];
  if (d.businessUnit) parts.push(d.businessUnit);
  if (d.typeGroup)    parts.push(d.typeGroup);
  // 집계 행: itemGroup > label 순으로 사용 (label에서 " 계" 제거)
  if (d.isAggregate) {
    var aggLabel = d.itemGroup || (d.label ? d.label.replace(/ 계$/, "") : null);
    if (aggLabel) parts.push(aggLabel);
  } else {
    if (d.itemGroup) parts.push(d.itemGroup);
    if (d.itemName)  parts.push(d.itemName);
  }

  var monthLbl = monthLabel(d.month);
  var qtyStr = Number.isFinite(d.shortageQty) ? formatNumber(d.shortageQty) : "-";
  parts.push(monthLbl + " 부족 " + qtyStr);

  var breadcrumb = parts.join(" > ");

  // 상품 유형은 BOM 전개 제외 안내 (개별/집계 모두 표시)
  var goodsNote = d.typeGroup === "상품"
    ? "<div class=\"cst-drill-goods-note\">상품 품목은 BOM 전개 대상이 아니며, 현재고/입고계획 기준으로 공급가능성을 판단합니다.</div>"
    : "";

  return "<div class=\"cst-drilldown-banner\">" +
    "<span class=\"cst-drill-label\">" + escapeHtml(breadcrumb) + " 기준 조회 중</span>" +
    "<button type=\"button\" class=\"cst-drill-clear\" id=\"cstClearDrilldown\">전체 공급원인 보기</button>" +
    "</div>" + goodsNote;
}

// ── 상품 드릴다운 상세 ────────────────────────────────────────────────────────
function renderCstGoodsPanel(d) {
  var months = getRtfMonths();
  var bomMap = (typeof buildBomMaxProducibleMap === "function") ? buildBomMaxProducibleMap(state.matSimAdj || {}) : null;
  var baseItems = computeRtfItems(bomMap, false, {});                          // 상품 조정 전
  var adjItems  = computeRtfItems(bomMap, false, state.goodsSupplyAdj || {});  // 조정 후 (부족 계산 = RTF와 동일)
  var baseMap = {}; baseItems.forEach(function(i) { baseMap[i.itemCode + "|" + i.plantCode] = i; });

  var codes = d.isAggregate ? new Set(d.itemCodes || []) : new Set([d.itemCode]);
  var items = adjItems.filter(function(i) {
    return i.typeGroup === "상품" && codes.has(i.itemCode) && (!d.plant || i.plantCode === d.plant);
  });
  // 정렬은 "조정 전(베이스라인) 부족" 기준 → 조정해도 순서가 안 바뀜 (동률은 코드순 고정)
  items.sort(function(a, b) {
    function baseShort(it) {
      var src = baseMap[it.itemCode + "|" + it.plantCode] || it;
      return src.monthlyStatus.reduce(function(s, ms) { return s + (ms.shortageQty || 0); }, 0);
    }
    var d2 = baseShort(b) - baseShort(a);
    if (Math.abs(d2) > 0.001) return d2;
    return String(a.itemCode).localeCompare(String(b.itemCode));
  });

  // 원래 공급 · 단위 맵
  var origSupply = new Map(), unitMap = {};
  state.mappedData.plan_monthly.forEach(function(r) {
    var c = cleanOptional(r.itemCode), p = cleanOptional(r.plant) || "", m = cleanOptional(r.month);
    if (!c || !m) return;
    var k = c + "|" + p + "|" + m;
    origSupply.set(k, (origSupply.get(k) || 0) + (cleanNumber(r.supplyQty) || 0));
    if (!unitMap[c] && cleanOptional(r.unit)) unitMap[c] = cleanOptional(r.unit);
  });

  var titleLabel = d.isAggregate ? (d.itemGroup || (d.label ? d.label.replace(/ 계$/, "") : "품목군")) : (d.itemName || d.itemCode || "상품");
  var hasGoodsAdj = state.goodsSupplyAdj && Object.keys(state.goodsSupplyAdj).length > 0;
  var resetBtn = hasGoodsAdj ? "<button type=\"button\" class=\"cst-sa-reset-all\" id=\"cstGoodsReset\">전체 초기화</button>" : "";

  var body = items.length
    ? renderCstGoodsMatTable(items, months, origSupply, unitMap, baseMap)
    : "<div class=\"cst-fgl-no-mat\">해당 상품의 공급계획 데이터가 없습니다.</div>";

  return "<section class=\"cst-card cst-fgl-section\">" +
    "<div class=\"cst-sec-title\">상품 공급(입고) 조정 · " + escapeHtml(titleLabel) +
      " <span class=\"cst-sa-count\">" + items.length + "건</span>" +
      (hasGoodsAdj ? " <span class=\"mat-sim-badge\">조정 중</span>" : "") + resetBtn + "</div>" +
    body +
    "</section>";
}

// 상품 조정 테이블 — 완제품 자재조정(cst-sa-*)과 동일 양식
function renderCstGoodsMatTable(items, months, origSupply, unitMap, baseMap) {
  var monthHeads = months.map(function(m, mi) {
    return "<th colspan=\"2\" class=\"cst-sa-mhd" + (mi > 0 ? " cst-sa-mborder" : "") + "\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHeads = months.map(function(_, mi) {
    return "<th class=\"cst-sa-sub" + (mi > 0 ? " cst-sa-mborder" : "") + "\">입고/조정</th><th class=\"cst-sa-sub\">부족</th>";
  }).join("");

  var bodyRows = items.map(function(it) {
    var baseItem = baseMap[it.itemCode + "|" + it.plantCode];
    var itemHasAdj = months.some(function(m) {
      var k = it.itemCode + "|" + it.plantCode + "|" + m;
      return state.goodsSupplyAdj && (k in state.goodsSupplyAdj);
    });
    var monthCells = months.map(function(month, mi) {
      var ms = it.monthlyStatus[mi] || {};
      var k = it.itemCode + "|" + it.plantCode + "|" + month;
      var orig = origSupply.get(k) || 0;
      var isAdj = state.goodsSupplyAdj && (k in state.goodsSupplyAdj) && Math.abs(state.goodsSupplyAdj[k] - orig) > 0.001;
      var adj = isAdj ? state.goodsSupplyAdj[k] : orig;
      var delta = adj - orig;
      var borderCls = mi > 0 ? " cst-sa-mborder" : "";
      var sales = Number.isFinite(ms.salesQty) ? ms.salesQty : null;
      var adjShort = Number.isFinite(ms.shortageQty) ? ms.shortageQty : null;
      var origShort = (baseItem && baseItem.monthlyStatus[mi]) ? (baseItem.monthlyStatus[mi].shortageQty || 0) : 0;
      var deltaHtml = isAdj
        ? "<span class=\"mat-sim-delta " + (delta > 0 ? "mat-sim-pos" : "mat-sim-neg") + "\">" + (delta > 0 ? "+" : "") + formatNumber(Math.round(delta)) + "</span>"
        : "";
      var salesHtml = sales !== null ? "<div class=\"cst-sa-sales\">판매 " + formatNumber(Math.round(sales)) + "</div>" : "";
      var inputCell = "<td class=\"cst-sa-input-cell" + borderCls + (isAdj ? " cst-sa-adjusted" : "") + "\">" +
        salesHtml +
        "<input type=\"number\" class=\"cst-goods-input\" data-key=\"" + escapeHtml(k) + "\" data-orig=\"" + Math.round(orig) +
        "\" value=\"" + Math.round(adj) + "\" min=\"0\" step=\"1\" />" + deltaHtml + "</td>";
      var shortCell = (adjShort === null) ? "<td class=\"cst-sa-short-cell" + borderCls + "\">-</td>"
        : (adjShort <= 0 && origShort > 0 && isAdj) ? "<td class=\"cst-sa-resolved" + borderCls + "\">✓ 해소</td>"
        : adjShort > 0 ? "<td class=\"cst-sa-short-num" + borderCls + "\">" + formatNumber(Math.round(adjShort)) + "</td>"
        : "<td class=\"cst-sa-short-cell" + borderCls + "\">-</td>";
      return inputCell + shortCell;
    }).join("");
    var resetBtn = itemHasAdj
      ? "<button class=\"cst-goods-row-reset\" data-item-code=\"" + escapeHtml(it.itemCode) + "\" data-plant=\"" + escapeHtml(it.plantCode) + "\">초기화</button>"
      : "";
    return "<tr class=\"cst-sa-row\">" +
      "<td class=\"cst-sa-code\">" + escapeHtml(it.itemCode) + "</td>" +
      "<td class=\"cst-sa-name\">" + escapeHtml(it.itemName) + "</td>" +
      "<td class=\"cst-sa-unit\">" + escapeHtml(unitMap[it.itemCode] || "EA") + "</td>" +
      monthCells +
      "<td class=\"cst-sa-reset-cell\">" + resetBtn + "</td>" +
      "</tr>";
  }).join("");

  return "<div class=\"cst-fgl-mat-wrap\"><div class=\"cst-h-scroll\"><table class=\"cst-sa-table cst-sa-goods\">" +
    "<thead><tr>" +
    "<th rowspan=\"2\" class=\"cst-sa-lhd\">품목코드</th>" +
    "<th rowspan=\"2\" class=\"cst-sa-lhd cst-sa-namehd\">품목명</th>" +
    "<th rowspan=\"2\" class=\"cst-sa-lhd\">단위</th>" +
    monthHeads + "<th rowspan=\"2\" class=\"cst-sa-lhd\"></th>" +
    "</tr><tr>" + subHeads + "</tr></thead>" +
    "<tbody>" + bodyRows + "</tbody>" +
    "</table></div></div>";
}


// ── 완제품 드릴다운 공급현황 패널 ─────────────────────────────────────────────
function renderCstFinishedGoodsPanel(d) {
  var months      = getRtfMonths();
  var targetMonth = d.month;

  // 기초재고 맵: itemCode|plant → baseQty
  var baseInvMap = new Map();
  state.mappedData.inventory_base.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant) || "";
    if (!code) return;
    var k = code + "|" + plant;
    baseInvMap.set(k, (baseInvMap.get(k) || 0) + (cleanNumber(r.baseQty) || 0));
  });

  // plan_monthly 전체 맵: itemCode|plant|month → {salesQty, supplyQty}
  var planMap = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant) || "", month = cleanOptional(r.month);
    if (!code || !month) return;
    var k = code + "|" + plant + "|" + month;
    if (!planMap.has(k)) planMap.set(k, { salesQty:0, supplyQty:0 });
    var e = planMap.get(k);
    e.salesQty  += (cleanNumber(r.salesQty)  || 0);
    e.supplyQty += (cleanNumber(r.supplyQty) || 0);
  });

  // 롤링 기초재고 계산: months[0]부터 targetMonth까지 순차 차감
  function rollingOpeningQty(itemCode, plant) {
    var opening = baseInvMap.get(itemCode + "|" + (plant || "")) || 0;
    for (var mi = 0; mi < months.length; mi++) {
      if (months[mi] === targetMonth) return opening;
      var pm = planMap.get(itemCode + "|" + (plant || "") + "|" + months[mi]);
      if (pm) opening = Math.max(0, opening + pm.supplyQty - pm.salesQty);
    }
    return opening;
  }

  if (d.isAggregate) {
    var codeSet = new Set(d.itemCodes || []);
    // 해당 품목코드 + 기준월 데이터 집계 (플랜트별 분리)
    var itemMap = new Map();
    state.mappedData.plan_monthly.forEach(function(r) {
      var code = cleanOptional(r.itemCode), month = cleanOptional(r.month), plant = cleanOptional(r.plant) || "";
      if (!code || !codeSet.has(code) || month !== targetMonth) return;
      var k = code + "|" + plant;
      if (!itemMap.has(k)) itemMap.set(k, { itemCode:code, itemName:cleanOptional(r.itemName)||code, plant:plant, salesQty:0, supplyQty:0 });
      var e = itemMap.get(k);
      e.salesQty  += (cleanNumber(r.salesQty)  || 0);
      e.supplyQty += (cleanNumber(r.supplyQty) || 0);
    });

    var entries = Array.from(itemMap.values()).map(function(e) {
      var openingQty = rollingOpeningQty(e.itemCode, e.plant);
      var available  = openingQty + e.supplyQty;
      var shortage   = Math.max(0, e.salesQty - available);
      return Object.assign(e, { openingQty:openingQty, available:available, shortage:shortage });
    }).sort(function(a, b) { return b.shortage - a.shortage; });

    if (entries.length === 0) return "";
    var titleLabel = d.itemGroup || (d.label ? d.label.replace(/ 계$/, "") : "완제품");
    var rows = entries.map(function(e) {
      var isShort = e.shortage > 0;
      return "<tr>" +
        "<td>" + escapeHtml(e.itemCode) + "</td>" +
        "<td>" + escapeHtml(e.itemName) + "</td>" +
        "<td>" + formatNumber(Math.round(e.salesQty)) + "</td>" +
        "<td>" + formatNumber(Math.round(e.openingQty)) + "</td>" +
        "<td>" + formatNumber(Math.round(e.supplyQty)) + "</td>" +
        "<td class=\"" + (isShort ? "cst-ss-short-num" : "") + "\">" + formatNumber(Math.round(e.shortage)) + "</td>" +
        "</tr>";
    }).join("");
    return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
      "<div class=\"cst-det-section-title\">" + escapeHtml(titleLabel) + " · " + escapeHtml(monthLabel(targetMonth)) + " 완제품 공급현황</div>" +
      "<div class=\"cst-det-scroll\"><table class=\"cst-ss-table cst-drill-goods-table\"><thead><tr>" +
      "<th>품목코드</th><th>품목명</th><th>판매계획</th><th>기초재고</th><th>공급계획</th><th>부족수량</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  // 개별 품목: 월별 롤링 계산
  var plant0 = d.plant || "";
  var opening = baseInvMap.get(d.itemCode + "|" + plant0) || 0;
  var rows2 = months.map(function(month) {
    var pm = planMap.get(d.itemCode + "|" + plant0 + "|" + month);
    var salesQty  = pm ? pm.salesQty  : null;
    var supplyQty = pm ? pm.supplyQty : null;
    var available = (salesQty !== null) ? opening + (supplyQty || 0) : null;
    var shortage  = available !== null ? Math.max(0, salesQty - available) : null;
    var isShort   = shortage !== null && shortage > 0;
    var hlCls     = month === targetMonth ? " cst-drill-month-hi" : "";
    var row = "<tr class=\"" + hlCls + "\">" +
      "<td>" + escapeHtml(monthLabel(month)) + "</td>" +
      "<td>" + (salesQty  !== null ? formatNumber(Math.round(salesQty))  : "-") + "</td>" +
      "<td>" + (available !== null ? formatNumber(Math.round(opening))   : "-") + "</td>" +
      "<td>" + (supplyQty !== null ? formatNumber(Math.round(supplyQty)) : "-") + "</td>" +
      "<td class=\"" + (isShort ? "cst-ss-short-num" : "") + "\">" + (shortage !== null ? formatNumber(Math.round(shortage)) : "-") + "</td>" +
      "</tr>";
    // 다음 달 기초재고 롤링
    if (salesQty !== null && supplyQty !== null) opening = Math.max(0, opening + supplyQty - salesQty);
    return row;
  }).join("");

  return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
    "<div class=\"cst-det-section-title\">" + escapeHtml(d.itemName || d.itemCode || "") + " · 월별 공급현황</div>" +
    "<div class=\"cst-det-scroll\"><table class=\"cst-ss-table cst-drill-goods-table\"><thead><tr>" +
    "<th>월</th><th>판매계획</th><th>기초재고</th><th>공급계획</th><th>부족수량</th>" +
    "</tr></thead><tbody>" + rows2 + "</tbody></table></div></div>";
}

// ── 드릴다운 부족자재 패널 ────────────────────────────────────────────────────
function _buildMatSupplyMap() {
  var m = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant), month = cleanOptional(r.month);
    if (!code || !month) return;
    var k = code + "|" + plant + "|" + month;
    m.set(k, (m.get(k) || 0) + (cleanNumber(r.supplyQty) || 0));
  });
  return m;
}

function recordMinutesEntry(d, targetMonth) {
  if (!state.minutesLog) state.minutesLog = [];
  var simAdj = state.matSimAdj || {};
  var months  = getRtfMonths();
  var monthIdx = months.indexOf(targetMonth);
  var codes   = d.isAggregate ? new Set(d.itemCodes || []) : new Set(d.itemCode ? [d.itemCode] : []);
  var plantFilter = (!d.isAggregate && d.plant) ? d.plant : null;
  var matSupplyMap = _buildMatSupplyMap();

  var entries = [];
  (state.bomResult && state.bomResult.items || []).forEach(function(item) {
    if (!item.parentItems.some(function(p) { return codes.has(p.code) && (!plantFilter || p.plant === plantFilter); })) return;
    var simKey = item.componentCode + "|" + item.plant + "|" + targetMonth;
    if (!(simKey in simAdj)) return;
    var orig = matSupplyMap.get(simKey) || 0;
    var adj  = simAdj[simKey];
    if (Math.abs(adj - orig) < 0.001) return;

    var matchParents = item.parentItems.filter(function(p) { return codes.has(p.code) && (!plantFilter || p.plant === plantFilter); });
    var matchReq  = matchParents.reduce(function(s, p) { return s + ((p.monthly[monthIdx] && p.monthly[monthIdx].reqQty) || 0); }, 0);
    var matchProd = matchParents.reduce(function(s, p) { return s + ((p.monthly[monthIdx] && p.monthly[monthIdx].prodQty) || 0); }, 0);
    var usageRate = matchProd > 0 ? matchReq / matchProd : null;
    var addlEA    = (usageRate && usageRate > 0 && adj > orig) ? Math.round((adj - orig) / usageRate) : 0;

    entries.push({
      matCode: item.componentCode, matName: item.componentName,
      plant: item.plant, month: targetMonth,
      orig: orig, adj: adj, delta: adj - orig, addlEA: addlEA,
    });
  });

  if (entries.length === 0) {
    alert("기록할 조정사항이 없습니다."); return;
  }
  var titleLabel = d.isAggregate
    ? (d.itemGroup || (d.label ? d.label.replace(/ 계$/, "") : "품목군"))
    : (d.itemName || d.itemCode || "품목");

  state.minutesLog.push({
    id: Date.now(), timestamp: new Date(),
    title: escapeHtml(titleLabel) + " · " + escapeHtml(monthLabel(targetMonth)) + " 자재 수급 조정",
    entries: entries,
  });
  render("minutes");
  alert("회의록에 기록되었습니다. 회의록 탭에서 확인하세요.");
}

function renderCstShortMaterialsPanel(d) {
  if (state.bomStatus !== BOM_STATUS.DONE || !state.bomResult) {
    return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
      "<div class=\"cst-det-section-title\">부족 자재 리스트</div>" +
      "<div class=\"cst-drill-mat-note\">공급원인 화면에서 BOM 전개 후 확인 가능합니다.</div></div>";
  }
  var months      = getRtfMonths();
  var targetMonth = d.month;
  var monthIdx    = months.indexOf(targetMonth);
  var codes       = d.isAggregate ? new Set(d.itemCodes || []) : new Set(d.itemCode ? [d.itemCode] : []);
  var plantFilter = (!d.isAggregate && d.plant) ? d.plant : null;
  var has9Code    = Array.from(codes).some(function(c) { return c && c.toString().startsWith("9"); });
  var simAdj      = state.matSimAdj || {};

  var matSupplyMap = _buildMatSupplyMap();

  var relatedItems = (state.bomResult.items || []).filter(function(item) {
    return item.parentItems.some(function(p) { return codes.has(p.code) && (!plantFilter || p.plant === plantFilter); });
  }).sort(function(a, b) {
    var aS = (a.monthlyData[monthIdx] || {}).shortageQty || 0;
    var bS = (b.monthlyData[monthIdx] || {}).shortageQty || 0;
    var aCan = a.hasInventory && a.hasSupplyPlan ? 1 : 0;
    var bCan = b.hasInventory && b.hasSupplyPlan ? 1 : 0;
    if (bS > 0 && aS <= 0) return 1;
    if (aS > 0 && bS <= 0) return -1;
    if (bCan !== aCan) return aCan - bCan;
    return bS - aS;
  });

  if (relatedItems.length === 0) {
    var note = has9Code ? "연결된 BOM 제약자재 없음"
      : "9코드(완제품) 외 품목은 BOM 전개 대상이 아닙니다.";
    return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
      "<div class=\"cst-det-section-title\">부족 자재 리스트 · " + escapeHtml(monthLabel(targetMonth)) + "</div>" +
      "<div class=\"cst-drill-mat-note\">" + note + "</div></div>";
  }

  var hasShared = relatedItems.some(function(i) { return i.isShared; });

  var hasAnyAdj = relatedItems.some(function(item) {
    var k = item.componentCode + "|" + item.plant + "|" + targetMonth;
    return (k in simAdj) && Math.abs(simAdj[k] - (matSupplyMap.get(k) || 0)) > 0.001;
  });

  var tot = { req:0, opening:0, incoming:0, adjIncoming:0, shortage:0, adjShortage:0,
              shortageCount:0, adjShortageCount:0, unknownCount:0 };
  var simResults = [];

  var rows = relatedItems.map(function(item) {
    var md      = item.monthlyData[monthIdx] || {};
    var canComp = item.hasInventory && item.hasSupplyPlan;
    var dec     = _cstDecByUnit(item.unit);
    var simKey  = item.componentCode + "|" + item.plant + "|" + targetMonth;

    var matchParents = item.parentItems.filter(function(p) {
      return codes.has(p.code) && (!plantFilter || p.plant === plantFilter);
    });
    var matchProd = matchParents.reduce(function(s, p) { return s + ((p.monthly[monthIdx] && p.monthly[monthIdx].prodQty) || 0); }, 0);
    var matchReq  = matchParents.reduce(function(s, p) { return s + ((p.monthly[monthIdx] && p.monthly[monthIdx].reqQty) || 0); }, 0);
    var usageRate = matchProd > 0 ? matchReq / matchProd : null;

    var incomingQty = matSupplyMap.get(simKey) || 0;
    var openingQty  = (canComp && md.availableQty !== null) ? Math.max(md.availableQty - incomingQty, 0) : null;

    var adjIncoming = (simKey in simAdj) ? simAdj[simKey] : incomingQty;
    var isAdjusted  = Math.abs(adjIncoming - incomingQty) > 0.001;

    var shortage    = (canComp && md.availableQty !== null) ? Math.max(matchReq - md.availableQty, 0) : null;
    var adjAvail    = (canComp && openingQty !== null) ? openingQty + adjIncoming : null;
    var adjShortage = (canComp && adjAvail !== null) ? Math.max(matchReq - adjAvail, 0) : null;

    if (isAdjusted && adjIncoming > incomingQty && usageRate && usageRate > 0) {
      var addlEA = Math.round((adjIncoming - incomingQty) / usageRate);
      if (addlEA > 0) simResults.push({ matName: item.componentName, delta: adjIncoming - incomingQty, addlEA: addlEA, unit: item.unit });
    }

    tot.req         += matchReq;
    tot.opening     += (openingQty !== null ? openingQty : 0);
    tot.incoming    += incomingQty;
    tot.adjIncoming += adjIncoming;
    if (shortage === null) tot.unknownCount++;
    else if (shortage > 0) { tot.shortage += shortage; tot.shortageCount++; }
    if (adjShortage !== null && adjShortage > 0) { tot.adjShortage += adjShortage; tot.adjShortageCount++; }

    function fmtV(v) { return v !== null && isFinite(v) ? escapeHtml(_cstFmtVal(v, dec, item.unit)) : "-"; }

    var usageDisp  = usageRate !== null ? escapeHtml(_cstFmtVal(usageRate, 4, "")) : "-";
    var prodDisp   = matchProd > 0 ? formatNumber(Math.round(matchProd)) : "-";
    var reqDisp    = matchReq  > 0 ? fmtV(matchReq) : "-";
    var openDisp   = openingQty !== null ? fmtV(openingQty) : (item.hasInventory ? "-" : "미연결");

    var incomDelta = adjIncoming - incomingQty;
    var incomCell  = "<input type=\"number\" class=\"mat-sim-input\" " +
      "data-key=\"" + escapeHtml(simKey) + "\" data-orig=\"" + incomingQty + "\" " +
      "value=\"" + adjIncoming + "\" min=\"0\" step=\"1\" />" +
      (isAdjusted ? "<span class=\"mat-sim-delta " + (incomDelta > 0 ? "mat-sim-pos" : "mat-sim-neg") + "\">" +
        (incomDelta > 0 ? "+" : "") + formatNumber(Math.round(incomDelta)) + "</span>" : "");

    var showShortage = hasAnyAdj ? adjShortage : shortage;
    var shortCls  = showShortage === null ? "cst-imp-adj" : showShortage > 0 ? "cst-ss-short-num" : "";
    var shortDisp = showShortage === null ? "확정불가" : showShortage > 0 ? fmtV(showShortage) : "-";
    if (isAdjusted && shortage !== null && adjShortage !== null) {
      var sDelta = adjShortage - shortage;
      if (Math.abs(sDelta) > 0.01) {
        shortDisp += "<span class=\"mat-sim-delta " + (sDelta < 0 ? "mat-sim-pos" : "mat-sim-neg") + "\">" +
          (sDelta < 0 ? "" : "+") + formatNumber(Math.round(sDelta)) + "</span>";
      }
    }

    var rowCls      = showShortage > 0 ? " cst-mat-shortage-row" : showShortage === null ? " cst-mat-unknown-row" : "";
    var sharedBadge = item.isShared ? " <span class=\"cst-shared-badge\">공용</span>" : "";

    return "<tr class=\"" + rowCls + "\">" +
      "<td>" + escapeHtml(item.componentCode) + "</td>" +
      "<td>" + escapeHtml(item.componentName) + sharedBadge + "</td>" +
      "<td>" + escapeHtml(displayPlantName(item.plant)) + "</td>" +
      "<td>" + escapeHtml(item.unit || "-") + "</td>" +
      "<td class=\"cst-drill-usage\">" + usageDisp + "</td>" +
      "<td>" + reqDisp + "</td>" +
      "<td>" + openDisp + "</td>" +
      "<td class=\"mat-sim-incoming-cell" + (isAdjusted ? " mat-sim-adjusted" : "") + "\">" + incomCell + "</td>" +
      "<td class=\"" + shortCls + "\">" + shortDisp + "</td>" +
      "</tr>";
  }).join("");

  var totIncomDisp = hasAnyAdj && Math.abs(tot.adjIncoming - tot.incoming) > 0.01
    ? formatNumber(Math.round(tot.adjIncoming)) +
      "<span class=\"mat-sim-delta " + (tot.adjIncoming > tot.incoming ? "mat-sim-pos" : "mat-sim-neg") + "\">(" +
      (tot.adjIncoming > tot.incoming ? "+" : "") + formatNumber(Math.round(tot.adjIncoming - tot.incoming)) + ")</span>"
    : formatNumber(Math.round(tot.incoming));

  var totShortVal   = hasAnyAdj ? tot.adjShortage : tot.shortage;
  var totShortCount = hasAnyAdj ? tot.adjShortageCount : tot.shortageCount;
  var totShortDisp  = totShortCount > 0
    ? formatNumber(Math.round(totShortVal)) + " (" + totShortCount + "종)"
    : tot.unknownCount > 0 ? "확정불가 " + tot.unknownCount + "종" : "-";
  if (hasAnyAdj && Math.abs(tot.adjShortage - tot.shortage) > 0.01) {
    var sTotDelta = tot.adjShortage - tot.shortage;
    totShortDisp += "<span class=\"mat-sim-delta " + (sTotDelta < 0 ? "mat-sim-pos" : "mat-sim-neg") + "\">" +
      (sTotDelta < 0 ? "" : "+") + formatNumber(Math.round(sTotDelta)) + "</span>";
  }

  var totalRow = "<tr class=\"cst-imp-total\">" +
    "<td colspan=\"5\" class=\"cst-imp-total-label\">합계 · " + escapeHtml(monthLabel(targetMonth)) + " 기준</td>" +
    "<td class=\"cst-imp-total-num\">" + formatNumber(Math.round(tot.req)) + "</td>" +
    "<td class=\"cst-imp-total-num\">" + formatNumber(Math.round(tot.opening)) + "</td>" +
    "<td class=\"cst-imp-total-num mat-sim-incoming-cell" + (hasAnyAdj ? " mat-sim-adjusted" : "") + "\">" + totIncomDisp + "</td>" +
    "<td class=\"cst-imp-total-num" + (totShortCount > 0 ? " cst-ss-short-num" : "") + "\">" + totShortDisp + "</td>" +
    "</tr>";

  // ── 조정 후 RTF 영향 계산 ────────────────────────────────────────────────
  var rtfImpactHtml = "";
  if (hasAnyAdj && typeof buildBomMaxProducibleMap === "function") {
    var adjBomMap = buildBomMaxProducibleMap(state.matSimAdj);
    var affParents = [], seenPk = new Set();
    relatedItems.forEach(function(item) {
      item.parentItems.forEach(function(p) {
        if (!codes.has(p.code)) return;
        if (plantFilter && p.plant !== plantFilter) return;
        var pk = p.code + "|" + (p.plant || "");
        if (seenPk.has(pk)) return;
        seenPk.add(pk);
        affParents.push({ code: p.code, name: p.name, plant: p.plant || "" });
      });
    });
    if (affParents.length > 0) {
      var rpMap = new Map(), rbMap = new Map();
      state.mappedData.plan_monthly.forEach(function(r) {
        var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant) || "", month = cleanOptional(r.month);
        if (!code || !month) return;
        var k = code + "|" + plant + "|" + month;
        if (!rpMap.has(k)) rpMap.set(k, { salesQty: 0, supplyQty: 0 });
        rpMap.get(k).salesQty  += cleanNumber(r.salesQty)  || 0;
        rpMap.get(k).supplyQty += cleanNumber(r.supplyQty) || 0;
      });
      state.mappedData.inventory_base.forEach(function(r) {
        var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant) || "";
        if (!code) return;
        var k = code + "|" + plant;
        rbMap.set(k, (rbMap.get(k) || 0) + (cleanNumber(r.baseQty) || 0));
      });

      var impMH = "<th class=\"cst-rtf-namecol\">완제품</th>" +
        months.map(function(m) {
          return "<th colspan=\"2\" class=\"cst-rtf-mhead\">" + escapeHtml(monthLabel(m)) + "</th>";
        }).join("");
      var impSH = "<th></th>" +
        months.map(function() {
          return "<th class=\"cst-rtf-sub\">조정 전</th><th class=\"cst-rtf-sub\">조정 후</th>";
        }).join("");

      var impRows = affParents.map(function(p) {
        var op = rbMap.get(p.code + "|" + p.plant) || 0, opAdj = op;
        var cells = months.map(function(month) {
          var pm = rpMap.get(p.code + "|" + p.plant + "|" + month) || { salesQty: 0, supplyQty: 0 };
          var sales = pm.salesQty, supply = pm.supplyQty;
          var sb = Math.max(0, sales - (op + supply));
          var aMax = adjBomMap.get(p.code + "|" + p.plant + "|" + month);
          var aq   = aMax !== undefined ? Math.min(supply, aMax) : supply;
          var sa   = Math.max(0, sales - (opAdj + aq));
          op    = Math.max(0, op    + supply - sales);
          opAdj = Math.max(0, opAdj + aq     - sales);
          var bc = sb > 0 ? "cst-rtf-s" : "cst-rtf-ok";
          var bl = sb > 0 ? "부족" : "-";
          var improved = sb > 0 && sa === 0, partial = sb > 0 && sa > 0 && sa < sb;
          var ac = improved ? "cst-rtf-improved" : partial ? "cst-rtf-partial" : bc;
          var al = improved ? "✓ 해소" : partial ? "△ 개선" : bl;
          return "<td class=\"" + bc + "\">" + escapeHtml(bl) + "</td>" +
                 "<td class=\"" + ac + "\">" + escapeHtml(al) + "</td>";
        }).join("");
        return "<tr><td class=\"cst-rtf-name\">" + escapeHtml(p.name) + "</td>" + cells + "</tr>";
      }).join("");

      rtfImpactHtml =
        "<div class=\"mat-rtf-impact-panel\">" +
        "<div class=\"mat-rtf-impact-title\">조정 후 RTF 영향</div>" +
        "<div class=\"cst-det-scroll\"><table class=\"mat-rtf-impact-table\"><thead>" +
        "<tr>" + impMH + "</tr><tr>" + impSH + "</tr>" +
        "</thead><tbody>" + impRows + "</tbody></table></div></div>";
    }
  }

  var simPanel = "";
  if (hasAnyAdj) {
    var resultLines = simResults.length > 0
      ? simResults.map(function(r) {
          return "<div class=\"mat-sim-result-row\">" +
            "<span class=\"mat-sim-mat-name\">" + escapeHtml(r.matName) + "</span>" +
            " 입고 +" + formatNumber(Math.round(r.delta)) + " " + escapeHtml(r.unit || "") +
            " → 최대 <strong>+" + formatNumber(r.addlEA) + " EA</strong> 추가 생산 가능</div>";
        }).join("")
      : "<div class=\"mat-sim-result-row\">입고계획 감소 또는 영향 없음</div>";

    simPanel = "<div class=\"mat-sim-result-panel\">" +
      "<div class=\"mat-sim-result-title\">시뮬레이션 결과 · " + escapeHtml(monthLabel(targetMonth)) + "</div>" +
      resultLines + "</div>" +
      rtfImpactHtml +
      "<div class=\"mat-sim-actions\">" +
      "<button class=\"mat-sim-record-btn\" data-month=\"" + escapeHtml(targetMonth) + "\">결정사항 회의록에 기록</button>" +
      "<button class=\"mat-sim-reset-btn\">조정 초기화</button>" +
      "</div>";
  } else {
    simPanel = "<div class=\"mat-sim-hint\">입고계획 수치를 수정하면 부족수량이 실시간으로 재계산됩니다.</div>";
  }

  var sharedNote = hasShared
    ? "<div class=\"cst-imp-note\">공용자재 포함 — 기초재고·입고계획은 전체 완제품 공용이므로 실제 가용수량은 배분 기준 별도 확인 필요</div>"
    : "";

  return "<div class=\"cst-det-section\" style=\"margin:12px 0;\">" +
    "<div class=\"cst-det-section-title\">부족 자재 리스트 · " + escapeHtml(monthLabel(targetMonth)) + " (" + relatedItems.length + "건)" +
    (hasAnyAdj ? " <span class=\"mat-sim-badge\">시뮬레이션 적용 중</span>" : "") + "</div>" +
    sharedNote +
    "<div class=\"cst-det-scroll\"><table class=\"cst-ss-table cst-drill-goods-table cst-mat-panel-table\"><thead><tr>" +
    "<th>자재코드</th><th>자재명</th><th>플랜트</th><th>단위</th>" +
    "<th>개당<br>소요량</th><th>필요수량</th><th>기초재고</th><th>입고계획</th><th>부족수량</th>" +
    "</tr></thead><tbody>" + rows + totalRow + "</tbody></table></div>" +
    simPanel + "</div>";
}

// ── 요약 카드 ─────────────────────────────────────────────────────────────────
function renderConstraintSummaryCard(result) {
  var s = result.stats;
  var fmtTime = result.completedAt
    ? result.completedAt.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit", second:"2-digit" })
    : "-";
  var items = [
    { label:"전개상태",              value:"완료",                                                                      cls:"ok"       },
    { label:"전개완료시각",          value:fmtTime,                                                                     cls:""         },
    { label:"확정 부족 제약대상",    value:s.totalConstraints  > 0 ? s.totalConstraints  + "건" : "-",   cls:s.totalConstraints  > 0 ? "shortage" : "" },
    { label:"공용자재 제약",         value:s.sharedConstraints > 0 ? s.sharedConstraints + "건" : "-",   cls:s.sharedConstraints > 0 ? "warn"     : "" },
    { label:"전용자재 부족",         value:s.dedicatedShortage > 0 ? s.dedicatedShortage + "건" : "-",   cls:s.dedicatedShortage > 0 ? "shortage" : "" },
    { label:"반제품 조달구분 확인",  value:s.provenanceCheck   > 0 ? s.provenanceCheck   + "건" : "-",   cls:s.provenanceCheck   > 0 ? "warn"     : "" },
    { label:"품목유형 확인 필요",    value:s.categoryUnknown   > 0 ? s.categoryUnknown   + "건" : "-",   cls:s.categoryUnknown   > 0 ? "warn"     : "" },
    { label:"현재고 미연결",         value:s.noInventory       > 0 ? s.noInventory       + "건" : "-",   cls:s.noInventory       > 0 ? "warn"     : "" },
    { label:"입고계획 미연결",       value:s.noSupplyPlan      > 0 ? s.noSupplyPlan      + "건" : "-",   cls:s.noSupplyPlan      > 0 ? "warn"     : "" },
    { label:"부족 확정 불가",        value:s.indeterminate     > 0 ? s.indeterminate     + "건" : "-",   cls:s.indeterminate     > 0 ? "warn"     : "" },
    { label:"BOM 코드 누락",         value:s.missingCompCode   > 0 ? s.missingCompCode   + "행" : "-",   cls:s.missingCompCode   > 0 ? "warn"     : "" },
  ];
  return "<section class=\"cst-card cst-summary-card\"><div class=\"cst-summary-grid\">" +
    items.map(function(i) {
      return "<div class=\"cst-sum-item\"><div class=\"cst-sum-label\">" + escapeHtml(i.label) +
             "</div><div class=\"cst-sum-value" + (i.cls ? " " + i.cls : "") + "\">" + escapeHtml(i.value) + "</div></div>";
    }).join("") + "</div></section>";
}

// ── 필터 바 (상세보기 토글 포함) ─────────────────────────────────────────────
function renderConstraintFilterBar(allItems) {
  var f          = state.constraintFilter || "all";
  var detailMode = state.constraintDetailMode;
  var filters = [
    { key:"all",           label:"전체",           count:allItems.length },
    { key:"shortage",      label:"확정 부족",       count:allItems.filter(function(i) { return i.hasAnyShortage; }).length },
    { key:"shared",        label:"공용자재",        count:allItems.filter(function(i) { return i.isShared && i.hasAnyShortage; }).length },
    { key:"dedicated",     label:"전용자재",        count:allItems.filter(function(i) { return !i.isShared && i.hasAnyShortage; }).length },
    { key:"indeterminate", label:"확정 불가",       count:allItems.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan || i.unitMismatch; }).length },
    { key:"need-data",     label:"데이터 미연결",   count:allItems.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan; }).length },
    { key:"provenance",    label:"반제품 조달구분", count:allItems.filter(function(i) { return i.needsProvenanceCheck; }).length },
  ];
  var btns = filters.map(function(ft) {
    return "<button type=\"button\" class=\"cst-filter-btn" + (f === ft.key ? " active" : "") +
           "\" data-cst-filter=\"" + escapeHtml(ft.key) + "\">" + escapeHtml(ft.label) +
           "<span class=\"cst-filter-count\">" + ft.count + "</span></button>";
  }).join("");
  var toggleBtn = "<button type=\"button\" class=\"cst-detail-toggle" + (detailMode ? " active" : "") +
                  "\" id=\"cstDetailToggle\">월별 상세보기</button>";
  return "<div class=\"cst-filter-bar\">" +
         "<div class=\"cst-filter-btns\">" + btns + "</div>" +
         "<div class=\"cst-filter-right\">" + toggleBtn +
         "<input type=\"search\" class=\"cst-search\" id=\"cstSearch\" placeholder=\"자재코드·자재명·영향품목 검색\" value=\"" +
         escapeHtml(state.constraintSearch || "") + "\"></div></div>";
}

// ── 의사결정 필요사항 ────────────────────────────────────────────────────────
function decisionLabel(item) {
  if (item.needsProvenanceCheck)                 return "반제품 조달구분 확인 필요";
  if (item.categoryUnknown)                      return "품목유형 확인 필요";
  if (item.needsMaster)                          return "기준정보 확인 필요";
  if (item.unitMismatch)                         return "단위 정합 확인 필요";
  if (!item.hasInventory && !item.hasSupplyPlan) return "현재고·입고계획 연결 필요";
  if (!item.hasInventory)                        return "현재고 연결 필요";
  if (!item.hasSupplyPlan)                       return "입고계획 확인 필요";
  if (item.isShared && item.hasAnyShortage)      return "공용자재 배분기준 필요";
  if (item.hasAltBom && item.hasAnyShortage)     return "대체BOM 검토 필요";
  if (item.hasAnyShortage)                       return "긴급입고 검토 필요";
  return "-";
}
var DECISION_CLS = {
  "긴급입고 검토 필요":         "cst-dec-urgent",
  "공용자재 배분기준 필요":     "cst-dec-warn",
  "대체BOM 검토 필요":          "cst-dec-info",
  "반제품 조달구분 확인 필요":  "cst-dec-check",
  "품목유형 확인 필요":         "cst-dec-check",
  "현재고 연결 필요":           "cst-dec-link",
  "현재고·입고계획 연결 필요":  "cst-dec-link",
  "입고계획 확인 필요":         "cst-dec-link",
  "공급계획 연결 필요":         "cst-dec-link",
  "단위 정합 확인 필요":        "cst-dec-check",
  "기준정보 확인 필요":         "cst-dec-check",
};
function decisionCls(label) { return DECISION_CLS[label] || "cst-dec-neutral"; }

// ── 단위별 표시 정밀도 ───────────────────────────────────────────────────────
function _cstDecByUnit(unit) {
  var u = (unit || "").trim().toUpperCase();
  if (/^(KG|L|KL)$/.test(u))                                         return 4;
  if (/^(G|ML|MG)$/.test(u))                                         return 3;
  if (/^(TB|EA|SH|ROL|PCS|정|매|개|병|봉|캔|포|통|박|SET)$/.test(u)) return 0;
  return 4;
}
// v > 0 전제. 반올림 결과가 0이면 "<최소단위" 반환 (plain text, 호출측에서 escapeHtml)
function _cstFmtVal(v, dec, unit) {
  var suf = unit ? " " + unit : "";
  if (!v || !isFinite(v) || v <= 0) return "-";
  if (dec === 0) {
    var r0 = Math.round(v);
    return r0 === 0 ? ("<1" + suf) : (formatNumber(r0) + suf);
  }
  var factor = Math.pow(10, dec);
  var r = Math.round(v * factor) / factor;
  if (r === 0) return "<0." + "0".repeat(dec - 1) + "1" + suf;
  return r.toLocaleString("ko-KR", { maximumFractionDigits: dec, minimumFractionDigits: 0 }) + suf;
}

// ── 압축 셀 계산 ─────────────────────────────────────────────────────────────
function compactCellValue(item, md) {
  if (item.needsProvenanceCheck) return { text:"조달구분 확인", cls:"cst-neutral-cell" };
  if (item.unitMismatch)         return { text:"단위 판단불가", cls:"cst-neutral-cell" };
  if (!item.hasInventory)        return { text:"현재고 연결필요", cls:"cst-neutral-cell" };
  if (!item.hasSupplyPlan)       return { text:"입고계획 확인", cls:"cst-neutral-cell" };
  if (md.shortageQty === null)   return { text:"판단불가",      cls:"cst-neutral-cell" };
  if (md.shortageQty > 0) {
    var matUnit = (item.unit && item.unit !== "확인필요") ? item.unit : "";
    var qty = _cstFmtVal(md.shortageQty, _cstDecByUnit(matUnit), matUnit);
    if (item.isShared) return { text:"공통제약 " + qty, cls:"cst-compact-shared" };
    return { text:"자재 부족 " + qty, cls:"cst-shortage-cell" };
  }
  return { text:"-", cls:"cst-neutral-cell" };
}

// ── 정합성 검증 헬퍼 ─────────────────────────────────────────────────────────
function vldNum(v) {
  if (v === null || v === undefined) return "-";
  var n = (typeof v === "number") ? v : cleanNumber(v);
  if (n === null || n === undefined || !isFinite(n) || isNaN(n)) return "-";
  return formatNumber(Math.round(n));
}
function vldRatio(v) {
  if (v === null || v === undefined || !isFinite(v) || isNaN(v)) return "-";
  return v.toFixed(4);
}
var VLD_STATUS_CLS = {
  "정상":"vld-s-ok","연결필요":"vld-s-link","확인필요":"vld-s-check",
  "단위 정합 확인":"vld-s-unit","판단불가":"vld-s-unknown","자재 부족":"vld-s-short",
};
function vldBadge(status) {
  var cls = VLD_STATUS_CLS[status] || "vld-s-check";
  return "<span class=\"vld-badge " + cls + "\">" + escapeHtml(status || "확인필요") + "</span>";
}

// ── 정합성 검증 계산 ─────────────────────────────────────────────────────────
function computeValidation() {
  var planRows      = state.mappedData.plan_monthly;
  var inventoryRows = state.mappedData.inventory_base;
  var bomRows       = state.mappedData.bom_components;
  var masterRows    = state.mappedData.item_master;
  var months        = getRtfMonths();
  var items         = (state.bomResult && state.bomResult.items) || [];

  var baseBomRows = bomRows.filter(function(r) {
    var alt = cleanOptional(r.alternativeBom); return alt === "" || alt === "1";
  });

  // 완제품 생산계획 map
  var prodPlanMap = new Map();
  planRows.forEach(function(r) {
    var code = cleanOptional(r.itemCode);
    if (!code || !code.startsWith("9")) return;
    var key = code + "|" + cleanOptional(r.plant) + "|" + cleanOptional(r.month);
    prodPlanMap.set(key, (prodPlanMap.get(key) || 0) + (cleanNumber(r.supplyQty) || 0));
  });
  // 현재고 map
  var inventoryMap = new Map();
  inventoryRows.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant);
    if (!code || !plant) return;
    var key = code + "|" + plant;
    var qty = cleanNumber(r.baseQty) || 0, unit = cleanOptional(r.unit) || "";
    var ex = inventoryMap.get(key);
    if (ex) { ex.qty += qty; if (!ex.unit && unit) ex.unit = unit; }
    else inventoryMap.set(key, { qty:qty, unit:unit });
  });
  // 공급계획 map
  var supplyMap = new Map();
  planRows.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant), month = cleanOptional(r.month);
    if (!code || !plant || !month) return;
    var key = code + "|" + plant + "|" + month;
    var qty = cleanNumber(r.supplyQty) || 0, unit = cleanOptional(r.unit) || "";
    var ex = supplyMap.get(key);
    if (ex) { ex.qty += qty; if (!ex.unit && unit) ex.unit = unit; }
    else supplyMap.set(key, { qty:qty, unit:unit });
  });
  // 기준정보 map
  var masterMap = new Map();
  masterRows.forEach(function(r) { if (r.itemCode && !masterMap.has(r.itemCode)) masterMap.set(r.itemCode, r); });

  // ① 대상 품목 검증
  var planKeys9 = new Set(), planKeys7 = new Set(); var missingKeyRows = 0;
  planRows.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant);
    if (!code || !plant) { missingKeyRows++; return; }
    if (code.startsWith("9")) planKeys9.add(code + "|" + plant);
    else if (code.startsWith("7")) planKeys7.add(code + "|" + plant);
  });
  var semiInBomRoot = new Set();
  bomRows.forEach(function(r) { if (r.rootItemCode && r.rootItemCode.startsWith("8")) semiInBomRoot.add(r.rootItemCode); });
  var _bs = (state.bomResult && state.bomResult.stats) || {};
  var sec1 = {
    totalRtf:         planKeys9.size + planKeys7.size,
    codes9:           planKeys9.size,
    codes7:           planKeys7.size,
    semiInRoot:       semiInBomRoot.size,
    missingKey:       missingKeyRows,
    semiList:         Array.from(semiInBomRoot),
    // BOM 구조 통계 (BOM 전개 결과)
    multiLevelRoots:  _bs.multiLevelRoots  || 0,
    singleLevelRoots: _bs.singleLevelRoots || 0,
    semiExpanded:     _bs.semiExpanded     || 0,
    semiNoSubBom:     _bs.semiNoSubBom     || 0,
    dupExactCount:    _bs.dupExactCount    || 0,
    dupInRootCount:   _bs.dupInRootCount   || 0,
  };

  // ② BOM 매칭 검증
  var bomRoots9 = new Set();
  baseBomRows.forEach(function(r) {
    if (r.rootItemCode && r.rootItemCode.startsWith("9")) bomRoots9.add(r.rootItemCode + "|" + r.plant);
  });
  var unmatchedList = [];
  planKeys9.forEach(function(k) {
    if (!bomRoots9.has(k)) { var p = k.split("|"); unmatchedList.push({ code:p[0], plant:p[1] }); }
  });
  var altBomRoots = new Set();
  bomRows.forEach(function(r) {
    if (!r.rootItemCode || !r.rootItemCode.startsWith("9")) return;
    var alt = cleanOptional(r.alternativeBom);
    if (alt !== "" && alt !== "1") altBomRoots.add(r.rootItemCode + "|" + r.plant);
  });
  var missingBase = 0, missingComp = 0, missingCode = 0;
  baseBomRows.forEach(function(r) {
    if (!r.rootItemCode || !r.rootItemCode.startsWith("9")) return;
    if (!r.componentCode || !String(r.componentCode).trim()) { missingCode++; return; }
    var bq = cleanNumber(r.baseQty);
    if (!bq || bq === 0) missingBase++;
    if (cleanNumber(r.componentQty) === null) missingComp++;
  });
  var sec2 = {
    target9:planKeys9.size, matched:planKeys9.size - unmatchedList.length,
    unmatched:unmatchedList.length, multiAlt:altBomRoots.size,
    missingBase:missingBase, missingComp:missingComp, missingCode:missingCode,
    unmatchedList:unmatchedList,
  };

  // ③ BOM 수량 검증 (부족·판단불가 대상)
  var targetItems = items.filter(function(i) { return i.hasAnyShortage || i.unitMismatch || !i.hasInventory; });
  var sec3 = [];
  targetItems.forEach(function(item) {
    baseBomRows.forEach(function(bom) {
      if (!bom.componentCode || bom.componentCode !== item.componentCode || bom.plant !== item.plant) return;
      if (!bom.rootItemCode || !bom.rootItemCode.startsWith("9")) return;
      var baseQty = cleanNumber(bom.baseQty), compQty = cleanNumber(bom.componentQty);
      var ratio = (baseQty && baseQty > 0 && compQty !== null) ? compQty / baseQty : null;
      var totalProd = months.reduce(function(s, m) {
        return s + (prodPlanMap.get(bom.rootItemCode + "|" + bom.plant + "|" + m) || 0);
      }, 0);
      sec3.push({
        rootCode:cleanText(bom.rootItemCode, "확인필요"),
        rootName:cleanText(bom.rootItemName, bom.rootItemCode || "확인필요"),
        compCode:item.componentCode, compName:item.componentName,
        plant:item.plant, baseQty:baseQty, compQty:compQty, ratio:ratio,
        totalProd:totalProd, totalReq:(ratio !== null ? totalProd * ratio : null),
      });
    });
  });

  // ④ 현재고 연결 검증
  var sec4 = items.map(function(item) {
    var inv = inventoryMap.get(item.componentCode + "|" + item.plant);
    return { code:item.componentCode, name:item.componentName, plant:item.plant,
             hasInv:!!inv, qty:inv ? inv.qty : null, unit:inv ? inv.unit : "" };
  });

  // ⑤ 공급계획 연결 검증
  var sec5 = items.map(function(item) {
    var md = months.map(function(m) {
      var sd = supplyMap.get(item.componentCode + "|" + item.plant + "|" + m);
      return { month:m, qty:sd ? sd.qty : null, unit:sd ? sd.unit : "" };
    });
    var hasAny = md.some(function(d) { return d.qty !== null && d.qty > 0; });
    var firstUnit = ""; md.some(function(d) { if (d.unit) { firstUnit = d.unit; return true; } return false; });
    return { code:item.componentCode, name:item.componentName, plant:item.plant,
             hasSupply:hasAny, unit:firstUnit, monthly:md };
  });

  // ⑥ 단위 정합 검증
  var sec6 = items.map(function(item) {
    var inv = inventoryMap.get(item.componentCode + "|" + item.plant);
    var invUnit = inv ? inv.unit : "";
    var firstSupplyUnit = "";
    months.some(function(m) {
      var sd = supplyMap.get(item.componentCode + "|" + item.plant + "|" + m);
      if (sd && sd.unit) { firstSupplyUnit = sd.unit; return true; } return false;
    });
    var master = masterMap.get(item.componentCode);
    var masterUnit = cleanOptional(master ? (master.unit || master.unitOfMeasure || master.baseUnit || "") : "") || "";
    var bomUnit = "";
    baseBomRows.some(function(r) {
      if (r.componentCode === item.componentCode && r.plant === item.plant && r.componentUnit) {
        bomUnit = cleanOptional(r.componentUnit) || ""; return true;
      } return false;
    });
    var compareUnit = invUnit || masterUnit;
    var mismatch = !!(bomUnit && compareUnit && bomUnit.toLowerCase() !== compareUnit.toLowerCase());
    var status = mismatch ? "단위 정합 확인" : (!bomUnit && !invUnit && !firstSupplyUnit) ? "확인필요" : "정상";
    return { code:item.componentCode, name:item.componentName,
             bomUnit:bomUnit||"-", invUnit:invUnit||"-", supplyUnit:firstSupplyUnit||"-",
             masterUnit:masterUnit||"-", mismatch:mismatch, status:status };
  });

  // ⑦ 부족 판정 검증
  var sec7 = items.filter(function(i) { return i.hasAnyShortage || i.unitMismatch || !i.hasInventory; })
    .map(function(item) {
      var inv = inventoryMap.get(item.componentCode + "|" + item.plant);
      var monthly = item.monthlyData.map(function(md) {
        var sd = supplyMap.get(item.componentCode + "|" + item.plant + "|" + md.month);
        var supplyQty = sd ? sd.qty : 0;
        var judgment = item.unitMismatch ? "판단불가"
          : !item.hasInventory ? "연결필요"
          : md.shortageQty === null ? "판단불가"
          : md.shortageQty > 0 ? "자재 부족" : "정상";
        return { month:md.month, required:md.requiredQty, supply:supplyQty,
                 available:md.availableQty, shortage:md.shortageQty, judgment:judgment };
      });
      return { code:item.componentCode, name:item.componentName, plant:item.plant,
               baseQty:inv ? inv.qty : null, unitMismatch:item.unitMismatch,
               hasInv:item.hasInventory, monthly:monthly };
    });

  var summary = {
    targetCount:     items.length,
    bomUnmatched:    sec2.unmatched,
    categoryUnknown: items.filter(function(i) { return i.categoryUnknown; }).length,
    needInventory:   items.filter(function(i) { return !i.hasInventory; }).length,
    needSupply:      items.filter(function(i) { return !i.hasSupplyPlan; }).length,
    provenanceCheck: items.filter(function(i) { return i.needsProvenanceCheck; }).length,
    unitMismatch:    sec6.filter(function(r) { return r.mismatch; }).length,
    indeterminate:   items.filter(function(i) { return !i.hasInventory || !i.hasSupplyPlan || i.unitMismatch; }).length,
    shortage:        items.filter(function(i) { return i.hasAnyShortage; }).length,
  };
  // ⑧ BOM 계산 정합 + 플랜트별 자재 분리 검증
  var sec8 = { calcChecks:[], plantSplit:[] };

  items.forEach(function(item) {
    var anyMismatch = false;
    var monthlyCheck = months.map(function(m, mi) {
      var md = item.monthlyData[mi] || {};
      var engineReq = md.requiredQty || 0;
      var parentSum = item.parentItems.reduce(function(s, p) {
        return s + ((p.monthly[mi] && p.monthly[mi].reqQty) || 0);
      }, 0);
      var ok = Math.abs(engineReq - parentSum) < 0.001;
      if (!ok) anyMismatch = true;
      return { month:m, engineReq:engineReq, parentSum:parentSum, ok:ok };
    });
    sec8.calcChecks.push({
      code:item.componentCode, name:item.componentName, plant:item.plant,
      isShared:item.isShared, parentCount:item.parentItems.length,
      monthlyCheck:monthlyCheck, anyMismatch:anyMismatch,
    });
  });

  var codeToItems = new Map();
  items.forEach(function(item) {
    if (!codeToItems.has(item.componentCode)) codeToItems.set(item.componentCode, []);
    codeToItems.get(item.componentCode).push(item);
  });
  codeToItems.forEach(function(itemList, code) {
    if (itemList.length > 1) {
      sec8.plantSplit.push({
        code:code, name:itemList[0].componentName,
        items:itemList.map(function(i) { return { plant:i.plant, isShared:i.isShared, parentCount:i.parentItems.length }; }),
      });
    }
  });

  return { summary:summary, sec1:sec1, sec2:sec2, sec3:sec3, sec4:sec4, sec5:sec5, sec6:sec6, sec7:sec7, sec8:sec8, months:months };
}

// ── 정합성 검증 패널 렌더 ─────────────────────────────────────────────────────
function renderValidationPanel() {
  if (!state.validationPanelOpen || !state.bomResult || state.bomResult.status !== BOM_STATUS.DONE) return "";
  var vd = computeValidation(), tab = state.validationTab || 0, s = vd.summary;
  var kpiItems = [
    { label:"제약 대상",           v:s.targetCount,     warn:false },
    { label:"BOM 미매칭",          v:s.bomUnmatched,    warn:s.bomUnmatched    > 0 },
    { label:"품목유형 확인 필요",   v:s.categoryUnknown, warn:s.categoryUnknown > 0 },
    { label:"현재고 미연결",        v:s.needInventory,   warn:s.needInventory   > 0 },
    { label:"입고계획 미연결",      v:s.needSupply,      warn:s.needSupply      > 0 },
    { label:"반제품 조달구분",      v:s.provenanceCheck, warn:s.provenanceCheck > 0 },
    { label:"단위 정합 확인",       v:s.unitMismatch,    warn:s.unitMismatch    > 0 },
    { label:"부족 확정 불가",       v:s.indeterminate,   warn:s.indeterminate   > 0 },
    { label:"확정 부족",            v:s.shortage,        warn:false, shortage:s.shortage > 0 },
  ];
  var kpiHtml = kpiItems.map(function(k) {
    var cls = k.shortage ? " vld-kpi-shortage" : k.warn ? " vld-kpi-warn" : "";
    return "<div class=\"vld-kpi" + cls + "\"><div class=\"vld-kpi-label\">" + escapeHtml(k.label) +
           "</div><div class=\"vld-kpi-value\">" + k.v + "</div></div>";
  }).join("");
  var tabLabels = ["①대상품목","②BOM매칭","③BOM수량","④현재고","⑤공급계획","⑥단위정합","⑦부족판정","⑧계산·플랜트"];
  var tabBar = tabLabels.map(function(lbl, i) {
    return "<button type=\"button\" class=\"vld-tab-btn" + (i === tab ? " active" : "") +
           "\" data-vld-tab=\"" + i + "\">" + escapeHtml(lbl) + "</button>";
  }).join("");
  var secData = [vd.sec1, vd.sec2, vd.sec3, vd.sec4, vd.sec5, vd.sec6, vd.sec7, vd.sec8];
  var secFns  = [renderVldSec1, renderVldSec2, renderVldSec3, renderVldSec4, renderVldSec5, renderVldSec6, renderVldSec7, renderVldSec8];
  var content = secFns[tab](secData[tab], vd.months);

  return "<div class=\"vld-overlay\" id=\"validationOverlay\">" +
         "<div class=\"vld-panel\">" +
         "<div class=\"vld-panel-header\"><span class=\"vld-panel-title\">정합성 검증</span>" +
         "<button type=\"button\" class=\"vld-close-btn\" id=\"vldCloseBtn\">✕ 닫기</button></div>" +
         "<div class=\"vld-kpi-bar\">" + kpiHtml + "</div>" +
         "<div class=\"vld-tab-bar\">" + tabBar + "</div>" +
         "<div class=\"vld-content\">" + content + "</div>" +
         "</div></div>";
}

function _vldKVTable(rows) {
  return "<table class=\"vld-table vld-kv-table\"><thead><tr><th>검증 항목</th><th>결과</th><th>비고</th></tr></thead>" +
    "<tbody>" + rows.map(function(r) {
      return "<tr><td class=\"vld-td-label\">" + escapeHtml(r.label) + "</td>" +
             "<td class=\"" + (r.warn ? "vld-td-warn" : "vld-td-ok") + "\">" + escapeHtml(String(r.value)) + "</td>" +
             "<td class=\"vld-td-note\">" + escapeHtml(r.note || "") + "</td></tr>";
    }).join("") + "</tbody></table>";
}

function renderVldSec1(s) {
  var base = _vldKVTable([
    { label:"RTF 대상 품목 수 (코드+플랜트 기준)", value: s.totalRtf + "건" },
    { label:"완제품 9코드 수", value: s.codes9 + "건" },
    { label:"상품 7코드 수",   value: s.codes7 + "건" },
    { label:"반제품 8코드 BOM 루트 등록",
      value: s.semiInRoot > 0 ? s.semiInRoot + "건 발견" : "없음", warn: s.semiInRoot > 0,
      note:  s.semiInRoot > 0 ? "공급원인 분석은 9코드 완제품 기준으로만 전개함." : "" },
    { label:"품목코드+플랜트 누락 행",
      value: s.missingKey > 0 ? s.missingKey + "행" : "없음", warn: s.missingKey > 0 },
  ]);
  var bomStructRows = [
    { label:"다단계 BOM 루트 (반제품 경유 감지)", value: s.multiLevelRoots > 0 ? s.multiLevelRoots + "건" : "없음",
      note: s.multiLevelRoots > 0 ? "반제품 하위 원료가 이미 Root BOM에 포함 — 경유단계 처리됨." : "" },
    { label:"단일 단계 루트 (반제품 추가전개 필요)", value: s.singleLevelRoots > 0 ? s.singleLevelRoots + "건" : "없음",
      warn: s.singleLevelRoots > 0 },
    { label:"반제품 추가전개 완료", value: s.semiExpanded > 0 ? s.semiExpanded + "건" : "없음",
      note: s.semiExpanded > 0 ? "반제품 하위 BOM 발견 → 원료/자재 기준으로 연쇄 전개됨." : "" },
    { label:"반제품 하위 BOM 연결 필요", value: s.semiNoSubBom > 0 ? s.semiNoSubBom + "건" : "없음",
      warn: s.semiNoSubBom > 0, note: s.semiNoSubBom > 0 ? "반제품 자체가 부족 판정 대상으로 유지됨 — BOM 연결 권장." : "" },
    { label:"완전 중복 행 (제거됨)", value: s.dupExactCount > 0 ? s.dupExactCount + "행" : "없음",
      note: s.dupExactCount > 0 ? "Root+구성품+수량+플랜트 모두 동일한 행은 1회만 반영." : "" },
    { label:"동일 Root 내 반복 자재 (합산 처리)", value: s.dupInRootCount > 0 ? s.dupInRootCount + "건" : "없음",
      note: s.dupInRootCount > 0 ? "같은 자재가 동일 Root에 복수 등장 — 필요수량 합산 처리됨." : "" },
  ];
  var bomStruct = "<div class=\"vld-sub-title\">BOM 구조 분석</div>" + _vldKVTable(bomStructRows);
  return base +
    (s.semiList && s.semiList.length ?
      "<div class=\"vld-sub-note\">반제품 루트: " + s.semiList.slice(0,10).map(escapeHtml).join(", ") + "</div>" : "") +
    bomStruct;
}

function renderVldSec2(s) {
  var summary = _vldKVTable([
    { label:"9코드 완제품 대상", value: s.target9 + "건" },
    { label:"BOM 매칭 성공",     value: s.matched + "건" },
    { label:"BOM 미매칭",        value: s.unmatched > 0 ? s.unmatched + "건" : "없음", warn: s.unmatched > 0,
      note: s.unmatched > 0 ? "BOM 데이터에 해당 완제품+플랜트 없음." : "" },
    { label:"대체BOM 존재",      value: s.multiAlt > 0 ? s.multiAlt + "건" : "없음", warn: s.multiAlt > 0,
      note: s.multiAlt > 0 ? "기본BOM(1번)만 사용. 대체BOM 제외됨." : "" },
    { label:"BOM 기준수량 누락", value: s.missingBase > 0 ? s.missingBase + "행" : "없음", warn: s.missingBase > 0 },
    { label:"구성요소수량 누락", value: s.missingComp > 0 ? s.missingComp + "행" : "없음", warn: s.missingComp > 0 },
    { label:"구성요소코드 누락", value: s.missingCode > 0 ? s.missingCode + "행" : "없음", warn: s.missingCode > 0,
      note: s.missingCode > 0 ? "해당 행은 집계에서 제외됨." : "" },
  ]);
  var detail = s.unmatchedList.length === 0 ? "" :
    "<div class=\"vld-sub-title\">BOM 미매칭 목록</div>" +
    "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr><th>완제품코드</th><th>플랜트</th></tr></thead><tbody>" +
    s.unmatchedList.slice(0, 50).map(function(r) {
      return "<tr><td>" + escapeHtml(r.code) + "</td><td>" + escapeHtml(displayPlantName(r.plant)) + "</td></tr>";
    }).join("") + "</tbody></table></div>";
  return summary + detail;
}

function renderVldSec3(rows) {
  if (!rows || rows.length === 0) return "<div class=\"vld-empty\">부족·판단불가 대상 없음</div>";
  var bodyHtml = rows.slice(0, 100).map(function(r) {
    return "<tr><td>" + escapeHtml(r.rootCode) + "</td>" +
           "<td class=\"vld-td-left\">" + escapeHtml(r.rootName) + "</td>" +
           "<td>" + escapeHtml(r.compCode) + "</td>" +
           "<td class=\"vld-td-left\">" + escapeHtml(r.compName) + "</td>" +
           "<td class=\"vld-td-r\">" + vldNum(r.baseQty) + "</td>" +
           "<td class=\"vld-td-r\">" + vldNum(r.compQty) + "</td>" +
           "<td class=\"vld-td-r\">" + vldRatio(r.ratio) + "</td>" +
           "<td class=\"vld-td-r\">" + vldNum(r.totalProd) + "</td>" +
           "<td class=\"vld-td-r\">" + vldNum(r.totalReq) + "</td></tr>";
  }).join("");
  return "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr>" +
    "<th>완제품코드</th><th>완제품명</th><th>하위품목코드</th><th>하위품목명</th>" +
    "<th class=\"vld-th-r\">BOM 기준수량</th><th class=\"vld-th-r\">구성요소수량</th>" +
    "<th class=\"vld-th-r\">BOM 환산계수</th><th class=\"vld-th-r\">총생산계획</th><th class=\"vld-th-r\">총 자재 필요수량</th>" +
    "</tr></thead><tbody>" + bodyHtml + "</tbody></table></div>" +
    (rows.length > 100 ? "<div class=\"vld-sub-note\">전체 " + rows.length + "건 중 100건 표시</div>" : "");
}

function renderVldSec4(rows) {
  if (!rows || rows.length === 0) return "<div class=\"vld-empty\">제약 대상 없음</div>";
  return "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr>" +
    "<th>하위품목코드</th><th>하위품목명</th><th>플랜트</th><th>현재고 연결</th>" +
    "<th class=\"vld-th-r\">현재고 수량</th><th>단위</th>" +
    "</tr></thead><tbody>" + rows.map(function(r) {
      return "<tr><td>" + escapeHtml(r.code) + "</td>" +
             "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
             "<td>" + escapeHtml(displayPlantName(r.plant)) + "</td>" +
             "<td>" + vldBadge(r.hasInv ? "정상" : "연결필요") + "</td>" +
             "<td class=\"vld-td-r\">" + vldNum(r.qty) + "</td>" +
             "<td>" + escapeHtml(r.unit || "-") + "</td></tr>";
    }).join("") + "</tbody></table></div>";
}

function renderVldSec5(rows, months) {
  if (!rows || rows.length === 0) return "<div class=\"vld-empty\">제약 대상 없음</div>";
  var mHeads = months.map(function(m) { return "<th class=\"vld-th-r\">" + escapeHtml(monthLabel(m)) + "</th>"; }).join("");
  return "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr>" +
    "<th>하위품목코드</th><th>하위품목명</th><th>플랜트</th><th>공급계획 연결</th><th>단위</th>" + mHeads +
    "</tr></thead><tbody>" + rows.map(function(r) {
      var mCells = r.monthly.map(function(md) {
        return "<td class=\"vld-td-r\">" + (md.qty !== null && md.qty > 0 ? vldNum(md.qty) : "-") + "</td>";
      }).join("");
      return "<tr><td>" + escapeHtml(r.code) + "</td>" +
             "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
             "<td>" + escapeHtml(displayPlantName(r.plant)) + "</td>" +
             "<td>" + vldBadge(r.hasSupply ? "정상" : "연결필요") + "</td>" +
             "<td>" + escapeHtml(r.unit || "-") + "</td>" + mCells + "</tr>";
    }).join("") + "</tbody></table></div>";
}

function renderVldSec6(rows) {
  if (!rows || rows.length === 0) return "<div class=\"vld-empty\">제약 대상 없음</div>";
  return "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr>" +
    "<th>하위품목코드</th><th>하위품목명</th>" +
    "<th>BOM 단위</th><th>현재고 단위</th><th>공급계획 단위</th><th>기준정보 단위</th><th>단위 정합</th>" +
    "</tr></thead><tbody>" + rows.map(function(r) {
      return "<tr><td>" + escapeHtml(r.code) + "</td>" +
             "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
             "<td>" + escapeHtml(r.bomUnit) + "</td><td>" + escapeHtml(r.invUnit) + "</td>" +
             "<td>" + escapeHtml(r.supplyUnit) + "</td><td>" + escapeHtml(r.masterUnit) + "</td>" +
             "<td>" + vldBadge(r.status) + "</td></tr>";
    }).join("") + "</tbody></table></div>";
}

function renderVldSec7(rows, months) {
  if (!rows || rows.length === 0) return "<div class=\"vld-empty\">부족·판단불가 대상 없음</div>";
  var mHeads = months.map(function(m) {
    return "<th class=\"vld-month-head\" colspan=\"5\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHeads = months.map(function() {
    return "<th class=\"vld-th-r\">필요</th><th class=\"vld-th-r\">공급계획</th>" +
           "<th class=\"vld-th-r\">가용</th><th class=\"vld-th-r\">자재 부족수량</th><th>판정</th>";
  }).join("");
  var bodyHtml = rows.map(function(r) {
    var mCells = r.monthly.map(function(md) {
      var avail = md.available === null ? "-" : vldNum(md.available);
      var short = md.shortage === null ? "-"
        : md.shortage > 0 ? "<span class=\"vld-short-num\">" + vldNum(md.shortage) + "</span>" : "-";
      return "<td class=\"vld-td-r\">" + vldNum(md.required) + "</td>" +
             "<td class=\"vld-td-r\">" + (md.supply > 0 ? vldNum(md.supply) : "-") + "</td>" +
             "<td class=\"vld-td-r\">" + avail + "</td>" +
             "<td class=\"vld-td-r\">" + short + "</td>" +
             "<td>" + vldBadge(md.judgment) + "</td>";
    }).join("");
    return "<tr><td>" + escapeHtml(r.code) + "</td>" +
           "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
           "<td>" + escapeHtml(displayPlantName(r.plant)) + "</td>" +
           "<td class=\"vld-td-r\">" + vldNum(r.baseQty) + "</td>" +
           mCells + "</tr>";
  }).join("");
  return "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead>" +
    "<tr><th>하위품목코드</th><th>하위품목명</th><th>플랜트</th><th class=\"vld-th-r\">기초재고</th>" + mHeads + "</tr>" +
    "<tr><th></th><th></th><th></th><th></th>" + subHeads + "</tr>" +
    "</thead><tbody>" + bodyHtml + "</tbody></table></div>";
}

function renderVldSec8(s, months) {
  var mismatchCount = s.calcChecks.filter(function(r) { return r.anyMismatch; }).length;
  var summaryHtml = _vldKVTable([
    { label:"BOM 계산 검증 대상 자재", value:s.calcChecks.length + "건" },
    { label:"계산 불일치",
      value:mismatchCount === 0 ? "없음" : mismatchCount + "건",
      warn:mismatchCount > 0,
      note:mismatchCount === 0 ? "엔진 집계 = Σ 완제품별 기여 합계 — 정상" : "불일치 항목 확인 필요" },
    { label:"동일 자재코드 복수 플랜트",
      value:s.plantSplit.length === 0 ? "없음" : s.plantSplit.length + "건",
      note:s.plantSplit.length > 0 ? "각 플랜트별 별도 행으로 분리 관리 중 (정상)" : "" },
  ]);

  // 계산 정합
  var calcHtml;
  var mismatches = s.calcChecks.filter(function(r) { return r.anyMismatch; });
  if (mismatches.length > 0) {
    var mHeads = months.map(function(m) {
      return "<th class=\"vld-month-head\" colspan=\"3\">" + escapeHtml(monthLabel(m)) + "</th>";
    }).join("");
    var subHeads = months.map(function() {
      return "<th class=\"vld-th-r\">엔진</th><th class=\"vld-th-r\">부모합</th><th>정합</th>";
    }).join("");
    var rows = mismatches.map(function(r) {
      var mCells = r.monthlyCheck.map(function(mc) {
        return "<td class=\"vld-td-r\">" + vldNum(mc.engineReq) + "</td>" +
               "<td class=\"vld-td-r\">" + vldNum(mc.parentSum) + "</td>" +
               "<td>" + vldBadge(mc.ok ? "정상" : "불일치") + "</td>";
      }).join("");
      return "<tr><td>" + escapeHtml(r.code) + "</td>" +
             "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
             "<td>" + escapeHtml(displayPlantName(r.plant)) + "</td>" + mCells + "</tr>";
    }).join("");
    calcHtml = "<div class=\"vld-sub-title\">계산 불일치 자재 목록</div>" +
      "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead>" +
      "<tr><th>자재코드</th><th>자재명</th><th>플랜트</th>" + mHeads + "</tr>" +
      "<tr><th></th><th></th><th></th>" + subHeads + "</tr>" +
      "</thead><tbody>" + rows + "</tbody></table></div>";
  } else {
    calcHtml = "<div class=\"vld-sub-title\">BOM 계산 정합</div>" +
      "<div class=\"vld-empty\">모든 자재의 엔진 집계 = 완제품별 기여 합산 — 정상</div>";
  }

  // 플랜트별 자재 분리 현황
  var plantHtml = "";
  if (s.plantSplit.length > 0) {
    var plantRows = s.plantSplit.map(function(r) {
      var plantCells = r.items.map(function(i) {
        return "<td>" + escapeHtml(displayPlantName(i.plant)) + "</td>" +
               "<td>" + vldBadge(i.isShared ? "공용(" + i.parentCount + "품목)" : "전용") + "</td>";
      }).join("");
      return "<tr><td>" + escapeHtml(r.code) + "</td>" +
             "<td class=\"vld-td-left\">" + escapeHtml(r.name) + "</td>" +
             plantCells + "</tr>";
    }).join("");
    // 최대 플랜트 수 계산 (가변 컬럼)
    var maxPlants = s.plantSplit.reduce(function(mx, r) { return Math.max(mx, r.items.length); }, 0);
    var phCols = Array.from({ length: maxPlants }, function(_, i) {
      return "<th>플랜트 " + (i + 1) + "</th><th>공용여부</th>";
    }).join("");
    plantHtml = "<div class=\"vld-sub-title\">복수 플랜트 자재 분리 현황 (플랜트별 별도 관리 확인)</div>" +
      "<div class=\"vld-scroll\"><table class=\"vld-table\"><thead><tr>" +
      "<th>자재코드</th><th>자재명</th>" + phCols + "</tr></thead><tbody>" +
      plantRows + "</tbody></table></div>";
  }

  return summaryHtml + calcHtml + plantHtml;
}

// ── 계산기준 패널 ─────────────────────────────────────────────────────────────
function renderCalcCriteria() {
  if (!state.calcCriteriaOpen) return "";
  var formulas = [
    ["총 자재 필요수량", "생산계획 × 구성요소수량 ÷ BOM 기준수량"],
    ["BOM 환산계수",     "구성요소수량 ÷ BOM 기준수량"],
    ["가용수량",         "월초재고 + 공급계획"],
    ["자재 부족수량",    "MAX(총 자재 필요수량 − 가용수량, 0)"],
    ["부족금액",         "자재 부족수량 × 표준원가"],
  ];
  var criteria = [
    "RTF 대상(완제품·상품)과 BOM 하위 공급제약 품목을 분리 처리",
    "공용자재는 완제품별 임의 배분 없이 <b>공통제약</b>으로 표시",
    "반제품·재공품은 중간단계 처리 — 하위 원료·자재 기준으로 전개",
    "품목유형이 없거나 불명확 시 <b>품목유형 확인 필요</b>로 표시 — 임의 추정 금지",
    "반제품 조달구분(자체생산/구매) 불명확 시 <b>반제품 조달구분 확인 필요</b>로 표시",
    "현재고 미연결 시 0 가정하지 않고 <b>현재고 연결 필요</b>로 표시",
    "입고계획 미연결 시 0 가정하지 않고 <b>입고계획 확인 필요</b>로 표시",
    "현재고·입고계획 모두 연결되어야 자재 부족수량 확정 가능",
    "대체BOM 적용 제외 — 기본BOM(1번)만 사용",
    "단위 불일치 시 임의 환산 없이 <b>단위 정합 확인</b>으로 표시",
  ];
  var formulaRows = formulas.map(function(f) {
    return "<li><span class=\"cst-crit-formula\">" + escapeHtml(f[0]) + "</span> = " + escapeHtml(f[1]) + "</li>";
  }).join("");
  var criteriaRows = criteria.map(function(c) {
    return "<li>" + c + "</li>";
  }).join("");
  return "<div class=\"cst-criteria-panel\">" +
    "<div class=\"cst-criteria-grid\">" +
    "<div class=\"cst-criteria-group\">" +
    "<div class=\"cst-criteria-group-title\">산식</div>" +
    "<ul class=\"cst-criteria-list\">" + formulaRows + "</ul></div>" +
    "<div class=\"cst-criteria-group\">" +
    "<div class=\"cst-criteria-group-title\">판정 기준</div>" +
    "<ul class=\"cst-criteria-list\">" + criteriaRows + "</ul></div>" +
    "</div></div>";
}

// ── 결과 표 섹션 ─────────────────────────────────────────────────────────────
function renderConstraintTableSection(result, bomStatus, months) {
  var isRunning = bomStatus === BOM_STATUS.RUNNING;
  var isDone    = bomStatus === BOM_STATUS.DONE;
  var lastTime  = isDone && result && result.completedAt
    ? result.completedAt.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit", second:"2-digit" })
    : null;
  var statusLabel = { idle:"미실행", running:"진행중", done:"완료", failed:"실패" }[bomStatus] || "-";
  var statusCls   = isDone ? " cst-status-done" : bomStatus === BOM_STATUS.FAILED ? " cst-status-fail" : "";

  var critOpen     = state.calcCriteriaOpen;
  var critBtnLabel = critOpen ? "계산기준 ▲" : "계산기준 ▼";
  var headerRight  = "<div class=\"cst-sec-actions\">" +
    "<button type=\"button\" id=\"calcCriteriaBtn\" class=\"cst-criteria-btn" + (critOpen ? " active" : "") + "\">" +
    escapeHtml(critBtnLabel) + "</button>" +
    "<span class=\"cst-status-badge" + statusCls + "\">전개상태: " + escapeHtml(statusLabel) + "</span>" +
    (lastTime ? "<span class=\"cst-status-time\">마지막 전개: " + escapeHtml(lastTime) + "</span>" : "") +
    (isDone ? "<button type=\"button\" id=\"validationBtn\" class=\"cst-validate-btn\">정합성 검증</button>" : "") +
    "<button type=\"button\" id=\"bomExpandBtn\" class=\"cst-bom-btn" + (isRunning ? " running" : "") + "\"" +
    (isRunning ? " disabled" : "") + " onclick=\"triggerBomExpand()\">BOM 전개</button></div>";

  var tableContent = "";
  if (bomStatus === BOM_STATUS.IDLE) {
    tableContent = "<div class=\"cst-guide-box\">BOM 전개 전입니다. 기준월과 대상기간을 확인한 뒤 BOM 전개 버튼을 눌러 공급제약 대상을 산출하십시오.</div>";
  } else if (bomStatus === BOM_STATUS.RUNNING) {
    tableContent = "<div class=\"cst-progress-box\"><div class=\"cst-spinner\"></div>" +
                   "<span class=\"cst-progress-label\">" + escapeHtml(state.bomProgressStep || "BOM 전개 중") + "</span></div>";
  } else if (bomStatus === BOM_STATUS.FAILED) {
    var reasons = ((result && result.failReasons) || []).map(function(r) { return "<li>" + escapeHtml(r) + "</li>"; }).join("");
    tableContent = "<div class=\"cst-fail-box\"><p>BOM 전개를 완료할 수 없습니다. 필수 데이터 연결 상태를 확인하십시오.</p>" +
                   (reasons ? "<ul class=\"cst-fail-list\">" + reasons + "</ul>" : "") + "</div>";
  } else if (isDone && result) {
    var detailMode = state.constraintDetailMode;
    var filtered   = filterConstraintItems(result.items);
    var SHOW_LIMIT = 80;
    var showAll    = state.constraintShowAll;
    var displayed  = showAll ? filtered : filtered.slice(0, SHOW_LIMIT);
    var moreCount  = filtered.length - displayed.length;
    var moreBtn    = moreCount > 0
      ? "<div class='cst-show-more'><button type='button' id='cstShowMore'>+ " + moreCount + "개 더 보기</button></div>"
      : "";
    tableContent = renderConstraintFilterBar(result.items) +
                   renderConstraintTableBody(displayed, months, detailMode) +
                   moreBtn;
  }

  return "<section class=\"cst-card cst-table-block\">" +
         "<div class=\"cst-sec-title\">BOM 전개 공급원인 분석" + headerRight + "</div>" +
         renderCalcCriteria() +
         tableContent + "</section>";
}

// ── 빠른 시뮬레이션 핸들러 ──────────────────────────────────────────────────
function _cstSimRun(compKey) {
  var sec = document.querySelector(".cst-sim-section[data-compkey=\"" + compKey + "\"]");
  if (!sec) return;
  var sd;
  try { sd = JSON.parse(sec.getAttribute("data-simdata")); } catch(e) { return; }

  var incomingByMonth = {}, prodAdjByMonth = {}, altBomCoeff = null;
  sec.querySelectorAll(".cst-sim-input").forEach(function(inp) {
    var type  = inp.getAttribute("data-type");
    var month = inp.getAttribute("data-month");
    var raw   = inp.value.trim();
    var val   = raw !== "" ? (parseFloat(raw) || 0) : 0;
    if (type === "incoming") incomingByMonth[month] = val;
    else if (type === "prod") prodAdjByMonth[month] = val;
    else if (type === "altbom" && raw !== "") altBomCoeff = parseFloat(raw) || null;
  });

  var matUnit = sd.matUnit || "";
  var dec     = typeof sd.dec === "number" ? sd.dec : 0;
  function fmtN(v) {
    if (!v || !isFinite(v) || v <= 0) return "-";
    return v.toLocaleString("ko-KR", { maximumFractionDigits: dec, minimumFractionDigits: 0 }) + (matUnit ? " " + matUnit : "");
  }

  var rows = sd.months.map(function(month, i) {
    var md = sd.monthlyData[i] || {};
    if (md.availableQty === null || md.availableQty === undefined) return null;
    var incoming = incomingByMonth[month] || 0;
    var prodAdj  = prodAdjByMonth[month]  || 0;
    var useCoeff = (altBomCoeff !== null && sd.hasAltBom) ? altBomCoeff : sd.avgUnitReq;
    var newAvail = (md.availableQty || 0) + incoming;
    var newReq   = md.requiredQty || 0;
    if ((prodAdj !== 0 || (altBomCoeff !== null && sd.hasAltBom)) && sd.avgUnitReq) {
      var origProd = sd.avgUnitReq > 0 ? newReq / sd.avgUnitReq : 0;
      newReq = Math.max(0, (origProd + prodAdj) * (useCoeff || sd.avgUnitReq));
    }
    var before = md.shortageQty !== null && md.shortageQty !== undefined
      ? md.shortageQty : Math.max(0, (md.requiredQty || 0) - (md.availableQty || 0));
    var after  = Math.max(0, newReq - newAvail);
    return { month: month, before: before, after: after };
  }).filter(Boolean);

  var beforeRow = "<tr><td class=\"cst-sim-rlabel\">시뮬레이션 전 자재 부족수량</td>" +
    rows.map(function(r) {
      return "<td class=\"cst-sim-rnum" + (r.before > 0 ? " cst-sim-rnum-s" : "") + "\">" + fmtN(r.before) + "</td>";
    }).join("") + "</tr>";
  var afterRow = "<tr><td class=\"cst-sim-rlabel\">시뮬레이션 후 자재 부족수량</td>" +
    rows.map(function(r) {
      return "<td class=\"cst-sim-rnum" + (r.after > 0 ? " cst-sim-rnum-s" : (r.before > 0 ? " cst-sim-rnum-ok" : "")) + "\">" + fmtN(r.after) + "</td>";
    }).join("") + "</tr>";
  var resolveRow = "<tr><td class=\"cst-sim-rlabel\">부족 해소 여부</td>" +
    rows.map(function(r) {
      if (r.before === 0) return "<td class=\"cst-sim-rstat\">-</td>";
      if (r.after === 0)  return "<td class=\"cst-sim-rstat cst-sim-resolved\">✓ 해소</td>";
      if (r.after < r.before) return "<td class=\"cst-sim-rstat cst-sim-improved\">▽ 개선</td>";
      return "<td class=\"cst-sim-rstat cst-sim-unresolved\">✗ 미해소</td>";
    }).join("") + "</tr>";
  var noteRow = "<tr><td class=\"cst-sim-rlabel\">검토 결과</td>" +
    rows.map(function(r) {
      var note = r.before === 0 ? "부족 없음"
               : r.after === 0  ? "가정 시나리오로 해소 가능"
               : r.after < r.before ? "개선되나 부족 잔존"
               : "추가 조정 검토 필요";
      return "<td class=\"cst-sim-rnote\">" + note + "</td>";
    }).join("") + "</tr>";

  var tbody = sec.querySelector(".cst-sim-result tbody");
  if (tbody) tbody.innerHTML = beforeRow + afterRow + resolveRow + noteRow;
  var res = sec.querySelector(".cst-sim-result");
  if (res) res.style.display = "";
}

function _cstSimReset(compKey) {
  var sec = document.querySelector(".cst-sim-section[data-compkey=\"" + compKey + "\"]");
  if (!sec) return;
  sec.querySelectorAll(".cst-sim-input").forEach(function(inp) { inp.value = ""; });
  var res = sec.querySelector(".cst-sim-result");
  if (res) res.style.display = "none";
}

// ── 펼침 상세 v2: 수급요약 + 영향품목/조율 후보 ──────────────────────────────
function renderCstDetailExpanded(item, months, totalCols) {
  var matUnit    = (item.unit && item.unit !== "확인필요") ? item.unit : "";
  var dec        = _cstDecByUnit(matUnit);
  var canCompute = item.hasInventory && item.hasSupplyPlan && !item.unitMismatch;

  // 입고계획 by month
  var supplyByMonth = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant), month = cleanOptional(r.month);
    if (code !== item.componentCode || plant !== item.plant || !month) return;
    supplyByMonth.set(month, (supplyByMonth.get(month) || 0) + (cleanNumber(r.supplyQty) || 0));
  });

  // 월초재고: availableQty - supplyQty (canCompute 시), 1월은 기초재고만 표시
  var baseInv = null;
  state.mappedData.inventory_base.some(function(r) {
    if (cleanOptional(r.itemCode) === item.componentCode && cleanOptional(r.plant) === item.plant) {
      baseInv = cleanNumber(r.baseQty); return true;
    }
    return false;
  });
  var openingByMonth = new Map();
  months.forEach(function(month, i) {
    var md        = item.monthlyData[i] || {};
    var supplyQty = supplyByMonth.get(month) || 0;
    var opening;
    if (canCompute && md.availableQty !== null) {
      opening = Math.max(md.availableQty - supplyQty, 0);
    } else if (i === 0 && item.hasInventory && baseInv !== null) {
      opening = baseInv;
    } else {
      opening = null;
    }
    openingByMonth.set(month, opening);
  });

  function fmtZ(v, d, u) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    if (v === 0) return "0" + (u ? " " + u : "");
    return _cstFmtVal(v, d, u);
  }

  // ══ SECTION 1: 월별 자재 수급요약 ══
  function statusBadge(status) {
    var cls = {
      "확정부족":         "cst-sum-s-shortage",
      "정상":             "cst-sum-s-ok",
      "현재고 연결필요":  "cst-sum-s-link",
      "입고계획 확인필요":"cst-sum-s-link",
      "품목유형 확인필요":"cst-sum-s-check",
      "판단불가":         "cst-sum-s-unknown",
    }[status] || "cst-sum-s-unknown";
    return "<span class=\"cst-sum-s-badge " + cls + "\">" + escapeHtml(status) + "</span>";
  }

  var summaryRows = months.map(function(month, i) {
    var md        = item.monthlyData[i] || {};
    var supplyQty  = supplyByMonth.get(month) || 0;
    var openingQty = openingByMonth.get(month);
    var isShort   = canCompute && md.shortageQty > 0;

    var status;
    if (!item.hasInventory)        status = "현재고 연결필요";
    else if (!item.hasSupplyPlan)  status = "입고계획 확인필요";
    else if (item.categoryUnknown) status = "품목유형 확인필요";
    else if (md.shortageQty === null) status = "판단불가";
    else if (md.shortageQty > 0)   status = "확정부족";
    else                            status = "정상";

    var rowCls = status === "확정부족" ? " cst-ss-shortage"
               : status === "정상"      ? " cst-ss-ok"
               : " cst-ss-uncertain";

    return "<tr class=\"cst-ss-row" + rowCls + "\">" +
      "<td class=\"cst-ss-month\">" + escapeHtml(monthLabel(month)) + "</td>" +
      "<td class=\"cst-ss-num\">" + escapeHtml(md.requiredQty > 0 ? _cstFmtVal(md.requiredQty, dec, matUnit) : "-") + "</td>" +
      "<td class=\"cst-ss-num\">" + escapeHtml(item.hasInventory ? fmtZ(openingQty, dec, matUnit) : "연결필요") + "</td>" +
      "<td class=\"cst-ss-num\">" + escapeHtml(item.hasSupplyPlan ? fmtZ(supplyQty, dec, matUnit) : "확인필요") + "</td>" +
      "<td class=\"cst-ss-num\">" + escapeHtml(canCompute && md.availableQty !== null ? fmtZ(md.availableQty, dec, matUnit) : "-") + "</td>" +
      "<td class=\"cst-ss-num" + (isShort ? " cst-ss-short-num" : "") + "\">" +
        escapeHtml(isShort ? _cstFmtVal(md.shortageQty, dec, matUnit) : "-") + "</td>" +
      "<td class=\"cst-ss-status\">" + statusBadge(status) + "</td>" +
      "</tr>";
  }).join("");

  var summaryHtml =
    "<div class=\"cst-det-section\">" +
    "<div class=\"cst-det-section-title\">월별 자재 수급요약</div>" +
    "<div class=\"cst-det-scroll\"><table class=\"cst-ss-table supply-summary-table\"><thead><tr>" +
    "<th>월</th><th>총 자재 필요수량</th><th>월초재고</th><th>입고계획</th><th>가용수량</th><th>자재 부족수량</th><th>판단상태</th>" +
    "</tr></thead><tbody>" + summaryRows + "</tbody></table></div></div>";

  // ══ SECTION SIM: 빠른 시뮬레이션 ══
  var simHtml = "";
  if (canCompute) {
    var tp = 0, tr2 = 0;
    item.parentItems.forEach(function(p) {
      p.monthly.forEach(function(m) { tp += m.prodQty; tr2 += m.reqQty; });
    });
    var avgUnitReq = tp > 0 ? tr2 / tp : null;

    var simKey = item.componentCode + "|" + item.plant;
    var simDataObj = {
      months:      months,
      monthlyData: item.monthlyData.map(function(md) {
        return { requiredQty: md.requiredQty || 0, availableQty: md.availableQty, shortageQty: md.shortageQty };
      }),
      hasAltBom:   !!item.hasAltBom,
      avgUnitReq:  avgUnitReq,
      matUnit:     matUnit,
      dec:         dec,
    };
    var simKey_esc  = escapeHtml(simKey);
    var simData_esc = escapeHtml(JSON.stringify(simDataObj));

    var simMHds = months.map(function(m) {
      return "<th class=\"cst-sim-mh\">" + escapeHtml(monthLabel(m)) + "</th>";
    }).join("");

    var simInRow = "<tr><td class=\"cst-sim-ilabel\">입고 추가/당김 (" + escapeHtml(matUnit || "자재단위") + ")</td>" +
      months.map(function(m) {
        return "<td><input type=\"number\" step=\"any\" class=\"cst-sim-input\" data-type=\"incoming\" data-month=\"" +
          escapeHtml(m) + "\" placeholder=\"0\"></td>";
      }).join("") + "</tr>";

    var simPRow = "<tr><td class=\"cst-sim-ilabel\">생산계획 조정 (EA — 음수 감소/양수 증가)</td>" +
      months.map(function(m) {
        return "<td><input type=\"number\" step=\"1\" class=\"cst-sim-input\" data-type=\"prod\" data-month=\"" +
          escapeHtml(m) + "\" placeholder=\"0\"></td>";
      }).join("") + "</tr>";

    var simAltRow = item.hasAltBom
      ? "<tr><td class=\"cst-sim-ilabel\">대체BOM 1개당 소요량 (" + escapeHtml(matUnit || "자재단위") +
        ") <span class=\"cst-sim-tag\">대체BOM 있음</span></td>" +
        "<td colspan=\"" + months.length + "\"><input type=\"number\" step=\"any\" class=\"cst-sim-input\" data-type=\"altbom\"" +
        " placeholder=\"미입력 시 기본BOM 계수 유지\" style=\"width:220px\"></td></tr>"
      : "";

    var coefNote = avgUnitReq !== null
      ? "<div class=\"cst-sim-coefnote\">기본BOM 기준 1개당 소요량: " + escapeHtml(_cstFmtVal(avgUnitReq, 6, matUnit)) + "</div>"
      : "";

    simHtml =
      "<div class=\"cst-det-section cst-sim-section\" data-compkey=\"" + simKey_esc + "\" data-simdata=\"" + simData_esc + "\">" +
      "<div class=\"cst-det-section-title\">빠른 시뮬레이션 <span class=\"cst-sim-tag cst-sim-tag-warn\">임시 가정 결과 · 원본 미반영</span></div>" +
      "<div class=\"cst-sim-body\">" +
      coefNote +
      "<div class=\"cst-det-scroll\"><table class=\"cst-sim-input-table\"><thead><tr>" +
      "<th class=\"cst-sim-ilabel-h\">입력 항목</th>" + simMHds + "</tr></thead>" +
      "<tbody>" + simInRow + simPRow + simAltRow + "</tbody></table></div>" +
      "<div class=\"cst-sim-btns\">" +
      "<button type=\"button\" class=\"btn-sim-run\"" +
      " onclick=\"_cstSimRun(this.closest('.cst-sim-section').getAttribute('data-compkey'))\">▶ 시뮬레이션 실행</button> " +
      "<button type=\"button\" class=\"btn-sim-reset\"" +
      " onclick=\"_cstSimReset(this.closest('.cst-sim-section').getAttribute('data-compkey'))\">초기화</button> " +
      "<button type=\"button\" class=\"btn-sim-send\" disabled title=\"확정 조정은 조정입력 화면에서 반영\">조정안으로 보내기</button>" +
      "</div>" +
      "<div class=\"cst-sim-result\" style=\"display:none\">" +
      "<div class=\"cst-sim-result-title\">▼ 시뮬레이션 결과 (가정 기준)</div>" +
      "<div class=\"cst-det-scroll\"><table class=\"cst-sim-result-table\"><thead><tr>" +
      "<th class=\"cst-sim-ilabel-h\">결과 항목</th>" + simMHds + "</tr></thead>" +
      "<tbody></tbody></table></div>" +
      "</div>" +
      "</div></div>";
  }

  // ══ SECTION 2: 영향품목 및 조율 후보 ══

  // 판매계획 / 공급계획 lookup (부족 컬럼 — shortageConfirmed 여부 무관)
  var salesByParentMonth = new Map();
  var supplyByParentMonth = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant) || "", month = cleanOptional(r.month);
    if (!code || !month) return;
    var key = code + "|" + plant + "|" + month;
    salesByParentMonth.set(key,  (salesByParentMonth.get(key)  || 0) + (cleanNumber(r.salesQty)  || 0));
    supplyByParentMonth.set(key, (supplyByParentMonth.get(key) || 0) + (cleanNumber(r.supplyQty) || 0));
  });

  // 부모 완제품 기초재고 lookup (롤링 기초재고 계산용)
  var parentBaseInvMap = new Map();
  state.mappedData.inventory_base.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant) || "";
    if (!code) return;
    var k = code + "|" + plant;
    parentBaseInvMap.set(k, (parentBaseInvMap.get(k) || 0) + (cleanNumber(r.baseQty) || 0));
  });

  // 롤링 기초재고: months[0]부터 monthIdx 직전까지 재고 차감 후 opening qty 반환
  function getParentOpeningQty(pCode, pPlant, monthIdx) {
    var plant = pPlant || "";
    var opening = parentBaseInvMap.get(pCode + "|" + plant) || 0;
    for (var mi = 0; mi < monthIdx; mi++) {
      var k = pCode + "|" + plant + "|" + months[mi];
      var s = salesByParentMonth.get(k)  || 0;
      var q = supplyByParentMonth.get(k) || 0;
      opening = Math.max(0, opening + q - s);
    }
    return opening;
  }

  // 월별 자재 부족수량 index
  var monthlyShortage = new Map();
  item.monthlyData.forEach(function(md, i) { monthlyShortage.set(months[i], md.shortageQty); });

  // 월별 전체 자재 필요수량 (자재 부족수량 안분 기준)
  var totalReqByMonth = new Map();
  item.parentItems.forEach(function(p) {
    p.monthly.forEach(function(md) {
      totalReqByMonth.set(md.month, (totalReqByMonth.get(md.month) || 0) + md.reqQty);
    });
  });

  var sortedParents = item.parentItems.slice().sort(function(a, b) {
    var aR = a.monthly.reduce(function(s, m) { return s + m.reqQty; }, 0);
    var bR = b.monthly.reduce(function(s, m) { return s + m.reqQty; }, 0);
    return bR - aR;
  });
  var EXPAND_LIMIT = 20;
  var hasMore = sortedParents.length > EXPAND_LIMIT;
  var shownParents = sortedParents.slice(0, EXPAND_LIMIT);

  // 3컬럼/월: 생산계획, 부족, 자재 부족수량
  var impMonthHeads = months.map(function(m) {
    return "<th class=\"cst-imp-month impact-month-header\" colspan=\"3\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var impSubHeads = months.map(function() {
    return "<th class=\"cst-imp-sub impact-month-metric-header\">생산계획</th>" +
           "<th class=\"cst-imp-sub impact-month-metric-header\">부족</th>" +
           "<th class=\"cst-imp-sub impact-month-metric-header\">자재 부족수량</th>";
  }).join("");

  var impRows = shownParents.map(function(p) {
    var unitReqNum = null;
    p.monthly.some(function(m) {
      if (m.prodQty > 0 && m.reqQty > 0) { unitReqNum = m.reqQty / m.prodQty; return true; }
      return false;
    });
    var adjLabel = !canCompute ? "데이터 연결 후 판단"
                 : item.hasAnyShortage ? "조율 검토 대상" : "-";
    var adjCls = adjLabel === "조율 검토 대상"      ? " cst-adj-candidate"
               : adjLabel === "데이터 연결 후 판단" ? " cst-adj-unknown" : "";

    var monthlyCells = p.monthly.map(function(md, mi) {
      var month = months[mi];
      var sc = mi % 2 === 1 ? " cst-imp-col-shade" : "";

      // 생산계획
      var prodDisp = md.prodQty > 0 ? formatNumber(Math.round(md.prodQty)) : "-";

      // 부족: 판매계획 - (기초재고 + 생산계획)
      var salesQty    = salesByParentMonth.get(p.code + "|" + (p.plant || "") + "|" + month) || 0;
      var openingQty  = getParentOpeningQty(p.code, p.plant, mi);
      var rtfShortage = Math.max(0, salesQty - (openingQty + md.prodQty));
      var rtfDisp = rtfShortage > 0 ? formatNumber(Math.round(rtfShortage)) : "-";

      // 자재 부족수량: 전체 자재 부족수량을 reqQty 비율로 안분
      var totalShortage = monthlyShortage.get(month);
      var totalReqQty = totalReqByMonth.get(month) || 0;
      var pMatShortage = null;
      if (canCompute && totalShortage !== null && totalShortage > 0 && totalReqQty > 0) {
        pMatShortage = totalShortage * (md.reqQty / totalReqQty);
      }
      var matDisp = (pMatShortage !== null && pMatShortage > 0)
        ? escapeHtml(_cstFmtVal(pMatShortage, dec, matUnit)) : "-";

      return "<td class=\"cst-imp-num" + sc + "\">" + prodDisp + "</td>" +
             "<td class=\"cst-imp-num cst-imp-short" + sc + "\">" + rtfDisp + "</td>" +
             "<td class=\"cst-imp-num cst-imp-matshort" + sc + "\">" + matDisp + "</td>";
    }).join("");

    return "<tr class=\"cst-imp-row\">" +
      "<td class=\"cst-imp-code\" title=\"" + escapeHtml(p.code) + "\">" + escapeHtml(p.code) + "</td>" +
      "<td class=\"cst-imp-name\" title=\"" + escapeHtml(p.name) + "\">" + escapeHtml(p.name) + "</td>" +
      "<td class=\"cst-imp-center\">" + escapeHtml(p.itemGroup === NEED_MASTER ? "확인필요" : p.itemGroup) + "</td>" +
      "<td class=\"cst-imp-num cst-imp-coeff\" title=\"완제품 1개 생산 시 소요량\">" +
        escapeHtml(unitReqNum !== null ? _cstFmtVal(unitReqNum, 6, matUnit) : "-") + "</td>" +
      monthlyCells +
      "<td class=\"cst-imp-adj" + adjCls + "\">" + escapeHtml(adjLabel) + "</td>" +
      "</tr>";
  }).join("");

  // 합계 행
  var totalRow = "<tr class=\"cst-imp-total\">" +
    "<td colspan=\"4\" class=\"cst-imp-total-label\">합계</td>" +
    months.map(function(month, mi) {
      var sc = mi % 2 === 1 ? " cst-imp-col-shade" : "";
      var md = item.monthlyData[mi];
      var totalShortage = monthlyShortage.get(month);
      var shortDisp = (canCompute && totalShortage !== null && totalShortage > 0)
        ? escapeHtml(_cstFmtVal(totalShortage, dec, matUnit)) : "-";
      return "<td class=\"cst-imp-num" + sc + "\">-</td>" +
             "<td class=\"cst-imp-num" + sc + "\">-</td>" +
             "<td class=\"cst-imp-num cst-imp-total-num cst-imp-matshort" + sc + "\">" + shortDisp + "</td>";
    }).join("") +
    "<td class=\"cst-imp-adj\">-</td>" +
    "</tr>";

  var moreMsg = hasMore
    ? "<div class=\"cst-detail-more\">전체 " + sortedParents.length + "개 중 " + EXPAND_LIMIT + "개 표시</div>"
    : "";

  var impactHtml =
    "<div class=\"cst-det-section\">" +
    "<div class=\"cst-det-section-title\">영향품목 및 조율 후보</div>" +
    "<div class=\"cst-imp-note\">공용자재의 자재 부족수량은 영향품목 기준으로 표시되며, 최종 배분은 회의에서 결정합니다.</div>" +
    "<div class=\"cst-det-scroll\"><table class=\"cst-imp-table impact-items-table\"><thead>" +
    "<tr class=\"cst-imp-head\">" +
    "<th class=\"impact-month-header\" rowspan=\"2\">완제품코드</th>" +
    "<th class=\"impact-month-header\" rowspan=\"2\">완제품명</th>" +
    "<th class=\"impact-month-header\" rowspan=\"2\">품목군</th>" +
    "<th class=\"impact-month-header\" rowspan=\"2\" title=\"완제품 1개 생산 시 소요량\">개당 소요량</th>" +
    impMonthHeads +
    "<th class=\"impact-month-header\" rowspan=\"2\">조율 후보</th></tr>" +
    "<tr class=\"cst-imp-head\">" + impSubHeads + "</tr>" +
    "</thead><tbody>" + impRows + totalRow + "</tbody></table>" + moreMsg + "</div></div>";

  return "<tr class=\"cst-detail-row\"><td colspan=\"" + totalCols + "\" class=\"cst-detail-cell\">" +
    "<div class=\"cst-detail-inner cst-detail-v2\">" +
    summaryHtml + simHtml + impactHtml +
    "</div></td></tr>";
}

// ── 결과 표 본문 ─────────────────────────────────────────────────────────────
// ── BOM 테이블 인라인 입고조정 서브행 ─────────────────────────────────────────
function renderCstAdjSubRow(item, months, totalCols, matSupplyMap) {
  var simAdj  = state.matSimAdj || {};
  var dec     = _cstDecByUnit(item.unit);
  var compKey = item.componentCode + "|" + item.plant;

  var cells = months.map(function(month) {
    var k    = item.componentCode + "|" + item.plant + "|" + month;
    var orig = (matSupplyMap && matSupplyMap.get(k)) || 0;
    var adj  = (k in simAdj) ? simAdj[k] : orig;
    var isAdj = (k in simAdj) && Math.abs(simAdj[k] - orig) > 0.001;
    var delta = adj - orig;
    return { k: k, orig: orig, adj: adj, isAdj: isAdj, delta: delta };
  });

  // 조정 후 부족 계산 — 월간 롤링 (잉여 자재 다음 달로 이월)
  var shortCells = (function() {
    var extraCarry = 0;
    return months.map(function(month, mi) {
      var k    = item.componentCode + "|" + item.plant + "|" + month;
      var orig = (matSupplyMap && matSupplyMap.get(k)) || 0;
      var adj  = (k in simAdj) ? simAdj[k] : orig;
      var md   = item.monthlyData[mi] || {};
      if (!item.hasInventory || !item.hasSupplyPlan || md.availableQty === null) {
        extraCarry = 0;
        return null;
      }
      var opening   = Math.max(0, md.availableQty - orig);
      var req       = md.requiredQty || 0;
      var origAvail = opening + orig;
      var adjAvail  = opening + adj + extraCarry;
      var origShortage = Math.max(0, req - origAvail);
      var adjShortage  = Math.max(0, req - adjAvail);
      // 다음 달로 넘길 잉여 = 조정 후 잉여 - 원래 잉여
      var origEnding = Math.max(0, origAvail - req);
      var adjEnding  = Math.max(0, adjAvail  - req);
      extraCarry = Math.max(0, adjEnding - origEnding);
      return { adjShortage: adjShortage, origShortage: origShortage };
    });
  })();

  var hasAnyItemAdj = cells.some(function(c) { return c.isAdj; });

  var mhdCells = months.map(function(m, mi) {
    return "<th class=\"cst-adj-mhd" + (mi > 0 ? " cst-adj-mborder" : "") + "\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var origCells = cells.map(function(c, ci) {
    return "<td class=\"cst-adj-val" + (ci > 0 ? " cst-adj-mborder" : "") + "\">" +
      (c.orig > 0 ? formatNumber(Math.round(c.orig)) : "-") + "</td>";
  }).join("");
  var inputCells = cells.map(function(c, ci) {
    var borderCls = ci > 0 ? " cst-adj-mborder" : "";
    var activeCls = c.isAdj ? " cst-adj-active" : "";
    var deltaHtml = c.isAdj
      ? "<span class=\"mat-sim-delta " + (c.delta > 0 ? "mat-sim-pos" : "mat-sim-neg") + "\">" +
        (c.delta > 0 ? "+" : "") + formatNumber(Math.round(c.delta)) + "</span>"
      : "";
    return "<td class=\"cst-adj-input-cell" + borderCls + activeCls + "\">" +
      "<input type=\"number\" class=\"cst-adj-month-input\" " +
      "data-key=\"" + escapeHtml(c.k) + "\" data-orig=\"" + c.orig + "\" " +
      "value=\"" + c.adj + "\" min=\"0\" step=\"1\" />" +
      deltaHtml + "</td>";
  }).join("");
  var sCells = shortCells.map(function(s, ci) {
    var borderCls = ci > 0 ? " cst-adj-mborder" : "";
    if (s === null) return "<td class=\"cst-adj-val" + borderCls + "\">-</td>";
    if (s.adjShortage <= 0 && s.origShortage > 0) return "<td class=\"cst-adj-resolved" + borderCls + "\">✓ 해소</td>";
    if (s.adjShortage <= 0) return "<td class=\"cst-adj-val" + borderCls + "\">-</td>";
    return "<td class=\"cst-adj-shortage" + borderCls + "\">" + escapeHtml(_cstFmtVal(s.adjShortage, dec, item.unit)) + "</td>";
  }).join("");

  var resetBtn = hasAnyItemAdj
    ? "<button class=\"cst-adj-row-reset\" data-comp-code=\"" + escapeHtml(item.componentCode) +
      "\" data-plant=\"" + escapeHtml(item.plant) + "\">초기화</button>"
    : "";

  return "<tr class=\"cst-adj-subrow\" data-comp-key=\"" + escapeHtml(compKey) + "\">" +
    "<td colspan=\"" + totalCols + "\" class=\"cst-adj-subrow-cell\">" +
    "<div class=\"cst-adj-inner\">" +
    "<table class=\"cst-adj-table\"><thead><tr>" +
    "<th class=\"cst-adj-rlabel-hd\"></th>" + mhdCells + "<th class=\"cst-adj-action-hd\"></th>" +
    "</tr></thead><tbody>" +
    "<tr class=\"cst-adj-orig-row\"><td class=\"cst-adj-rlabel\">현재 입고계획</td>" + origCells + "<td class=\"cst-adj-action-cell\"></td></tr>" +
    "<tr class=\"cst-adj-input-row\"><td class=\"cst-adj-rlabel cst-adj-input-lbl\">조정 입고량</td>" + inputCells + "<td class=\"cst-adj-action-cell\">" + resetBtn + "</td></tr>" +
    "<tr class=\"cst-adj-short-row\"><td class=\"cst-adj-rlabel\">부족 (조정후)</td>" + sCells + "<td class=\"cst-adj-action-cell\"></td></tr>" +
    "</tbody></table>" +
    "</div></td></tr>";
}

function renderConstraintTableBody(items, months, detailMode) {
  var leftPos = 0;
  var cols = CONSTR_LEFT_COLS.map(function(c) { var r = Object.assign({}, c, { left:leftPos }); leftPos += c.width; return r; });
  var totalLeftW = leftPos;
  var impactSortState = state.constraintImpactSort || 0;
  var sortIcon = impactSortState === 1 ? " ↓" : impactSortState === -1 ? " ↑" : " ↕";

  var monthColW   = detailMode ? CONSTR_METRIC_W : CONSTR_COMPACT_W;
  var monthColCnt = detailMode ? CONSTR_METRICS.length : 1;
  var totalCols   = cols.length + months.length * monthColCnt;
  var minW        = totalLeftW + months.length * monthColCnt * monthColW;

  var colgroup = cols.map(function(c) { return "<col style=\"width:" + c.width + "px;\">"; }).join("") +
    months.reduce(function(acc) {
      for (var i = 0; i < monthColCnt; i++) acc += "<col style=\"width:" + monthColW + "px;\">";
      return acc;
    }, "");

  var leftHeaders = cols.map(function(col) {
    var aCls = col.align === "left" ? " cst-cell-left" : "";
    var xCls = col.isName ? " cst-col-name" : col.isLast ? " cst-col-last-sticky" : "";
    var label = escapeHtml(col.label);
    if (col.sortable) {
      label = "<span class=\"cst-sort-th\" data-sort-impact=\"1\">" + label + escapeHtml(sortIcon) + "</span>";
    }
    return "<th class=\"cst-sticky" + aCls + xCls + "\" style=\"left:" + col.left + "px;width:" + col.width + "px;\" rowspan=\"" + (detailMode ? 2 : 1) + "\">" + label + "</th>";
  }).join("");

  var monthHead, subHead = "";
  if (detailMode) {
    monthHead = months.map(function(m, mi) {
      return "<th class=\"cst-month-head" + (mi > 0 ? " cst-month-start" : "") + "\" colspan=\"" + CONSTR_METRICS.length + "\">" +
             escapeHtml(monthLabel(m)) + "</th>";
    }).join("");
    subHead = "<tr>" + months.map(function(_, mi) {
      return CONSTR_METRICS.map(function(metric, ci) {
        return "<th class=\"cst-sub-head" + (metric === "부족" ? " cst-key-sub" : "") +
               (ci === 0 && mi > 0 ? " cst-month-start" : "") + "\">" + escapeHtml(CONSTR_METRICS_LABEL[metric] || metric) + "</th>";
      }).join("");
    }).join("") + "</tr>";
  } else {
    monthHead = months.map(function(m, mi) {
      return "<th class=\"cst-month-head" + (mi > 0 ? " cst-month-start" : "") + "\">" +
             escapeHtml(monthLabel(m)) + "</th>";
    }).join("");
  }

  var bodyRows;
  if (!items.length) {
    var emptyMsg = "공급 제약 대상이 없습니다";
    var _d = state.cstDrilldown;
    if (_d) {
      var tg = _d.typeGroup || "";
      if (tg === "완제품" || tg === "완제품(수탁)") {
        emptyMsg = "해당 품목의 BOM 연결 자재가 없습니다. BOM 파일에서 품목코드(자재번호 Root)를 확인하십시오.";
      } else if (!tg || tg === STATUS.UNKNOWN) {
        emptyMsg = "집계 조건 기준 조회입니다. 개별 품목 행을 클릭하여 공급원인을 확인하십시오.";
      } else {
        emptyMsg = "RTF 결과와 공급원인 결과 연결 필요 — BOM 전개 후 재조회하십시오.";
      }
    }
    bodyRows = "<tr><td colspan=\"" + totalCols + "\" class=\"cst-empty\">" + escapeHtml(emptyMsg) + "</td></tr>";
  } else {
    bodyRows = items.map(function(item) {
      var compKey    = item.componentCode + "|" + item.plant;
      var isExpanded = state.expandedConstraintRows && state.expandedConstraintRows.has(compKey);
      var unitTitle  = item.unitMismatch
        ? "BOM 단위와 현재고/공급계획 단위가 일치하지 않아 자재 부족수량 계산이 불가능합니다."
        : item.unitMissing ? "단위 기준정보가 없어 단위 정합성을 확인할 수 없습니다." : "";
      var parentTooltip = "영향 품목군: " + (item.parentItemGroup === NEED_MASTER ? "확인필요" : item.parentItemGroup) +
                          "\n대표 영향품목: " + (item.parentItems.length > 0 ? item.parentItems[0].name : "-");

      var leftCells = cols.map(function(col) {
        var aCls = col.align === "left" ? " cst-cell-left" : "";
        var xCls = col.isName ? " cst-col-name" : col.isLast ? " cst-col-last-sticky" : "";
        var value = "", extra = "", titleAttr = "", htmlContent = null;
        if      (col.key === "plant")        value = displayPlantName(item.plant);
        else if (col.key === "itemCategory") value = item.displayCategory;
        else if (col.key === "shareType")    value = item.isShared ? "공용" : "전용";
        else if (col.key === "code")         value = item.componentCode;
        else if (col.key === "name") {
          value = item.componentName;
          titleAttr = " title=\"" + escapeHtml(item.componentName + "\n" + parentTooltip) + "\"";
        }
        else if (col.key === "unit") {
          value = item.unit;
          if (unitTitle) titleAttr = " title=\"" + escapeHtml(unitTitle) + "\"";
        }
        else if (col.key === "impactCount") {
          var cnt = item.parentItems.length;
          if (cnt > 0) {
            htmlContent = "<button type=\"button\" class=\"cst-impact-btn\" data-comp-key=\"" + escapeHtml(compKey) +
                          "\" title=\"영향 완제품 목록 팝업\">" + cnt + "개</button>";
          } else {
            htmlContent = "<span style=\"color:#9ca3af\">—</span>";
          }
        }
        else if (col.key === "note") {
          var shortLabel = shortNoteLabel(item.note);
          value = shortLabel;
          if (item.note && item.note !== "-") titleAttr = " title=\"" + escapeHtml(item.note) + "\"";
        }
        else if (col.key === "decision") {
          var dLabel = decisionLabel(item);
          htmlContent = "<span class=\"" + decisionCls(dLabel) + "\">" + escapeHtml(dLabel) + "</span>" +
            ((item.hasAltBom && item.hasAnyShortage)
              ? " <button type=\"button\" class=\"cst-altbom-btn\" title=\"대체BOM이 존재합니다. 적용 기준 검토 후 수동 반영하십시오.\">대체BOM 검토</button>"
              : "");
        }
        var unitWarnCls = (col.key === "unit" && (item.unitMismatch || item.unitMissing)) ? " cst-unit-warn" : "";
        return "<td class=\"cst-sticky cst-td" + aCls + xCls + unitWarnCls + "\" style=\"left:" + col.left + "px;width:" + col.width + "px;\"" + titleAttr + ">" +
               (htmlContent !== null ? htmlContent : extra + escapeHtml(value)) + "</td>";
      }).join("");

      var metricCells;
      if (detailMode) {
        var _mUnit = (item.unit && item.unit !== "확인필요") ? item.unit : "";
        var _mDec  = _cstDecByUnit(_mUnit);
        metricCells = item.monthlyData.map(function(md, mi) {
          return CONSTR_METRICS.map(function(metric, ci) {
            var borderCls = ci === 0 && mi > 0 ? " cst-month-start" : "";
            var value = "-", cls = "cst-metric-cell", tip = "";
            if (metric === "필요") {
              if (md.requiredQty > 0) {
                value = _cstFmtVal(md.requiredQty, _mDec, _mUnit);
                tip   = "정확값: " + md.requiredQty + (_mUnit ? " " + _mUnit : "");
              }
            } else if (metric === "가용") {
              if (item.unitMismatch || md.availableQty === null) {
                value = "판단불가"; cls += " cst-neutral-cell";
              } else if (md.availableQty === 0) {
                value = "0" + (_mUnit ? " " + _mUnit : "");
              } else {
                value = _cstFmtVal(md.availableQty, _mDec, _mUnit);
                tip   = "정확값: " + md.availableQty + (_mUnit ? " " + _mUnit : "");
              }
            } else {
              if (item.unitMismatch || md.shortageQty === null) {
                value = "판단불가"; cls += " cst-neutral-cell";
              } else if (md.shortageQty > 0) {
                value = _cstFmtVal(md.shortageQty, _mDec, _mUnit);
                cls  += " cst-shortage-cell";
                tip   = "정확값: " + md.shortageQty + (_mUnit ? " " + _mUnit : "");
              } else {
                value = "-"; cls += " cst-neutral-cell";
              }
            }
            var tipAttr = tip ? " title=\"" + escapeHtml(tip) + "\"" : "";
            return "<td class=\"" + cls + borderCls + "\"" + tipAttr + ">" + escapeHtml(value) + "</td>";
          }).join("");
        }).join("");
      } else {
        metricCells = item.monthlyData.map(function(md, mi) {
          var borderCls = mi > 0 ? " cst-month-start" : "";
          var cell = compactCellValue(item, md);
          return "<td class=\"cst-compact-cell " + cell.cls + borderCls + "\">" + escapeHtml(cell.text) + "</td>";
        }).join("");
      }

      var rowCls = !item.hasInventory ? "cst-row-nodata" : item.isShared ? "cst-row-shared" : "cst-row-dedicated";
      var mainRow = "<tr class=\"" + rowCls + "\" data-comp-key=\"" + escapeHtml(compKey) + "\">" + leftCells + metricCells + "</tr>";

      return mainRow;
    }).join("");
  }

  return "<div class=\"cst-h-scroll\"><table class=\"cst-table\" style=\"min-width:" + minW + "px;\">" +
         "<colgroup>" + colgroup + "</colgroup>" +
         "<thead><tr>" + leftHeaders + monthHead + "</tr>" + subHead + "</thead>" +
         "<tbody>" + bodyRows + "</tbody></table></div>";
}

// ── AI 제안 박스 (RTF 관점) ───────────────────────────────────────────────────
// 공용자재 경합 충돌 데이터 계산 (waterfall 배분 기준 미확보 FG 도출)
function computeSharedMaterialConflicts(months) {
  var result = [];
  (state.bomResult.items || []).forEach(function(bi) {
    if (!bi.isShared || !bi.hasAnyShortage) return;

    // 부족이 가장 큰 월 기준
    var worstMd = null;
    (bi.monthlyData || []).forEach(function(md) {
      if (!md || (md.shortageQty || 0) <= 0) return;
      if (!worstMd || md.shortageQty > worstMd.shortageQty) worstMd = md;
    });
    if (!worstMd) return;

    var j = months.indexOf(worstMd.month);
    if (j < 0) return;

    // 소요량 내림차순 정렬 후 waterfall 배분 재현
    var allocations = (bi.parentItems || [])
      .map(function(pi) {
        var mData = pi.monthly && pi.monthly[j];
        if (!mData) return null;
        var reqQty = mData.reqQty || 0;
        if (reqQty === 0) return null;
        return { name: pi.name || pi.code, code: pi.code, required: reqQty };
      })
      .filter(Boolean)
      .sort(function(a, b) { return b.required - a.required; });

    var remaining = Math.max(0, worstMd.availableQty || 0);
    allocations.forEach(function(a) {
      a.allocated = Math.min(a.required, remaining);
      a.deficit   = a.required - a.allocated;
      remaining   = Math.max(0, remaining - a.allocated);
    });

    result.push({
      componentName:  bi.componentName,
      componentCode:  bi.componentCode,
      plant:          bi.plant,
      month:          worstMd.month,
      available:      worstMd.availableQty || 0,
      totalRequired:  worstMd.requiredQty  || 0,
      shortage:       worstMd.shortageQty  || 0,
      allocations:    allocations,
      deficitFgs:     allocations.filter(function(a) { return a.deficit > 0; }),
      priorityFgs:    allocations.filter(function(a) { return a.deficit === 0; }),
    });
  });
  // 부족 수량 큰 순 정렬
  result.sort(function(a, b) { return b.shortage - a.shortage; });
  return result;
}

// ── AI 수급 분석 엔진: 품절·매출차질 진단 + 권장 증량량(롤링 최소) 산출 ───────────
var _cstAiPlan = null; // 렌더 시 계산 → 적용 버튼 핸들러에서 재사용
function computeAiPlan(months) {
  if (state.bomStatus !== BOM_STATUS.DONE || !state.bomResult) return null;
  if (typeof computeRtfItems !== "function" || typeof buildBomMaxProducibleMap !== "function") return null;

  var supplyMap = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant) || "", month = cleanOptional(r.month);
    if (!code || !month) return;
    var k = code + "|" + plant + "|" + month;
    supplyMap.set(k, (supplyMap.get(k) || 0) + (cleanNumber(r.supplyQty) || 0));
  });

  // 현재(기존 조정 반영) 상태
  var curItems = computeRtfItems(buildBomMaxProducibleMap(state.matSimAdj || {}));
  var shortFgs = curItems.filter(function(fg) {
    return fg.typeGroup === "완제품" && fg.monthlyStatus.some(function(ms) { return (ms.shortageQty || 0) > 0; });
  });

  // 자재별 권장 증량 (롤링 최소: 각 달 부족만 딱 메움 → 과잉 증량 방지)
  var overrides = {};      // key → 권장 입고량
  var matByFg   = {};      // "fgCode|plant" → Set(적용할 key)
  (state.bomResult.items || []).forEach(function(mat) {
    if (!mat.hasAnyShortage || !mat.monthlyData || !mat.monthlyData.length) return;
    var av0 = mat.monthlyData[0].availableQty;
    if (av0 === null || av0 === undefined) return; // 판단불가 자재 스킵
    var supply0 = supplyMap.get(mat.componentCode + "|" + mat.plant + "|" + months[0]) || 0;
    var opening = av0 - supply0; // 자재 기초재고
    var addedKeys = [];
    months.forEach(function(month, mi) {
      var md = mat.monthlyData[mi]; if (!md) return;
      var required = md.requiredQty || 0;
      var key = mat.componentCode + "|" + mat.plant + "|" + month;
      var orig = supplyMap.get(key) || 0;
      var need = Math.max(orig, required - opening, 0);
      if (need > orig + 0.001) { overrides[key] = need; addedKeys.push(key); }
      opening = Math.max(opening + Math.max(orig, need) - required, 0);
    });
    if (addedKeys.length) {
      (mat.parentItems || []).forEach(function(p) {
        var fk = p.code + "|" + p.plant;
        if (!matByFg[fk]) matByFg[fk] = new Set();
        addedKeys.forEach(function(k) { matByFg[fk].add(k); });
      });
    }
  });

  // 권장안 반영 후 시나리오
  var merged = Object.assign({}, state.matSimAdj || {}, overrides);
  var afterItems = computeRtfItems(buildBomMaxProducibleMap(merged));
  var afterShort = afterItems.filter(function(fg) {
    return fg.typeGroup === "완제품" && fg.monthlyStatus.some(function(ms) { return (ms.shortageQty || 0) > 0; });
  });

  // 매출차질(부족×판가) & 재고 증가(완제품·상품 기말금액 월별 최대 delta)
  var lostSalesTotal = 0;
  shortFgs.forEach(function(fg) {
    fg.monthlyStatus.forEach(function(ms) {
      if ((ms.shortageQty || 0) > 0 && Number.isFinite(ms.lostSalesAmount)) lostSalesTotal += ms.lostSalesAmount;
    });
  });
  var invIncrease = 0;
  months.forEach(function(_, mi) {
    var b = aggregateMonth(curItems, mi), a = aggregateMonth(afterItems, mi);
    if (Number.isFinite(a.endingAmount) && Number.isFinite(b.endingAmount)) {
      var d = a.endingAmount - b.endingAmount;
      if (d > invIncrease) invIncrease = d;
    }
  });

  // 완제품별 행 (매출차질 순)
  var fgRows = shortFgs.map(function(fg) {
    var lost = 0;
    fg.monthlyStatus.forEach(function(ms) { if ((ms.shortageQty || 0) > 0 && Number.isFinite(ms.lostSalesAmount)) lost += ms.lostSalesAmount; });
    var worst = fg.monthlyStatus.reduce(function(mx, ms) { return (ms.shortageQty || 0) > (mx.shortageQty || 0) ? ms : mx; }, fg.monthlyStatus[0] || {});
    var fk = fg.itemCode + "|" + fg.plantCode;
    var keys = matByFg[fk] ? Array.from(matByFg[fk]) : [];
    var relMats = (state.bomResult.items || []).filter(function(mat) {
      return mat.hasAnyShortage && mat.parentItems.some(function(p) { return p.code === fg.itemCode && p.plant === fg.plantCode; });
    });
    var matName = relMats.length ? relMats[0].componentName : "";
    return { code: fg.itemCode, name: fg.itemName, lost: lost, worst: worst, keys: keys, matName: matName, resolvable: keys.length > 0 };
  }).sort(function(a, b) { return b.lost - a.lost; });

  return {
    shortageCount: shortFgs.length,
    lostSalesTotal: lostSalesTotal,
    afterShortageCount: afterShort.length,
    invIncrease: invIncrease,
    overrides: overrides,
    hasRecommendation: Object.keys(overrides).length > 0,
    fgRows: fgRows,
  };
}

function renderCstAiSuggestion(months) {
  var plan = computeAiPlan(months);
  _cstAiPlan = plan;
  if (!plan) return "";
  var hasAdj = Object.keys(state.matSimAdj || {}).length > 0;
  var hasApplied = state.aiAppliedKeys && Object.keys(state.aiAppliedKeys).length > 0;
  var clearBtn = hasApplied
    ? "<button type=\"button\" class=\"cst-ai-clear-all\" id=\"cstAiClearAll\">✕ 권장안 해제</button>"
    : "";

  // 부족 없음
  if (plan.shortageCount === 0) {
    return "<div class=\"cst-ai-box cst-ai-ok\">" +
      "<span class=\"cst-ai-chip\">AI 분석</span>" +
      "<span class=\"cst-ai-ok-text\">✓ " + (hasAdj ? "조정 반영 시 " : "현재 계획 기준 ") + "공급부족 없음 — 전 품목 대응 가능</span>" +
      clearBtn +
      "</div>";
  }

  var afterTxt = plan.afterShortageCount === 0
    ? "품절 <b class=\"cst-ai-good\">0건</b>"
    : "품절 <b class=\"cst-ai-good\">" + plan.afterShortageCount + "건</b> <span class=\"cst-ai-planshort\">(공급계획 요인, 자재증량 불가)</span>";

  var applyBtn = plan.hasRecommendation
    ? "<button type=\"button\" class=\"cst-ai-apply-all\" id=\"cstAiApplyAll\">⚡ 권장안 전체 적용</button>"
    : "";

  var headline = "<div class=\"cst-ai-head\">" +
    "<div class=\"cst-ai-head-metric\"><span class=\"cst-ai-head-lbl\">품절</span><span class=\"cst-ai-head-num\">" + plan.shortageCount + "건</span></div>" +
    "<div class=\"cst-ai-head-metric\"><span class=\"cst-ai-head-lbl\">매출차질</span><span class=\"cst-ai-head-num cst-ai-lost\">" + escapeHtml(formatMoney(plan.lostSalesTotal)) + "</span></div>" +
    "<div class=\"cst-ai-head-arrow\">➜</div>" +
    "<div class=\"cst-ai-head-after\">권장 증량 적용 시 " + afterTxt +
      (plan.hasRecommendation ? " <span class=\"cst-ai-invnote\">재고 +" + escapeHtml(formatMoney(plan.invIncrease)) + "</span>" : "") + "</div>" +
    applyBtn + clearBtn +
    "</div>";

  var top = plan.fgRows.slice(0, 5);
  var rows = top.map(function(r) {
    var rec = r.resolvable
      ? "<span class=\"cst-ai-row-mat\">" + escapeHtml(r.matName) + " 증량</span><button type=\"button\" class=\"cst-ai-apply-one\" data-fgkeys=\"" + escapeHtml(r.keys.join(",")) + "\">적용</button>"
      : "<span class=\"cst-ai-planshort\">공급계획 증대 필요</span>";
    return "<div class=\"cst-ai-row\">" +
      "<span class=\"cst-ai-row-code\">" + escapeHtml(r.code) + "</span>" +
      "<span class=\"cst-ai-row-name\">" + escapeHtml(r.name) + "</span>" +
      "<span class=\"cst-ai-row-lost\">차질 " + escapeHtml(formatMoney(r.lost)) + "</span>" +
      "<span class=\"cst-ai-row-rec\">" + rec + "</span>" +
      "</div>";
  }).join("");
  var moreStr = plan.fgRows.length > 5 ? "<div class=\"cst-ai-more\">외 " + (plan.fgRows.length - 5) + "건 — 아래 목록에서 확인</div>" : "";

  return "<div class=\"cst-ai-box\">" +
    "<span class=\"cst-ai-chip\">AI 분석</span>" +
    headline +
    "<div class=\"cst-ai-list\">" + rows + moreStr + "</div>" +
    "</div>";
}

function _getSharedConflictChip(months) {
  if (state.bomStatus !== BOM_STATUS.DONE || !state.bomResult) return "";
  var conflicts = computeSharedMaterialConflicts(months);
  if (conflicts.length === 0) return "";
  return "<div class='cst-cmp-shared-chip' title='공용자재 배분기준 확인 필요'>⚠ 공용자재 경합 " + conflicts.length + "건</div>";
}

// ── KPI 테이블 (재고금액·재고일수 월별, RTF 화면과 동일 형식) ────────────────
function renderCstCompareBanner() {
  if (typeof computeRtfItems !== "function" || typeof aggregateMonth !== "function") return "";

  var months = getRtfMonths();
  var adj = state.matSimAdj || {};
  var goodsAdj = state.goodsSupplyAdj || {};
  var hasAdj = Object.keys(adj).length > 0 || Object.keys(goodsAdj).length > 0;

  // BOM RTF 캐시: BOM 전개 완료 후 첫 렌더에서만 계산, 이후 렌더에서 재사용
  if (!_cstBomRtfItems && typeof buildBomMaxProducibleMap === "function") {
    _cstBomRtfItems = computeRtfItems(buildBomMaxProducibleMap({}));
  }
  var beforeItems = _cstBomRtfItems || computeRtfItems(null);
  var afterItems  = hasAdj && typeof buildBomMaxProducibleMap === "function"
    ? computeRtfItems(buildBomMaxProducibleMap(adj), false, goodsAdj)
    : beforeItems;

  var maxAmt = 0;
  months.forEach(function(_, mi) {
    var a = aggregateMonth(afterItems, mi);
    if (Number.isFinite(a.endingAmount) && a.endingAmount > maxAmt) maxAmt = a.endingAmount;
  });

  // RTF 상단과 동일 기준(전체재고 = 결산 앵커 + 완제품·상품 변동)으로 표시
  var _useTotal = (typeof rtfHeadlineInv === "function");
  var monthData = months.map(function(month, mi) {
    var ba = _useTotal ? rtfHeadlineInv(beforeItems, mi) : aggregateMonth(beforeItems, mi);
    var aa = _useTotal ? rtfHeadlineInv(afterItems,  mi) : aggregateMonth(afterItems,  mi);
    var bAmtRaw = _useTotal ? ba.amount : ba.endingAmount;
    var aAmtRaw = _useTotal ? aa.amount : aa.endingAmount;
    var bDaysRaw = _useTotal ? ba.days : ba.inventoryDays;
    var aDaysRaw = _useTotal ? aa.days : aa.inventoryDays;
    var bAmt  = Number.isFinite(bAmtRaw)  ? bAmtRaw : null;
    var aAmt  = Number.isFinite(aAmtRaw)  ? aAmtRaw : null;
    var bDays = Number.isFinite(bDaysRaw) ? Math.round(bDaysRaw) : null;
    var aDays = Number.isFinite(aDaysRaw) ? Math.round(aDaysRaw) : null;
    return {
      month:     month,
      amtVal:    aAmt !== null ? formatMoney(aAmt) : "—",
      deltaAmt:  (hasAdj && bAmt !== null && aAmt !== null) ? aAmt - bAmt : null,
      daysVal:   aDays,
      deltaDays: (hasAdj && bDays !== null && aDays !== null) ? aDays - bDays : null,
      amtRaw:    aAmt,
    };
  });

  function deltaSpan(val, unit) {
    if (val === null || val === 0) return "";
    var cls = val > 0 ? "cst-kpi-delta up" : "cst-kpi-delta dn";
    var sign = val > 0 ? "+" : "";
    var txt = unit === "일" ? sign + val + "일" : sign + formatMoney(val);
    return "<span class='" + cls + "'>(" + txt + ")</span>";
  }

  var headerRow = "<tr>" +
    "<th class='rtf-kpi-lbl-hd'></th>" +
    months.map(function(m) {
      return "<th class='rtf-kpi-month-hd'>" + escapeHtml(monthLabel(m)) + "</th>";
    }).join("") + "</tr>";

  var amtRow = "<tr class='rtf-kpi-r-amt'>" +
    "<td class='rtf-kpi-row-lbl'>" + (_useTotal && getActualsAnchor && getActualsAnchor() ? "전체재고" : "재고금액") + "</td>" +
    monthData.map(function(d) {
      return "<td class='rtf-kpi-val'>" +
        "<span class='rtf-kpi-main'>" + escapeHtml(d.amtVal) + "</span>" +
        deltaSpan(d.deltaAmt, "amt") +
        "</td>";
    }).join("") + "</tr>";

  var daysRow = "<tr class='rtf-kpi-r-days'>" +
    "<td class='rtf-kpi-row-lbl'>재고일수</td>" +
    monthData.map(function(d) {
      var txt = d.daysVal !== null ? d.daysVal + "일" : "—";
      var hiCls = d.daysVal !== null && d.daysVal > 120 ? " hi" : "";
      return "<td class='rtf-kpi-val" + hiCls + "'>" +
        "<span class='rtf-kpi-main'>" + escapeHtml(txt) + "</span>" +
        deltaSpan(d.deltaDays, "일") +
        "</td>";
    }).join("") + "</tr>";

  var sharedChip = _getSharedConflictChip(months);

  return "<div class='rtf-kpi-wrap' style='margin-bottom:12px;'>" +
    "<table class='rtf-kpi-table'>" +
    "<thead>" + headerRow + "</thead>" +
    "<tbody>" + amtRow + daysRow + "</tbody>" +
    "</table>" +
    (sharedChip ? "<div style='padding:6px 10px;'>" + sharedChip + "</div>" : "") +
  "</div>";
}

// ── 완제품별 클릭 → 자재 조정 리스트 ─────────────────────────────────────────
function renderCstRtfShortList(months) {
  if (state.bomStatus !== BOM_STATUS.DONE || !state.bomResult) return "";
  if (typeof computeRtfItems !== "function") return "";

  var adjMap   = typeof buildBomMaxProducibleMap === "function" ? buildBomMaxProducibleMap(state.matSimAdj) : null;
  var rtfItems = computeRtfItems(adjMap);
  var shortFgs = rtfItems.filter(function(fg) {
    return fg.typeGroup === "완제품" &&
      fg.monthlyStatus.some(function(ms) { return (ms.shortageQty || 0) > 0; });
  });

  // RTF에서 특정 완제품 부족 셀을 클릭해 넘어온 경우 → 그 완제품만 표시
  var d = state.cstDrilldown;
  if (d && !d.isAggregate && d.itemCode) {
    shortFgs = shortFgs.filter(function(fg) {
      return fg.itemCode === d.itemCode && (!d.plant || fg.plantCode === d.plant);
    });
  } else if (d && d.isAggregate && d.itemCodes && d.itemCodes.length) {
    var _codeSet = new Set(d.itemCodes);
    shortFgs = shortFgs.filter(function(fg) {
      return _codeSet.has(fg.itemCode) && (!d.plant || fg.plantCode === d.plant);
    });
  }

  if (shortFgs.length === 0) return "";

  var expanded = state.cstRtfExpanded || new Set();
  var simAdj   = state.matSimAdj || {};
  var hasAdj   = Object.keys(simAdj).length > 0;

  var supplyMap = new Map();
  state.mappedData.plan_monthly.forEach(function(r) {
    var code = cleanOptional(r.itemCode), plant = cleanOptional(r.plant) || "", month = cleanOptional(r.month);
    if (!code || !month) return;
    var k = code + "|" + plant + "|" + month;
    supplyMap.set(k, (supplyMap.get(k) || 0) + (cleanNumber(r.supplyQty) || 0));
  });

  // BOM에 root로 등록된 완제품 코드 집합 (플랜트 무관) — "BOM 미연결" vs "자재 부족 없음" 구분용
  var bomRootSet = new Set();
  (state.mappedData.bom_components || []).forEach(function(b) {
    var rc = cleanOptional(b.rootItemCode);
    if (rc) bomRootSet.add(rc);
  });

  var rows = shortFgs.map(function(fg) {
    var fgKey  = fg.itemCode + "|" + fg.plantCode;
    var isOpen = expanded.has(fgKey);

    // 원인 자재: BOM 부족 자재 중 이 완제품을 parentItem으로 갖는 것
    var relMats = (state.bomResult.items || []).filter(function(mat) {
      return mat.hasAnyShortage && mat.parentItems.some(function(p) {
        return p.code === fg.itemCode && p.plant === fg.plantCode;
      });
    });

    // 최악 부족월
    var worst = fg.monthlyStatus.reduce(function(mx, ms) {
      return (ms.shortageQty || 0) > (mx.shortageQty || 0) ? ms : mx;
    }, fg.monthlyStatus[0] || {});

    // 이 완제품에 연결된 전체 자재(부족 무관) — 부족 자재가 없을 때 원인 구분용
    var allMats = (state.bomResult.items || []).filter(function(mat) {
      return mat.parentItems.some(function(p) { return p.code === fg.itemCode && p.plant === fg.plantCode; });
    });
    // 생산(BOM) 플랜트가 계획 플랜트와 다른지 — 폴백으로 연결된 경우
    var prodPlants = {};
    allMats.forEach(function(m) { if (m.plant && m.plant !== fg.plantCode) prodPlants[m.plant] = true; });
    var crossPlants = Object.keys(prodPlants);

    var sharedCnt = relMats.filter(function(m) { return m.isShared; }).length;
    var matBadge, matBadgeCls;
    if (relMats.length > 0) {
      matBadge = "원인자재 " + relMats.length + "종" + (sharedCnt > 0 ? " (공용 " + sharedCnt + ")" : "");
      matBadgeCls = "";
    } else if (allMats.length > 0) {
      matBadge = "자재 부족 없음 (공급계획 요인)";
      matBadgeCls = " cst-fgl-matbadge-neutral";
    } else if (bomRootSet.has(fg.itemCode)) {
      matBadge = "BOM 플랜트 불일치 — 원천 확인";
      matBadgeCls = " cst-fgl-matbadge-none";
    } else {
      matBadge = "BOM 미연결";
      matBadgeCls = " cst-fgl-matbadge-none";
    }
    var worstStr = (worst.shortageQty || 0) > 0
      ? monthLabel(worst.month) + " " + formatNumber(Math.round(worst.shortageQty)) + "개 부족"
      : "";

    var sharedAlertBadge = fg.hasSharedAlert
      ? "<span class=\"cst-fgl-shared-badge\">⚠공용</span>" : "";
    var altBomBadge = fg.hasAltBomAlert
      ? "<span class=\"cst-fgl-altbom-badge\" title=\"대체 BOM 존재 — 공급 부족 시 전환 검토 가능\">대체BOM</span>" : "";
    // 생산 플랜트 표식 (판매계획 플랜트와 다르게 실제 BOM/자재가 있는 공장)
    var prodPlantBadge = crossPlants.length > 0
      ? "<span class=\"cst-fgl-prodplant-badge\" title=\"판매계획 플랜트와 생산(BOM·자재) 플랜트가 다릅니다. 원천 정정 대상.\">생산: " + escapeHtml(crossPlants.map(displayPlantName).join(",")) + " (BOM)</span>"
      : "";
    var summaryRow = "<tr class=\"cst-fgl-row" + (isOpen ? " cst-fgl-open" : "") +
      "\" data-fgkey=\"" + escapeHtml(fgKey) + "\">" +
      "<td class=\"cst-fgl-icon\">" + (isOpen ? "▼" : "▶") + "</td>" +
      "<td class=\"cst-fgl-name\">" +
        "<span class=\"cst-fgl-code-chip\">" + escapeHtml(fg.itemCode) + "</span>" +
        escapeHtml(fg.itemName) + sharedAlertBadge + altBomBadge + prodPlantBadge +
        "<span class=\"cst-fgl-code-sub\">" +
        (fg.businessUnit && fg.businessUnit !== "기준정보 확인 필요" ? escapeHtml(fg.businessUnit) + " · " : "") +
        escapeHtml(fg.plant) +
        "</span></td>" +
      "<td class=\"cst-fgl-meta\"><span class=\"cst-fgl-matbadge" + matBadgeCls + "\">" +
      escapeHtml(matBadge) + "</span></td>" +
      "<td class=\"cst-fgl-shortage\">" +
      (worstStr ? "<span class=\"cst-fgl-short-chip\">" + escapeHtml(worstStr) + "</span>" : "") +
      "</td>" +
      "</tr>";

    if (!isOpen) return summaryRow;

    var matContent = relMats.length > 0
      ? renderCstFgMatTable(relMats, months, supplyMap, simAdj)
      : allMats.length > 0
        ? "<div class=\"cst-fgl-no-mat\">연결된 자재는 모두 충분합니다. 이 완제품의 부족은 <b>공급계획(생산계획) 자체 부족</b>이 원인입니다.</div>"
        : bomRootSet.has(fg.itemCode)
          ? "<div class=\"cst-fgl-no-mat\">이 완제품은 BOM이 다른 플랜트에 등록돼 있어 자재가 연결되지 않았습니다. <b>판매계획 플랜트 정정(원천)</b>이 필요합니다.</div>"
          : "<div class=\"cst-fgl-no-mat\">BOM에 이 완제품(Root)이 없습니다. BOM 파일을 확인하세요.</div>";

    var detailRow = "<tr class=\"cst-fgl-detail-row\"><td colspan=\"4\" class=\"cst-fgl-detail-cell\">" + matContent + "</td></tr>";
    return summaryRow + detailRow;
  }).join("");

  var resetBtn = hasAdj
    ? "<button type=\"button\" class=\"cst-sa-reset-all\" id=\"cstSaResetAll\">전체 초기화</button>"
    : "";

  // RTF에서 특정 완제품으로 드릴다운된 경우 — 필터 상태 표시 + 전체 보기
  var drillNotice = "";
  var _dFilter = (d && !d.isAggregate && d.itemCode) ? (d.itemName || d.itemCode)
    : (d && d.isAggregate && d.itemCodes && d.itemCodes.length) ? (d.label || (d.itemCodes.length + "개 품목"))
    : null;
  if (_dFilter) {
    drillNotice = "<div class=\"cst-fgl-drill-notice\">🔎 <b>" + escapeHtml(_dFilter) + "</b> 기준으로 필터 중" +
      "<button type=\"button\" class=\"cst-fgl-drill-clear\" id=\"cstClearDrilldownTop\">전체 보기 ✕</button></div>";
  }

  return "<section class=\"cst-card cst-fgl-section\">" +
    "<div class=\"cst-sec-title\">RTF 부족 완제품 · 원인 자재 조정 <span class=\"cst-sa-count\">" +
    shortFgs.length + "건</span>" +
    (hasAdj ? " <span class=\"mat-sim-badge\">조정 중</span>" : "") + resetBtn + "</div>" +
    drillNotice +
    "<table class=\"cst-fgl-table\"><tbody>" + rows + "</tbody></table>" +
    "</section>";
}

// ── 완제품별 자재 조정 테이블 (내부) ──────────────────────────────────────────
function renderCstFgMatTable(mats, months, supplyMap, simAdj) {
  var monthHeads = months.map(function(m, mi) {
    return "<th colspan=\"2\" class=\"cst-sa-mhd" + (mi > 0 ? " cst-sa-mborder" : "") + "\">" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");
  var subHeads = months.map(function(_, mi) {
    return "<th class=\"cst-sa-sub" + (mi > 0 ? " cst-sa-mborder" : "") + "\">입고/조정</th><th class=\"cst-sa-sub\">부족</th>";
  }).join("");

  var bodyRows = mats.map(function(item) {
    var dec         = _cstDecByUnit(item.unit);
    var sharedBadge = item.isShared ? " <span class=\"cst-shared-badge\">공용</span>" : "";
    var itemHasAdj  = months.some(function(m) {
      var k = item.componentCode + "|" + item.plant + "|" + m;
      return (k in simAdj) && Math.abs(simAdj[k] - (supplyMap.get(k) || 0)) > 0.001;
    });

    var _extraCarry = 0;
    var monthCells = months.map(function(month, mi) {
      var k    = item.componentCode + "|" + item.plant + "|" + month;
      var orig = supplyMap.get(k) || 0;
      var adj  = (k in simAdj) ? simAdj[k] : orig;
      var isAdj = (k in simAdj) && Math.abs(simAdj[k] - orig) > 0.001;
      var delta = adj - orig;
      var md   = item.monthlyData[mi] || {};
      var origShortage = md.shortageQty || 0;

      var adjShortage = null;
      if (item.hasInventory && item.hasSupplyPlan && md.availableQty !== null) {
        var opening   = Math.max(0, md.availableQty - orig);
        var req       = md.requiredQty || 0;
        var origAvail = opening + orig;
        var adjAvail  = opening + adj + _extraCarry;
        adjShortage   = Math.max(0, req - adjAvail);
        // 다음 달로 잉여 이월
        var origEnding = Math.max(0, origAvail - req);
        var adjEnding  = Math.max(0, adjAvail  - req);
        _extraCarry = Math.max(0, adjEnding - origEnding);
      } else {
        _extraCarry = 0;
      }
      var hasAnyItemAdj = months.some(function(m) {
        var kk = item.componentCode + "|" + item.plant + "|" + m;
        return (kk in simAdj) && Math.abs(simAdj[kk] - (supplyMap.get(kk) || 0)) > 0.001;
      });
      var showShortage = (isAdj || hasAnyItemAdj) ? adjShortage : origShortage;
      var borderCls    = mi > 0 ? " cst-sa-mborder" : "";
      var deltaHtml    = isAdj
        ? "<span class=\"mat-sim-delta " + (delta > 0 ? "mat-sim-pos" : "mat-sim-neg") + "\">" +
          (delta > 0 ? "+" : "") + formatNumber(Math.round(delta)) + "</span>"
        : "";

      var reqHtml = "<div class=\"cst-sa-sales\">소요 " + escapeHtml(_cstFmtVal(md.requiredQty || 0, dec, "")) + "</div>";
      var inputCell = "<td class=\"cst-sa-input-cell" + borderCls + (isAdj ? " cst-sa-adjusted" : "") + "\">" +
        reqHtml +
        "<input type=\"number\" class=\"cst-adj-month-input\" data-key=\"" + escapeHtml(k) +
        "\" data-orig=\"" + orig + "\" value=\"" + adj + "\" min=\"0\" step=\"1\" />" + deltaHtml + "</td>";

      var shortCell = (showShortage === null || showShortage === undefined) ? "<td class=\"cst-sa-short-cell" + borderCls + "\">-</td>"
        : (showShortage <= 0 && origShortage > 0 && isAdj) ? "<td class=\"cst-sa-resolved" + borderCls + "\">✓ 해소</td>"
        : showShortage > 0 ? "<td class=\"cst-sa-short-num" + borderCls + "\">" + escapeHtml(_cstFmtVal(showShortage, dec, "")) + "</td>"
        : "<td class=\"cst-sa-short-cell" + borderCls + "\">-</td>";

      return inputCell + shortCell;
    }).join("");

    var resetBtn = itemHasAdj
      ? "<button class=\"cst-adj-row-reset\" data-comp-code=\"" + escapeHtml(item.componentCode) +
        "\" data-plant=\"" + escapeHtml(item.plant) + "\">초기화</button>"
      : "";

    return "<tr class=\"cst-sa-row\">" +
      "<td class=\"cst-sa-code\">" + escapeHtml(item.componentCode) + "</td>" +
      "<td class=\"cst-sa-name\">" + escapeHtml(item.componentName) + sharedBadge + "</td>" +
      "<td class=\"cst-sa-unit\">" + escapeHtml(item.unit || "-") + "</td>" +
      monthCells +
      "<td class=\"cst-sa-reset-cell\">" + resetBtn + "</td>" +
      "</tr>";
  }).join("");

  return "<div class=\"cst-fgl-mat-wrap\"><div class=\"cst-h-scroll\"><table class=\"cst-sa-table\">" +
    "<thead><tr>" +
    "<th rowspan=\"2\" class=\"cst-sa-lhd\">자재코드</th>" +
    "<th rowspan=\"2\" class=\"cst-sa-lhd cst-sa-namehd\">자재명</th>" +
    "<th rowspan=\"2\" class=\"cst-sa-lhd\">단위</th>" +
    monthHeads + "<th rowspan=\"2\" class=\"cst-sa-lhd\"></th>" +
    "</tr><tr>" + subHeads + "</tr></thead>" +
    "<tbody>" + bodyRows + "</tbody>" +
    "</table></div></div>";
}

// ── 화면 렌더 ─────────────────────────────────────────────────────────────────
function renderConstraint() {
  var hasData   = state.mappedData.plan_monthly.length > 0;
  var bomStatus = state.bomStatus || BOM_STATUS.IDLE;
  var months    = getRtfMonths();

  var d = state.cstDrilldown;
  // 상품 유형은 BOM 전개 불필요 — 개별/집계 모두 goods 패널로 처리
  var isGoods = d && d.typeGroup === "상품";

  // 상세 분석: BOM 미완료 시 자동 펼침 (전개 버튼에 접근해야 하므로)
  var detailOpen = state.cstAnalysisOpen || (bomStatus !== BOM_STATUS.DONE);
  var collapseIcon = detailOpen ? "▼" : "▶";

  var detailBody = detailOpen
    ? ((d ? renderCstDrilldownBanner(d) : "") +
       (isGoods ? renderCstGoodsPanel(d) : "") +
       (!isGoods && d ? renderCstFinishedGoodsPanel(d) : "") +
       (d ? renderCstShortMaterialsPanel(d) : "") +
       (!isGoods ? renderConstraintTableSection(state.bomResult, bomStatus, months) : "") +
       (!isGoods ? renderValidationPanel() : ""))
    : "";

  // BOM 전개 완료 후에만 무거운 비교 배너·부족목록 렌더 (미완료 시 연산 불필요)
  var bomDone = bomStatus === BOM_STATUS.DONE;

  // 상품 드릴다운: BOM 전개 불필요 → 완제품과 동일한 KPI 배너 + 조정 패널을 상단에 바로 노출
  if (isGoods) {
    return "<div class=\"cst-screen\">" +
      (!hasData ? "<div class=\"cst-toolbar-warn-bar\">데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 먼저 선택하십시오.</div>" : "") +
      renderCstDrilldownBanner(d) +
      (bomDone ? renderCstCompareBanner() : "") +
      renderCstGoodsPanel(d) +
      "</div>";
  }

  return "<div class=\"cst-screen\">" +
    (!hasData ? "<div class=\"cst-toolbar-warn-bar\">데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 먼저 선택하십시오.</div>" : "") +
    (bomDone ? renderCstAiSuggestion(months) : "") +
    (bomDone ? renderCstCompareBanner() : "") +
    (bomDone ? renderCstRtfShortList(months) : "") +
    "<div class=\"cst-collapse-wrap\">" +
    "<button type=\"button\" class=\"cst-collapse-btn\" id=\"cstAnalysisToggle\">" +
    escapeHtml(collapseIcon + " 상세 분석 (BOM 전개 · 정합성 검증)") +
    "</button>" +
    detailBody +
    "</div>" +
    "</div>";
}

// ── 영향품목 팝업 ─────────────────────────────────────────────────────────────
function openCstImpactPopup(compKey) {
  var item = (state.bomResult && state.bomResult.items || []).find(function(it) {
    return (it.componentCode + "|" + (it.plant || "")) === compKey;
  });
  if (!item || !item.parentItems.length) return;

  var months = getRtfMonths();

  // RTF 상태 맵
  var rtfMap = new Map();
  if (typeof computeRtfItems === "function") {
    var adj = typeof buildBomMaxProducibleMap === "function" ? buildBomMaxProducibleMap(state.matSimAdj || {}) : null;
    computeRtfItems(adj).forEach(function(fg) {
      rtfMap.set(fg.itemCode + "|" + (fg.plant || ""), fg);
    });
  }

  var monthHeaders = months.map(function(m) {
    return "<th class='cst-popup-mhd'>" + escapeHtml(monthLabel(m)) + "</th>";
  }).join("");

  var rows = item.parentItems.map(function(p) {
    var fgKey = p.code + "|" + (p.plant || "");
    var fgRtf = rtfMap.get(fgKey);
    var monthCells = months.map(function(m) {
      if (!fgRtf) return "<td class='cst-popup-unknown'>—</td>";
      var ms = fgRtf.monthlyStatus.find(function(s) { return s.month === m; });
      if (!ms) return "<td class='cst-popup-unknown'>—</td>";
      var s = ms.shortageQty || 0;
      if (s > 0) return "<td class='cst-popup-short'>부족<br><span class='cst-popup-qty'>" + formatNumber(Math.round(s)) + "</span></td>";
      return "<td class='cst-popup-ok'>✓ 정상</td>";
    }).join("");
    return "<tr>" +
      "<td class='cst-popup-fname'>" + escapeHtml(p.name || p.code) + "</td>" +
      "<td class='cst-popup-fcode'>" + escapeHtml(p.code) + "</td>" +
      monthCells + "</tr>";
  }).join("");

  var html = "<div id='cstImpactOverlay' class='cst-popup-overlay'>" +
    "<div class='cst-popup-box'>" +
      "<div class='cst-popup-header'>" +
        "<div><div class='cst-popup-title'>영향 완제품 목록</div>" +
        "<div class='cst-popup-subtitle'>" + escapeHtml(item.componentName) + " · " + escapeHtml(item.componentCode) + "</div></div>" +
        "<button class='cst-popup-close' id='cstImpactClose'>✕</button>" +
      "</div>" +
      "<div class='cst-popup-body'>" +
        "<table class='cst-popup-table'><thead><tr>" +
          "<th>완제품명</th><th>코드</th>" + monthHeaders +
        "</tr></thead><tbody>" + rows + "</tbody></table>" +
      "</div>" +
    "</div></div>";

  var existing = document.getElementById("cstImpactOverlay");
  if (existing) existing.remove();
  document.body.insertAdjacentHTML("beforeend", html);

  function closePopup() {
    var el = document.getElementById("cstImpactOverlay");
    if (el) el.remove();
  }
  document.getElementById("cstImpactClose").addEventListener("click", closePopup);
  document.getElementById("cstImpactOverlay").addEventListener("click", function(e) {
    if (e.target === this) closePopup();
  });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { closePopup(); document.removeEventListener("keydown", esc); }
  });
}

// ── BOM 전개 실행 (onclick에서 직접 호출 — addEventListener 미사용) ──────────────
function triggerBomExpand() {
  if (state.bomStatus === BOM_STATUS.RUNNING) return;
  var myId  = ++_bomAnimId;
  var steps = ["데이터 확인 중","소요량 산출 중","가용수량 비교 중","공용자재 확인 중"];
  var stepIdx = 0;
  state.bomStatus       = BOM_STATUS.RUNNING;
  state.bomProgressStep = "BOM 전개 중";
  state.expandedConstraintRows = new Set();
  state.constraintShowAll = false;
  _cstBomRtfItems = null;
  if (typeof _bomMaxProducibleCache !== "undefined") _bomMaxProducibleCache = null;
  if (typeof invalidateRtfCache === "function") invalidateRtfCache();
  render("constraint");

  var advance = function() {
    if (myId !== _bomAnimId) return;
    if (stepIdx < steps.length) {
      state.bomProgressStep = steps[stepIdx++];
      var labelEl = document.querySelector(".cst-progress-label");
      if (labelEl) {
        labelEl.textContent = state.bomProgressStep;
      } else {
        render("constraint");
      }
      setTimeout(advance, 160);
    } else {
      state.bomProgressStep = "전개 계산 중...";
      var labelEl2 = document.querySelector(".cst-progress-label");
      if (labelEl2) { labelEl2.textContent = state.bomProgressStep; }
      else { render("constraint"); }
      setTimeout(function() {
        if (myId !== _bomAnimId) return;
        try {
          var res = computeBomExpansion();
          state.bomResult  = res;
          state.bomStatus  = res.status;
        } catch(e) {
          state.bomResult  = { status:BOM_STATUS.FAILED, failReasons:["BOM 전개 오류: " + (e.message || e)], items:[], stats:{} };
          state.bomStatus  = BOM_STATUS.FAILED;
        }
        state.bomProgressStep = "";
        state.constraintSearch = "";
        state.constraintDetailMode = false;
        state.constraintImpactSort = 0;
        state.constraintFilter = (state.bomResult && state.bomResult.items && state.bomResult.items.some(function(i) { return i.hasAnyShortage; })) ? "shortage" : "all";
        if (typeof invalidateRtfCache === "function") invalidateRtfCache();
        render("constraint");
        if (state.currentMenuId === "rtf") render("rtf");
      }, 50);
    }
  };
  setTimeout(advance, 100);
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindConstraint() {

  // 더 보기
  var showMoreBtn = document.querySelector("#cstShowMore");
  if (showMoreBtn) showMoreBtn.addEventListener("click", function() {
    state.constraintShowAll = true;
    render("constraint");
  });

  // 필터 버튼
  document.querySelectorAll("[data-cst-filter]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      state.constraintFilter = btn.dataset.cstFilter;
      state.constraintShowAll = false; // 필터 변경 시 행 제한 초기화
      render("constraint");
    });
  });

  // 검색
  var searchInput = document.querySelector("#cstSearch");
  if (searchInput) searchInput.addEventListener("input", function(e) {
    state.constraintSearch = e.target.value;
    render("constraint");
  });

  // 상세보기 토글
  var toggleBtn = document.querySelector("#cstDetailToggle");
  if (toggleBtn) toggleBtn.addEventListener("click", function() {
    state.constraintDetailMode = !state.constraintDetailMode;
    render("constraint");
  });

  // 영향품목수 정렬 (0→1→-1→0)
  document.querySelectorAll("[data-sort-impact]").forEach(function(el) {
    el.addEventListener("click", function() {
      var cur = state.constraintImpactSort || 0;
      state.constraintImpactSort = cur === 0 ? 1 : cur === 1 ? -1 : 0;
      render("constraint");
    });
  });

  // 정합성 검증 버튼
  var critBtn = document.querySelector("#calcCriteriaBtn");
  if (critBtn) critBtn.addEventListener("click", function() {
    state.calcCriteriaOpen = !state.calcCriteriaOpen;
    render("constraint");
  });

  var valBtn = document.querySelector("#validationBtn");
  if (valBtn) valBtn.addEventListener("click", function() {
    state.validationPanelOpen = true;
    state.validationTab = 0;
    render("constraint");
  });

  // 패널 닫기
  var closeBtn = document.querySelector("#vldCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", function() {
    state.validationPanelOpen = false;
    render("constraint");
  });
  // 오버레이 배경 클릭으로 닫기
  var overlay = document.querySelector("#validationOverlay");
  if (overlay) overlay.addEventListener("click", function(e) {
    if (e.target === overlay) { state.validationPanelOpen = false; render("constraint"); }
  });

  // 검증 탭 전환
  document.querySelectorAll("[data-vld-tab]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      state.validationTab = parseInt(btn.dataset.vldTab, 10) || 0;
      render("constraint");
    });
  });

  // 영향품목 팝업
  document.querySelectorAll(".cst-impact-btn").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      openCstImpactPopup(btn.dataset.compKey);
    });
  });

  // 드릴다운 해제 (상세 분석 배너 + 부족목록 상단 두 곳)
  ["#cstClearDrilldown", "#cstClearDrilldownTop"].forEach(function(sel) {
    var el = document.querySelector(sel);
    if (el) el.addEventListener("click", function() {
      state.cstDrilldown = null;
      render("constraint");
    });
  });

  // ── 완제품 카드 입고 조정 입력 ──
  document.querySelectorAll(".cst-fg-adj-input").forEach(function(inp) {
    inp.addEventListener("change", function() {
      if (!state.matSimAdj) state.matSimAdj = {};
      var key = inp.dataset.key;
      var val = Math.max(0, parseFloat(inp.value) || 0);
      if (val < 0.001) { delete state.matSimAdj[key]; }
      else              { state.matSimAdj[key] = val; }
      render("constraint");
      if (state.currentMenuId === "rtf") render("rtf");
    });
  });

  // ── 자재 시뮬레이션 입고계획 인라인 편집 ──
  document.querySelectorAll(".mat-sim-input").forEach(function(inp) {
    inp.addEventListener("change", function() {
      if (!state.matSimAdj) state.matSimAdj = {};
      var key  = inp.dataset.key;
      var orig = parseFloat(inp.dataset.orig) || 0;
      var val  = Math.max(0, parseFloat(inp.value) || 0);
      if (Math.abs(val - orig) < 0.001) {
        delete state.matSimAdj[key];
      } else {
        state.matSimAdj[key] = val;
      }
      render("constraint");
    });
  });

  // ── 결정사항 회의록 기록 ──
  var recordBtn = document.querySelector(".mat-sim-record-btn");
  if (recordBtn) recordBtn.addEventListener("click", function() {
    var month = recordBtn.dataset.month;
    if (state.cstDrilldown) recordMinutesEntry(state.cstDrilldown, month);
  });

  // ── 조정 초기화 (드릴다운 패널) ──
  var resetBtn = document.querySelector(".mat-sim-reset-btn");
  if (resetBtn) resetBtn.addEventListener("click", function() {
    state.matSimAdj = {};
    state.aiAppliedKeys = {};
    render("constraint");
  });

  // ── 상품 조정 초기화 ──
  var goodsReset = document.querySelector("#cstGoodsReset");
  if (goodsReset) goodsReset.addEventListener("click", function() {
    state.goodsSupplyAdj = {};
    if (typeof invalidateRtfCache === "function") invalidateRtfCache();
    render("constraint");
    if (state.currentMenuId === "rtf") render("rtf");
  });

  // ── 상품 공급(입고) 조정 입력 ──
  document.querySelectorAll(".cst-goods-input").forEach(function(inp) {
    inp.addEventListener("change", function() {
      if (!state.goodsSupplyAdj) state.goodsSupplyAdj = {};
      var key  = inp.dataset.key;
      var orig = parseFloat(inp.dataset.orig) || 0;
      var val  = Math.max(0, parseFloat(inp.value) || 0);
      if (Math.abs(val - orig) < 0.001) { delete state.goodsSupplyAdj[key]; }
      else                              { state.goodsSupplyAdj[key] = val; }
      if (typeof invalidateRtfCache === "function") invalidateRtfCache();
      render("constraint");
      if (state.currentMenuId === "rtf") render("rtf");
    });
  });
  // ── 상품 행 초기화 ──
  document.querySelectorAll(".cst-goods-row-reset").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (!state.goodsSupplyAdj) return;
      var code = btn.dataset.itemCode, plant = btn.dataset.plant;
      Object.keys(state.goodsSupplyAdj).forEach(function(k) {
        var p = k.split("|");
        if (p[0] === code && p[1] === plant) delete state.goodsSupplyAdj[k];
      });
      if (typeof invalidateRtfCache === "function") invalidateRtfCache();
      render("constraint");
      if (state.currentMenuId === "rtf") render("rtf");
    });
  });

  // ── AI 권장안 적용 (전체 / 개별) ──
  var aiApplyAll = document.querySelector("#cstAiApplyAll");
  if (aiApplyAll) aiApplyAll.addEventListener("click", function() {
    if (!_cstAiPlan || !_cstAiPlan.overrides) return;
    if (!state.matSimAdj) state.matSimAdj = {};
    if (!state.aiAppliedKeys) state.aiAppliedKeys = {};
    Object.keys(_cstAiPlan.overrides).forEach(function(k) {
      state.matSimAdj[k] = _cstAiPlan.overrides[k];
      state.aiAppliedKeys[k] = true;
    });
    render("constraint");
    if (state.currentMenuId === "rtf") render("rtf");
  });
  document.querySelectorAll(".cst-ai-apply-one").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (!_cstAiPlan || !_cstAiPlan.overrides) return;
      if (!state.matSimAdj) state.matSimAdj = {};
      if (!state.aiAppliedKeys) state.aiAppliedKeys = {};
      (btn.dataset.fgkeys || "").split(",").filter(Boolean).forEach(function(k) {
        if (k in _cstAiPlan.overrides) { state.matSimAdj[k] = _cstAiPlan.overrides[k]; state.aiAppliedKeys[k] = true; }
      });
      render("constraint");
      if (state.currentMenuId === "rtf") render("rtf");
    });
  });
  // ── AI 권장안 해제 (적용했던 것만 되돌림) ──
  var aiClearAll = document.querySelector("#cstAiClearAll");
  if (aiClearAll) aiClearAll.addEventListener("click", function() {
    if (state.matSimAdj && state.aiAppliedKeys) {
      Object.keys(state.aiAppliedKeys).forEach(function(k) { delete state.matSimAdj[k]; });
    }
    state.aiAppliedKeys = {};
    if (typeof invalidateRtfCache === "function") invalidateRtfCache();
    render("constraint");
    if (state.currentMenuId === "rtf") render("rtf");
  });

  // ── 상세 분석 접기/펼치기 ──
  var analysisToggle = document.querySelector("#cstAnalysisToggle");
  if (analysisToggle) analysisToggle.addEventListener("click", function() {
    state.cstAnalysisOpen = !state.cstAnalysisOpen;
    render("constraint");
  });

  // ── 전체 초기화 (통합 조정 테이블) ──
  var saResetAll = document.querySelector("#cstSaResetAll");
  if (saResetAll) saResetAll.addEventListener("click", function() {
    state.matSimAdj = {};
    state.aiAppliedKeys = {};
    render("constraint");
  });

  // ── BOM 테이블 월별 입고조정 입력 ──
  document.querySelectorAll(".cst-adj-month-input").forEach(function(inp) {
    inp.addEventListener("change", function() {
      if (!state.matSimAdj) state.matSimAdj = {};
      var key  = inp.dataset.key;
      var orig = parseFloat(inp.dataset.orig) || 0;
      var val  = Math.max(0, parseFloat(inp.value) || 0);
      if (Math.abs(val - orig) < 0.001) {
        delete state.matSimAdj[key];
      } else {
        state.matSimAdj[key] = val;
      }
      render("constraint");
    });
  });

  // ── 행별 초기화 ──
  document.querySelectorAll(".cst-adj-row-reset").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var compCode = btn.dataset.compCode;
      var plant    = btn.dataset.plant;
      var adj = state.matSimAdj || {};
      Object.keys(adj).forEach(function(k) {
        var parts = k.split("|");
        if (parts[0] === compCode && parts[1] === plant) delete adj[k];
      });
      render("constraint");
    });
  });

  // ── 완제품 행 클릭 → 자재 조정 펼침/접기 ──
  document.querySelectorAll(".cst-fgl-row").forEach(function(row) {
    row.addEventListener("click", function() {
      if (window.getSelection && window.getSelection().toString()) return; // 텍스트 선택 중이면 무시
      if (!state.cstRtfExpanded) state.cstRtfExpanded = new Set();
      var key = row.dataset.fgkey;
      if (state.cstRtfExpanded.has(key)) state.cstRtfExpanded.delete(key);
      else state.cstRtfExpanded.add(key);
      render("constraint");
    });
  });
}
