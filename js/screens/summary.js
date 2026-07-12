// ── 3단 헤드라인 띠: ①현재 → ②RTF조정후 → ③감축확정후 (연말 기준) ──────────
// 회의 진행에 따라 점진 공개: 조정 입력 전에는 ②③이 "확정 전" 대기 카드로 표시
function renderHeadlineStrip() {
  if (typeof computeHeadlineTriple !== "function") return "";
  var h = computeHeadlineTriple();
  if (!h) return "";

  // 재고·일수·품절 모두 감소 = 좋음(초록), 증가 = 나쁨(빨강)
  function chip(delta, kind) {
    if (delta === null || !Number.isFinite(delta)) return "";
    var rounded = kind === "amt" ? Math.round(delta / 1e8) : Math.round(delta);
    if (rounded === 0) return "";
    var cls  = delta < 0 ? "dn" : "up";
    var sign = delta >= 0 ? "+" : "";
    var txt  = kind === "amt" ? sign + formatMoney(delta) : sign + rounded + (kind === "days" ? "일" : "건");
    return "<span class='sum-hl-chip " + cls + "'>" + escapeHtml(txt) + "</span>";
  }

  function card(no, title, s, prev, waitNote, isFinal) {
    var head = "<div class='sum-hl-title'><span class='sum-hl-no'>" + no + "</span>" + escapeHtml(title) + "</div>";
    if (!s) {
      return "<div class='sum-hl-card sum-hl-dim'>" + head +
        "<div class='sum-hl-wait'>" + escapeHtml(waitNote) + "</div></div>";
    }
    var useDisc  = s.disc !== null;
    var daysVal  = useDisc ? s.disc : s.mgmt;
    var prevDays = prev ? (useDisc ? prev.disc : prev.mgmt) : null;
    var mets = [
      { val: Number.isFinite(s.amt) ? formatMoney(s.amt) : "—", sub: "전체재고",
        chip: prev && Number.isFinite(s.amt) && Number.isFinite(prev.amt) ? chip(s.amt - prev.amt, "amt") : "" },
      { val: Number.isFinite(daysVal) ? Math.round(daysVal) + "일" : "—", sub: useDisc ? "재고일수(공시)" : "재고일수(관리)",
        chip: prev && Number.isFinite(daysVal) && Number.isFinite(prevDays) ? chip(daysVal - prevDays, "days") : "" },
      { val: s.shortCnt + "건", sub: "품절 품목",
        chip: prev ? (s.shortCnt === prev.shortCnt
                        ? "<span class='sum-hl-chip ok'>" + (s.shortCnt === 0 ? "품절 0 유지" : "±0 유지") + "</span>"
                        : chip(s.shortCnt - prev.shortCnt, "cnt"))
                   : "" },
    ];
    return "<div class='sum-hl-card" + (isFinal ? " sum-hl-final" : "") + "'>" + head +
      "<div class='sum-hl-metrics'>" + mets.map(function(m) {
        return "<div class='sum-hl-metric'><div class='sum-hl-val'>" + escapeHtml(m.val) + (m.chip || "") + "</div>" +
               "<div class='sum-hl-sub'>" + escapeHtml(m.sub) + "</div></div>";
      }).join("") + "</div></div>";
  }

  // 카드 제목에 기준월을 박는다. 예전엔 "현재 계획"이라고만 써서, 12월말 전망(2,279억)을
  // 지금 재고(6월말 2,714억)로 읽는 사람이 나왔다. "현재"라는 단어가 작은 기준 안내를 덮는다.
  // 헤드라인의 목적은 "회의로 12월 재고를 얼마나 줄였나"이므로 12월 기준이 맞다 — 라벨만 고친다.
  var mLabel = monthLabel(h.month) + "말";
  var arrow  = "<div class='sum-hl-arrow'>→</div>";
  return "<div class='sum-card sum-hl-wrap'>" +
    "<div class='sum-hl-head'><h3>결과 헤드라인</h3>" +
    "<span class='sum-hl-basis'>전부 <b>" + escapeHtml(mLabel) + " 전망</b>입니다 (지금 재고가 아닙니다) · " +
      "회의 진행에 따라 ②·③ 확정</span></div>" +
    "<div class='sum-hl-strip'>" +
      card("①", "원계획대로 " + mLabel, h.base, null, "", false) +
      arrow +
      card("②", "RTF 조정 후 " + mLabel, h.rtf, h.base, "1부 품절방어 조정 확정 전", false) +
      arrow +
      card("③", "감축 확정 후 " + mLabel, h.fin, h.rtf || h.base, "2부 재고절감 확정 전", true) +
    "</div></div>";
}

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

  var chartSection = hasData ? renderScenarioChartCard("sum") : "";

  var headlineHtml = hasData ? renderHeadlineStrip() : "";

  return "<div class=\"sum-screen\">" +
    "<section class=\"sum-card sum-header\">" +
    "<h2>회의안건</h2>" +
    "<p>현재 계획 기준으로 RTF 공급부족 및 재고초과 이슈를 확인하고, RTF 조정과 재고조정 의사결정이 필요한 안건을 요약합니다.</p>" +
    "</section>" +
    headlineHtml +
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

