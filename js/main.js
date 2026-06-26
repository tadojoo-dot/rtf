// ── 탭 렌더 ──────────────────────────────────────────────────────────────────
function renderTabs(activeId) {
  tabNav.innerHTML = menus.map(([id, label]) =>
    `<button type="button" class="tab-btn ${id === activeId ? "active" : ""}" data-menu-id="${escapeHtml(id)}">${escapeHtml(label)}</button>`,
  ).join("");
  tabNav.querySelectorAll("[data-menu-id]").forEach((btn) =>
    btn.addEventListener("click", () => render(btn.dataset.menuId)));
}

// ── 회의체계 ─────────────────────────────────────────────────────────────────
function renderMeeting() {
  return `<section class="section-band">
    <div class="section-header">
      <div><p class="eyebrow">local mode</p><h2>로컬 파일 모드</h2></div>
      <p>서버 없이 index.html을 직접 열어 사용합니다. 데이터점검 화면에서 RAW 파일을 선택하면 브라우저 메모리에서만 읽어 RTF 화면에 반영합니다.</p>
    </div>
    <div class="process-grid">
      <article class="card process-card"><h3>1. RAW 선택</h3><p>데이터점검에서 엑셀 파일을 복수 선택합니다.</p></article>
      <article class="card process-card"><h3>2. RTF 확인</h3><p>사업부별/플랜트별/유형별 계층형 월별 매트릭스를 확인합니다.</p></article>
      <article class="card process-card"><h3>3. 상세 점검</h3><p>그룹을 펼쳐 유형, 품목군, 자재별 월별 항목을 확인합니다.</p></article>
    </div>
  </section>`;
}

// ── 데이터점검 ────────────────────────────────────────────────────────────────
function renderDataCheck() {
  const parsedFiles = Object.values(state.rawFiles);
  const uploadRows  = state.uploadedFiles.map((file) => [
    escapeHtml(file.name),
    formatBytes(file.size),
    escapeHtml(file.rawType ?? "-"),
    file.parseSuccess ? badge("ok","읽기 성공") : file.parseStatus === "error" ? badge("missing", file.parseMessage ?? "읽기 실패") : badge("warn","대기"),
    file.sheetNames?.length ? file.sheetNames.map(escapeHtml).join(", ") : "-",
    file.rowCount?.toLocaleString("ko-KR") ?? "-",
  ]);
  const requiredRows = requiredFiles.map((file) => {
    const parsed = parsedFiles.find((raw) => raw.rawType === file.id || raw.name === file.label);
    return [escapeHtml(file.label), parsed ? badge("ok","연결 완료") : badge("missing","미연결"), parsed ? escapeHtml(parsed.name) : "-"];
  });
  const counts = state.mappedData;
  return `<section class="section-band">
    <div class="section-header">
      <div><p class="eyebrow">local raw</p><h2>RAW 파일 선택</h2></div>
      <p>필요한 RAW 엑셀 파일을 모두 선택하세요. 선택한 파일은 브라우저 메모리에서만 읽고 원본은 수정하지 않습니다.</p>
    </div>
    <div class="upload-zone">
      <label for="rawUpload"><strong>RAW 파일 선택</strong></label>
      <input id="rawUpload" type="file" multiple accept=".xlsx,.xls,.xlsm,.csv" />
    </div>
  </section>
  <section class="section-band"><div class="section-header"><h2>필수 파일 연결 여부</h2></div>${renderTable(["필수 파일","상태","선택된 파일"], requiredRows)}</section>
  <section class="section-band"><div class="section-header"><h2>읽기 상태</h2></div>${renderTable(["파일명","크기","RAW 유형","읽기 상태","시트명","행 수"], uploadRows)}</section>
  <section class="section-band"><div class="section-header"><h2>매핑 결과</h2></div>${renderTable(["테이블","행 수"], [
    ["판매/공급계획", formatNumber(counts.plan_monthly.length)],
    ["기초재고",      formatNumber(counts.inventory_base.length)],
    ["사업부 기준정보", formatNumber(counts.item_master.length)],
    ["BOM",          formatNumber(counts.bom_components.length)],
  ])}</section>`;
}

