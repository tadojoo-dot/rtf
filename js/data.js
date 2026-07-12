// ── 파일 타입 감지 ────────────────────────────────────────────────────────────
function detectRawType(fileName) {
  const name = String(fileName ?? "");
  if (name.includes("판매계획_공급계획")) return "salesSupplyPlan";
  if (name.includes("기초재고_자재"))    return "materialInventory";
  if (name.includes("기초재고_재공품"))  return "wipInventory";
  if (name.includes("사업부") && name.includes("품목 기준정보")) return "itemMaster";
  if (name.includes("BOM"))              return "bom";
  if (name.includes("적정재고"))         return "targetInventory";
  if (name.includes("나보타"))           return "nabota";
  if (name.includes("매출"))             return "salesActual";
  // 결산자료 — 재고 총괄장의 1~6월 리뷰 원천.
  // 평소엔 fetch로 자동 로드하지만(start.bat 서버 모드), index.html을 파일로 직접 열면
  // fetch가 막히므로 파일 선택으로도 읽을 수 있어야 한다. "결산_RAW"보다 먼저 판정할 것.
  //   · closing.json 하나만 골라도 됨 (사전계산, 1MB — 권장)
  //   · 또는 (26년 N월) 재고자산 결산.xlsx 6개
  if (name === "closing.json")       return "closingJson";
  if (name.includes("재고자산 결산")) return "closingMonthly";
  if (name.includes("결산실적_월별요약") || name.includes("결산_raw") || name.includes("결산_RAW")) return "actualMonthly";
  if (name.includes("RTF_RAW_보조양식")) return "rtfHelper";
  return "unknown";
}

// ── RAW 파일 자동 로드 ────────────────────────────────────────────────────────
// 필요한 파일은 전부 프로젝트 폴더에 있다. start.bat이 그 폴더를 서버로 서빙하므로
// 앱이 알아서 읽으면 된다 → 회의 당일 파일 선택 0회.
//
// index.html을 파일로 직접 열면(file://) 브라우저가 fetch를 막으므로 그때만 수동 선택.
// 파일이 없으면 조용히 건너뛴다(선택 사항인 파일도 있다).
const AUTO_RAW_FILES = [
  "판매계획_공급계획_RAW.xlsx",
  "기초재고_자재_RAW.xlsx",
  "기초재고_재공품_RAW.xlsx",
  "사업부 별 품목 기준정보.xlsx",
  "BOM_RAW.xlsx",
  "적정재고_RAW.xlsx",
  "매출_RAW.xlsx",
  "결산_RAW.xlsx",
  "나보타_RAW.xlsx",
];

function setBootStatus(text, tone) {
  const el = document.querySelector(".topbar-status span:nth-child(2)");
  if (el) el.textContent = text;
  const dot = document.querySelector(".topbar-status .status-dot");
  if (dot) dot.style.background = tone === "ok" ? "var(--good)"
                              : tone === "err" ? "var(--danger)" : "var(--warn)";
}

async function autoLoadRawFiles() {
  if (typeof location !== "undefined" && location.protocol === "file:") {
    setBootStatus("RAW 파일 선택 필요 (파일 모드)", "warn");
    return false;
  }

  const files = [];
  for (let i = 0; i < AUTO_RAW_FILES.length; i++) {
    const name = AUTO_RAW_FILES[i];
    setBootStatus(`데이터 읽는 중… ${i + 1}/${AUTO_RAW_FILES.length}`, "warn");
    try {
      const res = await fetch("./" + encodeURIComponent(name), { cache: "no-store" });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      // processFiles는 File 인터페이스 중 name/size/arrayBuffer만 쓴다
      files.push({ name, size: buf.byteLength, arrayBuffer: async () => buf });
    } catch (e) { /* 없으면 건너뛴다 */ }
  }

  if (!files.length) {
    setBootStatus("RAW 파일 선택 필요", "warn");
    return false;
  }
  setBootStatus("데이터 처리 중…", "warn");
  await processFiles(files);
  const n = (state.mappedData.plan_monthly || []).length;
  setBootStatus(n ? `데이터 연결 완료 · ${files.length}개 파일` : "데이터 읽기 실패", n ? "ok" : "err");
  return true;
}

