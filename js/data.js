// ── 파일 타입 감지 ────────────────────────────────────────────────────────────
function detectRawType(fileName) {
  const name = String(fileName ?? "");
  if (name.includes("판매계획_공급계획")) return "salesSupplyPlan";
  if (name.includes("기초재고_자재"))    return "materialInventory";
  if (name.includes("기초재고_재공품"))  return "wipInventory";
  if (name.includes("사업부") && name.includes("품목 기준정보")) return "itemMaster";
  if (name.includes("BOM"))              return "bom";
  if (name.includes("적정재고"))         return "targetInventory";
  if (name.includes("결산실적_월별요약")) return "actualMonthly";
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
  const tables = { item_master:[], inventory_base:[], plan_monthly:[], bom_components:[], business_mapping:[], target_inv:[] };
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
    if (file.rawType === "bom")           tables.bom_components.push(...mapBomRows(rows));
    if (file.rawType === "targetInventory") tables.target_inv.push(...mapTargetInvRows(rows));
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