function bindDataCheck() {
  document.querySelector("#rawUpload")?.addEventListener("change", (e) =>
    processFiles(Array.from(e.target.files ?? [])));
}

// ── 플레이스홀더 ──────────────────────────────────────────────────────────────
function renderPlaceholder(title) {
  return `<section class="section-band"><div class="section-header"><h2>${escapeHtml(title)}</h2><p>현재 로컬 파일 모드에서는 데이터점검과 RTF 화면을 중심으로 사용합니다.</p></div></section>`;
}

// ── 회의안건 ──────────────────────────────────────────────────────────────────
function renderSummary() {
  var planRows = state.mappedData.plan_monthly;
  var hasData  = planRows.length > 0;

  // 완제품(9코드) RTF 부족 아이템: supplyQty < salesQty인 월 존재
  var rtfMap = new Map();
  if (hasData) {
    planRows.forEach(function(row) {
      var code = cleanOptional(row.itemCode);
      if (!code || !code.startsWith("9")) return;
      var plant = cleanOptional(row.plant), month = cleanOptional(row.month);
      if (!plant || !month) return;
      var key = code + "|" + plant;
      var sales  = cleanNumber(row.salesQty)  || 0;
      var supply = cleanNumber(row.supplyQty) || 0;
      if (!rtfMap.has(key))
        rtfMap.set(key, { code:code, name:cleanOptional(row.itemName)||code, plant:plant, itemType:cleanOptional(row.itemType)||"완제품", shortageMonths:[] });
      var e = rtfMap.get(key);
      if (sales > 0 && supply < sales && !e.shortageMonths.includes(month)) e.shortageMonths.push(month);
    });
  }
  var rtfItems = [];
  rtfMap.forEach(function(item) { if (item.shortageMonths.length > 0) rtfItems.push(item); });
  rtfItems.sort(function(a,b) { return b.shortageMonths.length - a.shortageMonths.length; });

  // BOM 공급원인 부족 아이템
  var bomDone  = state.bomStatus === BOM_STATUS.DONE;
  var bomItems = bomDone && state.bomResult && state.bomResult.items
    ? state.bomResult.items.filter(function(i) { return i.hasAnyShortage; })
    : null;

  // KPI 카드 렌더
  function kpiVal(n, avail) {
    if (!avail) return { val:"연결필요", cls:"neutral" };
    if (n === 0) return { val:"없음", cls:"ok" };
    return { val:n + "건", cls:n > 0 ? "shortage" : "ok" };
  }
  var kpiRtf = kpiVal(rtfItems.length, hasData);
  var kpiBom = kpiVal(bomItems ? bomItems.length : 0, bomItems !== null);
  var kpiCards = [
    { label:"RTF 조정 필요",       val:kpiRtf.val, cls:kpiRtf.cls, screen:"rtf",               desc:"판매계획 대비 공급 부족 품목", link:"RTF판정 화면 바로가기" },
    { label:"공급원인 확인 필요",   val:kpiBom.val, cls:kpiBom.cls, screen:"constraint",         desc:"BOM 전개 기준 자재 부족 현황", link:"공급원인 화면 바로가기" },
    { label:"재고초과 조정 필요",   val:"-",        cls:"",         screen:"inventory-forecast", desc:"후속 단계 구현 예정",          link:"재고전망 화면 바로가기" },
    { label:"최종 영향 확인 필요",  val:"-",        cls:"",         screen:"impact",             desc:"후속 단계 구현 예정",          link:"조정영향 화면 바로가기" },
  ];

  var kpiHtml = "<div class=\"sum-kpi-grid\">" + kpiCards.map(function(c) {
    return "<div class=\"sum-kpi-card\" onclick=\"render('" + escapeHtml(c.screen) + "')\" title=\"" + escapeHtml(c.link) + "\">" +
           "<div class=\"sum-kpi-label\">" + escapeHtml(c.label) + "</div>" +
           "<div class=\"sum-kpi-value " + escapeHtml(c.cls) + "\">" + escapeHtml(c.val) + "</div>" +
           "<div class=\"sum-kpi-desc\">" + escapeHtml(c.desc) + "</div>" +
           "<div class=\"sum-kpi-nav\">→ " + escapeHtml(c.link) + "</div></div>";
  }).join("") + "</div>";

  // 안건 목록 생성 (실제 데이터만, 가짜 항목 없음)
  var agendaRows = [];

  if (!hasData) {
    agendaRows.push({ type:"공통", months:"-", category:"-", items:"데이터 미연결", summary:"데이터점검 화면에서 RAW 파일을 먼저 선택하십시오.", screen:"data-check", status:"확인 필요" });
  } else {
    // RTF 조정 안건 (상위 15개)
    rtfItems.slice(0, 15).forEach(function(item) {
      var mths = item.shortageMonths.slice().sort().map(monthLabel).join(", ");
      agendaRows.push({
        type:     "RTF 조정",
        months:   mths,
        category: item.itemType || "완제품",
        items:    item.name,
        summary:  "판매계획 대비 공급 부족 (" + item.shortageMonths.length + "개월)",
        screen:   "rtf",
        status:   "확인 필요",
      });
    });

    // 공급원인 확인 안건
    if (bomItems && bomItems.length > 0) {
      bomItems.slice(0, 15).forEach(function(item) {
        var shMths = item.monthlyData.filter(function(md) { return md.shortageQty > 0; })
                       .map(function(md) { return monthLabel(md.month); }).join(", ");
        agendaRows.push({
          type:     "공급원인 확인",
          months:   shMths || "-",
          category: item.displayCategory || "자재",
          items:    item.componentName || item.componentCode,
          summary:  item.note || "자재 부족 발생",
          screen:   "constraint",
          status:   "조정 필요",
        });
      });
    } else if (state.bomStatus === BOM_STATUS.IDLE) {
      agendaRows.push({
        type:"공급원인 확인", months:"-", category:"전체", items:"-",
        summary:"BOM 전개 전 — 공급원인 화면에서 BOM 전개 실행 필요",
        screen:"constraint", status:"확인 필요",
      });
    }

    if (agendaRows.length === 0) {
      agendaRows.push({ type:"없음", months:"-", category:"-", items:"-", summary:"현재 계획 기준 조정 필요 안건이 없습니다.", screen:"", status:"완료" });
    }
  }

  // 유형별 배지 CSS 클래스
  function typeCls(t) {
    if (t === "RTF 조정")      return "sum-type-rtf";
    if (t === "공급원인 확인") return "sum-type-bom";
    if (t === "재고초과 조정") return "sum-type-inv";
    if (t === "최종 영향 검토") return "sum-type-impact";
    return "sum-type-default";
  }
  // 진행상태 배지 CSS 클래스
  function statusCls(s) {
    if (s === "확인 필요")     return "sum-s-check";
    if (s === "조정 필요")     return "sum-s-adjust";
    if (s === "영향 검토 필요") return "sum-s-review";
    if (s === "완료")          return "sum-s-done";
    return "sum-s-default";
  }

  var agendaThead = "<tr><th>안건유형</th><th>대상월</th><th>대상구분</th><th>주요 품목·자재</th><th>문제 요약</th><th>확인 화면</th><th>진행상태</th></tr>";
  var agendaTbody = agendaRows.map(function(row) {
    var navBtn = row.screen
      ? "<button type=\"button\" class=\"sum-nav-btn\" onclick=\"render('" + escapeHtml(row.screen) + "')\">" + escapeHtml(screenButtonLabel(row.screen)) + "</button>"
      : "-";
    return "<tr>" +
      "<td><span class=\"sum-type-badge " + typeCls(row.type) + "\">" + escapeHtml(row.type) + "</span></td>" +
      "<td>" + escapeHtml(row.months) + "</td>" +
      "<td>" + escapeHtml(row.category) + "</td>" +
      "<td class=\"sum-td-left\" title=\"" + escapeHtml(row.items) + "\">" + escapeHtml(row.items) + "</td>" +
      "<td class=\"sum-td-left\" title=\"" + escapeHtml(row.summary) + "\">" + escapeHtml(row.summary) + "</td>" +
      "<td>" + navBtn + "</td>" +
      "<td><span class=\"sum-status-badge " + statusCls(row.status) + "\">" + escapeHtml(row.status) + "</span></td>" +
      "</tr>";
  }).join("");

  var chartSection = hasData
    ? "<div class=\"sum-card sum-chart-card\">" +
        "<div class=\"sum-chart-header\"><h3>연간 재고금액 추이</h3><span class=\"sum-chart-sub\">완제품+상품 전사 합계 · 실적(1~5월) + 원계획(6~12월)</span></div>" +
        "<div class=\"sum-chart-wrap\"><canvas id=\"sumInvChart\"></canvas></div>" +
        "<div class=\"sum-chart-legend\">" +
          "<span class=\"sum-leg sum-leg-actual\">실적</span>" +
          "<span class=\"sum-leg sum-leg-base\">원계획</span>" +
        "</div>" +
      "</div>"
    : "";

  return "<div class=\"sum-screen\">" +
    "<section class=\"sum-card sum-header\">" +
    "<h2>수급관리 회의안건</h2>" +
    "<p>현재 계획 기준으로 RTF 공급부족 및 재고초과 이슈를 확인하고, RTF 조정과 재고조정 의사결정이 필요한 안건을 요약합니다.</p>" +
    "</section>" +
    kpiHtml +
    chartSection +
    "<div class=\"sum-card sum-agenda-card\">" +
    "<div class=\"sum-agenda-header\"><h3>회의 안건 목록</h3><span class=\"sum-agenda-note\">데이터 기준 자동 생성 · 가짜 항목 없음</span></div>" +
    "<div class=\"sum-h-scroll\"><table class=\"sum-agenda-table\"><thead>" + agendaThead + "</thead><tbody>" + agendaTbody + "</tbody></table></div>" +
    "</div></div>";
}