// ── 파일 처리 흐름 ────────────────────────────────────────────────────────────
async function processFiles(files) {
  state.uploadedFiles = files.map((file) => ({
    name: file.name, size: file.size,
    rawType: detectRawType(file.name), parseStatus: "reading",
  }));
  render("data-check");

  const rawFiles = {};
  state.closingJson = null;
  for (const file of files) {
    const rawType = detectRawType(file.name);
    // 결산자료는 월별로 6개가 들어오므로 rawType을 키로 쓰면 서로 덮어쓴다 → 파일명으로 구분
    const key = (rawType === "unknown" || rawType === "closingMonthly") ? file.name : rawType;

    // 사전계산 JSON — 엑셀이 아니라 JSON이라 별도 처리 (파일 모드에서 이거 하나만 고르면 됨)
    if (rawType === "closingJson") {
      try {
        const buf  = await file.arrayBuffer();
        const text = new TextDecoder("utf-8").decode(buf);
        state.closingJson = JSON.parse(text);
        rawFiles[key] = { name: file.name, size: file.size, rawType,
                          parseStatus: "success", parseSuccess: true,
                          sheets: [], sheetNames: ["(사전계산 JSON)"],
                          rowCount: state.closingJson.items ? state.closingJson.items.length : 0 };
      } catch (error) {
        rawFiles[key] = { name: file.name, size: file.size, rawType,
                          parseStatus: "error", parseSuccess: false,
                          parseMessage: error.message, sheets: [], sheetNames: [], rowCount: 0 };
      }
      continue;
    }

    try {
      const workbook = await parseWorkbook(file);
      rawFiles[key] = {
        name: file.name, size: file.size, rawType,
        parseStatus: "success", parseSuccess: true,
        sheets: workbook.sheets,
        sheetNames: workbook.sheets.map((s) => s.name),
        rowCount: workbook.sheets.reduce((sum, s) => sum + s.rowCount, 0),
      };
    } catch (error) {
      rawFiles[key] = {
        name: file.name, size: file.size, rawType,
        parseStatus: "error", parseSuccess: false,
        parseMessage: error.message, sheets: [], sheetNames: [], rowCount: 0,
      };
    }
  }
  state.rawFiles = rawFiles;
  state.uploadedFiles = Object.values(rawFiles);
  state.mappedData = mapRawData(rawFiles);

  // 결산자료는 시트를 해제하기 전에 읽어야 한다.
  // 평소엔 data/closing.json을 fetch하지만(39ms), index.html을 파일로 직접 열면 fetch가
  // 막히므로 사용자가 고른 결산 xlsx의 시트를 그 자리에서 파싱해야 한다.
  if (typeof loadClosingData === "function") {
    try {
      const c = await loadClosingData(true);
      if (c && c.errors && c.errors.length) console.warn("[결산자료]", c.errors);
    } catch (e) { console.error("[결산자료 로드 실패]", e); }
  }

  // 매핑 완료 후 원본 시트 데이터 해제 — mappedData로 이미 추출했으므로 메모리 반환
  Object.values(state.rawFiles).forEach(function(f) { f.sheets = []; });

  // RTF 계산 캐시 무효화
  if (typeof invalidateRtfCache === "function") invalidateRtfCache();

  // 이전에 BOM 전개를 끝낸 상태라면, 새 계획/재고를 즉시 반영하도록 자동 재전개
  // (전개 결과는 스냅샷이라 파일만 바꾸면 자재 제약·과잉·관리일수 분모가 낡은 채 남음)
  if (state.bomStatus === BOM_STATUS.DONE && typeof reexpandBom === "function") {
    reexpandBom();
  }

  render(state.currentMenuId);
}

async function parseWorkbook(file) {
  if (!window.XLSX) throw new Error("XLSX 라이브러리 연결 필요");
  const buffer = await file.arrayBuffer();
  const workbook = window.XLSX.read(buffer, { type: "array", cellDates: false, raw: true });
  return {
    sheets: workbook.SheetNames.map((name) => {
      const rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1, raw: true, defval: "", blankrows: true,
      });
      return { name, rows, rowCount: Math.max(0, rows.filter((r) => r.some((c) => c !== "")).length - 1) };
    }),
  };
}

