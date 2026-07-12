// ── 탭 렌더 ──────────────────────────────────────────────────────────────────
// 스토리 탭(번호+그룹 라벨) / 도구 탭(우측, 번호 없음) 분리
// ── 상태 스냅샷 (조정·점검 전체를 시점별로 저장/복원) ─────────────────────────
// 조정 4종(자재·생산·재고·과잉)은 세션값이라 F5 시 사라짐 → 스냅샷이 유일한 영구 보존수단.
function _snapKey() { return "sopSnapshots"; }
function _snapLoad() { try { return JSON.parse(localStorage.getItem(_snapKey()) || "[]"); } catch (e) { return []; } }
function _snapStore(arr) { try { localStorage.setItem(_snapKey(), JSON.stringify(arr)); } catch (e) {} }
function _snapStamp() {
  var d = new Date(), p = function(n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function snapControlHtml() {
  var arr = _snapLoad();
  var opts = "<option value=''>⏱ 시점 불러오기…</option>" + arr.slice().reverse().map(function(s) {
    return "<option value='" + s.id + "'>" + escapeHtml((s.label ? s.label + " · " : "") + s.ts) + "</option>";
  }).join("");
  return "<span class='snap-control'>" +
    "<button type='button' class='snap-save-btn' title='현재 조정·점검 상태를 시점으로 저장'>📸 스냅샷</button>" +
    "<select class='snap-select' title='저장된 시점으로 되돌리기'>" + opts + "</select>" +
    (arr.length ? "<button type='button' class='snap-del-btn' title='선택한 시점 삭제'>🗑</button>" : "") +
    "</span>";
}
function _snapBind() {
  var saveBtn = tabNav.querySelector(".snap-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", snapSave);
  var sel = tabNav.querySelector(".snap-select");
  if (sel) sel.addEventListener("change", function() { if (this.value) snapRestore(this.value); });
  var delBtn = tabNav.querySelector(".snap-del-btn");
  if (delBtn) delBtn.addEventListener("click", function() {
    var s = tabNav.querySelector(".snap-select");
    if (s && s.value) snapDelete(s.value); else alert("삭제할 시점을 드롭다운에서 먼저 선택하세요.");
  });
}
function _snapCapture() {
  return {
    matSimAdj:     Object.assign({}, state.matSimAdj),
    fgProdAdj:     Object.assign({}, state.fgProdAdj),
    invSupplyAdj:  Object.assign({}, state.invSupplyAdj),
    excessAdj:     Object.assign({}, state.excessAdj),
    aiAppliedKeys: Object.assign({}, state.aiAppliedKeys),
    aiExcessKeys:  Object.assign({}, state.aiExcessKeys),
    rtfWalkDone:   Object.assign({}, state.rtfWalkDone),
  };
}
function snapSave() {
  var label = prompt("스냅샷 라벨 (예: RTF조정 1차 / 과잉감축안)", "");
  if (label === null) return; // 취소
  var arr = _snapLoad();
  arr.push({ id: Date.now(), ts: _snapStamp(), label: (label || "").trim(), data: _snapCapture() });
  _snapStore(arr);
  render(state.currentMenuId); // 컨트롤·드롭다운 갱신
}
function snapRestore(id) {
  var arr = _snapLoad();
  var s = arr.find(function(x) { return String(x.id) === String(id); });
  if (!s) return;
  if (!confirm("현재 조정·점검 상태를 '" + (s.label || s.ts) + "' 시점으로 되돌립니다.\n지금 작업 중인 조정은 사라집니다. 진행할까요?")) {
    var selC = tabNav.querySelector(".snap-select"); if (selC) selC.value = ""; return;
  }
  var d = s.data || {};
  state.matSimAdj     = Object.assign({}, d.matSimAdj);
  state.fgProdAdj     = Object.assign({}, d.fgProdAdj);
  state.invSupplyAdj  = Object.assign({}, d.invSupplyAdj);
  state.excessAdj     = Object.assign({}, d.excessAdj);
  state.aiAppliedKeys = Object.assign({}, d.aiAppliedKeys);
  state.aiExcessKeys  = Object.assign({}, d.aiExcessKeys);
  state.rtfWalkDone   = Object.assign({}, d.rtfWalkDone);
  if (typeof saveRtfWalk === "function") saveRtfWalk(); // 점검상태는 영구저장이라 동기화
  render(state.currentMenuId);
}
function snapDelete(id) {
  var arr = _snapLoad();
  var s = arr.find(function(x) { return String(x.id) === String(id); });
  if (!s) return;
  if (!confirm("'" + (s.label || s.ts) + "' 시점을 삭제할까요?")) return;
  _snapStore(arr.filter(function(x) { return String(x.id) !== String(id); }));
  render(state.currentMenuId);
}

function renderTabs(activeId) {
  var visible = menus.filter(function(m) { return m[3] !== false; });
  var story   = visible.filter(function(m) { return m[4] !== "util"; });
  var utils   = visible.filter(function(m) { return m[4] === "util"; });

  var html = "";
  var lastGroup = null;
  story.forEach(function(m, idx) {
    var id = m[0], label = m[1], group = m[4] || "";
    if (group && group !== lastGroup) {
      html += `<span class="nav-group-label">${escapeHtml(group)}</span>`;
      lastGroup = group;
    }
    html += `<button type="button" class="tab-btn ${id === activeId ? "active" : ""}" data-menu-id="${escapeHtml(id)}"><span class="tab-num">${idx + 1}</span><span class="tab-label">${escapeHtml(label)}</span></button>`;
  });
  utils.forEach(function(m, idx) {
    var id = m[0], label = m[1];
    html += `<button type="button" class="tab-btn tab-util ${idx === 0 ? "tab-util-first " : ""}${id === activeId ? "active" : ""}" data-menu-id="${escapeHtml(id)}"><span class="tab-label">${escapeHtml(label)}</span></button>`;
  });
  html += snapControlHtml(); // 우측 도구 영역 — 상태 스냅샷

  tabNav.innerHTML = html;
  tabNav.querySelectorAll("[data-menu-id]").forEach(function(btn) {
    btn.addEventListener("click", function() { render(btn.dataset.menuId); });
  });
  _snapBind();
}

// ── 회의체계 ─────────────────────────────────────────────────────────────────
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

  // 결산자료(1~6월) — 재고 총괄장의 원천. 세 경로 중 하나로 들어온다.
  //   json   = data/closing.json 자동 로드 (start.bat 서버 모드, 0.04초)
  //   upload = 사용자가 결산 xlsx 6개를 직접 선택 (index.html을 파일로 직접 연 경우)
  //   xlsx   = 결산 폴더를 fetch로 직접 파싱 (json이 없는 서버 모드, 12초)
  const cl = state.closing;
  const clRow = (() => {
    if (cl && cl.status === "done") {
      const src = { json: "자동 로드 (사전계산)", upload: "선택한 파일에서 읽음", xlsx: "폴더에서 직접 파싱" }[cl.source] || cl.source;
      return [badge("ok", "연결 완료"),
              `${(cl.loaded || []).length}개월 · 품목 ${formatNumber(cl.items ? cl.items.size : 0)}개`,
              escapeHtml(src)];
    }
    if (cl && cl.fileMode) {
      return [badge("missing", "미연결"),
              "index.html을 파일로 직접 연 상태 — 브라우저가 폴더 접근을 막습니다",
              "<b>start.bat으로 실행</b>하거나, 위에서 <b>결산자료 폴더의 6개 파일을 함께 선택</b>하세요"];
    }
    if (cl && cl.status === "error") {
      return [badge("missing", "읽기 실패"), escapeHtml((cl.errors || []).join(" / ")), "-"];
    }
    return [badge("warn", "대기"), "-", "-"];
  })();

  return `<section class="section-band">
    <div class="section-header">
      <div><p class="eyebrow">local raw</p><h2>RAW 파일 선택</h2></div>
      <p>필요한 RAW 엑셀 파일을 모두 선택하세요. 선택한 파일은 브라우저 메모리에서만 읽고 원본은 수정하지 않습니다.<br>
         <b>재고 총괄장(재고전망)을 쓰려면 <code>결산자료</code> 폴더의 <code>(26년 1~6월) 재고자산 결산.xlsx</code> 6개도 함께 선택하세요.</b>
         (start.bat으로 실행하면 자동으로 읽히므로 고를 필요 없습니다)</p>
    </div>
    <div class="upload-zone">
      <label for="rawUpload"><strong>RAW 파일 선택</strong></label>
      <input id="rawUpload" type="file" multiple accept=".xlsx,.xls,.xlsm,.csv" />
    </div>
  </section>
  <section class="section-band"><div class="section-header"><h2>필수 파일 연결 여부</h2></div>${renderTable(["필수 파일","상태","선택된 파일"], requiredRows)}</section>
  <section class="section-band"><div class="section-header"><h2>결산자료 (재고 총괄장용 · 1~6월)</h2></div>${renderTable(["상태","내용","경로"], [clRow])}</section>
  <section class="section-band"><div class="section-header"><h2>읽기 상태</h2></div>${renderTable(["파일명","크기","RAW 유형","읽기 상태","시트명","행 수"], uploadRows)}</section>
  <section class="section-band"><div class="section-header"><h2>매핑 결과</h2></div>${renderTable(["테이블","행 수"], [
    ["판매/공급계획", formatNumber(counts.plan_monthly.length)],
    ["기초재고",      formatNumber(counts.inventory_base.length)],
    ["사업부 기준정보", formatNumber(counts.item_master.length)],
    ["BOM",          formatNumber(counts.bom_components.length)],
  ])}</section>
  ${renderMatReqDownloadSection_inner()}`;
}

function bindDataCheck() {
  document.querySelector("#rawUpload")?.addEventListener("change", (e) =>
    processFiles(Array.from(e.target.files ?? [])));
}

// ── 운영 도구: 자재 필요량 다운로드 ─────────────────────────────────────────────

function downloadMatReq() {
  if (typeof BOM_STATUS === "undefined" || state.bomStatus !== BOM_STATUS.DONE
      || !state.bomResult || !state.bomResult.items) {
    alert("공급원인 화면에서 BOM 전개를 먼저 실행하세요.");
    return;
  }
  var months = getRtfMonths();
  var items  = state.bomResult.items;

  // 헤더
  var header = ["자재코드", "자재명", "유형", "플랜트", "단위"];
  months.forEach(function(m) { header.push(monthLabel(m) + "_필요수량"); });

  // 데이터 행
  var dataRows = items.map(function(bi) {
    var row = [
      bi.componentCode  || "",
      bi.componentName  || "",
      bi.displayCategory || "",
      displayPlantName(bi.plant),
      bi.unit || "",
    ];
    months.forEach(function(m) {
      var md = (bi.monthlyData || []).find(function(d) { return d.month === m; });
      row.push(md ? Math.round(md.requiredQty || 0) : 0);
    });
    return row;
  });

  // 플랜트 → 유형 → 자재코드 순 정렬
  dataRows.sort(function(a, b) {
    if (a[3] < b[3]) return -1; if (a[3] > b[3]) return 1;
    if (a[2] < b[2]) return -1; if (a[2] > b[2]) return 1;
    return String(a[0]).localeCompare(String(b[0]), "ko");
  });

  var allRows = [header].concat(dataRows);

  // 열 너비 설정
  var colWidths = [{ wch:16 }, { wch:32 }, { wch:12 }, { wch:8 }, { wch:6 }];
  months.forEach(function() { colWidths.push({ wch:14 }); });

  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(allRows);
  ws["!cols"] = colWidths;
  XLSX.utils.book_append_sheet(wb, ws, "자재필요량");

  var today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  XLSX.writeFile(wb, "자재필요량_" + today + ".xlsx");
}

// ── 판매계획-BOM 플랜트 불일치 목록 (원천 정정 요청용) ─────────────────────────
// 완제품이 판매계획엔 A공장, BOM·자재는 B공장에 등록된 경우를 찾아낸다.
function computePlantMismatches() {
  var plan = state.mappedData.plan_monthly || [];
  var bom  = state.mappedData.bom_components || [];
  var planByCode = new Map();  // code → { plants:Set, name, supply }
  plan.forEach(function(r) {
    var c = cleanOptional(r.itemCode); if (!c || !String(c).startsWith("9")) return;
    var p = cleanOptional(r.plant);
    if (!planByCode.has(c)) planByCode.set(c, { plants:new Set(), name:cleanText(r.itemName, c), supply:0 });
    var e = planByCode.get(c);
    if (p) e.plants.add(p);
    e.supply += (cleanNumber(r.supplyQty) || 0);
  });
  var bomByCode = new Map();  // code → Set(BOM plant)
  bom.forEach(function(r) {
    var c = cleanOptional(r.rootItemCode); if (!c) return;
    var alt = cleanOptional(r.alternativeBom); if (!(alt === "" || alt === "1")) return;
    if (!bomByCode.has(c)) bomByCode.set(c, new Set());
    if (r.plant) bomByCode.get(c).add(r.plant);
  });
  var out = [];
  planByCode.forEach(function(v, code) {
    var bset = bomByCode.get(code); if (!bset || !bset.size) return;  // BOM 자체 없음은 별도 이슈
    var pplants = Array.from(v.plants);
    if (pplants.some(function(p) { return bset.has(p); })) return;    // 정상 매칭
    var bplants = Array.from(bset);
    out.push({
      code: code, name: v.name,
      planPlant: pplants.map(displayPlantName).join(","),
      bomPlant:  bplants.map(displayPlantName).join(","),
      supply:    Math.round(v.supply),
      fallback:  (bset.size === 1 && pplants.length === 1) ? "예(단일공장→자동전개)" : "아니오(복수/모호)",
    });
  });
  return out.sort(function(a, b) { return String(a.code).localeCompare(String(b.code)); });
}

function downloadPlantMismatch() {
  var list = computePlantMismatches();
  if (!list.length) { alert("판매계획-BOM 플랜트 불일치 완제품이 없습니다."); return; }
  var header = ["완제품코드", "완제품명", "판매계획 플랜트", "BOM·자재 실제 플랜트", "공급계획 합계", "자동전개 가능"];
  var rows = list.map(function(m) { return [m.code, m.name, m.planPlant, m.bomPlant, m.supply, m.fallback]; });
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet([header].concat(rows));
  ws["!cols"] = [{ wch:14 }, { wch:36 }, { wch:14 }, { wch:18 }, { wch:14 }, { wch:20 }];
  XLSX.utils.book_append_sheet(wb, ws, "플랜트불일치");
  var today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  XLSX.writeFile(wb, "판매계획_BOM_플랜트불일치_" + today + ".xlsx");
}

// ── 플레이스홀더 ──────────────────────────────────────────────────────────────
function renderPlaceholder(title) {
  return `<section class="section-band"><div class="section-header"><h2>${escapeHtml(title)}</h2><p>현재 로컬 파일 모드에서는 데이터점검과 RTF 화면을 중심으로 사용합니다.</p></div></section>`;
}

// ── 회의안건 ──────────────────────────────────────────────────────────────────
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

// ── 회의록 ────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// 다운로드 화면
// ═══════════════════════════════════════════════════════════════════════════

// ── 요청양식 소요량 산출 기준 (판매계획 / 공급계획 토글) ──────────────────────
// 워크플로우: ①공급계획 회신 전엔 판매계획으로 소요량 선전개해 공장 발송 →
// ②공급계획 회신 후엔 공급계획 기준으로 재산출·재확인 가능.
function hasFgSupplyPlanData() {
  return (state.mappedData.plan_monthly || []).some(function(r) {
    var c = cleanOptional(r.itemCode);
    return c && c.startsWith("9") && (cleanNumber(r.supplyQty) || 0) > 0;
  });
}
function getReqFormBasis() {
  var hasSupply = hasFgSupplyPlanData();
  if (state.reqFormBasis === "supply") return hasSupply ? "supply" : "sales";
  if (state.reqFormBasis === "sales")  return "sales";
  return hasSupply ? "supply" : "sales"; // 미선택 시 자동: 공급계획 있으면 공급계획
}
function setReqFormBasis(b) {
  state.reqFormBasis = b;
  render(state.currentMenuId);
}

function renderDownload() {
  var hasPlan = (state.mappedData.plan_monthly || []).length > 0;
  var hasBom  = (state.mappedData.bom_components || []).length > 0;
  var hasInv  = (state.mappedData.inventory_base || []).length > 0;
  var dataOk  = hasPlan;
  var hint    = !hasPlan
    ? "⚠ 판매계획 RAW 파일을 먼저 연결하세요 (필수)"
    : !hasBom
      ? "판매계획 연결됨 — BOM 파일 없으면 자재 소요량 섹션이 비어있음"
      : "판매계획 · BOM · 재고 연결 완료 — 다운로드 가능";

  var hasSupply  = hasPlan && hasFgSupplyPlanData();
  var basis      = getReqFormBasis();
  var basisHint  = basis === "supply"
    ? "공장 회신 공급계획(생산계획) × BOM 으로 소요량 산출"
    : hasSupply
      ? "판매계획 × BOM 으로 소요량 산출 (공급계획 회신 전 선전개용)"
      : "판매계획 × BOM 으로 소요량 산출 — 공급계획 데이터 없음(전부 0)이라 판매계획 기준만 가능";
  function basisBtn(b, label, disabled) {
    var active = basis === b;
    return `<button type="button" onclick="setReqFormBasis('${b}')" ${disabled ? "disabled" : ""}
      style="font-size:13px;padding:6px 14px;border-radius:6px;cursor:${disabled ? "not-allowed" : "pointer"};
      border:1px solid ${active ? "#1a3558" : "#d1d5db"};
      background:${active ? "#1a3558" : "#fff"};color:${disabled ? "#9ca3af" : active ? "#fff" : "#374151"};
      font-weight:${active ? "600" : "400"};">${label}</button>`;
  }

  return `<section class="section-band">
    <div class="section-header">
      <div><p class="eyebrow">export</p><h2>생산 · 입고계획 요청서</h2></div>
      <p>선택한 기준(판매계획/공급계획)으로 공장별 필요 생산량·원부자재 소요량을 자동 계산하여 Excel 양식을 생성합니다.<br>
         담당자에게 배포 후 ★ 표시 칸을 작성 받아 회신받으세요.</p>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
      <span style="font-size:13px;color:#374151;font-weight:600;">소요량 산출 기준</span>
      ${basisBtn("sales", "판매계획 기준", !hasPlan)}
      ${basisBtn("supply", "공급계획 기준", !hasSupply)}
      <span style="font-size:12px;color:#6b7280;">${escapeHtml(basisHint)}</span>
    </div>
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:8px;">
      <button type="button" class="data-check-btn" onclick="downloadRequestForm()"
        ${dataOk ? "" : "disabled"}
        style="font-size:15px;padding:10px 24px;background:#1a3558;color:#fff;border:none;border-radius:8px;cursor:pointer;">
        ↓ 요청양식 다운로드 (공장별 시트)
      </button>
      <span style="font-size:13px;color:${dataOk ? "#15803d" : "#b91c1c"};">${escapeHtml(hint)}</span>
    </div>
    <div style="font-size:12px;color:#6b7280;line-height:1.8;padding:12px 0;">
      <strong>포함 내용:</strong><br>
      · 공장별 시트 분리 (향남·오송 등 플랜트 코드 기준)<br>
      · <strong>완제품·상품 생산계획</strong>: 품목별 판매계획 / 기초재고 / 필요생산량 / ★생산계획(입력칸)<br>
      · <strong>원부자재 입고계획</strong>: 자재별 월별 소요량 / 현재고 / 권장입고량 / ★입고계획(입력칸)<br>
      · 7개월 롤링 기준 (${hasPlan ? escapeHtml(getRtfMonths().map(monthLabel).join(" · ")) : "파일 연결 후 확인"})
    </div>
  </section>
  <section class="section-band">
    <div class="section-header">
      <div><h2>자재 필요량 (단순)</h2></div>
      <p>BOM 전개 기준 자재 소요량만 단순 추출합니다. 공급원인 화면에서 BOM 전개 후 사용 가능합니다.</p>
    </div>
    ${renderMatReqDownloadSection_inner()}
  </section>
  ${renderPlantMismatchSection_inner()}`;
}

function renderPlantMismatchSection_inner() {
  var hasData = (state.mappedData.plan_monthly || []).length > 0 && (state.mappedData.bom_components || []).length > 0;
  var count = hasData ? computePlantMismatches().length : 0;
  var hint = !hasData
    ? "판매계획 · BOM 파일을 먼저 연결하세요"
    : count > 0
      ? "불일치 완제품 " + count.toLocaleString("ko-KR") + "건 — 계획 담당자 정정 요청용"
      : "불일치 없음 — 판매계획과 BOM 플랜트가 모두 일치";
  return `<section class="section-band">
    <div class="section-header">
      <div><h2>판매계획-BOM 플랜트 불일치 (원천 정정용)</h2></div>
      <p>완제품이 판매계획엔 A공장, BOM·자재는 B공장에 등록된 건을 추출합니다.
         (대시보드는 단일공장 BOM이면 자동 전개하지만, 원천 데이터 정정을 위해 목록을 제공합니다.)</p>
    </div>
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <button type="button" class="data-check-btn" onclick="downloadPlantMismatch()" ${hasData && count > 0 ? "" : "disabled"}
        style="font-size:14px;padding:8px 18px;">
        ↓ 플랜트 불일치 목록 다운로드
      </button>
      <span style="font-size:13px;color:${count > 0 ? "#b45309" : "#6b7280"};">${escapeHtml(hint)}</span>
    </div>
  </section>`;
}

function renderMatReqDownloadSection_inner() {
  var bomDone = (typeof BOM_STATUS !== "undefined")
    && state.bomStatus === BOM_STATUS.DONE
    && state.bomResult && state.bomResult.items && state.bomResult.items.length > 0;
  var stale = typeof isBomStale === "function" && isBomStale();
  var hint = !bomDone
    ? "공급원인 화면에서 BOM 전개 후 사용 가능"
    : stale
    ? "⚠ 계획 변경됨 · 공급원인 화면에서 재전개 필요"
    : "자재 " + (state.bomResult.items.length).toLocaleString("ko-KR") + "개 · BOM 전개 완료";
  return `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
    <button type="button" class="data-check-btn" onclick="downloadMatReq()" ${bomDone ? "" : "disabled"}
      style="font-size:14px;padding:8px 18px;">
      ↓ 자재 필요량 다운로드
    </button>
    <span style="font-size:13px;color:#6b7280;">${escapeHtml(hint)}</span>
  </div>`;
}

// ── 공장별 생산/입고계획 요청 양식 다운로드 ────────────────────────────────────
function downloadRequestForm() {
  var months    = getRtfMonths();
  var rtfItems  = computeRtfItems();
  var today     = new Date().toLocaleDateString("ko-KR");
  var todayFile = new Date().toISOString().slice(0,10).replace(/-/g,"");

  // 완제품 코드 셋 — BOM 자재 목록에서 완제품/상품 제외용
  // computeRtfItems는 판매계획 있는 품목만 반환하므로, item_master와 BOM parent도 추가
  var fgCodeSet = new Set(rtfItems.map(function(i){ return i.itemCode; }));
  (state.mappedData.item_master || []).forEach(function(r) {
    var ic = cleanOptional(r.itemCode);
    var t  = cleanOptional(r.itemType) || "";
    var sc = String(ic || "");
    if (ic && (t.includes("완제품") || t.includes("상품") || sc.startsWith("9") || sc.startsWith("7")))
      fgCodeSet.add(ic);
  });
  (state.mappedData.bom_components || []).forEach(function(b) {
    var rc = cleanOptional(b.rootItemCode);
    if (rc) fgCodeSet.add(rc); // BOM 부모(완제품/반제품) 코드도 제외
  });

  // 판매계획 맵 "itemCode|plant|month" → qty
  var salesMap = new Map();
  (state.mappedData.plan_monthly || []).forEach(function(r) {
    var ic = cleanOptional(r.itemCode), pl = cleanOptional(r.plant)||"", mo = cleanOptional(r.month);
    if (!ic || !mo) return;
    var k = ic+"|"+pl+"|"+mo;
    salesMap.set(k, (salesMap.get(k)||0) + (cleanNumber(r.salesQty)||cleanNumber(r.supplyQty)||0));
  });

  // 자재 소요량 맵 "compCode|plant" → [qty×month]
  // 산출 기준은 화면 토글 선택(판매계획/공급계획)을 따른다 — getReqFormBasis().
  // (기초재고 차감 없음: 재고 감안은 공장이 ★입고계획 입력 시 반영)
  // 화면 BOM 전개와 동일 엔진 사용 → 대체BOM 필터·중복행 제거·반제품 다단계·
  // 플랜트 폴백 규칙이 그대로 적용되어 공장 발송값과 화면값의 정합이 보장된다.
  var basis      = getReqFormBasis();
  var basisLabel = basis === "supply" ? "공급계획(생산계획) × BOM" : "판매계획 × BOM";
  var reqExp     = computeBomExpansion(basis === "supply" ? "supplyQty" : "salesQty");
  if (reqExp.status !== BOM_STATUS.DONE) {
    alert("소요량 전개 실패:\n" + (reqExp.failReasons || []).join("\n"));
    return;
  }
  var consMap = new Map();
  (reqExp.matFlows || []).forEach(function(f) {
    var arr = months.map(function(m) { return (f.reqByMonth && f.reqByMonth[m]) || 0; });
    consMap.set(f.componentCode + "|" + f.plant, arr);
  });

  // 단위 맵 — item_master 우선, inventory_base 보조
  var unitMap = new Map();
  (state.mappedData.inventory_base || []).forEach(function(r) {
    var ic = cleanOptional(r.itemCode), u = cleanOptional(r.unit)||"";
    if (ic && u) unitMap.set(ic, u);
  });
  (state.mappedData.item_master || []).forEach(function(r) {
    var ic = cleanOptional(r.itemCode), u = cleanOptional(r.unit)||"";
    if (ic && u) unitMap.set(ic, u); // item_master 우선 덮어씀
  });

  // 상품(구매재판매) vs 완제품/반제품 분리
  var sangItems = rtfItems.filter(function(i){ return (i.typeGroup||"").indexOf("상품") >= 0; });
  var madeItems = rtfItems.filter(function(i){ return (i.typeGroup||"").indexOf("상품") < 0; });

  // 플랜트별 FG 분류 (완제품/반제품만)
  var plantFg = {};
  madeItems.forEach(function(item) {
    var p = item.plantCode || "기타";
    if (!plantFg[p]) plantFg[p] = [];
    plantFg[p].push(item);
  });

  // 자재 유형 표시명 (BOM itemCategory → 한글)
  function matCategoryLabel(cat) {
    var c = (cat || "").trim().toUpperCase();
    var map = {
      "ROH":"원료", "ZR":"원료", "ZRM":"원료",
      "VERP":"포장재", "ZP":"포장재", "ZPM":"포장재",
      "HALB":"반제품", "ZH":"반제품",
      "HIBE":"소모품", "NLAG":"비축자재",
      "FERT":"완제품", "ZF":"완제품",
    };
    if (map[c]) return map[c];
    // 이미 한글이면 그대로 사용
    if (cat && /[가-힣]/.test(cat)) return cat;
    return cat || "원부자재";
  }

  // 플랜트별 자재 분류 — 완제품 코드 제외, unit·category 저장
  var plantMat = {};
  (state.mappedData.bom_components || []).forEach(function(b) {
    var pl  = cleanOptional(b.plant) || "기타";
    var cc  = cleanOptional(b.componentCode) || "";
    var cn  = cleanOptional(b.componentName) || cc;
    var u   = cleanOptional(b.componentUnit) || cleanOptional(b.unit) || "";
    var cat = matCategoryLabel(cleanOptional(b.itemCategory));
    if (!cc || fgCodeSet.has(cc)) return; // 완제품 코드 제외
    if (!plantMat[pl]) plantMat[pl] = {};
    if (!plantMat[pl][cc]) plantMat[pl][cc] = { code:cc, name:cn, unit:u, category:cat };
    else {
      if (!plantMat[pl][cc].unit && u) plantMat[pl][cc].unit = u;
      if (plantMat[pl][cc].category === "원부자재" && cat !== "원부자재") plantMat[pl][cc].category = cat;
    }
  });

  var wb = XLSX.utils.book_new();

  // ── 안내 시트 ──────────────────────────────────────────────────────────────
  var plantCodes = Array.from(new Set(
    Object.keys(plantFg).concat(Object.keys(plantMat))
  )).sort();

  var coverRows = [
    ["생산계획 · 원부자재 입고계획 요청서"],
    [],
    ["요청일",         today],
    ["회신기한",       ""],
    ["소요량 산출기준", basisLabel + " (기본 BOM 기준 — 대체 BOM 사용 품목은 별도 확인 요)"],
    [],
    ["■ 작성 안내"],
    ["· 담당 공장 시트를 열어 ★ 열에 계획 수량을 입력 후 회신 부탁드립니다."],
    ["· 판매계획(출고) / 소요량(출고) 열은 시스템 기준값으로 수정하지 마세요."],
    ["· ★ 생산계획(입고) / ★ 입고계획(입력) 열만 입력하면 됩니다."],
    [],
    ["■ 시트 구성"],
  ];
  plantCodes.forEach(function(p) {
    var pn = displayPlantName ? displayPlantName(p) : p;
    coverRows.push([
      "  · " + pn,
      "완제품 " + (plantFg[p]||[]).length + "개  /  자재 " + Object.keys(plantMat[p]||{}).length + "개",
    ]);
  });
  var coverWs = XLSX.utils.aoa_to_sheet(coverRows);
  coverWs["!cols"] = [{wch:16},{wch:50}];
  XLSX.utils.book_append_sheet(wb, coverWs, "안내");

  // ── 헤더 빌더 (공용) ───────────────────────────────────────────────────────
  function monthCols(outLabel, inLabel) {
    var hd = [];
    months.forEach(function(m) {
      var ml = monthLabel(m);
      hd.push(ml + " " + outLabel);
      hd.push("★" + ml + " " + inLabel);
    });
    return hd;
  }

  // ── 공장별 시트 ────────────────────────────────────────────────────────────
  plantCodes.forEach(function(plantCode) {
    var plantName = displayPlantName ? displayPlantName(plantCode) : plantCode;
    var fgItems   = (plantFg[plantCode] || []).slice().sort(function(a,b){
      return String(a.itemCode).localeCompare(String(b.itemCode),"ko");
    });
    var matItems  = Object.values(plantMat[plantCode] || {}).sort(function(a,b){
      return String(a.code).localeCompare(String(b.code),"ko");
    });

    var rows = [];

    // 제목
    rows.push(["※ " + plantName + " 생산·입고계획 요청  (" + months.map(monthLabel).join(", ") + ")"]);
    rows.push([]);

    // ── ① 완제품 생산계획 ──────────────────────────────────────────────────
    rows.push(["■ 완제품 · 상품 생산계획"]);
    rows.push(
      ["담당자", "유형", "플랜트", "품목코드", "품목명", "단위", "기초재고(수량)"]
      .concat(monthCols("판매계획(출고)", "생산계획(입고)"))
    );

    if (!fgItems.length) {
      rows.push(["", "", "", "(해당 품목 없음)"]);
    }
    fgItems.forEach(function(item) {
      var unit = unitMap.get(item.itemCode) || "";
      var row  = [
        "",                           // 담당자 — 공백
        item.typeGroup || "",
        plantName,
        item.itemCode,
        item.itemName || "",
        unit,
        Math.round(item.baseQty || 0),
      ];
      months.forEach(function(m, mi) {
        var ms    = (item.monthlyStatus && item.monthlyStatus[mi]) || {};
        var sales = Math.round(ms.salesQty || 0);
        row.push(sales); // 판매계획(출고) — 참고값
        row.push("");    // ★ 생산계획(입고) — 입력 칸
      });
      rows.push(row);
    });

    rows.push([]);
    rows.push([]);

    // ── ② 원부자재 입고계획 ────────────────────────────────────────────────
    rows.push(["■ 원부자재 입고계획"]);
    rows.push(
      ["담당자", "유형", "플랜트", "자재코드", "자재명", "단위", "기초재고(수량)"]
      .concat(monthCols("소요량(출고)", "입고계획(입력)"))
    );

    if (!matItems.length) {
      rows.push(["", "", "", "(BOM 데이터 없음)"]);
    }
    matItems.forEach(function(mat) {
      var matInv  = (state.mappedData.inventory_base || []).find(function(r){
        return cleanOptional(r.itemCode) === mat.code;
      });
      var baseQty = matInv ? Math.round(cleanNumber(matInv.baseQty)||0) : 0;
      var unit    = unitMap.get(mat.code) || mat.unit || "";
      var ck      = mat.code + "|" + plantCode;
      var consArr = consMap.get(ck) || [];

      var row = [
        "",          // 담당자 — 공백
        mat.category || "원부자재",
        plantName,
        mat.code,
        mat.name,
        unit,
        baseQty,
      ];
      months.forEach(function(m, mi) {
        var cons = Math.round(consArr[mi] || 0);
        row.push(cons); // 소요량(출고) — 참고값
        row.push("");   // ★ 입고계획(입력) — 입력 칸
      });
      rows.push(row);
    });

    // 시트 생성 + 열 너비
    var ws   = XLSX.utils.aoa_to_sheet(rows);
    var cols = [{wch:8},{wch:8},{wch:7},{wch:12},{wch:28},{wch:5},{wch:10}];
    months.forEach(function(){ cols.push({wch:13},{wch:13}); });
    ws["!cols"] = cols;

    // ★ 입력 칸 파스텔 음영 (연한 파란색)
    try {
      var range = XLSX.utils.decode_range(ws["!ref"] || "A1");
      for (var R = range.s.r; R <= range.e.r; R++) {
        months.forEach(function(m, mi) {
          var C = 8 + mi * 2;
          var addr = XLSX.utils.encode_cell({r: R, c: C});
          if (!ws[addr]) ws[addr] = {t: "z", v: ""};
          ws[addr].s = { fill: { patternType: "solid", fgColor: { rgb: "D6EAF8" } } };
        });
      }
    } catch(e) {}

    var sheetName = plantName.replace(/[\/\\?\*\[\]]/g,"").slice(0,31) || "공장";
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  // ── 상품 시트 (별도) ────────────────────────────────────────────────────────
  if (sangItems.length > 0) {
    sangItems.sort(function(a,b){ return String(a.itemCode).localeCompare(String(b.itemCode),"ko"); });
    var sangRows = [];
    sangRows.push(["■ 상품 입고계획  (" + months.map(monthLabel).join(", ") + ")"]);
    sangRows.push([]);
    sangRows.push(
      ["담당자","유형","품목코드","품목명","단위","기초재고(수량)"]
      .concat(monthCols("판매계획(출고)","입고계획(입력)"))
    );
    sangItems.forEach(function(item) {
      var unit = unitMap.get(item.itemCode) || "";
      var row = [
        "",
        item.typeGroup || "상품",
        item.itemCode,
        item.itemName || "",
        unit,
        Math.round(item.baseQty || 0),
      ];
      months.forEach(function(m, mi) {
        var ms    = (item.monthlyStatus && item.monthlyStatus[mi]) || {};
        var sales = Math.round(ms.salesQty || 0);
        row.push(sales);
        row.push("");
      });
      sangRows.push(row);
    });
    var sangWs = XLSX.utils.aoa_to_sheet(sangRows);
    var sangCols = [{wch:8},{wch:8},{wch:12},{wch:28},{wch:5},{wch:10}];
    months.forEach(function(){ sangCols.push({wch:13},{wch:13}); });
    sangWs["!cols"] = sangCols;
    try {
      var sRange = XLSX.utils.decode_range(sangWs["!ref"] || "A1");
      for (var sR = sRange.s.r; sR <= sRange.e.r; sR++) {
        months.forEach(function(m, mi) {
          var sC = 7 + mi * 2;
          var sAddr = XLSX.utils.encode_cell({r: sR, c: sC});
          if (!sangWs[sAddr]) sangWs[sAddr] = {t: "z", v: ""};
          sangWs[sAddr].s = { fill: { patternType: "solid", fgColor: { rgb: "D6EAF8" } } };
        });
      }
    } catch(e) {}
    XLSX.utils.book_append_sheet(wb, sangWs, "상품");
  }

  XLSX.writeFile(wb, "입고출고계획_" + (basis === "supply" ? "공급계획기준_" : "판매계획기준_") + todayFile + ".xlsx", {cellStyles: true});
}

// ── 화면 전환 ─────────────────────────────────────────────────────────────────
function render(menuId) {
  // 렌더 경계 토큰 — 한 번의 render() 안에서 무거운 시나리오 계산을 1회로 메모이즈(성능).
  // 렌더마다 증가시켜, 다음 렌더에서는 자동으로 재계산되도록 함(값이 낡을 일 없음).
  if (typeof bumpRenderEpoch === "function") bumpRenderEpoch();
  // 같은 화면 안에서의 재렌더(품목군 펼치기, 정렬, 필터 등)는 스크롤 위치 유지.
  // 실제 탭 전환일 때만 맨 위로 이동.
  var isSameScreen  = state.currentMenuId === menuId;
  var savedScrollY  = isSameScreen ? window.scrollY : 0;
  // 내부 스크롤박스(.rtf-h-scroll 등, 틀고정 표)는 window 스크롤과 별개라 따로 저장/복원
  var savedInnerScroll = [];
  if (isSameScreen) {
    document.querySelectorAll(".rtf-h-scroll").forEach(function(el) {
      var sec = el.closest("[id]");
      if (sec) savedInnerScroll.push({ id: sec.id, top: el.scrollTop, left: el.scrollLeft });
    });
  }
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
    // 재고전망 = 재고 총괄장 (6월 결산 리뷰 + 하반기 3단 전망).
    // 기존 renderInventoryForecast는 남겨둠(롤백용) — 결산자료가 없으면 안내문을 띄운다.
    "inventory-forecast":  renderInventoryReview,
    "inventory-variance":  () => renderExcessAdjustment(),
    "bom-sim":             renderBomSim,
    "download":            renderDownload,
    "diagnosis":           renderDiagnosis,
    "adjustment":          () => renderPlaceholder("조정안 입력"),
    "impact":              renderImpact,
    "minutes":             renderMinutes,
  };
  // 데이터 있는 무거운 화면은 "계산 중..." 표시 후 비동기 렌더 → 탭 클릭 즉시 반응
  var heavyScreens = new Set(["rtf","summary","constraint","inventory-forecast","inventory-variance","impact"]);
  var hasPlanData  = (state.mappedData.plan_monthly || []).length > 0;

  function doRender() {
    try {
    screenRoot.innerHTML = (screens[menu[0]] || renderMeeting)();
    if (menu[0] === "data-check")          bindDataCheck();
    if (menu[0] === "rtf")                 bindRtf();
    if (menu[0] === "constraint")          bindConstraint();
    if (menu[0] === "minutes")             bindMinutes();
    if (menu[0] === "inventory-forecast")  bindInventoryReview();
    if (menu[0] === "inventory-variance")  bindExcessAdjustment();
    if (menu[0] === "bom-sim")             bindBomSim();
    if (menu[0] === "impact")              bindImpact();
    if (menu[0] === "summary")             bindSummary();
    if (isSameScreen) window.scrollTo(0, savedScrollY);
    savedInnerScroll.forEach(function(s) {
      var sec = document.getElementById(s.id);
      var el  = sec && sec.querySelector(".rtf-h-scroll");
      if (el) { el.scrollTop = s.top; el.scrollLeft = s.left; }
    });
    } catch(e) {
      screenRoot.innerHTML = "<div style='padding:40px;color:#b91c1c;font-size:14px;'>" +
        "⚠ 화면 렌더 오류: " + escapeHtml(String(e && e.message || e)) + "<br>" +
        "<span style='font-size:12px;color:#6b7280;'>F12 Console에서 상세 확인</span></div>";
      console.error("[render error]", menu[0], e);
    }
  }

  // "계산 중..." 플레이스홀더는 실제 탭 전환에서만 (같은 화면 내 재렌더=편집/토글은 바로 그려 깜빡임 방지)
  if (heavyScreens.has(menu[0]) && hasPlanData && !isSameScreen) {
    screenRoot.innerHTML = "<div style='padding:80px 0;text-align:center;color:#94a3b8;font-size:15px;'>계산 중...</div>";
    requestAnimationFrame(function() { requestAnimationFrame(doRender); });
  } else {
    doRender();
  }
}

// ── 시작 ─────────────────────────────────────────────────────────────────────
render("meeting");