function screenButtonLabel(screenId) {
  var labels = { rtf:"RTF판정 보기", constraint:"공급원인 보기", "inventory-forecast":"재고전망 보기", "inventory-variance":"재고변동 보기", diagnosis:"수급진단 보기", adjustment:"조정입력 보기", impact:"조정영향 보기", "data-check":"데이터점검 이동", summary:"회의안건 보기" };
  return labels[screenId] || "화면 이동";
}

// ── 수급진단 ──────────────────────────────────────────────────────────────────
function renderDiagnosis() {
  const adjTypes = ["RTF 개선","적정재고 초과 조정","생산 Pull-in","생산 이연","입고 추가","입고 이연","공급계획 감량","공통자재 배분 확인"];
  return `<section class="section-band">
    <div class="section-header">
      <div><h2>수급진단 및 조정 대상 선별</h2></div>
      <p>RTF 개선 대상과 적정재고 초과 조정 대상을 함께 선별합니다.</p>
    </div>
    <div class="adj-candidate-area">
      <button type="button" class="adj-candidate-btn" disabled title="조정입력 연계 기능은 후속 단계에서 구현 예정입니다.">조정안에 담기</button>
      <span class="adj-candidate-hint">조정입력 연계 기능은 후속 단계에서 구현 예정입니다.</span>
    </div>
    <div class="notice-no-data">
      <strong>조정 유형 기준 (향후 구현 예정)</strong><br><br>
      ${adjTypes.map(t => `<span class="cause-type-tag" style="margin:3px 4px 3px 0;display:inline-block;">${escapeHtml(t)}</span>`).join(" ")}
    </div>
  </section>`;
}