// ── 데이터 매핑 ───────────────────────────────────────────────────────────────
function mapTargetInvRows(rows) {
  // 적정재고_raw.xlsx 레이아웃: 헤더행 = [내역, 자재, 자재 내역, 사업부, ...],
  // "적정재고" 그룹(수량/금액/재고일수 3컬럼), "적정재고(구간)" MIN/MAX 그룹.
  // 컬럼 위치는 그룹 헤더 텍스트로 동적 탐색 (서브헤더 행 + 빈 행은 코드 필터로 스킵)
  for (var hr = 0; hr < Math.min(rows.length, 10); hr++) {
    var hrow = rows[hr] || [];
    if (String(hrow[0]).trim() !== "내역" || String(hrow[1]).trim() !== "자재") continue;
    // 그룹 헤더(적정재고/적정재고(구간)/서비스/MOQ/공급주기/12개월평균)는 "내역/자재" 행과 같은 행에
    // 있는 레이아웃도, 바로 위 행(병합셀 상위 그룹행)에 있는 레이아웃도 있음(월별 파일마다 다름) —
    // 두 행 다 검색해서 있는 쪽을 채택(같은 행 우선, 없으면 위 행).
    var hrowAbove = rows[hr - 1] || [];
    var findGroupCol = function(pred) {
      for (var i = 0; i < hrow.length; i++) { if (pred(String(hrow[i]).trim())) return i; }
      for (var j = 0; j < hrowAbove.length; j++) { if (pred(String(hrowAbove[j]).trim())) return j; }
      return -1;
    };
    var optCol   = findGroupCol(function(hv) { return hv === "적정재고"; });
    var rangeCol = findGroupCol(function(hv) { return hv.indexOf("적정재고(구간)") === 0; });
    var svcCol   = findGroupCol(function(hv) { return hv.indexOf("서비스") >= 0; });
    var moqCol   = findGroupCol(function(hv) { return hv === "MOQ"; });
    var cycleCol = findGroupCol(function(hv) { return hv.indexOf("공급주기") >= 0; });
    var avgOutCol= findGroupCol(function(hv) { return hv.indexOf("12개월 평균") >= 0; });
    // 수요변동(CV) = 표준편차 ÷ 12개월 평균 출고.
    // "수요가 불안정해서 재고를 쌓았다"는 변명을 이 숫자 하나가 막는다.
    var sdCol    = findGroupCol(function(hv) { return hv === "표준편차"; });
    if (optCol < 0) break; // 이 레이아웃 아님 → 기존 로직으로
    // 서브헤더 행(월라벨 "YY.M"·S/F평균)도 "내역/자재" 행 자체에 있을 수도, 바로 다음 행에 있을 수도 있음 —
    // 월라벨 패턴이 실제로 있는 쪽을 채택.
    var srowCandidate = rows[hr + 1] || [];
    var hrowHasMonths = hrow.some(function(v) { return /^\d{2}\.\d{1,2}$/.test(String(v).trim()); });
    var srow = hrowHasMonths ? hrow : srowCandidate; // 서브헤더 행 (S/F 26.1… / 25.1… / 수량·금액 등)
    // 월별 실적/예측 컬럼 탐색 (서브헤더 라벨 "YY.M" 기반 — 연도 하드코딩 없음, 열 추가·연도 경과에 견딤).
    // S/F(예측) 그룹과 출고실적 그룹은 "S/F … 평균" 컬럼을 경계로 구분 (앞=예측, 뒤=실적).
    // 라벨이 "S/F 3개월 평균"/"S/F 평균" 등으로 와도 매칭(사이 글자 허용) — 연도 라벨 실수에도 경계가 안 흔들림.
    // 실적은 최신 연도=당해(outCurYear), 그 직전 연도=전년(outPrevYear)으로 동적 분리.
    var sfAvgCol = -1;
    for (var sc0 = 0; sc0 < srow.length; sc0++) {
      if (/S\/F.*평균/.test(String(srow[sc0]))) sfAvgCol = sc0;
    }
    var monthCols = [];
    for (var sc = 0; sc < srow.length; sc++) {
      var mm = String(srow[sc]).trim().match(/^(\d{2})\.(\d{1,2})$/);
      if (mm) monthCols.push({
        col: sc, year: 2000 + parseInt(mm[1], 10),
        month: "20" + mm[1] + "-" + String(parseInt(mm[2], 10)).padStart(2, "0"),
      });
    }
    var sfCols = [], actCols = [];
    if (sfAvgCol >= 0) {
      monthCols.forEach(function(c) { (c.col < sfAvgCol ? sfCols : actCols).push(c); });
    } else {
      // 폴백: 가장 이른 연도(전년 실적) 라벨이 처음 나오는 컬럼 앞 = 예측
      var minYear = Infinity, firstAct = Infinity;
      monthCols.forEach(function(c) { if (c.year < minYear) minYear = c.year; });
      monthCols.forEach(function(c) { if (c.year === minYear) firstAct = Math.min(firstAct, c.col); });
      monthCols.forEach(function(c) { (c.col < firstAct ? sfCols : actCols).push(c); });
    }
    var maxActYear = 0;
    actCols.forEach(function(c) { if (c.year > maxActYear) maxActYear = c.year; });
    var out26Cols = actCols.filter(function(c) { return c.year === maxActYear; });
    var out25Cols = actCols.filter(function(c) { return c.year === maxActYear - 1; });
    var DAYS = optCol + 2; // 그룹 내 [수량, 금액, 재고일수]
    return rows.slice(hr + 1).map(function(row) {
      var code = cleanOptional(row[1]);
      var days = cleanNumber(row[DAYS]);
      if (!code || days === null) return null;
      var pickMonths = function(cols) {
        var o = {};
        cols.forEach(function(c) {
          var v = cleanNumber(row[c.col]);
          if (v !== null) o[c.month] = v;
        });
        return o;
      };
      return {
        itemCode:     normalizeCode(String(code)),
        targetDays:   days,
        minDays:      rangeCol >= 0 ? cleanNumber(row[rangeCol + 2]) : null,
        maxDays:      rangeCol >= 0 ? cleanNumber(row[rangeCol + 5]) : null,
        serviceLevel: svcCol >= 0 ? cleanOptional(row[svcCol]) : null,
        itemType:     cleanOptional(row[0]),
        businessUnit: cleanOptional(row[3]),
        sfByMonth:    pickMonths(sfCols),    // S/F 판매예측 (월별)
        outPrevYear:  pickMonths(out25Cols), // 전년 월별 출고실적
        outCurYear:   pickMonths(out26Cols), // 당해 월별 출고실적
        moq:          moqCol >= 0 ? cleanNumber(row[moqCol]) : null,
        cycleMonths:  cycleCol >= 0 ? cleanNumber(row[cycleCol]) : null,
        avg12OutQty:  avgOutCol >= 0 ? cleanNumber(row[avgOutCol]) : null,
        stdDev:       sdCol >= 0 ? cleanNumber(row[sdCol]) : null,   // 수요 표준편차 → CV 산출용
      };
    }).filter(function(r) { return r !== null; });
  }

  const headerIndex = findHeaderIndex(rows, ["자재코드"]);
  if (headerIndex < 0) {
    const header = rows[0] || [];
    const idx = indexer(header);
    return rows.slice(1).map(function(r) {
      const code = cleanOptional(get(r, idx("자재코드")) || get(r, idx("품목코드")) || get(r, idx("itemCode")));
      const days  = cleanNumber(get(r, idx("적정재고일수")) || get(r, idx("목표재고일수")) || get(r, idx("targetDays")));
      return { itemCode: code ? normalizeCode(code) : null, targetDays: days };
    }).filter(function(r) { return r.itemCode && r.targetDays !== null; });
  }
  const header = rows[headerIndex];
  const idx = indexer(header);

  // 적정재고_raw.xlsx 는 3행 멀티헤더: Row 3에 자재코드는 있지만 "적정재고일수" 컬럼명이 없음.
  // 이 경우 고정 컬럼 인덱스로 직접 읽는다.
  if (idx("적정재고일수") < 0 && idx("목표재고일수") < 0) {
    const CODE_COL = 2;   // Col C: 자재코드
    const DAYS_COL = 51;  // 적정재고 재고일수
    const MIN_COL  = 54;  // 구간 MIN 일수
    const MAX_COL  = 57;  // 구간 MAX 일수
    const SVC_COL  = 41;  // 서비스레벨 (A/B/C)
    const TYPE_COL = 1;   // Col B: 내역 (완제품/상품)
    const BU_COL   = 4;   // Col E: 사업부
    return rows.slice(headerIndex + 1).filter(function(row) {
      return cleanOptional(row[CODE_COL]);
    }).map(function(row) {
      const code = cleanOptional(row[CODE_COL]);
      const days = cleanNumber(row[DAYS_COL]);
      return {
        itemCode:     code ? normalizeCode(String(code)) : null,
        targetDays:   days,
        minDays:      cleanNumber(row[MIN_COL]),
        maxDays:      cleanNumber(row[MAX_COL]),
        serviceLevel: cleanOptional(row[SVC_COL]),
        itemType:     cleanOptional(row[TYPE_COL]),
        businessUnit: cleanOptional(row[BU_COL]),
      };
    }).filter(function(r) { return r.itemCode && r.targetDays !== null; });
  }

  return rows.slice(headerIndex + 1).filter(function(row) {
    return get(row, idx("자재코드")) || get(row, idx("품목코드"));
  }).map(function(row) {
    const code = get(row, idx("자재코드")) || get(row, idx("품목코드"));
    const days  = cleanNumber(get(row, idx("적정재고일수")) || get(row, idx("목표재고일수")));
    return { itemCode: code ? normalizeCode(String(code)) : null, targetDays: days };
  }).filter(function(r) { return r.itemCode && r.targetDays !== null; });
}

