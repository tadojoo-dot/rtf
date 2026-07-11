// 결산자료 → data/closing.json 사전 계산
//
// 왜 필요한가: 결산 xlsx 6개(각 2.8MB, 4천 품목 × 96컬럼)를 브라우저에서 직접 파싱하면
// 약 12초간 UI가 멈춘다. 회의 중에는 결산 파일이 바뀌지 않으므로 미리 한 번 계산해
// 가벼운 JSON으로 떨궈두고, 앱은 그것만 읽는다 (로드 0.1초 수준).
//
// 실행: node tools/build-closing.js          (start.bat이 자동 실행 — 결산 파일이 더 새로우면)
// 새 달 결산 파일을 넣으면 CLOSING_MONTHS에 월을 추가하고 다시 돌린다.
//
// 스펙: docs/재고전망-스펙.md

const fs   = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const ROOT   = path.resolve(__dirname, "..");
const SRCDIR = path.join(ROOT, "결산자료");
const OUTDIR = path.join(ROOT, "data");
const OUT    = path.join(OUTDIR, "closing.json");

const MONTHS       = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
const NABOTA_PLANT = "1220";

const srcFile = m => path.join(SRCDIR, `(26년 ${Number(m.slice(5, 7))}월) 재고자산 결산.xlsx`);
const num     = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const norm    = v => String(v == null ? "" : v).replace(/\s+/g, "");
const code    = v => String(v ?? "").trim().replace(/\.0$/, "");
const R       = v => Math.round(v);   // 원 단위 정수 — JSON 크기 축소

// ── 최신성 검사: 결산 파일이 closing.json보다 새롭지 않으면 스킵 ──
function isFresh() {
  if (!fs.existsSync(OUT)) return false;
  const outM = fs.statSync(OUT).mtimeMs;
  return MONTHS.every(m => {
    const f = srcFile(m);
    return !fs.existsSync(f) || fs.statSync(f).mtimeMs <= outM;
  });
}

function cols(header, wanted) {
  const out = {};
  for (const [k, label] of Object.entries(wanted)) {
    out[k] = header.findIndex(c => norm(c) === norm(label));
    if (out[k] < 0) throw new Error(`컬럼 '${label}' 없음`);
  }
  return out;
}

function parseMonth(month) {
  const file = srcFile(month);
  if (!fs.existsSync(file)) return null;

  const wb = XLSX.readFile(file, { raw: true, cellDates: false, cellStyles: false, cellFormula: false });
  const matName = wb.SheetNames.find(n => n.startsWith("자재수불") && !n.includes("피벗"));
  const wipName = wb.SheetNames.find(n => n.startsWith("재공품수불") && !n.includes("피벗"));
  if (!matName) throw new Error(`${month}: 자재수불 시트 없음`);

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[matName], { header: 1, defval: null, raw: true });

  let hr = -1;
  for (let i = 0; i < 8; i++) {
    if ((rows[i] || []).some(c => norm(c) === norm("입고금액(플랜트제외)"))) { hr = i; break; }
  }
  if (hr < 0) throw new Error(`${month}: 자재수불 헤더행 없음`);

  const C = cols(rows[hr], {
    plant: "플랜트", code: "자재", name: "자재 내역", std: "표준원가",
    base: "기초(금액)합계", end: "기말(금액)합계",
    buyIn: "구매입고(금액)", prodIn: "생산입고(금액)",
    sale: "판매(금액)",             // = 매출원가. 3평판·재고일수의 유일한 분모
    ccOut: "코스트센터출고(금액)",   // 샘플·데모·무상공급. 판매가 아님
    prodOut: "생산출고(금액)",       // 자재→생산 투입(사내 이동)
  });
  // CN열 '유형' — 결산_RAW 유형과 일치하는 컬럼 (평가클래스 D열이 아님)
  let cType = rows[hr].findIndex((c, i) => i > 80 && norm(c) === "유형");
  if (cType < 0) cType = 91;

  const items  = new Map();
  const nabota = { base: 0, end: 0, sale: 0 };

  for (let r = hr + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row[C.code] == null || row[C.code] === "") continue;

    const b = num(row[C.base]), e = num(row[C.end]), sl = num(row[C.sale]);
    if (String(row[C.plant]).trim() === NABOTA_PLANT) {
      nabota.base += b; nabota.end += e; nabota.sale += sl;
      continue;                                  // 나보타는 품목 전개 없음 — 총액만
    }

    const k = code(row[C.code]);
    let it = items.get(k);
    if (!it) {
      it = { name: String(row[C.name] || ""), type: String(row[cType] || "").trim(), std: 0,
             base: 0, end: 0, sale: 0, ccOut: 0, buyIn: 0, prodIn: 0, prodOut: 0 };
      items.set(k, it);
    }
    if (!it.std) it.std = num(row[C.std]);
    it.base    += b;
    it.end     += e;
    it.sale    += sl;
    it.ccOut   += num(row[C.ccOut]);
    it.buyIn   += num(row[C.buyIn]);
    it.prodIn  += num(row[C.prodIn]);
    it.prodOut += num(row[C.prodOut]);
  }

  const wip = { base: 0, end: 0, nabotaBase: 0, nabotaEnd: 0 };
  if (wipName) {
    const wr = XLSX.utils.sheet_to_json(wb.Sheets[wipName], { header: 1, defval: null, raw: true });
    for (let i = 1; i < wr.length; i++) {
      const x = wr[i];
      if (!x || x[5] == null || x[5] === "") continue;
      const b = num(x[14]), e = num(x[17]);
      if (String(x[4]).trim() === NABOTA_PLANT) { wip.nabotaBase += b; wip.nabotaEnd += e; }
      else                                      { wip.base       += b; wip.end       += e; }
    }
  }
  return { month, items, wip, nabota };
}

