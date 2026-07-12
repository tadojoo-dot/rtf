// ── 결산자료 파서 ─────────────────────────────────────────────────────────────
// 결산자료/(26년 N월) 재고자산 결산.xlsx (1~6월)을 fetch로 자동 로드.
// start.bat이 프로젝트 폴더를 로컬 서버로 서빙하므로 업로드 없이 읽힘.
// (index.html을 file://로 직접 열면 fetch가 차단됨 → 반드시 start.bat 사용)
//
// 스펙: docs/재고전망-스펙.md
//   · 나보타 = 플랜트 1220 → 품목 전개에서 제외, 총액만 결산_RAW로 별도 표시
//   · 유형 = CN열(idx 91). 평가클래스(D열)가 아님 — CN열이 결산_RAW 유형과 일치
//   · 판매(금액) = 품목별 매출원가. 재고일수 분모·3평판의 원천
//   · 자재코드로 플랜트 합산해야 (기말−기초) = (입고−소비)가 성립 (99.4% 검증)

var CLOSING_DIR    = "./결산자료/";
var CLOSING_MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
var NABOTA_PLANT   = "1220";

var CLOSING_STATUS = { IDLE: "idle", LOADING: "loading", DONE: "done", ERROR: "error" };

function closingFileName(month) {
  return "(26년 " + Number(month.slice(5, 7)) + "월) 재고자산 결산.xlsx";
}