// 나보타_RAW: 비점검(계획 없음) 사업부의 월별 집계 — 총재고 델타·각주용.
// 레이아웃: 헤더행에 "YYYY-MM" 월 라벨, 지표행은 col1(구분) 라벨(재고금액/입고금액/출고금액(전체)/재고일수).
// 값 단위 = 억. 재고금액만 필수(총재고 델타), 입·출고는 증감 원인 각주용(있으면 사용).
function mapNabotaRows(rows) {
  var hr = -1, monthCols = [];
  for (var r = 0; r < Math.min(rows.length, 8); r++) {
    var mc = [];
    (rows[r] || []).forEach(function(v, c) {
      var m = String(v == null ? "" : v).trim().match(/^(\d{4})-(\d{2})$/);
      if (m) mc.push({ col: c, month: m[1] + "-" + m[2] });
    });
    if (mc.length >= 6) { hr = r; monthCols = mc; break; }
  }
  if (hr < 0) return [];
  function findRow(test) {
    for (var i = hr + 1; i < rows.length; i++) {
      var lbl = String((rows[i] || [])[1] == null ? "" : rows[i][1]).trim();
      if (lbl && test(lbl)) return rows[i];
    }
    return null;
  }
  var invR       = findRow(function(l) { return l === "재고금액"; });
  var intakeR    = findRow(function(l) { return l.indexOf("입고") >= 0 && l.indexOf("제품") < 0; });
  var outR       = findRow(function(l) { return l.indexOf("출고") >= 0 && l.indexOf("제품") < 0; }); // 출고(전체)
  var outProdR   = findRow(function(l) { return l.indexOf("출고") >= 0 && l.indexOf("제품") >= 0; }); // 출고(제품만)=판매원가
  var invProdR   = findRow(function(l) { return l === "재고금액(제품만)"; });
  var intakeProdR= findRow(function(l) { return l === "입고금액(제품만)"; });
  var salesR    = findRow(function(l) { return l === "매출액"; });
  var daysR     = findRow(function(l) { return l.indexOf("재고일수") >= 0; });
  return monthCols.map(function(mc) {
    return {
      month:      mc.month,
      invAmt:     invR      ? cleanNumber(invR[mc.col])      : null, // 억, 재고금액(총재고 델타용, 원료·자재·재공품·제품 전체)
      intakeAmt:  intakeR   ? cleanNumber(intakeR[mc.col])   : null, // 억
      outAmt:     outR      ? cleanNumber(outR[mc.col])      : null, // 억, 출고(전체)
      outProdAmt: outProdR  ? cleanNumber(outProdR[mc.col])  : null, // 억, 출고(제품만)=판매원가(원가 모드)
      invProdAmt:    invProdR    ? cleanNumber(invProdR[mc.col])    : null, // 억, 재고금액(제품만) — RTF매트릭스 나보타행 기말재고용
      intakeProdAmt: intakeProdR ? cleanNumber(intakeProdR[mc.col]) : null, // 억, 입고금액(제품만)
      salesAmt:   salesR    ? cleanNumber(salesR[mc.col])    : null, // 억, 매출액(매출 모드)
      invDays:    daysR     ? cleanNumber(daysR[mc.col])     : null,
    };
  }).filter(function(r) { return r.invAmt !== null; });
}

