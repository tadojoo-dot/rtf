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
    rtfExtraOpen: false,
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

  function makeNode(id, parentId, level, kind, label, items, meta = {}) {
    return { id, parentId, level, kind, label, items, meta, expanded: false };
  }

  function buildHierarchy(items, mode) {
    const nodes = [];
    const firstKey = mode === "business" ? "businessUnit" : "plant";
    const topValues = [...new Set(items.map((item) => item[firstKey]))].sort((a, b) => String(a).localeCompare(String(b), "ko-KR"));
    topValues.forEach((topValue) => {
      const topItems = items.filter((item) => item[firstKey] === topValue);
      const topId = `${mode}|${topValue}`;
      nodes.push(makeNode(topId, "", 0, mode, topValue, topItems));
      const typeValues = [...new Set(topItems.map((item) => item.typeGroup))].sort();
      typeValues.forEach((type) => {
        const typeItems = topItems.filter((item) => item.typeGroup === type);
        const typeId = `${topId}|${type}`;
        nodes.push(makeNode(typeId, topId, 1, "type", `${type} 계`, typeItems, { type }));
        const groupValues = [...new Set(typeItems.map((item) => item.itemGroup))].sort((a, b) => String(a).localeCompare(String(b), "ko-KR"));
        groupValues.forEach((group) => {
          const groupItems = typeItems.filter((item) => item.itemGroup === group);
          const groupId = `${typeId}|${group}`;
          nodes.push(makeNode(groupId, typeId, 2, "itemGroup", `${group} 계`, groupItems, { type, itemGroup: group }));
          groupItems.forEach((item) => {
            nodes.push(makeNode(`${groupId}|${item.itemCode}`, groupId, 3, "item", item.itemName, [item], { type, itemGroup: group, item }));
          });
        });
      });
    });
    return nodes;
  }

  function statusClass(status) {
    return { 대응가능: "ok", 주의: "warn", 공급부족: "shortage", 판단불가: "unknown" }[status] ?? "unknown";
  }

  function renderStatus(status) {
    return `<span class="rtf-sbadge ${statusClass(status)}">${escapeHtml(status)}</span>`;
  }

  function getVisibleMonthColumns() {
    return state.rtfExtraOpen ? MONTH_COLUMNS : MONTH_COLUMNS.filter((metric) => !EXTRA_COLUMNS.includes(metric));
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

  function renderMetricCell(row, metric, muted = false, metricIndex = 0) {
    const cls = `${muted ? " rtf-muted-metric" : ""}${metricIndex === 0 ? " rtf-month-start" : ""}`;
    if (metric === "판매계획") return `<td class="rtf-metric-cell${cls}">${escapeHtml(formatDisplayQtyMoney(row.salesQty, row.salesAmount, row.hasNoPlan || row.noSalesPlan))}</td>`;
    if (metric === "RTF") return `<td class="rtf-metric-cell rtf-rtf-cell rtf-status-text ${statusClass(row.status)}${cls}">${escapeHtml(formatDisplayQtyMoney(row.rtfQty, row.rtfAmount, row.hasNoPlan || row.noSalesPlan))}</td>`;
    if (metric === "Shortage") {
      const hasShortage = state.rtfDisplayMode === "amount"
        ? Number.isFinite(row.shortageAmount) && row.shortageAmount > 0
        : Number.isFinite(row.shortageQty) && row.shortageQty > 0;
      const shortageText = state.rtfDisplayMode === "amount"
        ? (hasShortage ? formatMoney(row.shortageAmount) : "-")
        : (hasShortage ? formatNumber(row.shortageQty) : "-");
      return `<td class="rtf-metric-cell rtf-shortage-cell ${hasShortage ? `rtf-status-text ${statusClass(row.status)}` : "rtf-neutral-text"}${cls}">${escapeHtml(shortageText)}</td>`;
    }
    if (metric === "매출") return `<td class="rtf-metric-cell${cls}">${escapeHtml(Number.isFinite(row.salesAmount) ? formatMoney(row.salesAmount) : NEED_DATA)}</td>`;
    if (metric === "매출차질예상") return `<td class="rtf-metric-cell${cls}">${escapeHtml(Number.isFinite(row.lostSalesAmount) && row.lostSalesAmount > 0 ? formatMoney(row.lostSalesAmount) : "-")}</td>`;
    if (metric === "기말재고") return `<td class="rtf-metric-cell${cls}">${escapeHtml(formatEnding(row))}</td>`;
    if (metric === "재고일수") return `<td class="rtf-metric-cell${cls}">${escapeHtml(Number.isFinite(row.inventoryDays) ? `${formatNumber(row.inventoryDays, 1)}일` : "판단불가")}</td>`;
    return `<td class="rtf-metric-cell${cls}">-</td>`;
  }

  function actionForNode(node) {
    const worst = getRtfMonths().map((_, index) => aggregateMonth(node.items, index).status).reduce((a, b) => higherSeverity(a, b), STATUS.OK);
    if (node.items.some(hasMasterGap)) return NEED_MASTER;
    if (node.items.some((item) => !item.hasInventory)) return NEED_DATA;
    if (worst === STATUS.SHORTAGE) return "공급계획 보강 또는 생산 Pull-in 검토";
    if (worst === STATUS.WARN) return "Shortage 원인 확인";
    if (worst === STATUS.UNKNOWN) return "기준정보 또는 판매계획 확인";
    return "모니터링";
  }

  function renderHierarchyRow(node, mode) {
    const isItem = node.kind === "item";
    const hasChildren = !isItem;
    const item = node.meta.item;
    const firstCol = node.level === 0 ? node.label : "";
    const typeCol = isItem ? item.typeGroup : node.kind === "type" ? node.label : node.meta.type || "";
    const groupCol = isItem ? item.itemGroup : node.kind === "itemGroup" ? node.label : node.meta.itemGroup || "";
    const codeCol = isItem ? item.itemCode : "";
    const nameCol = isItem ? item.itemName : node.level === 0 ? `${node.label} 계` : node.label;
    const baseQty = formatBaseForNode(node);
    const rowClass = `rtf-h-row level-${node.level} ${isItem ? "is-item" : "is-group"}`;
    const monthColumns = getVisibleMonthColumns();
    const cells = getRtfMonths().map((month, index) => {
      const monthRow = isItem ? item.monthlyStatus[index] : aggregateMonth(node.items, index);
      return monthColumns.map((metric, metricIndex) => renderMetricCell(monthRow, metric, !["RTF", "Shortage"].includes(metric), metricIndex)).join("");
    }).join("");

    return `<tr class="${rowClass}" data-node-id="${escapeHtml(node.id)}" data-parent-id="${escapeHtml(node.parentId)}" data-level="${node.level}" ${node.parentId ? "hidden" : ""}>
      <td class="rtf-sticky rtf-tree-cell">${hasChildren ? `<button type="button" class="rtf-tree-toggle" data-node-id="${escapeHtml(node.id)}">확대</button>` : ""}<span class="rtf-indent rtf-indent-${node.level}"></span>${escapeHtml(firstCol)}</td>
      <td class="rtf-sticky rtf-left-type">${escapeHtml(typeCol)}</td>
      <td class="rtf-sticky rtf-left-group">${escapeHtml(groupCol)}</td>
      <td class="rtf-sticky rtf-left-code">${escapeHtml(codeCol)}</td>
      <td class="rtf-sticky rtf-left-name" title="${escapeHtml(nameCol)}">${escapeHtml(nameCol)}</td>
      <td class="rtf-sticky rtf-left-base">${escapeHtml(baseQty)}</td>
      ${cells}
      <td class="rtf-action-cell">${escapeHtml(actionForNode(node))}</td>
    </tr>`;
  }

  function renderRtfGuide(items) {
    const months = getRtfMonths();
    const monthStatuses = months.map((_, index) => aggregateMonth(items, index).status);
    const shortageMonths = monthStatuses.filter((status) => status === STATUS.SHORTAGE).length;
    const warnMonths = monthStatuses.filter((status) => status === STATUS.WARN).length;
    const worstStatus = monthStatuses.reduce((a, b) => higherSeverity(a, b), STATUS.OK);
    const viewRows = [
      ["사업부별", "사업부 > 유형 > 품목군 > 자재", `${formatNumber(items.length)}개 자재`, "사업부 책임 단위로 부족 월을 먼저 확인", "rtfBusinessMatrix"],
      ["플랜트별", "플랜트 > 유형 > 품목군 > 자재", `${months.length}개월`, "생산/공급 실행 단위로 Shortage 원인 확인", "rtfPlantMatrix"],
      ["자재상세", "선택 자재 월별 계산", state.rtfDisplayMode === "qty" ? "수량 기준" : "금액 기준", "행 클릭 후 BOM/기말재고/확인사항 확인", "rtfDetailPanel"],
    ];
    return `<section class="rtf-card rtf-nav-card" aria-label="RTF 화면 안내">
      <div class="rtf-nav-summary">
        <div>
          <h3>RTF 확인 순서</h3>
          <p>참고 리포트처럼 핵심 기준을 표로 먼저 정리했습니다. 아래 행을 누르면 해당 영역으로 이동합니다.</p>
        </div>
        <div class="rtf-nav-kpis">
          <span><b>${escapeHtml(monthLabel(months[0]))}</b> 기준월</span>
          <span><b>${escapeHtml(String(shortageMonths))}</b> 부족월</span>
          <span><b>${escapeHtml(String(warnMonths))}</b> 주의월</span>
          <span>${renderStatus(worstStatus)}</span>
        </div>
      </div>
      <div class="rtf-nav-table-wrap">
        <table class="rtf-nav-table">
          <thead><tr><th>화면</th><th>구조</th><th>현재 기준</th><th>볼 것</th><th>이동</th></tr></thead>
          <tbody>${viewRows.map(([name, structure, basis, focus, target]) => `<tr>
            <td class="rtf-nav-name">${escapeHtml(name)}</td>
            <td>${escapeHtml(structure)}</td>
            <td>${escapeHtml(basis)}</td>
            <td class="rtf-nav-focus">${escapeHtml(focus)}</td>
            <td><button type="button" class="rtf-nav-jump" data-rtf-jump="${escapeHtml(target)}">보기</button></td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="rtf-legend-row">
        <span>${renderStatus(STATUS.OK)} 판매계획 대응 가능</span>
        <span>${renderStatus(STATUS.WARN)} 기말재고가 판매계획보다 낮음</span>
        <span>${renderStatus(STATUS.SHORTAGE)} 공급 부족 발생</span>
        <span>${renderStatus(STATUS.UNKNOWN)} 기준정보 또는 계획 확인 필요</span>
      </div>
    </section>`;
  }

  function renderMatrixSection(title, mode, items, sectionId) {
    const months = getRtfMonths();
    const nodes = buildHierarchy(items, mode);
    const monthColumns = getVisibleMonthColumns();
    const firstHeader = mode === "business" ? "사업부" : mode === "plant" ? "플랜트" : "유형";
    const monthHeader = months.map((month) => `<th class="rtf-month-head" colspan="${monthColumns.length}">${monthLabel(month)}</th>`).join("");
    const metricHeader = months.map(() => monthColumns.map((metric, index) => `<th class="rtf-sub-head ${["RTF", "Shortage"].includes(metric) ? "rtf-key-sub" : ""}${index === 0 ? " rtf-month-start" : ""}">${escapeHtml(metric)}</th>`).join("")).join("");
    const body = nodes.length ? nodes.map((node) => renderHierarchyRow(node, mode)).join("") : `<tr><td colspan="${6 + months.length * monthColumns.length + 1}" class="rtf-empty">데이터 없음</td></tr>`;
    return `<section id="${escapeHtml(sectionId)}" class="rtf-card rtf-block rtf-matrix-block">
      <div class="rtf-sec-title"><span>${escapeHtml(title)}</span><span class="rtf-unit">상위 그룹 클릭 시 유형 > 품목군 > 자재코드/자재명 순서로 펼침</span></div>
      <div class="rtf-h-scroll">
        <table class="rtf-h-matrix-table ${state.rtfExtraOpen ? "is-expanded" : "is-collapsed"}">
          <thead>
            <tr>
              <th class="rtf-sticky rtf-left-first" rowspan="2">${escapeHtml(firstHeader)}</th>
              <th class="rtf-sticky rtf-left-type" rowspan="2">유형</th>
              <th class="rtf-sticky rtf-left-group" rowspan="2">품목군</th>
              <th class="rtf-sticky rtf-left-code" rowspan="2">자재코드</th>
              <th class="rtf-sticky rtf-left-name" rowspan="2">자재명</th>
              <th class="rtf-sticky rtf-left-base" rowspan="2">기초재고</th>
              ${monthHeader}
              <th class="rtf-action-head" rowspan="2">확인사항</th>
            </tr>
            <tr>${metricHeader}</tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>`;
  }

  function renderDetailEmpty() {
    return `<div class="rtf-detail-empty">자재 상세행을 선택하면 월별 계산과 확인 필요사항을 표시합니다.</div>`;
  }

  function bomState(item) {
    if (item.typeGroup !== "완제품") return "확인 필요";
    const rows = state.mappedData.bom_components.filter((row) => cleanOptional(row.rootItemCode) === item.itemCode);
    if (rows.length > 0) return "BOM 매칭";
    if (state.mappedData.bom_components.length === 0) return "구성품 데이터 연결 필요";
    return "BOM 미매칭";
  }

  function renderItemDetail(item) {
    const worst = item.monthlyStatus.reduce((status, month) => higherSeverity(status, month.status), STATUS.OK);
    const monthRows = item.monthlyStatus.map((m) => `<tr>
      <td class="${m.month === getRtfMonths()[0] ? "rtf-base-col" : ""}">${monthLabel(m.month)}</td>
      <td>${escapeHtml(formatDisplayQtyMoney(m.salesQty, m.salesAmount, m.noSalesPlan))}</td>
      <td>${escapeHtml(formatDisplayQtyMoney(m.rtfQty, m.rtfAmount, m.noSalesPlan))}</td>
      <td>${escapeHtml(state.rtfDisplayMode === "amount" ? (Number.isFinite(m.shortageAmount) && m.shortageAmount > 0 ? formatMoney(m.shortageAmount) : "-") : (Number.isFinite(m.shortageQty) && m.shortageQty > 0 ? formatNumber(m.shortageQty) : "-"))}</td>
      <td>${escapeHtml(Number.isFinite(m.salesAmount) ? formatMoney(m.salesAmount) : NEED_DATA)}</td>
      <td>${escapeHtml(Number.isFinite(m.lostSalesAmount) && m.lostSalesAmount > 0 ? formatMoney(m.lostSalesAmount) : "-")}</td>
      <td>${escapeHtml(formatEnding(m))}</td>
      <td>${escapeHtml(Number.isFinite(m.inventoryDays) ? `${formatNumber(m.inventoryDays, 1)}일` : "판단불가")}</td>
      <td class="rtf-td-left">${escapeHtml(m.reason || actionForNode({ items: [item] }))}</td>
    </tr>`).join("");
    return `<div class="rtf-detail-grid">
      <section class="rtf-dtl-section"><div class="rtf-dtl-stitle">선택 자재 정보</div><table class="rtf-dtl-table rtf-dtl-info"><tbody><tr><th>자재코드</th><td>${escapeHtml(item.itemCode)}</td><th>자재명</th><td>${escapeHtml(item.itemName)}</td></tr><tr><th>유형</th><td>${escapeHtml(item.typeGroup)}</td><th>대표 상태</th><td>${renderStatus(worst)}</td></tr></tbody></table></section>
      <section class="rtf-dtl-section"><div class="rtf-dtl-stitle">월별 계산</div><table class="rtf-dtl-table"><thead><tr><th>월</th><th>판매계획</th><th>RTF</th><th>Shortage</th><th>매출</th><th>매출차질예상</th><th>기말재고</th><th>재고일수</th><th>확인 필요사항</th></tr></thead><tbody>${monthRows}</tbody></table></section>
      <section class="rtf-dtl-section"><div class="rtf-dtl-stitle">BOM/구성품 점검</div><p class="rtf-dtl-note">${escapeHtml(bomState(item))}</p></section>
    </div>`;
  }

  function renderRtf() {
    const items = computeRtfItems();
    if (!state.mappedData.plan_monthly.length) {
      return `<div class="rtf-screen"><section class="rtf-card rtf-top"><h2 class="rtf-title">▣ RTF 월별 대응 현황</h2><div class="rtf-nodata">데이터 연결 필요<br>데이터점검 화면에서 RAW 파일을 선택해 주세요.</div></section></div>`;
    }
    return `<div class="rtf-screen rtf-excel-layout">
      <section class="rtf-card rtf-top"><h2 class="rtf-title">▣ RTF 월별 대응 현황</h2><div class="rtf-meta">기준월: ${getRtfMonths()[0]} | 대상기간: ${getRtfMonths().map(monthLabel).join("~")} | RTF_SAMPLE 예상 SHORTAGE 구조 반영</div><div class="rtf-insight">사업부별/플랜트별 계층형 월별 매트릭스입니다. RTF 컬럼은 상태명이 아니라 판매계획 대비 공급 가능한 수량 또는 금액을 표시합니다.</div></section>
      ${renderRtfGuide(items)}
      <div class="rtf-toolbar">
        <div class="rtf-mode-group" aria-label="표시 단위">
          <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "qty" ? "active" : ""}" data-rtf-mode="qty">수량</button>
          <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "amount" ? "active" : ""}" data-rtf-mode="amount">금액</button>
        </div>
        <button type="button" id="rtfExtraToggle" class="rtf-extra-toggle ${state.rtfExtraOpen ? "active" : ""}">${state.rtfExtraOpen ? "축소" : "확대"}</button>
        <span>확대 시 매출, 매출차질예상, 기말재고, 재고일수가 함께 표시됩니다.</span>
      </div>
      ${renderMatrixSection("사업부별", "business", items, "rtfBusinessMatrix")}
      ${renderMatrixSection("플랜트별", "plant", items, "rtfPlantMatrix")}
      <section id="rtfDetailPanel" class="rtf-card rtf-detail-panel"><div class="rtf-detail-hd"><span id="rtfDetailTitle" class="rtf-detail-hdtitle">자재 상세</span><button id="rtfDetailClose" class="rtf-detail-close" type="button">×</button></div><div id="rtfDetailBody" class="rtf-detail-body">${renderDetailEmpty()}</div></section>
    </div>`;
  }

  function renderPlaceholder(title) {
    return `<section class="section-band"><div class="section-header"><h2>${escapeHtml(title)}</h2><p>현재 로컬 파일 모드에서는 데이터점검과 RTF 화면을 중심으로 사용합니다.</p></div></section>`;
  }

  function bindDataCheck() {
    document.querySelector("#rawUpload")?.addEventListener("change", (event) => processFiles(Array.from(event.target.files ?? [])));
  }

  function setChildrenVisible(nodeId, visible) {
    document.querySelectorAll(`tr[data-parent-id="${CSS.escape(nodeId)}"]`).forEach((row) => {
      row.hidden = !visible;
      if (!visible) {
        row.classList.remove("expanded");
        const button = row.querySelector(".rtf-tree-toggle");
        if (button) { button.textContent = "확대"; button.classList.remove("expanded"); }
        setChildrenVisible(row.dataset.nodeId, false);
      }
    });
  }

  function bindRtf() {
    const items = computeRtfItems();
    document.querySelectorAll(".rtf-tree-toggle").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const row = button.closest("tr");
      const expanded = !row.classList.contains("expanded");
      row.classList.toggle("expanded", expanded);
      button.textContent = expanded ? "축소" : "확대";
      button.classList.toggle("expanded", expanded);
      setChildrenVisible(button.dataset.nodeId, expanded);
    }));
    document.querySelectorAll(".rtf-h-row.is-group").forEach((row) => row.addEventListener("click", (event) => {
      if (!event.target.closest(".rtf-tree-toggle")) row.querySelector(".rtf-tree-toggle")?.click();
    }));
    document.querySelectorAll(".rtf-h-row.is-item").forEach((row) => row.addEventListener("click", () => {
      const code = row.dataset.nodeId.split("|").pop();
      const item = items.find((entry) => entry.itemCode === code);
      if (!item) return;
      document.querySelectorAll(".rtf-h-row.selected").forEach((entry) => entry.classList.remove("selected"));
      row.classList.add("selected");
      const title = document.querySelector("#rtfDetailTitle");
      const body = document.querySelector("#rtfDetailBody");
      if (title) title.textContent = `${item.itemCode} ${item.itemName}`;
      if (body) body.innerHTML = renderItemDetail(item);
      document.querySelector("#rtfDetailPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }));
    document.querySelector("#rtfDetailClose")?.addEventListener("click", () => {
      document.querySelectorAll(".rtf-h-row.selected").forEach((row) => row.classList.remove("selected"));
      const title = document.querySelector("#rtfDetailTitle");
      const body = document.querySelector("#rtfDetailBody");
      if (title) title.textContent = "자재 상세";
      if (body) body.innerHTML = renderDetailEmpty();
    });
    document.querySelector("#rtfExtraToggle")?.addEventListener("click", () => {
      state.rtfExtraOpen = !state.rtfExtraOpen;
      render("rtf");
    });
    document.querySelectorAll("[data-rtf-mode]").forEach((button) => button.addEventListener("click", () => {
      if (state.rtfDisplayMode === button.dataset.rtfMode) return;
      state.rtfDisplayMode = button.dataset.rtfMode;
      render("rtf");
    }));
    document.querySelectorAll("[data-rtf-jump]").forEach((button) => button.addEventListener("click", () => {
      document.querySelector(`#${CSS.escape(button.dataset.rtfJump)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
