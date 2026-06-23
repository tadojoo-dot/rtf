(function () {
  const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"];
  const MONTH_COLUMNS = ["판매계획", "RTF", "Shortage", "매출", "매출차질예상", "기말재고", "재고일수"];
  const EXTRA_COLUMNS = ["매출", "매출차질예상", "기말재고", "재고일수"];
  const STATUS = { OK: "대응가능", WARN: "주의", SHORTAGE: "공급부족", UNKNOWN: "판단불가" };
  const STATUS_RANK = { 공급부족: 0, 주의: 1, 판단불가: 2, 대응가능: 3 };
  const NEED_MASTER = "기준정보 확인 필요";
  const NEED_DATA = "데이터 연결 필요";
  const NO_PLAN = "판매계획 없음";
  const ERROR_TEXTS = new Set(["#REF!", "#VALUE!", "#DIV/0!", "undefined", "null", "NaN", "Infinity", "-Infinity"]);
  const SHORT_TEXT = { [NEED_DATA]: "연결필요", [NEED_MASTER]: "확인필요" };

  const menus = [
    ["meeting", "회의체계"],
    ["data-check", "데이터점검"],
    ["summary", "종합현황"],
    ["rtf", "RTF(공급가능성 판정)"],
    ["constraint", "공급제한 원인"],
    ["inventory-variance", "재고금액 변동분석"],
    ["diagnosis", "수급 진단"],
    ["adjustment", "조정안 입력"],
    ["impact", "조정 후 영향"],
    ["minutes", "회의록"],
  ];

  const requiredFiles = [
    { id: "salesSupplyPlan", label: "판매계획_공급계획_RAW.xlsx" },
    { id: "materialInventory", label: "기초재고_자재_RAW.xlsx" },
    { id: "wipInventory", label: "기초재고_재공품_RAW.xlsx" },
    { id: "itemMaster", label: "사업부 별 품목 기준정보.xlsx" },
    { id: "bom", label: "BOM_RAW.xlsx" },
  ];

  const state = {
    currentMenuId: "meeting",
    uploadedFiles: [],
    rawFiles: {},
    mappedData: {
      item_master: [],
      inventory_base: [],
      plan_monthly: [],
      bom_components: [],
      business_mapping: [],
    },
    rtfExpanded: false,
    expandedItemGroups: new Set(),
    rtfDisplayMode: "qty",
  };

  const screenTitle = document.querySelector("#screenTitle");
  const tabNav = document.querySelector("#tabNav");
  const screenRoot = document.querySelector("#screenRoot");

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatNumber(value, digits = 0) {
    if (!Number.isFinite(value)) return "-";
    return value.toLocaleString("ko-KR", { maximumFractionDigits: digits, minimumFractionDigits: digits });
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatMoney(value) {
    if (!Number.isFinite(value)) return NEED_DATA;
    if (value === 0) return "-";
    return `${formatNumber(value / 100000000, 1)}억`;
  }

  function addMonths(month, offset) {
    const [year, monthNo] = month.split("-").map(Number);
    const date = new Date(year, monthNo - 1 + offset, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function extractPlanMonths(header) {
    const months = [...new Set(header.flatMap((cell) => {
      const match = cleanOptional(cell).match(/^(\d{4}-\d{2})_/);
      return match ? [match[1]] : [];
    }))].sort();
    return months.length ? months : MONTHS;
  }

  function getRtfMonths() {
    const planMonths = state.mappedData.plan_monthly.map((row) => cleanOptional(row.month)).filter(Boolean).sort();
    const baseMonth = planMonths[0] || MONTHS[0];
    return Array.from({ length: 7 }, (_, index) => addMonths(baseMonth, index));
  }

  function monthLabel(month) {
    const [year, monthNo] = month.split("-").map(Number);
    return monthNo === 1 ? `${year}년 1월` : `${monthNo}월`;
  }

  function cleanText(value, fallback = NEED_MASTER) {
    const text = String(value ?? "").trim();
    if (!text || ERROR_TEXTS.has(text)) return fallback;
    return text;
  }

  function cleanOptional(value) {
    const text = String(value ?? "").trim();
    if (!text || ERROR_TEXTS.has(text)) return "";
    return text;
  }

  function cleanNumber(value) {
    const text = String(value ?? "").replaceAll(",", "").trim();
    if (!text || ERROR_TEXTS.has(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeCode(value) {
    return String(value ?? "").trim().replace(/\.0$/, "");
  }

  function normalizeHeader(value) {
    return String(value ?? "").replaceAll(" ", "").trim();
  }

  function get(row, index) {
    return index >= 0 ? String(row[index] ?? "").trim() : "";
  }

  function toNumber(value) {
    const number = cleanNumber(value);
    return number ?? 0;
  }

  function firstNumber(row, indexes) {
    for (const index of indexes) {
      const value = toNumber(get(row, index));
      if (value !== 0) return value;
    }
    return 0;
  }

  function findHeaderIndex(rows, labels) {
    return rows.findIndex((row) => Array.isArray(row) && labels.every((label) => row.some((cell) => normalizeHeader(cell) === normalizeHeader(label))));
  }

  function findPlanHeaderIndex(rows) {
    return rows.findIndex((row) => Array.isArray(row)
      && row.some((cell) => normalizeHeader(cell) === normalizeHeader("자재"))
      && row.some((cell) => /^\d{4}-\d{2}_판매계획$/.test(normalizeHeader(cell)))
      && row.some((cell) => /^\d{4}-\d{2}_공급계획$/.test(normalizeHeader(cell))));
  }

  function indexer(header) {
    return (label, occurrence = 0) => {
      const normalized = normalizeHeader(label);
      let seen = 0;
      for (let index = 0; index < header.length; index += 1) {
        if (normalizeHeader(header[index]) === normalized) {
          if (seen === occurrence) return index;
          seen += 1;
        }
      }
      return -1;
    };
  }

  function detectRawType(fileName) {
    const name = String(fileName ?? "");
    if (name.includes("판매계획_공급계획")) return "salesSupplyPlan";
    if (name.includes("기초재고_자재")) return "materialInventory";
    if (name.includes("기초재고_재공품")) return "wipInventory";
    if (name.includes("사업부") && name.includes("품목 기준정보")) return "itemMaster";
    if (name.includes("BOM")) return "bom";
    if (name.includes("결산실적_월별요약")) return "actualMonthly";
    if (name.includes("RTF_RAW_보조양식")) return "rtfHelper";
    return "unknown";
  }

  async function processFiles(files) {
    state.uploadedFiles = files.map((file) => ({ name: file.name, size: file.size, rawType: detectRawType(file.name), parseStatus: "reading" }));
    render("data-check");

    const rawFiles = {};
    for (const file of files) {
      const rawType = detectRawType(file.name);
      const key = rawType === "unknown" ? file.name : rawType;
      try {
        const workbook = await parseWorkbook(file);
        rawFiles[key] = {
          name: file.name,
          size: file.size,
          rawType,
          parseStatus: "success",
          parseSuccess: true,
          sheets: workbook.sheets,
          sheetNames: workbook.sheets.map((sheet) => sheet.name),
          rowCount: workbook.sheets.reduce((sum, sheet) => sum + sheet.rowCount, 0),
        };
      } catch (error) {
        rawFiles[key] = {
          name: file.name,
          size: file.size,
          rawType,
          parseStatus: "error",
          parseSuccess: false,
          parseMessage: error.message,
          sheets: [],
          sheetNames: [],
          rowCount: 0,
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
          header: 1,
          raw: true,
          defval: "",
          blankrows: true,
        });
        return {
          name,
          rows,
          rowCount: Math.max(0, rows.filter((row) => row.some((cell) => cell !== "")).length - 1),
        };
      }),
    };
  }

  function mapRawData(rawFiles) {
    const tables = { item_master: [], inventory_base: [], plan_monthly: [], bom_components: [], business_mapping: [] };
    Object.values(rawFiles).filter((file) => file.parseSuccess).forEach((file) => {
      const rows = file.sheets?.[0]?.rows ?? [];
      if (file.rawType === "salesSupplyPlan") tables.plan_monthly.push(...mapPlanRows(rows));
      if (file.rawType === "materialInventory") tables.inventory_base.push(...mapMaterialInventoryRows(rows));
      if (file.rawType === "wipInventory") tables.inventory_base.push(...mapWipInventoryRows(rows));
      if (file.rawType === "itemMaster") {
        const itemRows = mapItemMasterRows(rows);
        tables.item_master.push(...itemRows);
        tables.business_mapping.push(...itemRows);
      }
      if (file.rawType === "bom") tables.bom_components.push(...mapBomRows(rows));
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
        manager: get(row, idx("담당자")),
        plant: get(row, idx("플랜트")),
        itemType: get(row, idx("내역")),
        itemCode: normalizeCode(get(row, idx("자재"))),
        itemName: get(row, idx("자재 내역")),
        unit: get(row, idx("Unit")),
        salesQty: cleanNumber(get(row, idx(`${month}_판매계획`))),
        supplyQty: cleanNumber(get(row, idx(`${month}_공급계획`))),
      })),
    );
  }

  function mapMaterialInventoryRows(rows) {
    const headerIndex = findHeaderIndex(rows, ["자재", "표준원가", "기초(수량)"]);
    if (headerIndex < 0) return [];
    const header = rows[headerIndex];
    const idx = indexer(header);
    return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재"))).map((row) => ({
      source: "기초재고_자재_RAW.xlsx",
      plant: get(row, idx("플랜트")),
      itemType: get(row, idx("내역")),
      itemCode: normalizeCode(get(row, idx("자재"))),
      itemName: get(row, idx("자재 내역")),
      unit: get(row, idx("Unit")),
      standardCost: toNumber(get(row, idx("표준원가"))),
      baseQty: toNumber(get(row, idx("기초(수량)"))),
      baseAmount: firstNumber(row, [idx("기초(금액)합계"), idx("기초(금액)")]),
    }));
  }

  function mapWipInventoryRows(rows) {
    const headerIndex = findHeaderIndex(rows, ["자재코드", "재공기초금액"]);
    if (headerIndex < 0) return [];
    const header = rows[headerIndex];
    const idx = indexer(header);
    return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재코드"))).map((row) => ({
      source: "기초재고_재공품_RAW.xlsx",
      plant: get(row, idx("플랜트")),
      itemType: "재공품",
      itemCode: normalizeCode(get(row, idx("자재코드"))),
      itemName: get(row, idx("자재내역")),
      unit: get(row, idx("단위")),
      standardCost: 0,
      baseQty: 0,
      baseAmount: firstNumber(row, [idx("재공기초금액"), idx("재공기말금액")]),
    }));
  }

  function mapItemMasterRows(rows) {
    const headerIndex = findHeaderIndex(rows, ["자재코드", "사업부"]);
    if (headerIndex < 0) return [];
    const header = rows[headerIndex];
    const idx = indexer(header);
    return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재코드"))).map((row) => ({
      itemCode: normalizeCode(get(row, idx("자재코드"))),
      itemName: get(row, idx("자재명")),
      businessUnit: get(row, idx("사업부")),
      itemGroup: get(row, idx("품목구분1")) || get(row, idx("품목구분")),
    }));
  }

  function mapBomRows(rows) {
    const headerIndex = findHeaderIndex(rows, ["자재번호(Root)", "구성요소"]);
    if (headerIndex < 0) return [];
    const header = rows[headerIndex];
    const idx = indexer(header);
    return rows.slice(headerIndex + 1).filter((row) => get(row, idx("자재번호(Root)"))).map((row) => ({
      plant: get(row, idx("플랜트")),
      rootItemCode: normalizeCode(get(row, idx("자재번호(Root)"))),
      rootItemName: get(row, idx("자재 내역")),
      alternativeBom: get(row, idx("대체 BOM")),
      baseQty: toNumber(get(row, idx("기준 수량"))),
      baseUnit: get(row, idx("기본단위")),
      itemCategory: get(row, idx("품목 범주")),
      componentCode: normalizeCode(get(row, idx("구성요소"))),
      componentName: get(row, idx("자재 내역", 1)),
      componentQty: toNumber(get(row, idx("구성요소 수량"))),
      componentUnit: get(row, idx("구성품목 단위")),
    }));
  }

  function renderTabs(activeId) {
    tabNav.innerHTML = menus.map(([id, label]) =>
      `<button type="button" class="tab-btn ${id === activeId ? "active" : ""}" data-menu-id="${escapeHtml(id)}">${escapeHtml(label)}</button>`,
    ).join("");
    tabNav.querySelectorAll("[data-menu-id]").forEach((button) => button.addEventListener("click", () => render(button.dataset.menuId)));
  }

  function badge(status, label) {
    return `<span class="badge ${status}">${escapeHtml(label)}</span>`;
  }

  function renderTable(headers, rows) {
    return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${headers.length}">표시할 데이터가 없습니다.</td></tr>`}</tbody></table></div>`;
  }

  function renderMeeting() {
    return `<section class="section-band">
      <div class="section-header">
        <div><p class="eyebrow">local mode</p><h2>로컬 파일 모드</h2></div>
        <p>서버 없이 index.html을 직접 열어 사용합니다. 데이터점검 화면에서 RAW 파일을 선택하면 브라우저 메모리에서만 읽어 RTF 화면에 반영합니다.</p>
      </div>
      <div class="process-grid">
        <article class="card process-card"><h3>1. RAW 선택</h3><p>데이터점검에서 엑셀 파일을 복수 선택합니다.</p></article>
        <article class="card process-card"><h3>2. RTF 확인</h3><p>사업부별/플랜트별 계층형 월별 매트릭스를 확인합니다.</p></article>
        <article class="card process-card"><h3>3. 상세 점검</h3><p>그룹을 펼쳐 유형, 품목군, 자재별 월별 항목을 확인합니다.</p></article>
      </div>
    </section>`;
  }

  function renderDataCheck() {
    const parsedFiles = Object.values(state.rawFiles);
    const uploadRows = state.uploadedFiles.map((file) => [
      escapeHtml(file.name),
      formatBytes(file.size),
      escapeHtml(file.rawType ?? "-"),
      file.parseSuccess ? badge("ok", "읽기 성공") : file.parseStatus === "error" ? badge("missing", file.parseMessage ?? "읽기 실패") : badge("warn", "대기"),
      file.sheetNames?.length ? file.sheetNames.map(escapeHtml).join(", ") : "-",
      file.rowCount?.toLocaleString("ko-KR") ?? "-",
    ]);
    const requiredRows = requiredFiles.map((file) => {
      const parsed = parsedFiles.find((raw) => raw.rawType === file.id || raw.name === file.label);
      return [escapeHtml(file.label), parsed ? badge("ok", "연결 완료") : badge("missing", "미연결"), parsed ? escapeHtml(parsed.name) : "-"];
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
    <section class="section-band"><div class="section-header"><h2>필수 파일 연결 여부</h2></div>${renderTable(["필수 파일", "상태", "선택된 파일"], requiredRows)}</section>
    <section class="section-band"><div class="section-header"><h2>읽기 상태</h2></div>${renderTable(["파일명", "크기", "RAW 유형", "읽기 상태", "시트명", "행 수"], uploadRows)}</section>
    <section class="section-band"><div class="section-header"><h2>매핑 결과</h2></div>${renderTable(["테이블", "행 수"], [
      ["판매/공급계획", formatNumber(counts.plan_monthly.length)],
      ["기초재고", formatNumber(counts.inventory_base.length)],
      ["사업부 기준정보", formatNumber(counts.item_master.length)],
      ["BOM", formatNumber(counts.bom_components.length)],
    ])}</section>`;
  }

  function itemTypeGroup(item) {
    const type = cleanOptional(item.itemType);
    if (type.includes("상품") || String(item.itemCode ?? "").startsWith("7")) return "상품";
    if (type.includes("완제품") || String(item.itemCode ?? "").startsWith("9")) return "완제품";
    return STATUS.UNKNOWN;
  }

  function higherSeverity(a, b) {
    return STATUS_RANK[a] <= STATUS_RANK[b] ? a : b;
  }

  function hasMasterGap(item) {
    if (item.typeGroup === "상품") return item.businessUnit === NEED_MASTER || item.itemGroup === NEED_MASTER;
    if (item.typeGroup === "완제품") return item.plant === NEED_MASTER || item.itemGroup === NEED_MASTER;
    return true;
  }

  function computeRtfItems() {
    const planRows = state.mappedData.plan_monthly;
    const inventoryRows = state.mappedData.inventory_base;
    const masterRows = state.mappedData.item_master;
    const costMap = new Map();
    const baseQtyMap = new Map();
    const inventorySet = new Set();
    const masterMap = new Map();
    const planLookup = new Map();
    const metaMap = new Map();

    inventoryRows.forEach((row) => {
      const code = cleanOptional(row.itemCode);
      if (!code) return;
      inventorySet.add(code);
      const cost = cleanNumber(row.standardCost);
      const baseQty = cleanNumber(row.baseQty);
      if (cost !== null && cost > 0 && !costMap.has(code)) costMap.set(code, cost);
      baseQtyMap.set(code, (baseQtyMap.get(code) ?? 0) + (baseQty ?? 0));
    });
    masterRows.forEach((row) => {
      const code = cleanOptional(row.itemCode);
      if (code && !masterMap.has(code)) masterMap.set(code, row);
    });
    planRows.forEach((row) => {
      const code = cleanOptional(row.itemCode);
      const month = cleanOptional(row.month);
      if (!code || !month) return;
      planLookup.set(`${code}|${month}`, row);
      if (!metaMap.has(code)) {
        metaMap.set(code, { itemCode: code, itemName: cleanText(row.itemName, code), plant: cleanOptional(row.plant), itemType: cleanOptional(row.itemType) });
      }
    });

    return [...metaMap.values()].map((meta) => {
      const master = masterMap.get(meta.itemCode);
      const standardCost = costMap.get(meta.itemCode) ?? null;
      const item = {
        ...meta,
        plant: cleanText(meta.plant, NEED_MASTER),
        businessUnit: cleanText(master?.businessUnit, NEED_MASTER),
        itemGroup: cleanText(master?.itemGroup, NEED_MASTER),
        standardCost,
        hasCost: standardCost !== null && standardCost > 0,
        hasInventory: inventorySet.has(meta.itemCode),
        baseQty: baseQtyMap.get(meta.itemCode) ?? null,
      };
      item.typeGroup = itemTypeGroup(item);
      let runningQty = item.baseQty;
      const masterGap = hasMasterGap(item);
      item.monthlyStatus = getRtfMonths().map((month) => {
        const plan = planLookup.get(`${item.itemCode}|${month}`);
        const salesQty = cleanNumber(plan?.salesQty);
        const supplyQty = cleanNumber(plan?.supplyQty);
        const noSalesPlan = !plan || salesQty === null || salesQty <= 0;
        const salesAmount = salesQty !== null && salesQty > 0 && item.hasCost ? salesQty * item.standardCost : null;
        let endingQty = null;
        let endingAmount = null;
        let rtfQty = null;
        let rtfAmount = null;
        let shortageQty = null;
        let shortageAmount = null;
        let lostSalesAmount = null;
        let inventoryDays = null;
        let status = STATUS.UNKNOWN;
        let reason = "";

        if (runningQty === null) {
          reason = NEED_DATA;
        } else if (masterGap) {
          reason = NEED_MASTER;
        } else if (noSalesPlan) {
          reason = NO_PLAN;
          if (supplyQty !== null) {
            runningQty += supplyQty;
            endingQty = runningQty;
          }
          rtfQty = 0;
          rtfAmount = item.hasCost ? 0 : null;
          endingAmount = item.hasCost && endingQty !== null ? Math.max(0, endingQty) * item.standardCost : null;
        } else if (supplyQty === null) {
          reason = NEED_DATA;
        } else {
          runningQty = runningQty + supplyQty - salesQty;
          endingQty = runningQty;
          shortageQty = endingQty < 0 ? Math.abs(endingQty) : 0;
          rtfQty = Math.max(0, salesQty - shortageQty);
          rtfAmount = item.hasCost ? rtfQty * item.standardCost : null;
          shortageAmount = shortageQty > 0 && item.hasCost ? shortageQty * item.standardCost : null;
          lostSalesAmount = shortageAmount;
          endingAmount = item.hasCost ? Math.max(0, endingQty) * item.standardCost : null;
          inventoryDays = salesQty > 0 && endingQty >= 0 ? (endingQty / salesQty) * 30 : null;
          if (shortageQty > 0) status = STATUS.SHORTAGE;
          else if (endingQty < salesQty) status = STATUS.WARN;
          else status = STATUS.OK;
        }

        return { month, salesQty, supplyQty, rtfQty, rtfAmount, endingQty, endingAmount, shortageQty, shortageAmount, lostSalesAmount, inventoryDays, salesAmount, status, reason, noSalesPlan };
      });
      return item;
    }).filter((item) => item.typeGroup === "상품" || item.typeGroup === "완제품");
  }

  function sumNullable(values) {
    let total = 0;
    let hasValue = false;
    values.forEach((value) => {
      if (Number.isFinite(value)) {
        total += value;
        hasValue = true;
      }
    });
    return hasValue ? total : null;
  }

  function aggregateMonth(items, monthIndex) {
    const monthRows = items.map((item) => item.monthlyStatus[monthIndex]);
    const status = monthRows.reduce((worst, row) => higherSeverity(worst, row.status), STATUS.OK);
    const salesQty = sumNullable(monthRows.map((row) => row.salesQty));
    const rtfQty = sumNullable(monthRows.map((row) => row.rtfQty));
    const shortageQty = sumNullable(monthRows.map((row) => row.shortageQty));
    const salesAmount = sumNullable(monthRows.map((row) => row.salesAmount));
    const rtfAmount = sumNullable(monthRows.map((row) => row.rtfAmount));
    const shortageAmount = sumNullable(monthRows.map((row) => row.shortageAmount));
    const lostSalesAmount = sumNullable(monthRows.map((row) => row.lostSalesAmount));
    const endingAmount = sumNullable(monthRows.map((row) => row.endingAmount));
    const endingQty = sumNullable(monthRows.map((row) => row.endingQty));
    const hasNoPlan = monthRows.every((row) => row.noSalesPlan);
    return {
      status: hasNoPlan ? STATUS.UNKNOWN : status,
      salesQty,
      rtfQty,
      shortageQty,
      salesAmount,
      rtfAmount,
      shortageAmount,
      lostSalesAmount,
      endingAmount,
      endingQty,
      inventoryDays: null,
      hasNoPlan,
    };
  }

  function makeNode(id, parentId, level, kind, label, items, cols = {}) {
    return { id, parentId, level, kind, label, items, cols };
  }

  function sortKo(arr) { return [...arr].sort((a, b) => String(a).localeCompare(String(b), "ko-KR")); }
  function uniq(items, key) { return sortKo([...new Set(items.map((i) => i[key]))]); }

  function buildHierarchy(items, mode) {
    const nodes = [];
    if (mode === "business") {
      uniq(items, "businessUnit").forEach((bu) => {
        const buItems = items.filter((i) => i.businessUnit === bu);
        const buId = `b|${bu}`;
        nodes.push(makeNode(buId, "", 0, "group", `${bu} 계`, buItems, { div: "사업부", bu, plant: "", type: "", group: "", code: "" }));
        uniq(buItems, "typeGroup").forEach((type) => {
          const typeItems = buItems.filter((i) => i.typeGroup === type);
          const typeId = `${buId}|${type}`;
          nodes.push(makeNode(typeId, buId, 1, "group", `${type} 계`, typeItems, { div: "유형", bu, plant: "", type, group: "", code: "" }));
          uniq(typeItems, "itemGroup").forEach((group) => {
            const groupItems = typeItems.filter((i) => i.itemGroup === group);
            const groupId = `${typeId}|${group}`;
            nodes.push(makeNode(groupId, typeId, 2, "itemGroup", `${group} 계`, groupItems, { div: "품목군", bu, plant: "", type, group, code: "" }));
            groupItems.forEach((item) => {
              nodes.push(makeNode(`${groupId}|${item.itemCode}`, groupId, 3, "item", item.itemName, [item],
                { div: "자재", bu: item.businessUnit, plant: item.plant, type: item.typeGroup, group: item.itemGroup, code: item.itemCode }));
            });
          });
        });
      });
    } else if (mode === "plant") {
      uniq(items, "plant").forEach((plant) => {
        const plantItems = items.filter((i) => i.plant === plant);
        const plantId = `p|${plant}`;
        nodes.push(makeNode(plantId, "", 0, "group", `${plant} 계`, plantItems, { div: "플랜트", bu: "", plant, type: "", group: "", code: "" }));
        uniq(plantItems, "typeGroup").forEach((type) => {
          const typeItems = plantItems.filter((i) => i.typeGroup === type);
          const typeId = `${plantId}|${type}`;
          nodes.push(makeNode(typeId, plantId, 1, "group", `${type} 계`, typeItems, { div: "유형", bu: "", plant, type, group: "", code: "" }));
          uniq(typeItems, "itemGroup").forEach((group) => {
            const groupItems = typeItems.filter((i) => i.itemGroup === group);
            const groupId = `${typeId}|${group}`;
            nodes.push(makeNode(groupId, typeId, 2, "itemGroup", `${group} 계`, groupItems, { div: "품목군", bu: "", plant, type, group, code: "" }));
            groupItems.forEach((item) => {
              nodes.push(makeNode(`${groupId}|${item.itemCode}`, groupId, 3, "item", item.itemName, [item],
                { div: "자재", bu: item.businessUnit, plant: item.plant, type: item.typeGroup, group: item.itemGroup, code: item.itemCode }));
            });
          });
        });
      });
    } else {
      uniq(items, "typeGroup").forEach((type) => {
        const typeItems = items.filter((i) => i.typeGroup === type);
        const typeId = `t|${type}`;
        nodes.push(makeNode(typeId, "", 0, "group", `${type} 계`, typeItems, { div: "유형", bu: "", plant: "", type, group: "", code: "" }));
        uniq(typeItems, "businessUnit").forEach((bu) => {
          const buItems = typeItems.filter((i) => i.businessUnit === bu);
          const buId = `${typeId}|${bu}`;
          nodes.push(makeNode(buId, typeId, 1, "group", `${bu} 계`, buItems, { div: "사업부", bu, plant: "", type, group: "", code: "" }));
          uniq(buItems, "plant").forEach((plant) => {
            const plantItems = buItems.filter((i) => i.plant === plant);
            const plantId = `${buId}|${plant}`;
            nodes.push(makeNode(plantId, buId, 2, "group", `${plant} 계`, plantItems, { div: "플랜트", bu, plant, type, group: "", code: "" }));
            uniq(plantItems, "itemGroup").forEach((group) => {
              const groupItems = plantItems.filter((i) => i.itemGroup === group);
              const groupId = `${plantId}|${group}`;
              nodes.push(makeNode(groupId, plantId, 3, "itemGroup", `${group} 계`, groupItems, { div: "품목군", bu, plant, type, group, code: "" }));
              groupItems.forEach((item) => {
                nodes.push(makeNode(`${groupId}|${item.itemCode}`, groupId, 4, "item", item.itemName, [item],
                  { div: "자재", bu: item.businessUnit, plant: item.plant, type: item.typeGroup, group: item.itemGroup, code: item.itemCode }));
              });
            });
          });
        });
      });
    }
    return nodes;
  }

  function statusClass(status) {
    return { 대응가능: "ok", 주의: "warn", 공급부족: "shortage", 판단불가: "unknown" }[status] ?? "unknown";
  }

  function renderStatus(status) {
    return `<span class="rtf-sbadge ${statusClass(status)}">${escapeHtml(status)}</span>`;
  }

  function getVisibleMonthColumns() {
    return state.rtfExpanded ? MONTH_COLUMNS : MONTH_COLUMNS.filter((metric) => !EXTRA_COLUMNS.includes(metric));
  }

  function formatQtyCell(value, noPlan = false) {
    if (noPlan) return NO_PLAN;
    return Number.isFinite(value) ? formatNumber(value) : NEED_DATA;
  }

  function formatDisplayQtyMoney(qtyValue, amountValue, noPlan = false) {
    if (noPlan) return NO_PLAN;
    if (state.rtfDisplayMode === "amount") return Number.isFinite(amountValue) ? formatMoney(amountValue) : NEED_DATA;
    return Number.isFinite(qtyValue) ? formatNumber(qtyValue) : NEED_DATA;
  }

  function formatEnding(row) {
    if (state.rtfDisplayMode === "amount") return Number.isFinite(row.endingAmount) ? formatMoney(row.endingAmount) : NEED_DATA;
    return Number.isFinite(row.endingQty) ? formatNumber(row.endingQty) : NEED_DATA;
  }

  function formatBaseForNode(node) {
    const qty = sumNullable(node.items.map((item) => item.baseQty));
    if (state.rtfDisplayMode === "qty") return Number.isFinite(qty) ? formatNumber(qty, 1) : NEED_DATA;
    if (node.items.some((item) => !item.hasCost || !Number.isFinite(item.baseQty))) return NEED_DATA;
    const amount = sumNullable(node.items.map((item) => item.baseQty * item.standardCost));
    return Number.isFinite(amount) ? formatMoney(amount) : NEED_DATA;
  }

  function renderMetricCell(row, metric, metricIndex, compressed) {
    const mb = metricIndex === 0 ? " rtf-month-start" : "";
    const noPlan = row.hasNoPlan || row.noSalesPlan;
    if (metric === "판매계획") {
      const raw = formatDisplayQtyMoney(row.salesQty, row.salesAmount, noPlan);
      const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
      return `<td class="rtf-metric-cell${mb}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
    }
    if (metric === "RTF") {
      const raw = formatDisplayQtyMoney(row.rtfQty, row.rtfAmount, noPlan);
      const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
      return `<td class="rtf-metric-cell rtf-rtf-cell rtf-status-text ${statusClass(row.status)}${mb}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
    }
    if (metric === "Shortage") {
      const isAmt = state.rtfDisplayMode === "amount";
      const hasShortage = isAmt ? (Number.isFinite(row.shortageAmount) && row.shortageAmount > 0) : (Number.isFinite(row.shortageQty) && row.shortageQty > 0);
      const raw = hasShortage ? (isAmt ? formatMoney(row.shortageAmount) : formatNumber(row.shortageQty)) : "-";
      return `<td class="rtf-metric-cell rtf-shortage-cell ${hasShortage ? `rtf-status-text shortage` : "rtf-neutral-text"}${mb}">${escapeHtml(raw)}</td>`;
    }
    if (metric === "매출") return `<td class="rtf-metric-cell rtf-muted-metric${mb}">${escapeHtml(Number.isFinite(row.salesAmount) ? formatMoney(row.salesAmount) : NEED_DATA)}</td>`;
    if (metric === "매출차질예상") {
      const val = Number.isFinite(row.lostSalesAmount) && row.lostSalesAmount > 0 ? formatMoney(row.lostSalesAmount) : "-";
      return `<td class="rtf-metric-cell ${val !== "-" ? "rtf-status-text shortage" : "rtf-neutral-text"}${mb}">${escapeHtml(val)}</td>`;
    }
    if (metric === "기말재고") return `<td class="rtf-metric-cell rtf-muted-metric${mb}">${escapeHtml(formatEnding(row))}</td>`;
    if (metric === "재고일수") return `<td class="rtf-metric-cell rtf-muted-metric${mb}">${escapeHtml(Number.isFinite(row.inventoryDays) ? `${formatNumber(row.inventoryDays, 1)}일` : "판단불가")}</td>`;
    return `<td class="rtf-metric-cell${mb}">-</td>`;
  }

  function renderHierarchyRow(node) {
    const isItem = node.kind === "item";
    const isItemGroup = node.kind === "itemGroup";
    const item = isItem ? node.items[0] : null;
    const { div, bu, plant, type, group, code } = node.cols;
    const baseQty = formatBaseForNode(node);
    const compressed = !state.rtfExpanded;
    const isHidden = compressed ? node.level > 0 : (isItem && !state.expandedItemGroups.has(node.parentId));
    const monthColumns = getVisibleMonthColumns();
    const cells = getRtfMonths().map((_, mIdx) => {
      const monthRow = isItem ? item.monthlyStatus[mIdx] : aggregateMonth(node.items, mIdx);
      return monthColumns.map((metric, colIdx) => renderMetricCell(monthRow, metric, colIdx, compressed)).join("");
    }).join("");
    const toggleBtn = isItemGroup && state.rtfExpanded
      ? `<button type="button" class="rtf-item-toggle" data-node-id="${escapeHtml(node.id)}">${state.expandedItemGroups.has(node.id) ? "-" : "+"}</button>`
      : "";
    const rowClass = `rtf-h-row level-${node.level} ${isItem ? "is-item" : "is-group"}`;
    return `<tr class="${rowClass}" data-node-id="${escapeHtml(node.id)}" data-parent-id="${escapeHtml(node.parentId)}"${isHidden ? " hidden" : ""}>
      <td class="rtf-sticky rtf-col-div">${toggleBtn}<span class="rtf-div-label">${escapeHtml(div)}</span></td>
      <td class="rtf-sticky rtf-col-bu">${escapeHtml(bu)}</td>
      <td class="rtf-sticky rtf-col-plant">${escapeHtml(plant)}</td>
      <td class="rtf-sticky rtf-col-type">${escapeHtml(type)}</td>
      <td class="rtf-sticky rtf-col-group">${escapeHtml(group)}</td>
      <td class="rtf-sticky rtf-col-code">${escapeHtml(code)}</td>
      <td class="rtf-sticky rtf-col-name" title="${escapeHtml(node.label)}">${escapeHtml(node.label)}</td>
      <td class="rtf-sticky rtf-col-base">${escapeHtml(baseQty)}</td>
      ${cells}
    </tr>`;
  }

  function renderMatrixSection(title, mode, items, sectionId) {
    const months = getRtfMonths();
    const nodes = buildHierarchy(items, mode);
    const monthColumns = getVisibleMonthColumns();
    const monthHeader = months.map((month) => `<th class="rtf-month-head" colspan="${monthColumns.length}">${escapeHtml(monthLabel(month))}</th>`).join("");
    const metricHeader = months.map(() => monthColumns.map((metric, idx) =>
      `<th class="rtf-sub-head${["RTF", "Shortage"].includes(metric) ? " rtf-key-sub" : ""}${idx === 0 ? " rtf-month-start" : ""}">${escapeHtml(metric)}</th>`
    ).join("")).join("");
    const COL_W = { "판매계획": 75, "RTF": 75, "Shortage": 80, "매출": 75, "매출차질예상": 90, "기말재고": 75, "재고일수": 75 };
    const metricCols = months.flatMap(() => monthColumns.map((m) => `<col style="width:${COL_W[m] || 75}px;min-width:${COL_W[m] || 75}px;">`)).join("");
    const colCount = 8 + months.length * monthColumns.length;
    const body = nodes.length ? nodes.map((node) => renderHierarchyRow(node)).join("") : `<tr><td colspan="${colCount}" class="rtf-empty">데이터 없음</td></tr>`;
    return `<section id="${escapeHtml(sectionId)}" class="rtf-card rtf-block rtf-matrix-block">
      <div class="rtf-sec-title"><span>${escapeHtml(title)}</span></div>
      <div class="rtf-h-scroll">
        <table class="rtf-h-matrix-table ${state.rtfExpanded ? "is-expanded" : "is-collapsed"}">
          <colgroup>
            <col class="rtf-col-div"><col class="rtf-col-bu"><col class="rtf-col-plant"><col class="rtf-col-type">
            <col class="rtf-col-group"><col class="rtf-col-code"><col class="rtf-col-name"><col class="rtf-col-base">
            ${metricCols}
          </colgroup>
          <thead>
            <tr>
              <th class="rtf-sticky rtf-col-div" rowspan="2">구분</th>
              <th class="rtf-sticky rtf-col-bu" rowspan="2">사업부</th>
              <th class="rtf-sticky rtf-col-plant" rowspan="2">플랜트</th>
              <th class="rtf-sticky rtf-col-type" rowspan="2">유형</th>
              <th class="rtf-sticky rtf-col-group" rowspan="2">품목군</th>
              <th class="rtf-sticky rtf-col-code" rowspan="2">자재코드</th>
              <th class="rtf-sticky rtf-col-name" rowspan="2">자재명</th>
              <th class="rtf-sticky rtf-col-base" rowspan="2">기초재고</th>
              ${monthHeader}
            </tr>
            <tr>${metricHeader}</tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>`;
  }

  function renderRtf() {
    const items = computeRtfItems();
    if (!state.mappedData.plan_monthly.length) {
      return `<div class="rtf-screen"><section class="rtf-card rtf-top"><h2 class="rtf-title">RTF 월별 대응 현황</h2><div class="rtf-nodata">데이터 연결 필요<br>데이터점검 화면에서 RAW 파일을 선택해 주세요.</div></section></div>`;
    }
    const months = getRtfMonths();
    return `<div class="rtf-screen rtf-excel-layout">
      <section class="rtf-card rtf-top">
        <h2 class="rtf-title">RTF 월별 대응 현황</h2>
        <div class="rtf-meta">기준월: ${escapeHtml(months[0])} | 대상기간: ${escapeHtml(months.map(monthLabel).join(" ~ "))} | 표시: ${state.rtfDisplayMode === "qty" ? "수량" : "금액"}</div>
        <div class="rtf-insight">RTF 컬럼은 판매계획 대비 공급 가능 수량(또는 금액)입니다. Shortage 발생 시 Shortage 컬럼에 붉은색으로 표시됩니다.</div>
      </section>
      <div class="rtf-toolbar">
        <div class="rtf-mode-group" aria-label="표시 단위">
          <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "qty" ? "active" : ""}" data-rtf-mode="qty">수량</button>
          <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "amount" ? "active" : ""}" data-rtf-mode="amount">금액</button>
        </div>
        <button type="button" id="rtfExpandToggle" class="rtf-extra-toggle ${state.rtfExpanded ? "active" : ""}">${state.rtfExpanded ? "축소" : "확대"}</button>
        <span class="rtf-toolbar-hint">${state.rtfExpanded ? "품목군까지 표시 · 품목군 행의 + 버튼으로 자재 상세 확인" : "계 행 + 판매계획/RTF/Shortage 표시"}</span>
      </div>
      ${renderMatrixSection("사업부별", "business", items, "rtfBusinessMatrix")}
      ${renderMatrixSection("플랜트별", "plant", items, "rtfPlantMatrix")}
      ${renderMatrixSection("유형별", "type", items, "rtfTypeMatrix")}
    </div>`;
  }

  function renderPlaceholder(title) {
    return `<section class="section-band"><div class="section-header"><h2>${escapeHtml(title)}</h2><p>현재 로컬 파일 모드에서는 데이터점검과 RTF 화면을 중심으로 사용합니다.</p></div></section>`;
  }

  function bindDataCheck() {
    document.querySelector("#rawUpload")?.addEventListener("change", (event) => processFiles(Array.from(event.target.files ?? [])));
  }

  function bindRtf() {
    document.querySelector("#rtfExpandToggle")?.addEventListener("click", () => {
      state.rtfExpanded = !state.rtfExpanded;
      state.expandedItemGroups.clear();
      render("rtf");
    });
    document.querySelectorAll("[data-rtf-mode]").forEach((btn) => btn.addEventListener("click", () => {
      if (state.rtfDisplayMode === btn.dataset.rtfMode) return;
      state.rtfDisplayMode = btn.dataset.rtfMode;
      render("rtf");
    }));
    document.querySelectorAll(".rtf-item-toggle").forEach((btn) => btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nodeId = btn.dataset.nodeId;
      const wasExpanded = state.expandedItemGroups.has(nodeId);
      if (wasExpanded) {
        state.expandedItemGroups.delete(nodeId);
        btn.textContent = "+";
      } else {
        state.expandedItemGroups.add(nodeId);
        btn.textContent = "-";
      }
      document.querySelectorAll(`tr[data-parent-id="${CSS.escape(nodeId)}"]`).forEach((row) => { row.hidden = wasExpanded; });
    }));
  }

  function render(menuId) {
    state.currentMenuId = menuId;
    const menu = menus.find(([id]) => id === menuId) || menus[0];
    screenTitle.textContent = menu[1];
    renderTabs(menu[0]);
    const screens = {
      meeting: renderMeeting,
      "data-check": renderDataCheck,
      rtf: renderRtf,
      summary: () => renderPlaceholder("종합현황"),
      constraint: () => renderPlaceholder("공급제한 원인"),
      "inventory-variance": () => renderPlaceholder("재고금액 변동분석"),
      diagnosis: () => renderPlaceholder("수급 진단"),
      adjustment: () => renderPlaceholder("조정안 입력"),
      impact: () => renderPlaceholder("조정 후 영향"),
      minutes: () => renderPlaceholder("회의록"),
    };
    screenRoot.innerHTML = (screens[menu[0]] || renderMeeting)();
    if (menu[0] === "data-check") bindDataCheck();
    if (menu[0] === "rtf") bindRtf();
  }

  render("meeting");
})();