function mapRawData(rawFiles) {
  const tables = { item_master:[], inventory_base:[], plan_monthly:[], bom_components:[], business_mapping:[], target_inv:[], actuals_monthly:[], actuals_meta:[], sales_actual:[], nabota_monthly:[], sales_history:[] };
  Object.values(rawFiles).filter((f) => f.parseSuccess).forEach((file) => {
    // 파일당 시트 전부 순회 (예: 판매계획_공급계획_RAW = 완제품상품/원부자재 두 시트) —
    // 각 map*Rows는 자기 헤더를 스스로 찾아 매칭 안 되면 [] 반환하므로 무관한 시트는 안전하게 무시됨.
    (file.sheets ?? []).forEach((sheet) => {
      const rows = sheet?.rows ?? [];
      if (file.rawType === "salesSupplyPlan")   { tables.plan_monthly.push(...mapPlanRows(rows)); tables.sales_history.push(...mapSalesHistoryRows(rows)); }
      if (file.rawType === "materialInventory") tables.inventory_base.push(...mapMaterialInventoryRows(rows));
      if (file.rawType === "wipInventory")      tables.inventory_base.push(...mapWipInventoryRows(rows));
      if (file.rawType === "itemMaster") {
        const itemRows = mapItemMasterRows(rows);
        tables.item_master.push(...itemRows);
        tables.business_mapping.push(...itemRows);
      }
      if (file.rawType === "bom")             tables.bom_components.push(...mapBomRows(rows));
      if (file.rawType === "targetInventory") tables.target_inv.push(...mapTargetInvRows(rows));
      if (file.rawType === "salesActual")     tables.sales_actual.push(...mapSalesActualRows(rows));
      if (file.rawType === "actualMonthly") {
        tables.actuals_monthly.push(...mapActualsRows(rows));
        tables.actuals_meta.push(...mapActualsMetaRows(rows));
      }
      if (file.rawType === "nabota")          tables.nabota_monthly.push(...mapNabotaRows(rows));
    });
  });
  return tables;
}