// ── 회의안건 차트 ─────────────────────────────────────────────────────────────
var _summaryChartInst = null;

function bindSummary() {
  if (!window.Chart) return;
  var canvas = document.querySelector("#sumInvChart");
  if (!canvas) return;

  if (_summaryChartInst) { _summaryChartInst.destroy(); _summaryChartInst = null; }

  var allMonths = [];
  for (var m = 1; m <= 12; m++) allMonths.push("2026-" + (m < 10 ? "0" + m : "" + m));
  var rtfMonths   = getRtfMonths();
  var rtfItemsArr = computeRtfItems(undefined, true);

  // 실적 (완제품+상품, Table1 plant="전체")
  var actualsRaw = allMonths.map(function(month) {
    var rows = (state.mappedData.actuals_monthly || []).filter(function(r) {
      return r.month === month && r.plant === "전체";
    });
    if (!rows.length) return null;
    return rows.reduce(function(s, r) { return s + (r.invAmt || 0); }, 0);
  });
  var lastActualIdx = -1;
  actualsRaw.forEach(function(v, i) { if (v !== null) lastActualIdx = i; });

  // 실적 데이터셋 (전망 월 null, 연결점 포함)
  var actualsData = allMonths.map(function(m, i) {
    return rtfMonths.includes(m) ? null : actualsRaw[i];
  });

  // 원계획 데이터셋 (실적 월 null, 연결점에서 시작)
  var baseData = allMonths.map(function() { return null; });
  if (lastActualIdx >= 0) baseData[lastActualIdx] = actualsRaw[lastActualIdx];
  rtfMonths.forEach(function(m, i) {
    var idx = allMonths.indexOf(m);
    if (idx < 0) return;
    var total = 0;
    rtfItemsArr.forEach(function(item) {
      var ms = item.monthlyStatus[i];
      if (ms && Number.isFinite(ms.endingAmount)) total += ms.endingAmount;
    });
    baseData[idx] = total / 100000000; // 원 → 억원
  });

  _summaryChartInst = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: allMonths.map(monthLabel),
      datasets: [
        {
          label: "실적",
          data: actualsData,
          borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,0.08)",
          borderWidth: 2.5, pointRadius: 4, tension: 0.3,
          fill: true, spanGaps: false,
        },
        {
          label: "원계획",
          data: baseData,
          borderColor: "#9ca3af", borderDash: [6, 3],
          borderWidth: 2, pointRadius: 3, tension: 0.3,
          fill: false, spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return ctx.raw !== null ? ctx.dataset.label + ": " + ctx.raw.toFixed(1) + "억" : null;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: "#f3f4f6" } },
        y: {
          title: { display: true, text: "재고금액 (억원)", color: "#6b7280", font: { size: 11 } },
          grid: { color: "#f3f4f6" },
          ticks: { callback: function(v) { return v.toFixed(1) + "억"; } },
        },
      },
    },
  });
}