// ── 종합현황 차트 ─────────────────────────────────────────────────────────────

var _scenChartInst = {}; // idPrefix → Chart 인스턴스 (회의안건 "sum" · 재고진단 "rv" 공용)

var FONT = "'Pretendard Variable', Pretendard, 'Apple SD Gothic Neo', sans-serif";

// 시나리오 증분 밴드/칩 색 — css/base.css 토큰과 동일(하드코딩은 캔버스 fillStyle 제약).
// --warn #e98300 / --warn-ink #a85e00 (재고 증가=나쁨·경고), --good #16a34a (재고 감소=좋음).
var FILL_WARN = "rgba(233,131,0,0.14)";
var FILL_GOOD = "rgba(22,163,74,0.14)";
var WARN_INK  = "#a85e00";
var GOOD_INK  = "#16a34a";

function _drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
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
}

// ── 연간 수급 추이 카드 (HTML만) — idPrefix로 canvas/legend id·버튼 host를 구분해
//    회의안건("sum")과 재고진단("rv")이 완전히 같은 차트를 공유한다.
function renderScenarioChartCard(idPrefix) {
  return "<div class=\"sum-card sum-chart-card\">" +
      "<div class=\"sum-chart-header\">" +
        "<h3>연간 수급 추이</h3>" +
        "<div class=\"sum-scenario-btns\" data-scenario-host=\"" + idPrefix + "\">" +
          "<button class=\"sum-scen-btn\" data-scenario=\"기존\">기존</button>" +
          "<button class=\"sum-scen-btn\" data-scenario=\"RTF조정\">RTF조정</button>" +
          "<button class=\"sum-scen-btn\" data-scenario=\"과잉조정\">과잉조정</button>" +
        "</div>" +
      "</div>" +
      "<div class=\"sum-chart-wrap\"><canvas id=\"" + idPrefix + "InvChart\"></canvas></div>" +
      "<div id=\"" + idPrefix + "ChartLegend\" class=\"sum-chart-legend\"></div>" +
    "</div>";
}