function mapPlanRows(rows) {
  const headerIndex = findPlanHeaderIndex(rows);
  if (headerIndex < 0) return [];
  const header = rows[headerIndex];
  const idx = indexer(header);
  const months = extractPlanMonths(header);
  return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재"))).flatMap((row) =>
    months.map((month) => ({
      month,
      manager:   get(row, idx("담당자")),
      plant:     normalizePlant(get(row, idx("플랜트"))),
      itemType:  get(row, idx("내역")),
      itemCode:  normalizeCode(get(row, idx("자재"))),
      itemName:  get(row, idx("자재 내역")),
      unit:      get(row, idx("Unit")),
      salesQty:  cleanNumber(get(row, idx(`${month}_판매계획`))),
      supplyQty: cleanNumber(get(row, idx(`${month}_공급계획`))),
    })),
  );
}

// 과거월 판매계획·실적 이력 (W열~ `{월}_판매계획`+`{월}_실적` 쌍) — AI 차질 원인 소견용.
// 실적 컬럼이 있는 월(과거)만 추출. 원부자재 시트 등 실적 없는 시트는 [] 반환(안전).
function mapSalesHistoryRows(rows) {
  const headerIndex = findPlanHeaderIndex(rows);
  if (headerIndex < 0) return [];
  const header = rows[headerIndex];
  const idx = indexer(header);
  const histMonths = [...new Set(header.flatMap((cell) => {
    const m = normalizeHeader(cell).match(/^(\d{4}-\d{2})_실적$/);
    return m ? [m[1]] : [];
  }))].sort();
  if (!histMonths.length) return [];
  return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재"))).flatMap((row) =>
    histMonths.map((month) => ({
      month,
      plant:     normalizePlant(get(row, idx("플랜트"))),
      itemCode:  normalizeCode(get(row, idx("자재"))),
      planQty:   cleanNumber(get(row, idx(`${month}_판매계획`))),
      actualQty: cleanNumber(get(row, idx(`${month}_실적`))),
    })),
  );
}

function mapMaterialInventoryRows(rows) {
  const headerIndex = findHeaderIndex(rows, ["자재","표준원가","기초(수량)"]);
  if (headerIndex < 0) return [];
  const header = rows[headerIndex];
  const idx = indexer(header);
  return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재"))).map((row) => ({
    source:       "기초재고_자재_RAW.xlsx",
    plant:        normalizePlant(get(row, idx("플랜트"))),
    itemType:     get(row, idx("내역")),
    itemCode:     normalizeCode(get(row, idx("자재"))),
    itemName:     get(row, idx("자재 내역")),
    unit:         get(row, idx("Unit")),
    standardCost: toNumber(get(row, idx("표준원가"))),
    baseQty:      toNumber(get(row, idx("기말(수량)"))),
    baseAmount:   firstNumber(row, [idx("기말(금액)합계"), idx("기말(금액)")]),
  }));
}

function mapWipInventoryRows(rows) {
  const headerIndex = findHeaderIndex(rows, ["자재코드","재공기말금액"]);
  if (headerIndex < 0) return [];
  const header = rows[headerIndex];
  const idx = indexer(header);
  return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재코드"))).map((row) => ({
    source:       "기초재고_재공품_RAW.xlsx",
    plant:        normalizePlant(get(row, idx("플랜트"))),
    itemType:     "재공품",
    itemCode:     normalizeCode(get(row, idx("자재코드"))),
    itemName:     get(row, idx("자재내역")),
    unit:         get(row, idx("단위")),
    standardCost: 0,
    baseQty:      0,
    baseAmount:   firstNumber(row, [idx("재공기말금액"), idx("재공기초금액")]),
  }));
}

