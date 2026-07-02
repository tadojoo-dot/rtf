// ── BOM 전개 시뮬레이션 ────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// 정전개 결과 계산 (단일 FG)
// ═══════════════════════════════════════════════════════════════════════════
function calcForwardBom(fgCode, plant, qty) {
  // plant이 NEED_MASTER이거나 빈 값이면 plant 필터 생략 (상품 등 플랜트 없는 케이스)
  var normPlant = (!plant || plant === NEED_MASTER) ? null : plant;

  var comps = (state.mappedData.bom_components || []).filter(function(b) {
    if (cleanOptional(b.rootItemCode) !== fgCode) return false;
    if (normPlant !== null) {
      var bp = cleanOptional(b.plant) || "";
      if (bp && bp !== normPlant) return false;
    }
    return true;
  });

  return comps.map(function(b) {
    var cc     = cleanOptional(b.componentCode) || "";
    var cn     = cleanOptional(b.componentName) || cc;
    var unit   = cleanOptional(b.componentUnit) || cleanOptional(b.unit) || "";
    var bomQty = cleanNumber(b.componentQty) || 0;
    var needed = bomQty * qty;
    var matInv = (state.mappedData.inventory_base || []).find(function(r) {
      return cleanOptional(r.itemCode) === cc;
    });
    var stock = matInv ? (cleanNumber(matInv.baseQty) || 0) : null;
    var diff  = stock !== null ? stock - needed : null;
    return { cc, cn, unit, bomQty, needed, stock, diff };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 정전개 멀티 집계: 여러 FG 품목의 자재 소요량 합산
// ═══════════════════════════════════════════════════════════════════════════
function calcForwardBomMulti(fgKeys, qty) {
  var matMap = new Map(); // compCode → aggregated row

  fgKeys.forEach(function(key) {
    var idx    = key.lastIndexOf("|");
    var fgCode = idx >= 0 ? key.slice(0, idx) : key;
    var plant  = idx >= 0 ? key.slice(idx + 1) : "";
    var rows   = calcForwardBom(fgCode, plant, qty);

    rows.forEach(function(r) {
      if (!r.cc) return;
      if (matMap.has(r.cc)) {
        var e = matMap.get(r.cc);
        e.needed += r.needed;
        if (e.stock !== null) e.diff = e.stock - e.needed;
      } else {
        matMap.set(r.cc, { cc: r.cc, cn: r.cn, unit: r.unit, needed: r.needed, stock: r.stock, diff: r.diff });
      }
    });
  });

  return Array.from(matMap.values()).sort(function(a, b) { return b.needed - a.needed; });
}

// ═══════════════════════════════════════════════════════════════════════════
// 역전개 결과 계산
// ═══════════════════════════════════════════════════════════════════════════
function calcReverseBom(matCode) {
  var months   = getRtfMonths();
  var rtfItems = computeRtfItems();
  var rtfMap   = new Map();
  rtfItems.forEach(function(item) {
    rtfMap.set(item.itemCode + "|" + (item.plantCode || ""), item);
  });

  var usages = (state.mappedData.bom_components || []).filter(function(b) {
    return cleanOptional(b.componentCode) === matCode;
  });

  return usages.map(function(b) {
    var rc     = cleanOptional(b.rootItemCode) || "";
    var pl     = cleanOptional(b.plant) || "";
    var bomQty = cleanNumber(b.componentQty) || 0;
    var fgItem = rtfMap.get(rc + "|" + pl);
    var rn     = fgItem ? (fgItem.itemName || rc) : (cleanOptional(b.rootItemName) || rc);

    var monthlyNeeds = months.map(function(m, mi) {
      var ms    = fgItem && fgItem.monthlyStatus && fgItem.monthlyStatus[mi];
      var sales = ms ? Math.round(ms.salesQty || 0) : 0;
      return Math.round(sales * bomQty);
    });

    return { rc, rn, pl, bomQty, fgItem, monthlyNeeds };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 정전개 결과 HTML
// ═══════════════════════════════════════════════════════════════════════════
function renderForwardResult() {
  var fgKeys = state.bomSimFgCodes || [];
  var qty    = state.bomSimQty || 0;

  if (!fgKeys.length || !qty) {
    return "<div class='bsim-empty'>완제품을 선택(복수 선택 가능)하고 수량 입력 후 <strong>조회</strong>를 누르세요.</div>";
  }

  var rows = calcForwardBomMulti(fgKeys, qty);

  if (!rows.length) {
    return "<div class='bsim-empty'>선택한 품목의 BOM 데이터가 없습니다.<br>" +
      "데이터점검에서 BOM 파일 연결 여부를 확인하세요.<br>" +
      "<span style='font-size:12px;color:#9ca3af;'>선택된 품목코드: " +
      fgKeys.map(function(k){ return escapeHtml(k.split("|")[0]); }).join(", ") +
      "</span></div>";
  }

  var rtfItems = computeRtfItems ? computeRtfItems() : [];
  var rtfMap   = new Map();
  rtfItems.forEach(function(i) { rtfMap.set(i.itemCode + "|" + (i.plantCode || ""), i); });

  var selectedNames = fgKeys.map(function(key) {
    var item = rtfMap.get(key);
    return item ? (item.itemName || key.split("|")[0]) : key.split("|")[0];
  });

  var shortCnt = rows.filter(function(r) { return r.diff !== null && r.diff < 0; }).length;
  var noCnt    = rows.filter(function(r) { return r.stock === null; }).length;

  var summary =
    "<div class='bsim-summary'>" +
      "<span class='bsim-sum-item'>선택 품목 <strong>" + fgKeys.length + "개</strong></span>" +
      "<span class='bsim-sum-item'>자재 <strong>" + rows.length + "개</strong></span>" +
      (shortCnt > 0
        ? "<span class='bsim-sum-item bsim-shortage-tag'>⚠ 재고부족 " + shortCnt + "개</span>"
        : "<span class='bsim-sum-item bsim-ok-tag'>✓ 전 자재 재고 충분</span>") +
      (noCnt > 0 ? "<span class='bsim-sum-item bsim-warn-tag'>재고 미연결 " + noCnt + "개</span>" : "") +
    "</div>" +
    "<div class='bsim-selected-names'>" + selectedNames.map(escapeHtml).join("  ·  ") + "</div>";

  var trs = rows.map(function(r) {
    var diffCls = r.diff === null  ? "bsim-nodata"
                : r.diff >= 0     ? "bsim-surplus"
                :                    "bsim-shortage";
    var diffTxt = r.diff === null  ? "재고 미연결"
                : r.diff >= 0     ? "+" + formatNumber(Math.round(r.diff)) + " 여유"
                :                    formatNumber(Math.round(r.diff)) + " 부족";
    return "<tr class='" + (r.diff !== null && r.diff < 0 ? "bsim-row-short" : "") + "'>" +
      "<td class='bsim-td-code'>" + escapeHtml(r.cc) + "</td>" +
      "<td class='bsim-td-name'>" + escapeHtml(r.cn) + "</td>" +
      "<td class='bsim-td-c'>" + escapeHtml(r.unit) + "</td>" +
      "<td class='bsim-td-r bsim-td-need'>" + escapeHtml(formatNumber(Math.round(r.needed))) + "</td>" +
      "<td class='bsim-td-r'>" + (r.stock !== null
        ? escapeHtml(formatNumber(Math.round(r.stock)))
        : "<span class='bsim-nodata'>—</span>") + "</td>" +
      "<td class='bsim-td-r " + diffCls + "'>" + escapeHtml(diffTxt) + "</td>" +
    "</tr>";
  }).join("");

  return summary +
    "<div class='bsim-table-wrap'>" +
      "<table class='bsim-table'><thead><tr>" +
        "<th>자재코드</th><th>자재명</th><th>단위</th>" +
        "<th>필요수량 합계</th><th>현재고</th><th>부족 / 여유</th>" +
      "</tr></thead><tbody>" + trs + "</tbody></table>" +
    "</div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 역전개 결과 HTML
// ═══════════════════════════════════════════════════════════════════════════
function renderReverseResult() {
  var matCode = state.bomSimMatCode || "";
  if (!matCode) {
    return "<div class='bsim-empty'>자재코드 또는 자재명을 입력 후 <strong>조회</strong>를 누르세요.</div>";
  }

  var months = getRtfMonths();
  var rows   = calcReverseBom(matCode);

  // 이름 검색 fallback
  if (!rows.length) {
    var nameMatch = (state.mappedData.bom_components || []).find(function(b) {
      return (cleanOptional(b.componentName) || "").includes(matCode);
    });
    if (nameMatch) {
      state.bomSimMatCode = cleanOptional(nameMatch.componentCode) || matCode;
      rows = calcReverseBom(state.bomSimMatCode);
    }
  }

  if (!rows.length) {
    return "<div class='bsim-empty'>[" + escapeHtml(matCode) + "] 이 자재를 사용하는 완제품이 없습니다.</div>";
  }

  var matInv  = (state.mappedData.inventory_base || []).find(function(r) {
    return cleanOptional(r.itemCode) === state.bomSimMatCode;
  });
  var stock   = matInv ? Math.round(cleanNumber(matInv.baseQty) || 0) : null;
  var unit    = matInv ? (cleanOptional(matInv.unit) || "") : "";
  var totalM0 = rows.reduce(function(s, r) { return s + (r.monthlyNeeds[0] || 0); }, 0);

  var summary =
    "<div class='bsim-summary'>" +
      "<span class='bsim-sum-item'>사용 완제품 <strong>" + rows.length + "개</strong></span>" +
      "<span class='bsim-sum-item'>이번달 총 소요 <strong>" + formatNumber(totalM0) + (unit ? " " + unit : "") + "</strong></span>" +
      (stock !== null
        ? "<span class='bsim-sum-item" + (stock < totalM0 ? " bsim-shortage-tag" : " bsim-ok-tag") + "'>현재고 " +
            formatNumber(stock) + (unit ? " " + unit : "") + (stock < totalM0 ? " ⚠ 부족" : " ✓") + "</span>"
        : "") +
    "</div>";

  var mHd = months.map(function(m) {
    return "<th>" + escapeHtml(monthLabel(m)) + " 소요</th>";
  }).join("");

  var trs = rows.map(function(r) {
    var pn     = displayPlantName ? displayPlantName(r.pl) : r.pl;
    var mCells = r.monthlyNeeds.map(function(v) {
      return "<td class='bsim-td-r'>" + (v > 0 ? escapeHtml(formatNumber(v)) : "<span class='bsim-nodata'>—</span>") + "</td>";
    }).join("");
    return "<tr>" +
      "<td class='bsim-td-code'>" + escapeHtml(r.rc) + "</td>" +
      "<td class='bsim-td-name'>" + escapeHtml(r.rn) + "</td>" +
      "<td class='bsim-td-c'>" + escapeHtml(pn) + "</td>" +
      "<td class='bsim-td-r'>" + escapeHtml(formatNumber(r.bomQty)) + "</td>" +
      mCells +
    "</tr>";
  }).join("");

  return summary +
    "<div class='bsim-table-wrap'>" +
      "<table class='bsim-table'><thead><tr>" +
        "<th>완제품코드</th><th>완제품명</th><th>플랜트</th>" +
        "<th>BOM수량/EA</th>" + mHd +
      "</tr></thead><tbody>" + trs + "</tbody></table>" +
    "</div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 메인 렌더
// ═══════════════════════════════════════════════════════════════════════════
function renderBomSim() {
  var tab      = state.bomSimTab || "forward";
  var rtfItems = computeRtfItems ? computeRtfItems() : [];
  var hasBom   = (state.mappedData.bom_components || []).length > 0;

  if (!hasBom) {
    return "<section class='section-band'><div class='section-header'><h2>BOM 전개 시뮬레이션</h2>" +
      "<p>데이터점검 화면에서 BOM RAW 파일을 먼저 연결하세요.</p></div></section>";
  }

  var tabHtml =
    "<div class='bsim-tabs'>" +
      "<button class='bsim-tab" + (tab === "forward" ? " bsim-tab-active" : "") + "' data-tab='forward'>" +
        "정전개 <span class='bsim-tab-sub'>완제품 → 자재</span>" +
      "</button>" +
      "<button class='bsim-tab" + (tab === "reverse" ? " bsim-tab-active" : "") + "' data-tab='reverse'>" +
        "역전개 <span class='bsim-tab-sub'>자재 → 완제품</span>" +
      "</button>" +
    "</div>";

  var pane = "";
  var selectedSet = new Set(state.bomSimFgCodes || []);

  if (tab === "forward") {
    var fgOpts = "<option value=''>-- 완제품 / 상품 선택 --</option>" +
      rtfItems.map(function(item) {
        var val = item.itemCode + "|" + (item.plantCode || "");
        var lbl = (item.itemName || item.itemCode) + "  (" + item.itemCode + " · " +
          (displayPlantName ? displayPlantName(item.plantCode || "") : item.plantCode || "") + ")";
        var sel = selectedSet.has(val) ? " selected" : "";
        return "<option value='" + escapeHtml(val) + "'" + sel + ">" + escapeHtml(lbl) + "</option>";
      }).join("");

    pane =
      "<div class='bsim-ctrl'>" +
        "<div class='bsim-ctrl-row bsim-ctrl-row-multi'>" +
          "<label class='bsim-label'>완제품 선택</label>" +
          "<div class='bsim-fg-sel-wrap'>" +
            "<select multiple class='bsim-fg-sel' id='bsimFgSel' size='6'>" + fgOpts + "</select>" +
            "<div class='bsim-sel-hint'>Ctrl+클릭: 복수 선택 · Shift+클릭: 범위 선택</div>" +
          "</div>" +
        "</div>" +
        "<div class='bsim-ctrl-row'>" +
          "<label class='bsim-label'>품목당 수량</label>" +
          "<input type='number' class='bsim-qty' id='bsimQty' value='" + (state.bomSimQty || 1000) + "' min='1' step='1'>" +
          "<span class='bsim-qty-unit'>개 (EA)</span>" +
          "<button class='bsim-run' id='bsimRun'>조회</button>" +
        "</div>" +
      "</div>" +
      "<div class='bsim-result' id='bsimResult'>" + renderForwardResult() + "</div>";

  } else {
    var matEntries = new Map();
    (state.mappedData.bom_components || []).forEach(function(b) {
      var cc = cleanOptional(b.componentCode) || "";
      var cn = cleanOptional(b.componentName) || "";
      if (cc) matEntries.set(cc, cn);
    });
    var matOpts = Array.from(matEntries.entries()).map(function(e) {
      return "<option value='" + escapeHtml(e[0]) + "'>" +
        escapeHtml(e[1] ? e[0] + "  " + e[1] : e[0]) + "</option>";
    }).join("");

    pane =
      "<div class='bsim-ctrl'>" +
        "<div class='bsim-ctrl-row'>" +
          "<label class='bsim-label'>자재 검색</label>" +
          "<input list='bsimMatList' class='bsim-mat-inp' id='bsimMatInp' " +
            "placeholder='자재코드 또는 자재명 입력' value='" + escapeHtml(state.bomSimMatCode || "") + "'>" +
          "<datalist id='bsimMatList'>" + matOpts + "</datalist>" +
          "<button class='bsim-run' id='bsimRevRun'>조회</button>" +
        "</div>" +
        "<div class='bsim-ctrl-hint'>이 자재가 어느 완제품에, 얼마나 사용되는지 역방향으로 추적합니다.</div>" +
      "</div>" +
      "<div class='bsim-result' id='bsimRevResult'>" + renderReverseResult() + "</div>";
  }

  return "<div class='bsim-screen'>" + tabHtml + pane + "</div>";
}

// ═══════════════════════════════════════════════════════════════════════════
// 이벤트 바인딩
// ═══════════════════════════════════════════════════════════════════════════
function bindBomSim() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;

  // 탭 전환
  root.querySelectorAll(".bsim-tab").forEach(function(btn) {
    btn.addEventListener("click", function() {
      state.bomSimTab = btn.dataset.tab;
      render("bom-sim");
    });
  });

  // 정전개 조회 — 결과 영역만 업데이트 (멀티셀렉 보존)
  var runBtn = root.querySelector("#bsimRun");
  if (runBtn) {
    runBtn.addEventListener("click", function() {
      var sel = root.querySelector("#bsimFgSel");
      var qty = root.querySelector("#bsimQty");
      if (sel) {
        state.bomSimFgCodes = Array.from(sel.selectedOptions).map(function(o) { return o.value; }).filter(Boolean);
        state.bomSimFgCode  = state.bomSimFgCodes[0] || "";
      }
      if (qty) state.bomSimQty = parseInt(qty.value) || 1;
      var result = root.querySelector("#bsimResult");
      if (result) result.innerHTML = renderForwardResult();
    });
  }

  // 역전개 조회
  var revBtn = root.querySelector("#bsimRevRun");
  if (revBtn) {
    revBtn.addEventListener("click", function() {
      var inp = root.querySelector("#bsimMatInp");
      if (inp) state.bomSimMatCode = inp.value.trim();
      var result = root.querySelector("#bsimRevResult");
      if (result) result.innerHTML = renderReverseResult();
    });
  }

  // 역전개 Enter 키
  var matInp = root.querySelector("#bsimMatInp");
  if (matInp) {
    matInp.addEventListener("keydown", function(e) {
      if (e.key === "Enter") {
        state.bomSimMatCode = matInp.value.trim();
        var result = root.querySelector("#bsimRevResult");
        if (result) result.innerHTML = renderReverseResult();
      }
    });
  }
}