// ── 회의록 ────────────────────────────────────────────────────────────────────
function renderMinutes() {
  var log = state.minutesLog || [];
  var header = "<div class=\"min-toolbar\">" +
    "<h2 class=\"min-title\">회의록 · 결정사항</h2>" +
    (log.length > 0 ? "<button class=\"min-clear-all-btn\">전체 삭제</button>" : "") +
    "</div>";
  if (log.length === 0) {
    return "<div class=\"min-screen\">" + header +
      "<div class=\"min-empty\">기록된 결정사항이 없습니다.<br>공급원인 화면 → 부족자재 리스트에서 입고계획을 조정하고 기록하세요.</div></div>";
  }
  var entries = log.slice().reverse().map(function(entry) {
    var ts = entry.timestamp instanceof Date
      ? entry.timestamp.toLocaleString("ko-KR", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" })
      : "-";
    var adjRows = entry.entries.map(function(e) {
      var sign = e.delta > 0 ? "+" : "";
      return "<tr>" +
        "<td>" + escapeHtml(e.matCode) + "</td>" +
        "<td>" + escapeHtml(e.matName) + "</td>" +
        "<td>" + escapeHtml(e.month) + "</td>" +
        "<td>" + formatNumber(Math.round(e.orig)) + "</td>" +
        "<td>" + formatNumber(Math.round(e.adj)) + "</td>" +
        "<td class=\"" + (e.delta > 0 ? "min-delta-pos" : "min-delta-neg") + "\">" +
          sign + formatNumber(Math.round(e.delta)) + "</td>" +
        "<td>" + (e.addlEA > 0 ? "+" + formatNumber(e.addlEA) + " EA" : "-") + "</td>" +
        "</tr>";
    }).join("");
    return "<div class=\"min-entry\" data-entry-id=\"" + entry.id + "\">" +
      "<div class=\"min-entry-header\">" +
        "<span class=\"min-ts\">" + escapeHtml(ts) + "</span>" +
        "<span class=\"min-entry-title\">" + entry.title + "</span>" +
        "<button class=\"min-delete-btn\" data-id=\"" + entry.id + "\">삭제</button>" +
      "</div>" +
      "<div class=\"min-entry-body\">" +
        "<table class=\"min-table\"><thead><tr>" +
        "<th>자재코드</th><th>자재명</th><th>월</th><th>원 입고계획</th><th>조정 후</th><th>변동</th><th>추가 생산</th>" +
        "</tr></thead><tbody>" + adjRows + "</tbody></table>" +
      "</div></div>";
  }).join("");
  return "<div class=\"min-screen\"><div class=\"min-inner\">" + header + entries + "</div></div>";
}

function bindMinutes() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;
  root.addEventListener("click", function(e) {
    var del = e.target.closest(".min-delete-btn");
    if (del) {
      var id = parseInt(del.dataset.id, 10);
      state.minutesLog = (state.minutesLog || []).filter(function(entry) { return entry.id !== id; });
      render("minutes"); return;
    }
    var clearAll = e.target.closest(".min-clear-all-btn");
    if (clearAll && confirm("전체 결정사항을 삭제하시겠습니까?")) {
      state.minutesLog = [];
      render("minutes");
    }
  });
}