function mountScenarioChart(idPrefix) {
  if (!window.Chart) return;
  var canvas = document.querySelector("#" + idPrefix + "InvChart");
  if (!canvas) return;
  if (_scenChartInst[idPrefix]) { _scenChartInst[idPrefix].destroy(); delete _scenChartInst[idPrefix]; }
  if (typeof computeScenarioItemSets !== "function" || typeof getRtfMonths !== "function" ||
      typeof computeRtfItems !== "function" || typeof rtfHeadlineInv !== "function" ||
      typeof rtfDisclosureDays !== "function") return;

  var allMonths = [];
  for (var m = 1; m <= 12; m++) allMonths.push("2026-" + (m < 10 ? "0" + m : "" + m));
  var months      = getRtfMonths();               // 전망 6개월(앵커월 다음 달부터, 예: 2026-07~12)
  var rtfItemsArr = computeRtfItems(undefined, true);
  var anchor      = typeof getActualsAnchor === "function" ? getActualsAnchor() : null;

  var scenSet = computeScenarioItemSets();
  var matScenRtf   = { fg: state.fgProdAdj, mat: state.matSimAdj };
  var matScenFinal = {
    fg:  Object.assign({}, state.fgProdAdj || {}, state.excessAdj    || {}),
    mat: Object.assign({}, state.matSimAdj || {}, state.matExcessAdj || {}),
  };
  var hasRtfAdj    = scenSet.hasRtfAdj;
  var hasCut       = scenSet.hasExcess || Object.keys(state.matExcessAdj || {}).length > 0;
  var matAdjBomMap = hasRtfAdj ? buildBomMaxProducibleMap(state.matSimAdj, state.fgProdAdj) : null;

  // ── 실적 값 조회 ──────────────────────────────────────────────────────────
  function getActuals(month, metric) {
    var rows = (state.mappedData.actuals_monthly || []).filter(function(r) {
      return r.month === month && r.plant === "전체";
    });
    if (!rows.length) return null;
    if (metric === "invAmt")    return rows.reduce(function(s, r) { return s + (r.invAmt    || 0); }, 0);
    if (metric === "salesAmt")  return rows.reduce(function(s, r) { return s + (r.salesAmt  || 0); }, 0);
    if (metric === "supplyAmt") return rows.reduce(function(s, r) { return s + (r.supplyAmt || 0); }, 0);
    return null;
  }

  // ── 판매·공급 막대(전 시나리오 공통, 기존 로직 유지) ────────────────────────
  var salesData = allMonths.map(function(m) {
    if (!months.includes(m)) return getActuals(m, "salesAmt");
    var ri = months.indexOf(m), total = 0, has = false;
    rtfItemsArr.forEach(function(item) {
      var ms = item.monthlyStatus[ri];
      if (ms && item.hasCost && Number.isFinite(ms.salesQty)) { total += ms.salesQty * item.standardCost; has = true; }
    });
    return has ? total / 100000000 : 0;
  });

  var supplyData = allMonths.map(function(m) {
    if (!months.includes(m)) return getActuals(m, "supplyAmt");
    var ri = months.indexOf(m), total = 0, has = false;
    rtfItemsArr.forEach(function(item) {
      var ms = item.monthlyStatus[ri];
      if (ms && item.hasCost && Number.isFinite(ms.supplyQty)) { total += ms.supplyQty * item.standardCost; has = true; }
    });
    return has ? total / 100000000 : 0;
  });

  var invActData = allMonths.map(function(m) {
    return months.includes(m) ? null : getActuals(m, "invAmt");
  });

  // ── 재고금액 라인(공용 엔진) ──────────────────────────────────────────────
  // 전체재고 = 결산 앵커 + 완제품·상품 변동 + 원부자재 롤포워드 + 미착품·평가충당금 + 나보타(rtfHeadlineInv/totalInvAmountWon).
  // 앵커월은 전망 구간(months)에 포함되지 않으므로, 실적 라인과 이어지도록 앵커월 자체 값을
  // 전망 라인에도 공유점으로 심는다(임의 보정이 아니라 같은 앵커 값 재사용 — delta=0인 지점).
  function buildInvLine(items, matScenario) {
    var arr = allMonths.map(function() { return null; });
    if (anchor) {
      var aIdx = allMonths.indexOf(anchor.month);
      if (aIdx >= 0) arr[aIdx] = anchor.totalInvWon / 1e8;
    }
    months.forEach(function(m, mi) {
      var idx = allMonths.indexOf(m); if (idx < 0) return;
      var inv = rtfHeadlineInv(items, mi, matScenario);
      arr[idx] = Number.isFinite(inv.amount) ? inv.amount / 1e8 : null;
    });
    return arr;
  }

  // ── 재고일수 뱃지(공시기준: 재고금액 ÷ 누적매출원가 × 경과일수) ─────────────
  // 실적 구간은 결산 원본(getActualsMeta().cumCogs)으로 직접 계산, 전망 구간은 rtfDisclosureDays.
  function buildDaysLine(items, matScenario) {
    var arr = allMonths.map(function() { return null; });
    var meta = typeof getActualsMeta === "function" ? getActualsMeta() : {};
    allMonths.forEach(function(m, idx) {
      if (months.includes(m)) return;
      var mm = meta[m], invAmtB = getActuals(m, "invAmt");
      if (mm && Number.isFinite(mm.cumCogs) && mm.cumCogs > 0 && Number.isFinite(invAmtB)) {
        var monthNo = Number(m.slice(5, 7));
        arr[idx] = invAmtB * (monthNo * 30) / mm.cumCogs;
      }
    });
    months.forEach(function(m, mi) {
      var idx = allMonths.indexOf(m); if (idx < 0) return;
      var dv = rtfDisclosureDays(items, mi, matScenario);
      arr[idx] = Number.isFinite(dv) ? dv : null;
    });
    return arr;
  }

  // ── 기존(원계획) 시나리오 ─────────────────────────────────────────────────
  var invBaseData  = buildInvLine(scenSet.base, null);
  var daysBaseData = buildDaysLine(scenSet.base, null);

  // ── RTF조정 시나리오 ──────────────────────────────────────────────────────
  var rtfDeltaData = null, invRtfData = null, daysRtfData = null;

  if (hasRtfAdj && matAdjBomMap) {
    rtfDeltaData = allMonths.map(function(m) {
      if (!months.includes(m)) return null;
      var ri = months.indexOf(m), rtfTotal = 0, baseTotal = 0;
      rtfItemsArr.forEach(function(item) {
        var ms = item.monthlyStatus[ri]; if (!ms || !item.hasCost) return;
        var adj = computeAdjMonthly(item, matAdjBomMap)[ri];
        var rtfSup  = adj ? (adj.finalSupply !== undefined ? adj.finalSupply : (adj.adjSupply || 0)) : (ms.supplyQty || 0);
        rtfTotal  += rtfSup * item.standardCost;
        baseTotal += (ms.supplyQty || 0) * item.standardCost;
      });
      var delta = (rtfTotal - baseTotal) / 100000000;
      return delta > 0 ? delta : 0;
    });

    invRtfData  = buildInvLine(scenSet.rtfAdj, matScenRtf);
    daysRtfData = buildDaysLine(scenSet.rtfAdj, matScenRtf);
  }

  // ── 과잉조정 시나리오 ─────────────────────────────────────────────────────
  var invExcessData = null, daysExcessData = null;

  if (hasCut) {
    var fItems = scenSet.hasExcess ? scenSet.final : scenSet.rtfAdj;
    invExcessData  = buildInvLine(fItems, matScenFinal);
    daysExcessData = buildDaysLine(fItems, matScenFinal);
  }

  // 과잉조정 화면에 실제로 그려지는 RTF선(RTF조정 없으면 기존선과 동일 — 밴드 폭 0으로 자연히 사라짐)
  var rtfPlotted = invRtfData || invBaseData;

  // KPI 배너(renderScenarioKpiBanner)와 같은 문법의 델타 표기: "+7.1억"/"-11.4억", 반올림 0이면 null
  function deltaTxt(deltaEok) {
    if (!Number.isFinite(deltaEok)) return null;
    if (Math.round(deltaEok) === 0) return null;
    var sign = deltaEok >= 0 ? "+" : "";
    return sign + formatMoney(deltaEok * 1e8);
  }

  // ── 시나리오 버튼 연결 (idPrefix 스코프) ─────────────────────────────────
  document.querySelectorAll("[data-scenario-host=\"" + idPrefix + "\"] [data-scenario]").forEach(function(btn) {
    var s = btn.dataset.scenario;
    var enabled = s === "기존" || (s === "RTF조정" && hasRtfAdj) || (s === "과잉조정" && hasCut);
    btn.disabled = !enabled;
    btn.classList.toggle("active", s === state.chartScenario);
    btn.onclick = function() {
      if (!enabled || s === state.chartScenario) return;
      state.chartScenario = s;
      mountScenarioChart(idPrefix);
    };
  });

  // ── 시나리오별 datasets 구성 ──────────────────────────────────────────────
  var salesBg = allMonths.map(function(m) {
    return months.includes(m) ? "rgba(30,58,138,0.28)" : "rgba(30,58,138,0.85)";
  });
  var supplyBgFull  = allMonths.map(function(m) { return months.includes(m) ? "rgba(55,65,81,0.28)" : "rgba(55,65,81,0.85)"; });
  var supplyBgLight = allMonths.map(function(m) { return months.includes(m) ? "rgba(55,65,81,0.15)" : "rgba(55,65,81,0.5)"; });
  var rtfDeltaBg    = allMonths.map(function(m) { return months.includes(m) ? "rgba(59,130,246,0.7)" : "transparent"; });

  var sc = state.chartScenario || "기존";
  if (sc === "RTF조정" && !hasRtfAdj) sc = "기존";
  if (sc === "과잉조정" && !hasCut)   sc = hasRtfAdj ? "RTF조정" : "기존";

  var datasets, activeInvLineIdx, invActLineIdx, activeDaysData, activeInvData;

  if (sc === "기존") {
    datasets = [
      { label: "판매금액",       data: salesData,   backgroundColor: salesBg,     borderColor: "transparent", borderRadius: 3, order: 2 },
      { label: "공급금액",       data: supplyData,  backgroundColor: supplyBgFull, borderColor: "transparent", borderRadius: 3, order: 2 },
      { type:"line", label:"재고금액(실적)", data: invActData,  borderColor:"#1e3a8a", backgroundColor:"transparent", borderWidth:2.5, pointRadius:4, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(기존)", data: invBaseData, borderColor:"#9ca3af", backgroundColor:"transparent", borderWidth:2, borderDash:[6,3], pointRadius:3, tension:0.3, spanGaps:false, order:1 },
    ];
    invActLineIdx   = 2;
    activeInvLineIdx = 3;
    activeDaysData  = daysBaseData;
    activeInvData   = invBaseData;

  } else if (sc === "RTF조정") {
    datasets = [
      { label: "판매금액",       data: salesData,    backgroundColor: salesBg,      borderColor:"transparent", borderRadius:3, order:2 },
      { label: "공급금액(기존)", data: supplyData,   backgroundColor: supplyBgLight, borderColor:"transparent", borderRadius:3, order:2, stack:"sup" },
      { label: "RTF 증분",       data: rtfDeltaData, backgroundColor: rtfDeltaBg,    borderColor:"transparent", borderRadius:3, order:2, stack:"sup" },
      { type:"line", label:"재고금액(실적)",   data: invActData,  borderColor:"#1e3a8a", backgroundColor:"transparent", borderWidth:2.5, pointRadius:4, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(기존)",   data: invBaseData, borderColor:"#d1d5db", backgroundColor:"transparent", borderWidth:1.5, borderDash:[5,4], pointRadius:2, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(RTF조정)", data: invRtfData,  borderColor:"#1e3a8a", backgroundColor:"transparent", borderWidth:2.5, borderDash:[4,4], pointRadius:4, tension:0.3, spanGaps:false, order:1,
        fill: { target: 4, above: FILL_WARN, below: FILL_WARN } }, // 원계획→RTF조정: RTF는 품절방어로 공급을 늘리는 조정이라 항상 "증가=경고" 의미로 고정
    ];
    invActLineIdx   = 3;
    activeInvLineIdx = 5;
    activeDaysData  = daysRtfData;
    activeInvData   = invRtfData;

  } else { // 과잉조정
    datasets = [
      { label: "판매금액",        data: salesData,    backgroundColor: salesBg,      borderColor:"transparent", borderRadius:3, order:2 },
      { label: "공급금액(기존)",  data: supplyData,   backgroundColor: supplyBgLight, borderColor:"transparent", borderRadius:3, order:2, stack:"sup" },
      { label: "RTF 증분",        data: rtfDeltaData || allMonths.map(function(){return null;}), backgroundColor: rtfDeltaBg, borderColor:"transparent", borderRadius:3, order:2, stack:"sup" },
      { type:"line", label:"재고금액(실적)",    data: invActData,   borderColor:"#1e3a8a", backgroundColor:"transparent", borderWidth:2.5, pointRadius:4, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(기존)",    data: invBaseData,  borderColor:"#d1d5db", backgroundColor:"transparent", borderWidth:1.5, borderDash:[5,4], pointRadius:2, tension:0.3, spanGaps:false, order:1 },
      { type:"line", label:"재고금액(RTF조정)", data: rtfPlotted, borderColor:"#6b7280", backgroundColor:"transparent", borderWidth:1.5, borderDash:[4,4], pointRadius:2, tension:0.3, spanGaps:false, order:1,
        fill: hasRtfAdj ? { target: 4, above: FILL_WARN, below: FILL_WARN } : false }, // 원계획→RTF조정 밴드(RTF조정 없으면 폭 0)
      { type:"line", label:"재고금액(과잉조정)", data: invExcessData, borderColor:"#16a34a", backgroundColor:"transparent", borderWidth:2.5, pointRadius:4, tension:0.3, spanGaps:false, order:1,
        fill: { target: 5, above: FILL_WARN, below: FILL_GOOD } }, // RTF조정→과잉조정: 보통 감축=녹색(감소)이지만 자재 반작용으로 오히려 늘면 above가 걸려 경고색으로 뒤집힌다
    ];
    invActLineIdx   = 3;
    activeInvLineIdx = 6;
    activeDaysData  = daysExcessData;
    activeInvData   = invExcessData;
  }

  // ── 범례 업데이트 ─────────────────────────────────────────────────────────
  function leg(cls, label) {
    return "<span class=\"sum-leg " + cls + "\">" + label + "</span>";
  }
  var legendEl = document.querySelector("#" + idPrefix + "ChartLegend");
  if (legendEl) {
    var lgItems = [
      leg("sum-leg-sales-act",   "실적 판매"),
      leg("sum-leg-sales-fcst",  "전망 판매"),
      leg("sum-leg-supply-act",  "실적 공급"),
      leg("sum-leg-supply-fcst", "전망 공급"),
    ];
    if (sc !== "기존") lgItems.push(leg("sum-leg-rtf-delta", "RTF 증분"));
    lgItems.push(leg("sum-leg-inv-act",  "재고금액 실적"));
    if (sc === "기존")      lgItems.push(leg("sum-leg-inv-base",   "재고금액(기존)"));
    if (sc === "RTF조정")   lgItems.push(leg("sum-leg-inv-rtf",    "재고금액(RTF조정)"));
    if (sc === "과잉조정") { lgItems.push(leg("sum-leg-inv-rtf", "RTF조정")); lgItems.push(leg("sum-leg-inv-excess", "과잉조정")); }

    // 조정 총량 한 줄(기준월=12월 · 계획 마지막 달) — 시나리오 토글과 무관하게 항상 같은 총합을 보여준다
    var decIdx = allMonths.length - 1;
    var rtfTotalTxt = hasRtfAdj ? deltaTxt(invRtfData[decIdx] - invBaseData[decIdx]) : null;
    var cutTotalTxt = hasCut    ? deltaTxt(invExcessData[decIdx] - rtfPlotted[decIdx]) : null;
    var totalParts = [];
    if (rtfTotalTxt) totalParts.push("<span class=\"sum-chart-legend-total-item warn\">RTF 조정 " + rtfTotalTxt + "</span>");
    if (cutTotalTxt) totalParts.push("<span class=\"sum-chart-legend-total-item good\">과잉감축 " + cutTotalTxt + "</span>");
    var totalHtml = totalParts.length
      ? "<div class=\"sum-chart-legend-total\">" + totalParts.join("<span class=\"sum-chart-legend-total-sep\">·</span>") + "</div>"
      : "";

    legendEl.innerHTML = lgItems.join("") + totalHtml;
  }

  // ── 막대 숫자 레이블 플러그인 ─────────────────────────────────────────────
  var datalabelsPlugin = {
    afterDatasetsDraw: function(chart) {
      var ctx = chart.ctx;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      chart.data.datasets.forEach(function(ds, di) {
        if (ds.type === "line") return;
        var meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        meta.data.forEach(function(el, i) {
          var val = ds.data[i];
          if (!val || val <= 0) return;
          ctx.font = "bold 13px " + FONT;
          ctx.fillStyle = "#6b7280";
          ctx.fillText(Math.round(val).toLocaleString(), el.x, el.y - 4);
        });
      });
      ctx.restore();
    },
  };

  // ── 재고금액 레이블 + 재고일수 태그 플러그인 ─────────────────────────────
  var daysTagsPlugin = {
    afterDraw: function(chart) {
      var ctx = chart.ctx;
      var metaAct    = chart.getDatasetMeta(invActLineIdx);
      var metaActive = chart.getDatasetMeta(activeInvLineIdx);

      ctx.save();
      ctx.font = "bold 13px " + FONT;
      ctx.textAlign = "center";

      allMonths.forEach(function(m, i) {
        var isFcst   = months.includes(m);
        var lineVal  = isFcst ? activeInvData[i] : invActData[i];
        if (lineVal === null || lineVal === undefined) return;

        var meta = isFcst ? metaActive : metaAct;
        var el   = meta.data[i];
        if (!el) return;

        // 월별 델타 칩(전망 구간·활성 시나리오만) — RTF증분/감축증분을 KPI 배너와 같은 문법으로 표시
        var chipLines = [];
        if (isFcst) {
          if (sc === "RTF조정" && hasRtfAdj) {
            var dR = (Number.isFinite(invRtfData[i]) && Number.isFinite(invBaseData[i])) ? invRtfData[i] - invBaseData[i] : null;
            var tR = dR !== null ? deltaTxt(dR) : null;
            if (tR) chipLines.push({ text: tR, up: dR >= 0 });
          } else if (sc === "과잉조정") {
            if (hasRtfAdj) {
              var dR2 = (Number.isFinite(rtfPlotted[i]) && Number.isFinite(invBaseData[i])) ? rtfPlotted[i] - invBaseData[i] : null;
              var tR2 = dR2 !== null ? deltaTxt(dR2) : null;
              if (tR2) chipLines.push({ text: tR2, up: dR2 >= 0 });
            }
            if (hasCut) {
              var dC = (Number.isFinite(invExcessData[i]) && Number.isFinite(rtfPlotted[i])) ? invExcessData[i] - rtfPlotted[i] : null;
              var tC = dC !== null ? deltaTxt(dC) : null;
              if (tC) chipLines.push({ text: tC, up: dC >= 0 });
            }
          }
        }

        // 칩 블록 높이만큼 금액 레이블을 위로 밀어 칩이 그 사이 공간에 들어가게 한다(재고일수 뱃지는 선 아래라 원래도 안 겹침).
        // 위로 밀린 레이블이 차트 상단을 넘어서면(기존 daysTagsPlugin의 경계 가드와 같은 패턴) 칩을 포기하고 원위치로.
        var CHIP_H = 13;
        var chipBlockH = chipLines.length * CHIP_H;
        var amtY = el.y - 8 - chipBlockH;
        if (chipBlockH > 0 && amtY - 20 < chart.chartArea.top) {
          chipLines = [];
          chipBlockH = 0;
          amtY = el.y - 8;
        }

        // 재고금액 레이블 (선 위)
        ctx.font         = "bold 16px " + FONT;
        ctx.fillStyle    = isFcst ? (sc === "기존" ? "#9ca3af" : "#1e3a8a") : "#1e3a8a";
        ctx.textBaseline = "bottom";
        ctx.fillText(Math.round(lineVal).toLocaleString() + "억", el.x, amtY);

        // 델타 칩 (금액 레이블 바로 아래·점 위). up=true(증가)면 경고색, false(감소)면 녹색 —
        // 자재 반작용으로 감축인데 재고가 늘면 up이 true가 되어 그대로 경고색으로 뒤집힌다.
        if (chipLines.length) {
          ctx.font = "bold 11px " + FONT;
          chipLines.forEach(function(c, k) {
            ctx.fillStyle = c.up ? WARN_INK : GOOD_INK;
            ctx.fillText(c.text, el.x, amtY + (k + 1) * CHIP_H);
          });
          ctx.font = "bold 16px " + FONT; // 이후 재고일수 태그 측정 전, 폰트 상태 정리(측정용 15px는 아래서 별도 지정)
        }

        // 재고일수 태그 (선 아래)
        var dv = activeDaysData ? activeDaysData[i] : null;
        if (dv === null || dv === undefined) return;
        var text = Math.round(dv) + "일";
        ctx.font = "bold 15px " + FONT;
        var tw   = ctx.measureText(text).width + 18;
        var th   = 26;
        var tx   = el.x - tw / 2;
        var ty   = el.y + 6;
        if (ty + th > chart.chartArea.bottom - 2) return;

        var isExcess = sc === "과잉조정" && isFcst;
        ctx.fillStyle = isExcess ? "rgba(22,163,74,0.10)" : "rgba(15,118,110,0.13)";
        _drawRoundRect(ctx, tx, ty, tw, th, 5);
        ctx.fill();

        ctx.strokeStyle = isExcess ? "rgba(22,163,74,0.35)" : "rgba(15,118,110,0.40)";
        ctx.lineWidth   = 1.0;
        _drawRoundRect(ctx, tx, ty, tw, th, 5);
        ctx.stroke();

        ctx.fillStyle    = isExcess ? "#16a34a" : "#0f766e";
        ctx.textBaseline = "middle";
        ctx.fillText(text, el.x, ty + th / 2);
      });

      ctx.restore();
    },
  };

  // ── 차트 생성 ─────────────────────────────────────────────────────────────
  _scenChartInst[idPrefix] = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels: allMonths.map(monthLabel), datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 20 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              if (ctx.raw === null || ctx.raw === undefined) return null;
              return ctx.dataset.label + ": " + Math.round(ctx.raw).toLocaleString() + "억";
            },
          },
        },
      },
      scales: {
        x: { grid: { color: "#f3f4f6" }, ticks: { font: { family: FONT, size: 14 } } },
        y: {
          grid: { color: "#f3f4f6" },
          ticks: { font: { family: FONT, size: 14 }, callback: function(v) { return Math.round(v).toLocaleString() + "억"; } },
        },
      },
    },
    plugins: [datalabelsPlugin, daysTagsPlugin],
  });
}

function bindSummary() {
  mountScenarioChart("sum");
}