function mapItemMasterRows(rows) {
  const headerIndex = findHeaderIndex(rows, ["자재코드","사업부"]);
  if (headerIndex < 0) return [];
  const header = rows[headerIndex];
  const idx = indexer(header);
  return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재코드"))).map((row) => ({
    itemCode:     normalizeCode(get(row, idx("자재코드"))),
    itemName:     get(row, idx("자재명")),
    businessUnit: get(row, idx("사업부")),
    itemGroup:    get(row, idx("품목구분1")) || get(row, idx("품목구분")),
  }));
}

function mapBomRows(rows) {
  const headerIndex = findHeaderIndex(rows, ["자재번호(Root)","구성요소"]);
  if (headerIndex < 0) return [];
  const header = rows[headerIndex];
  const idx = indexer(header);
  return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재번호(Root)"))).map((row) => ({
    plant:          normalizePlant(get(row, idx("플랜트"))),
    rootItemCode:   normalizeCode(get(row, idx("자재번호(Root)"))),
    rootItemName:   get(row, idx("자재 내역")),
    alternativeBom: get(row, idx("대체 BOM")),
    baseQty:        toNumber(get(row, idx("기준 수량"))),
    baseUnit:       get(row, idx("기본단위")),
    itemCategory:   get(row, idx("품목 범주")),
    componentCode:  normalizeCode(get(row, idx("구성요소"))),
    componentName:  get(row, idx("자재 내역", 1)),
    componentQty:   toNumber(get(row, idx("구성요소 수량"))),
    componentUnit:  get(row, idx("구성품목 단위")),
  }));
}

// ── 매출_RAW 파싱 ─────────────────────────────────────────────────────────────
// 판가 = 순매출액(공시) / 총수량(PA). 품목별로 합산 후 나눠 판가 산출(rtf.js buildSalesPriceMap).
// 매출수량 컬럼은 전 행 0이라 사용 불가 → 총수량(PA)를 판매수량 단위로 사용.
function mapSalesActualRows(rows) {
  const headerIndex = findHeaderIndex(rows, ["상품", "순매출액(공시)", "총수량(PA)"]);
  if (headerIndex < 0) return [];
  const header = rows[headerIndex];
  const idx = indexer(header);
  return rows.slice(headerIndex + 1).filter((row) => get(row, idx("상품"))).map((row) => ({
    source:   "매출_RAW.xlsx",
    plant:    normalizePlant(get(row, idx("플랜트"))),
    itemCode: normalizeCode(get(row, idx("상품"))),
    itemName: get(row, idx("자재 내역")),
    netSales: toNumber(get(row, idx("순매출액(공시)"))),
    paQty:    toNumber(get(row, idx("총수량(PA)"))),
    costAmt:  toNumber(get(row, idx("원가금액"))), // 나보타 평균 원가율 산출용
    unitCost: toNumber(get(row, idx("단위당원가"))), // 기초재고 미연결 품목 표준원가 대체용
  }));
}

// ── 결산_raw 파싱 ─────────────────────────────────────────────────────────────
// 구조: row1=날짜헤더(merged), row2=지표헤더, row3~12=유형별(전체), row18~56=플랜트×유형
function mapActualsRows(rows) {
  var dateRow   = rows[1] || [];
  var metricRow = rows[2] || [];

  // 월 → {invAmt, supplyAmt, salesAmt, invDays} 컬럼 인덱스 맵
  var monthCols = {};
  var curMonth  = null;
  for (var ci = 2; ci < dateRow.length; ci++) {
    var dv = String(dateRow[ci] || "").trim();
    if (dv.match(/^\d{4}-\d{2}$/)) curMonth = dv;
    if (!curMonth) continue;
    if (!monthCols[curMonth]) monthCols[curMonth] = {};
    var mv = String(metricRow[ci] || "").trim();
    if      (mv === "재고금액") monthCols[curMonth].invAmt    = ci;
    else if (mv === "입고금액") monthCols[curMonth].supplyAmt = ci;
    else if (mv === "출고금액") monthCols[curMonth].salesAmt  = ci;
    else if (mv === "재고일수") monthCols[curMonth].invDays   = ci;
  }

  var SKIP_TYPES = new Set(["합계","총 합계","유형"]);
  var SKIP_KEYWORDS = ["합계","총"];
  function shouldSkip(type) {
    if (!type) return true;
    if (SKIP_TYPES.has(type)) return true;
    return SKIP_KEYWORDS.some(function(k) { return type.includes(k); });
  }

  function extractRow(row, plant, months) {
    var type = String(row[0] || "").trim();
    if (shouldSkip(type)) return [];
    var result = [];
    months.forEach(function(month) {
      var cols = monthCols[month];
      if (!cols || cols.invAmt === undefined) return;
      var invAmt = parseFloat(row[cols.invAmt]);
      if (!Number.isFinite(invAmt)) return; // 빈 월 스킵 → 실적/전망 경계 자동 판단
      result.push({
        month:     month,
        plant:     plant,
        type:      type,
        invAmt:    invAmt,
        supplyAmt: Number.isFinite(parseFloat(row[cols.supplyAmt])) ? parseFloat(row[cols.supplyAmt]) : null,
        salesAmt:  Number.isFinite(parseFloat(row[cols.salesAmt]))  ? parseFloat(row[cols.salesAmt])  : null,
        invDays:   Number.isFinite(parseFloat(row[cols.invDays]))   ? parseFloat(row[cols.invDays])   : null,
      });
    });
    return result;
  }

  var months  = Object.keys(monthCols);
  var result  = [];

  // Table 1: 유형별 전체 (row index 3~12, 1-indexed rows 4~13)
  // (mapActualsMetaRows에서 매출원가(누적)·미착품·평가충당금 전망을 별도 추출)
  for (var r = 3; r <= 12; r++) {
    if (rows[r]) result.push.apply(result, extractRow(rows[r], "전체", months));
  }

  // Table 2: 플랜트×유형 (row index 17~55, 1-indexed rows 18~56)
  for (var r2 = 19; r2 <= 55; r2++) {
    var row    = rows[r2];
    if (!row) continue;
    var plant2 = String(row[1] || "").trim();
    if (!plant2) continue; // 플랜트 없는 행 = 소계/전체 → Table1에서 이미 읽음
    result.push.apply(result, extractRow(row, plant2.replace(/\s+/g, ""), months));
  }

  return result;
}