// ── 화면 전환 ─────────────────────────────────────────────────────────────────
function render(menuId) {
  state.currentMenuId = menuId;
  const menu = menus.find(([id]) => id === menuId) || menus[0];
  screenTitle.textContent = menu[2] || menu[1];
  renderTabs(menu[0]);
  const screens = {
    "meeting":            renderMeeting,
    "data-check":         renderDataCheck,
    "rtf":                 renderRtf,
    "summary":             renderSummary,
    "constraint":          renderConstraint,
    "inventory-forecast":  renderInventoryForecast,
    "inventory-variance":  () => renderExcessAdjustment(),
    "diagnosis":           renderDiagnosis,
    "adjustment":          () => renderPlaceholder("조정안 입력"),
    "impact":              renderImpact,
    "minutes":             renderMinutes,
  };
  screenRoot.innerHTML = (screens[menu[0]] || renderMeeting)();
  if (menu[0] === "data-check")         bindDataCheck();
  if (menu[0] === "rtf")                bindRtf();
  if (menu[0] === "constraint")         bindConstraint();
  if (menu[0] === "minutes")            bindMinutes();
  if (menu[0] === "inventory-forecast")  bindInventoryForecast();
  if (menu[0] === "inventory-variance")  bindExcessAdjustment();
  if (menu[0] === "impact")              bindImpact();
  if (menu[0] === "summary")             bindSummary();
}

// ── 시작 ─────────────────────────────────────────────────────────────────────
render("meeting");
