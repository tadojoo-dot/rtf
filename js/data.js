// ── 파일 타입 감지 ────────────────────────────────────────────────────────────
function detectRawType(fileName) {
  const name = String(fileName ?? "");
  if (name.includes("판매계획_공급계획")) return "salesSupplyPlan";
  if (name.includes("기초재고_자재"))    return "materialInventory";
  if (name.includes("기초재고_재공품"))  return "wipInventory";
  if (name.includes("사업부") && name.includes("품목 기준정보")) return "itemMaster";
  if (name.includes("BOM"))              return "bom";
  if (name.includes("적정재고"))         return "targetInventory";
  if (name.includes("결산실적_월별요약") || name.includes("결산_raw") || name.includes("결산_RAW")) return "actualMonthly";
  if (name.includes("RTF_RAW_보조양식")) return "rtfHelper";
  return "unknown";
}

// ── 파일 처리 흐름 ────────────────────────────────────────────────────────────
async function processFiles(files) {
  state.uploadedFiles = files.map((file) => ({
    name: file.name, size: file.size,
    rawType: detectRawType(file.name), parseStatus: "reading",
  }));
  render("data-check");

  const rawFiles = {};
  for (const file of files) {
    const rawType = detectRawType(file.name);
    const key = rawType === "unknown" ? file.name : rawType;
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
  const headerIndex = findHeaderIndex(rows, ["자재코드"]);
  if (headerIndex < 0) {
    // fallback: treat first row as header
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
  return rows.slice(headerIndex + 1).filter(function(row) {
    return get(row, idx("자재코드")) || get(row, idx("품목코드"));
  }).map(function(row) {
    const code = get(row, idx("자재코드")) || get(row, idx("품목코드"));
    const days  = cleanNumber(get(row, idx("적정재고일수")) || get(row, idx("목표재고일수")));
    return { itemCode: code ? normalizeCode(String(code)) : null, targetDays: days };
  }).filter(function(r) { return r.itemCode && r.targetDays !== null; });
}

function mapRawData(rawFiles) {
  const tables = { item_master:[], inventory_base:[], plan_monthly:[], bom_components:[], business_mapping:[], target_inv:[], actuals_monthly:[] };
  Object.values(rawFiles).filter((f) => f.parseSuccess).forEach((file) => {
    const rows = file.sheets?.[0]?.rows ?? [];
    if (file.rawType === "salesSupplyPlan")   tables.plan_monthly.push(...mapPlanRows(rows));
    if (file.rawType === "materialInventory") tables.inventory_base.push(...mapMaterialInventoryRows(rows));
    if (file.rawType === "wipInventory")      tables.inventory_base.push(...mapWipInventoryRows(rows));
    if (file.rawType === "itemMaster") {
      const itemRows = mapItemMasterRows(rows);
      tables.item_master.push(...itemRows);
      tables.business_mapping.push(...itemRows);
    }
    if (file.rawType === "bom")             tables.bom_components.push(...mapBomRows(rows));
    if (file.rawType === "targetInventory") tables.target_inv.push(...mapTargetInvRows(rows));
    if (file.rawType === "actualMonthly")   tables.actuals_monthly.push(...mapActualsRows(rows));
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
      plant:     get(row, idx("플랜트")),
      itemType:  get(row, idx("내역")),
      itemCode:  normalizeCode(get(row, idx("자재"))),
      itemName:  get(row, idx("자재 내역")),
      unit:      get(row, idx("Unit")),
      salesQty:  cleanNumber(get(row, idx(`${month}_판매계획`))),
      supplyQty: cleanNumber(get(row, idx(`${month}_공급계획`))),
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
    plant:        get(row, idx("플랜트")),
    itemType:     get(row, idx("내역")),
    itemCode:     normalizeCode(get(row, idx("자재"))),
    itemName:     get(row, idx("자재 내역")),
    unit:         get(row, idx("Unit")),
    standardCost: toNumber(get(row, idx("표준원가"))),
    baseQty:      toNumber(get(row, idx("기초(수량)"))),
    baseAmount:   firstNumber(row, [idx("기초(금액)합계"), idx("기초(금액)")]),
  }));
}

function mapWipInventoryRows(rows) {
  const headerIndex = findHeaderIndex(rows, ["자재코드","재공기초금액"]);
  if (headerIndex < 0) return [];
  const header = rows[headerIndex];
  const idx = indexer(header);
  return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재코드"))).map((row) => ({
    source:       "기초재고_재공품_RAW.xlsx",
    plant:        get(row, idx("플랜트")),
    itemType:     "재공품",
    itemCode:     normalizeCode(get(row, idx("자재코드"))),
    itemName:     get(row, idx("자재내역")),
    unit:         get(row, idx("단위")),
    standardCost: 0,
    baseQty:      0,
    baseAmount:   firstNumber(row, [idx("재공기초금액"), idx("재공기말금액")]),
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
    plant:          get(row, idx("플랜트")),
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