function main() {
  if (process.argv.includes("--if-stale") && isFresh()) {
    console.log("closing.json 최신 — 스킵");
    return;
  }
  const t0 = Date.now();
  const snaps = MONTHS.map(m => {
    const s = parseMonth(m);
    console.log(`  ${m}  ${s ? s.items.size + "품목" : "파일 없음"}`);
    return s;
  }).filter(Boolean);

  if (!snaps.length) { console.error("결산자료 파일이 하나도 없습니다: " + SRCDIR); process.exit(1); }

  // 품목별 6개월 시계열. 필드는 배열로 눕혀 JSON 크기를 줄인다.
  // f = [base, end, sale, ccOut, buyIn, prodIn, prodOut] (원). 해당 월 데이터 없으면 null.
  const byItem = new Map();
  snaps.forEach(snap => {
    const mi = MONTHS.indexOf(snap.month);
    snap.items.forEach((s, k) => {
      let it = byItem.get(k);
      if (!it) { it = { c: k, n: s.name, t: s.type, s: 0, m: MONTHS.map(() => null) }; byItem.set(k, it); }
      if (!it.t && s.type) it.t = s.type;
      // 표준원가는 기중 가격변경이 있어 월마다 다르다. 전망(판매계획 × 표준원가)의 분모는
      // 가장 최근 값이어야 한다 — 1월 원가를 쓰면 6→7월에 재고일수가 25일 튄다.
      // MONTHS를 오름차순으로 돌므로 매번 덮어쓰면 마지막(최신) 월 값이 남는다.
      if (s.std) it.s = R(s.std);
      it.m[mi] = [R(s.base), R(s.end), R(s.sale), R(s.ccOut), R(s.buyIn), R(s.prodIn), R(s.prodOut)];
    });
  });

  const out = {
    builtAt: new Date().toISOString(),
    months:  MONTHS,
    fields:  ["base", "end", "sale", "ccOut", "buyIn", "prodIn", "prodOut"],
    nabotaPlant: NABOTA_PLANT,
    items:   [...byItem.values()],
    wip:     MONTHS.map(m => { const s = snaps.find(x => x.month === m); return s ? {
               base: R(s.wip.base), end: R(s.wip.end),
               nabotaBase: R(s.wip.nabotaBase), nabotaEnd: R(s.wip.nabotaEnd) } : null; }),
    nabota:  MONTHS.map(m => { const s = snaps.find(x => x.month === m); return s ? {
               base: R(s.nabota.base), end: R(s.nabota.end), sale: R(s.nabota.sale) } : null; }),
  };

  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
  console.log(`\n✓ ${OUT}  ${out.items.length}품목 · ${mb}MB · ${Date.now() - t0}ms`);
}

main();
