// ── 문자열 / 숫자 포맷 ──────────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
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

// ── 날짜 / 월 ────────────────────────────────────────────────────────────────
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

// 판매계획 전체(수만 행)를 매번 map/sort하면 화면 곳곳(품목별 루프 포함)에서
// 호출될 때마다 비용이 커짐 — 데이터 건수를 캐시 키로 재사용한다.
var _rtfMonthsCache = null;
var _rtfMonthsCacheKey = null;
function getRtfMonths() {
  const cacheKey = state.mappedData.plan_monthly.length;
  if (_rtfMonthsCache && _rtfMonthsCacheKey === cacheKey) return _rtfMonthsCache;
  const planMonths = state.mappedData.plan_monthly
    .map((row) => cleanOptional(row.month)).filter(Boolean).sort();
  const baseMonth = planMonths[0] || MONTHS[0];
  _rtfMonthsCache = Array.from({ length: 7 }, (_, i) => addMonths(baseMonth, i));
  _rtfMonthsCacheKey = cacheKey;
  return _rtfMonthsCache;
}
function invalidateRtfMonthsCache() { _rtfMonthsCache = null; _rtfMonthsCacheKey = null; }

function monthLabel(month) {
  const [year, monthNo] = month.split("-").map(Number);
  return monthNo === 1 ? `${year}년 1월` : `${monthNo}월`;
}

// ── 값 정제 ──────────────────────────────────────────────────────────────────
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

function normalizeCode(value)   { return String(value ?? "").trim().replace(/\.0$/, ""); }
function normalizeHeader(value) { return String(value ?? "").replaceAll(" ", "").trim(); }
function get(row, index)        { return index >= 0 ? String(row[index] ?? "").trim() : ""; }

// ── 플랜트 코드 정규화 ────────────────────────────────────────────────────────
// RAW 파일마다 플랜트 컬럼이 SAP 코드("1210")로 오거나 한글명("향남")으로 올 수 있음.
// 전 화면이 SAP 코드를 기준 키로 매칭하므로, 파싱 시점에 코드로 통일한다.
var PLANT_NAME_TO_CODE = { "향남":"1210", "나보타":"1220", "오송":"1230", "횡성":"1240" };
var PLANT_CODE_SET = new Set(["1210", "1220", "1230", "1240"]);
function normalizePlant(value) {
  const v = cleanOptional(value);
  if (!v || PLANT_CODE_SET.has(v)) return v;
  return PLANT_NAME_TO_CODE[v] || v;
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

// ── 헤더 탐색 ────────────────────────────────────────────────────────────────
function findHeaderIndex(rows, labels) {
  return rows.findIndex((row) =>
    Array.isArray(row) && labels.every((label) =>
      row.some((cell) => normalizeHeader(cell) === normalizeHeader(label))));
}

function findPlanHeaderIndex(rows) {
  return rows.findIndex((row) =>
    Array.isArray(row)
    && row.some((cell) => normalizeHeader(cell) === normalizeHeader("자재"))
    && row.some((cell) => /^\d{4}-\d{2}_판매계획$/.test(normalizeHeader(cell)))
    && row.some((cell) => /^\d{4}-\d{2}_공급계획$/.test(normalizeHeader(cell))));
}

function indexer(header) {
  return (label, occurrence = 0) => {
    const normalized = normalizeHeader(label);
    let seen = 0;
    for (let i = 0; i < header.length; i++) {
      if (normalizeHeader(header[i]) === normalized) {
        if (seen === occurrence) return i;
        seen++;
      }
    }
    return -1;
  };
}

// ── 공통 UI 헬퍼 ─────────────────────────────────────────────────────────────
function badge(status, label) {
  return `<span class="badge ${status}">${escapeHtml(label)}</span>`;
}

function renderTable(headers, rows) {
  const ths = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const trs = rows.length
    ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${headers.length}">표시할 데이터가 없습니다.</td></tr>`;
  return `<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}