function _cNum(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
function _cNorm(v) { return String(v == null ? "" : v).replace(/\s+/g, ""); }

// 헤더 이름으로 컬럼 위치를 찾는다 (인덱스 하드코딩 금지 — 월별 파일이 어긋날 수 있음)
function _cCols(header, wanted) {
  var out = {};
  Object.keys(wanted).forEach(function(key) {
    var label = _cNorm(wanted[key]);
    out[key] = header.findIndex(function(c) { return _cNorm(c) === label; });
  });
  return out;
}

// 결산 파일 1개를 읽는다. 필요한 시트는 자재수불·재공품수불 둘뿐인데 파일에는
// 재고현황·피벗·마스터 시트가 더 들어 있다 → 시트명만 먼저 읽고(bookSheets) 두 시트만
// 다시 파싱한다. 전체 파싱 대비 로드 시간이 크게 줄어든다.
function readClosingBook(buf, month) {
  var names = XLSX.read(buf, { type: "array", bookSheets: true }).SheetNames || [];
  var pick = function(prefix) {
    return names.find(function(n) { return n.indexOf(prefix) === 0 && n.indexOf("피벗") < 0; });
  };
  var matName = pick("자재수불");
  var wipName = pick("재공품수불");
  if (!matName) throw new Error(month + ": '자재수불' 시트를 찾을 수 없습니다");

  var want = wipName ? [matName, wipName] : [matName];
  var wb = XLSX.read(buf, {
    type: "array", sheets: want, raw: true,
    cellDates: false, cellStyles: false, cellFormula: false, cellHTML: false, cellText: false,
  });
  return { wb: wb, matName: matName, wipName: wipName };
}

// XLSX 워크북 → { matRows, wipRows } (파일 선택 경로와 형태를 맞추기 위한 어댑터)
function closingBookToRows(book) {
  return {
    matRows: XLSX.utils.sheet_to_json(book.wb.Sheets[book.matName], { header: 1, defval: null, raw: true }),
    wipRows: book.wipName
      ? XLSX.utils.sheet_to_json(book.wb.Sheets[book.wipName], { header: 1, defval: null, raw: true })
      : null,
  };
}

// 파일 선택(processFiles)으로 들어온 결산 파일에서 필요한 두 시트를 뽑는다.
// data.js의 parseWorkbook이 이미 sheet_to_json을 끝낸 형태({name, rows}[])로 준다.
function closingSheetsToRows(sheets, month) {
  var pick = function(prefix) {
    return (sheets || []).find(function(s) {
      return s.name.indexOf(prefix) === 0 && s.name.indexOf("피벗") < 0;
    });
  };
  var mat = pick("자재수불");
  var wip = pick("재공품수불");
  if (!mat) throw new Error(month + ": '자재수불' 시트를 찾을 수 없습니다");
  return { matRows: mat.rows, wipRows: wip ? wip.rows : null };
}

// 파일명 → 월 (예: "(26년 6월) 재고자산 결산.xlsx" → "2026-06")
function closingMonthFromName(name) {
  var m = String(name || "").match(/\((\d{2})년\s*(\d{1,2})월\)/);
  if (!m) return null;
  return "20" + m[1] + "-" + String(Number(m[2])).padStart(2, "0");
}

// ── 시트 rows → 품목별 월 스냅샷 ──────────────────────────────────────────────
function parseClosingWorkbook(src, month) {
  var rows    = src.matRows;
  var wipRows = src.wipRows;

  // 헤더행 탐색 (5월까지 index 2, 1~4월도 2 — 다만 방어적으로 스캔)
  var hr = -1;
  for (var i = 0; i < 8; i++) {
    if ((rows[i] || []).some(function(c) { return _cNorm(c) === _cNorm("입고금액(플랜트제외)"); })) { hr = i; break; }
  }
  if (hr < 0) throw new Error(month + ": 자재수불 헤더행(입고금액(플랜트제외))을 찾을 수 없습니다");

  var C = _cCols(rows[hr], {
    plant:  "플랜트",
    code:   "자재",
    name:   "자재 내역",
    std:    "표준원가",
    base:   "기초(금액)합계",
    end:    "기말(금액)합계",
    buyIn:  "구매입고(금액)",
    prodIn: "생산입고(금액)",
    subIn:  "외주가공입고(금액)",
    sale:   "판매(금액)",        // = 품목별 매출원가. 3평판·재고일수의 유일한 분모
    ccOut:  "코스트센터출고(금액)", // 샘플·데모·무상공급 등 내부 비용처리. 판매가 아님(매출원가 아님)
    prodOut:"생산출고(금액)",     // 자재→생산 투입(사내 이동). 재고일수 분모에 넣으면 이중계상
    inQty:  "입고금액(플랜트제외)",
    outQty: "소비금액(플랜트제외)", // = 판매 + 코스트센터 + 생산출고 + … → 판매만 따로 봐야 함
  });
  var CN_TYPE = 91; // CN열 '유형' — 헤더명이 '유형'이라 중복 위험 → 위치 우선, 이름으로 검증
  if (_cNorm(rows[hr][CN_TYPE]) !== "유형") {
    var alt = rows[hr].findIndex(function(c, i2) { return i2 > 80 && _cNorm(c) === "유형"; });
    if (alt >= 0) CN_TYPE = alt;
  }

  var items = new Map(); // 자재코드 → 스냅샷 (플랜트 합산, 나보타 제외)
  var nabota = { base: 0, end: 0, sale: 0 };

  for (var r = hr + 1; r < rows.length; r++) {
    var row = rows[r];
    if (!row || row[C.code] == null || row[C.code] === "") continue;

    var isNabota = String(row[C.plant]).trim() === NABOTA_PLANT;
    var b  = _cNum(row[C.base]),   e  = _cNum(row[C.end]);
    var sl = _cNum(row[C.sale]);

    if (isNabota) { nabota.base += b; nabota.end += e; nabota.sale += sl; continue; }

    // item_master와 같은 정규화를 써야 품목군 조인이 깨지지 않음
    var code = normalizeCode(row[C.code]);
    var it = items.get(code);
    if (!it) {
      it = { code: code, name: String(row[C.name] || ""), type: String(row[CN_TYPE] || "").trim(),
             std: 0, base: 0, end: 0, buyIn: 0, prodIn: 0, subIn: 0,
             sale: 0, ccOut: 0, prodOut: 0, in: 0, out: 0 };
      items.set(code, it);
    }
    if (!it.std) it.std = _cNum(row[C.std]);
    it.base    += b;
    it.end     += e;
    it.buyIn   += _cNum(row[C.buyIn]);
    it.prodIn  += _cNum(row[C.prodIn]);
    it.subIn   += _cNum(row[C.subIn]);
    it.sale    += sl;
    it.ccOut   += _cNum(row[C.ccOut]);
    it.prodOut += _cNum(row[C.prodOut]);
    it.in      += _cNum(row[C.inQty]);
    it.out     += _cNum(row[C.outQty]);
  }

  // 재공품 (별도 시트) — 플랜트 4, 자재코드 5, 재공기초 14, 재공기말 17
  var wip = { base: 0, end: 0, nabotaBase: 0, nabotaEnd: 0 };
  if (wipRows) {
    var wr = wipRows;
    for (var w = 1; w < wr.length; w++) {
      var x = wr[w];
      if (!x || x[5] == null || x[5] === "") continue;
      var wb0 = _cNum(x[14]), we = _cNum(x[17]);
      if (String(x[4]).trim() === NABOTA_PLANT) { wip.nabotaBase += wb0; wip.nabotaEnd += we; }
      else                                      { wip.base       += wb0; wip.end       += we; }
    }
  }

  return { month: month, items: items, wip: wip, nabota: nabota };
}

// ── 사전 계산 JSON 읽기 (기본 경로) ───────────────────────────────────────────
// 결산 xlsx 6개를 브라우저에서 직접 파싱하면 12초간 UI가 멈춘다. 결산 파일은 회의 중
// 바뀌지 않으므로 tools/build-closing.js가 미리 data/closing.json으로 떨궈둔다.
// (start.bat이 결산 파일이 더 새로우면 자동 재생성)
function closingJsonToSnaps(j) {
  var F = j.fields;   // ["base","end","sale","ccOut","buyIn","prodIn","prodOut"]
  return j.months.map(function(month, mi) {
    var items = new Map();
    j.items.forEach(function(it) {
      var a = it.m[mi];
      if (!a) return;
      var o = { name: it.n, type: it.t, std: it.s };
      F.forEach(function(f, k) { o[f] = a[k]; });
      o.in = 0; o.out = 0; o.subIn = 0;
      items.set(it.c, o);
    });
    return { month: month, items: items, wip: j.wip[mi] || { base:0, end:0, nabotaBase:0, nabotaEnd:0 },
             nabota: j.nabota[mi] || { base:0, end:0, sale:0 } };
  });
}

async function fetchClosingJson() {
  var res = await fetch("./data/closing.json", { cache: "no-store" });
  if (!res.ok) throw new Error("closing.json 없음 (HTTP " + res.status + ")");
  return closingJsonToSnaps(await res.json());
}

// 사용자가 데이터점검 화면에서 직접 고른 결산 파일 (file:// 로 열었을 때의 유일한 경로)
function uploadedClosingSnaps() {
  var out = [];
  Object.values(state.rawFiles || {}).forEach(function(f) {
    if (f.rawType !== "closingMonthly" || !f.parseSuccess) return;
    var month = closingMonthFromName(f.name);
    if (!month) return;
    try {
      out.push(parseClosingWorkbook(closingSheetsToRows(f.sheets, month), month));
    } catch (e) {
      console.warn("[결산자료] " + f.name + " 파싱 실패:", e.message);
    }
  });
  return out;
}

// ── 6개월 로드 → state.closing ────────────────────────────────────────────────
// 경로 우선순위 — 사용자가 파일을 고를 일이 없게 하는 게 목표다.
//   ① 사용자가 고른 closing.json (파일 모드에서 이거 하나만 고르면 끝)
//   ② data/closing.json 자동 fetch — 39ms. start.bat 서버 모드의 기본 경로.
//   ③ 사용자가 고른 결산 xlsx 6개
//   ④ 결산 폴더 xlsx를 fetch — JSON이 없고 서버 모드일 때 (12초)
async function loadClosingData(force) {
  if (!force && state.closing && state.closing.status === CLOSING_STATUS.DONE) return state.closing;

  state.closing = { status: CLOSING_STATUS.LOADING, months: CLOSING_MONTHS.slice(), errors: [], source: null };

  var snaps = [];

  // ① 사용자가 고른 사전계산 JSON
  if (state.closingJson) {
    try {
      snaps = closingJsonToSnaps(state.closingJson);
      state.closing.source = "json-upload";
    } catch (e) {
      state.closing.errors.push("closing.json 형식 오류: " + e.message);
    }
  }

  // ② 사전계산 JSON 자동 로드 (서버 모드의 기본 경로)
  if (!snaps.length) {
    try {
      snaps = await fetchClosingJson();
      state.closing.source = "json";
    } catch (jsonErr) {
      var fileMode = (typeof location !== "undefined" && location.protocol === "file:");

      // ③ 사용자가 직접 고른 결산 xlsx 6개
      var picked = uploadedClosingSnaps();
      if (picked.length) {
        snaps = picked;
        state.closing.source = "upload";

      } else if (fileMode) {
        // file:// 에서는 fetch가 원천 차단된다 → 무엇을 해야 하는지 화면에서 안내
        state.closing.status   = CLOSING_STATUS.ERROR;
        state.closing.fileMode = true;
        return state.closing;

      } else {
        // ④ 결산 폴더 xlsx 직접 파싱 (느림 — JSON이 없는 서버 모드)
        console.warn("[결산자료] 사전계산 JSON 미사용 → xlsx 직접 파싱:", jsonErr.message);
        if (!window.XLSX) throw new Error("XLSX 라이브러리 연결 필요");
        state.closing.source = "xlsx";
        for (var i = 0; i < CLOSING_MONTHS.length; i++) {
          var month = CLOSING_MONTHS[i];
          var url   = CLOSING_DIR + encodeURIComponent(closingFileName(month));
          try {
            var res = await fetch(url, { cache: "no-store" });
            if (!res.ok) throw new Error("HTTP " + res.status);
            var buf = await res.arrayBuffer();
            snaps.push(parseClosingWorkbook(closingBookToRows(readClosingBook(buf, month)), month));
          } catch (err) {
            state.closing.errors.push(month + ": " + (err && err.message ? err.message : String(err)));
            snaps.push(null);
          }
        }
      }
    }
  }

  var ok = snaps.filter(Boolean);
  if (!ok.length) {
    state.closing.status = CLOSING_STATUS.ERROR;
    return state.closing;
  }

  // 품목 마스터 조인 (사업부 / 품목군)
  var buMap = new Map(), grpMap = new Map();
  (state.mappedData.item_master || []).forEach(function(m) {
    if (!m.itemCode) return;
    if (m.businessUnit) buMap.set(m.itemCode, m.businessUnit);
    if (m.itemGroup)    grpMap.set(m.itemCode, m.itemGroup);
  });

  // 품목별 6개월 시계열로 합류
  var byItem = new Map();
  ok.forEach(function(snap) {
    var mi = CLOSING_MONTHS.indexOf(snap.month);
    snap.items.forEach(function(s, code) {
      var it = byItem.get(code);
      if (!it) {
        it = {
          itemCode: code, itemName: s.name, type: s.type, std: s.std,
          businessUnit: buMap.get(code) || "",
          itemGroup:    grpMap.get(code) || "",
          mon: CLOSING_MONTHS.map(function() { return null; }),
        };
        byItem.set(code, it);
      }
      if (!it.type && s.type) it.type = s.type;
      // 표준원가는 기중 가격변경으로 월마다 다르다 → 최신(마지막 월) 값으로 덮어쓴다.
      // 1월 원가를 쓰면 전망 매출원가 분모가 틀어져 6→7월 재고일수가 25일 튄다.
      if (s.std) it.std = s.std;
      it.mon[mi] = {
        base: s.base, end: s.end,
        sale: s.sale,       // 판매 = 매출원가. 3평판·재고일수 분모
        ccOut: s.ccOut,     // 코스트센터출고 = 샘플·데모·무상공급. 판매 아님
        buyIn: s.buyIn, prodIn: s.prodIn, subIn: s.subIn,
        prodOut: s.prodOut, in: s.in, out: s.out,
      };
    });
  });

  state.closing = {
    status:  CLOSING_STATUS.DONE,
    source:  state.closing.source,   // "json"(사전계산) | "xlsx"(폴백)
    months:  CLOSING_MONTHS.slice(),
    loaded:  ok.map(function(s) { return s.month; }),
    items:   byItem,
    wip:     CLOSING_MONTHS.map(function(m) {
               var s = ok.find(function(x) { return x.month === m; });
               return s ? s.wip : null;
             }),
    nabota:  CLOSING_MONTHS.map(function(m) {
               var s = ok.find(function(x) { return x.month === m; });
               return s ? s.nabota : null;
             }),
    errors:  state.closing.errors,
  };
  return state.closing;
}

// ── 파생 지표 ─────────────────────────────────────────────────────────────────

// 3평판 = 최근 3개월 평균 판매(금액). 회사 표준 용어.
// 금액 기준이라 품목군·유형으로 그대로 합산 가능 (수량은 단위가 달라 롤업 불가).
//
// ⚠ 분모는 유형에 따라 다르다:
//   · 제·상품  → 판매(금액). 코스트센터출고(샘플·데모·무상공급)는 판매가 아니다.
//   · 원부자재 → 판매되지 않고 생산에 투입된다 → 생산출고(금액).
//     판매를 분모로 쓰면 원부자재 전량이 "소진 불가(∞)"로 잡히는 오진이 난다.
function closingAvg3Sale(item, endIdx) {
  if (!item || !item.mon) return null;
  var isFg = (item.type === "완제품" || item.type === "상품");
  var end = (endIdx === undefined) ? item.mon.length - 1 : endIdx;
  var sum = 0, cnt = 0;
  for (var i = Math.max(0, end - 2); i <= end; i++) {
    var m = item.mon[i];
    if (m) { sum += (isFg ? m.sale : m.prodOut); cnt++; }
  }
  return cnt ? sum / cnt : null;
}

// 재고월수 = 기말재고금액 ÷ 3평판(또는 평균 생산출고). 출고 0이면 Infinity(=소진 불가).
function closingMonthsOfSupply(item, endIdx) {
  var end = (endIdx === undefined) ? item.mon.length - 1 : endIdx;
  var m = item.mon[end];
  if (!m || m.end <= 0) return null;
  var avg = closingAvg3Sale(item, end);
  if (avg === null) return null;
  return avg > 0 ? m.end / avg : Infinity;
}

// 결산 메타(매출원가 당월 등)에서 월별 값 뽑기 — 억 단위 → 원 환산
function closingCogsWon(month) {
  var meta = (state.mappedData.actuals_meta || []).find(function(r) { return r.month === month; });
  return (meta && Number.isFinite(meta.monthCogs)) ? meta.monthCogs * 1e8 : null;
}

// 공시기준 총재고 (억 → 원)
function closingTotalInvWon(month) {
  var meta = (state.mappedData.actuals_meta || []).find(function(r) { return r.month === month; });
  return (meta && Number.isFinite(meta.totalInv)) ? meta.totalInv * 1e8 : null;
}

// 재고일수 = 재고금액 ÷ 매출원가 × 해당월 일수
// 결산_raw의 '출고금액'은 원부자재 사내소비(생산출고)를 포함해 이중계상 → 쓰지 않는다.
function closingInvDays(month) {
  var inv  = closingTotalInvWon(month);
  var cogs = closingCogsWon(month);
  if (!Number.isFinite(inv) || !Number.isFinite(cogs) || cogs <= 0) return null;
  return inv / cogs * monthDays(month);
}