// ── 결산_raw 메타 파싱: 매출원가(누적) + 미착품·평가충당금 (전망월 포함, 억 단위) ──
// 공시기준 재고일수용. 미착품·평가충당금 전망은 사용자가 시트 하단 행에 직접 입력
// (미래 월도 값이 있으면 읽음 — 재고금액 없는 월도 스킵하지 않음)
function mapActualsMetaRows(rows) {
  var dateRow = rows[1] || [];
  var monthStart = {};
  var cur = null;
  for (var ci = 2; ci < dateRow.length; ci++) {
    var dv = String(dateRow[ci] || "").trim();
    if (dv.match(/^\d{4}-\d{2}$/) && dv !== cur) { cur = dv; monthStart[cur] = ci; }
  }

  function findRow(label, fromEnd) {
    if (fromEnd) {
      for (var r = rows.length - 1; r >= 0; r--)
        if (rows[r] && String(rows[r][0] || "").trim() === label) return rows[r];
    } else {
      for (var r2 = 0; r2 < rows.length; r2++)
        if (rows[r2] && String(rows[r2][0] || "").trim() === label) return rows[r2];
    }
    return null;
  }

  // 월 블록(재고금액/입고금액/출고금액/재고일수 4컬럼) 안의 첫 숫자 셀
  function blockValue(row, month) {
    if (!row) return null;
    var s = monthStart[month];
    for (var k = s; k < s + 4; k++) {
      var v = parseFloat(row[k]);
      if (Number.isFinite(v)) return v;
    }
    return null;
  }

  var cogsRow    = findRow("매출원가(누적)", false);
  var cogsMonRow = findRow("매출원가(당월)", false);
  var totalRow   = findRow("합계", false);
  // 미착품·평가충당금 전망은 하단 테이블에 입력 → 마지막 등장 행 우선
  var michakRow = findRow("미착품", true);
  var allowRow  = findRow("(평가충당금)", true);

  return Object.keys(monthStart).map(function(month) {
    return {
      month:        month,
      cumCogs:      blockValue(cogsRow, month),    // 매출원가 누적 (억)
      // 재고일수 분모 = 당월 매출원가. 결산_raw의 "출고금액"은 원부자재 사내 소비(생산출고)를
      // 포함해 이중계상 → 재고일수가 절반으로 축소됨. 사외 유출은 매출원가뿐이므로 이 값을 씀.
      monthCogs:    blockValue(cogsMonRow, month), // 매출원가 당월 (억)
      totalInv:     blockValue(totalRow, month),   // 공시기준 총재고 (억)
      michakInv:    blockValue(michakRow, month),  // 미착품 재고 (억)
      allowanceInv: blockValue(allowRow, month),   // 평가충당금 (억, 음수)
    };
  }).filter(function(r) {
    return r.cumCogs !== null || r.monthCogs !== null ||
           r.michakInv !== null || r.allowanceInv !== null;
  });
}
