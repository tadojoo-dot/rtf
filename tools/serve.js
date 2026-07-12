// 로컬 정적 서버 — start.bat이 띄운다.
// 프로젝트 폴더를 그대로 서빙하므로 앱이 RAW 파일과 결산자료를 fetch로 읽을 수 있다.
// (index.html을 파일로 직접 열면 브라우저가 fetch를 막아 데이터를 못 읽는다)
const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT = Number(process.argv[2]) || 8787;
const ROOT = process.cwd();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xls":  "application/vnd.ms-excel",
  ".csv":  "text/csv; charset=utf-8",
};

// ── 회의 상태 저장 ────────────────────────────────────────────────────────────
// 담당자 의견·판정·조정값을 브라우저(localStorage)에만 두면 브라우저가 죽거나 캐시를
// 지우거나 PC를 옮기는 순간 회의 몇 시간치가 통째로 날아간다. 100명 앞에서 그러면 끝이다.
// 그래서 파일로 남긴다. 저장할 때마다 이전 버전을 백업해 두어 실수로 지워도 되돌린다.
const STATE_FILE = path.join(ROOT, "data", "meeting.json");
const BACKUP_DIR = path.join(ROOT, "data", "backup");

function saveMeeting(body, res) {
  try {
    JSON.parse(body);   // 깨진 JSON을 파일에 쓰지 않는다
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "invalid json" }));
  }
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    // 기존 파일을 백업 (최근 30개만 유지)
    if (fs.existsSync(STATE_FILE)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(STATE_FILE, path.join(BACKUP_DIR, "meeting-" + ts + ".json"));
      const old = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith("meeting-")).sort();
      old.slice(0, Math.max(0, old.length - 30))
         .forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) {} });
    }
    fs.writeFileSync(STATE_FILE, body, "utf8");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, savedAt: new Date().toISOString() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);

  if (p === "/api/meeting" && req.method === "POST") {
    let body = "";
    req.on("data", c => {
      body += c;
      if (body.length > 20e6) { req.destroy(); }   // 20MB 넘으면 끊는다
    });
    req.on("end", () => saveMeeting(body, res));
    return;
  }

  if (p === "/" || p === "") p = "/index.html";

  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log("RTF Dashboard 서버: http://127.0.0.1:" + PORT + "/index.html");
  console.log("폴더: " + ROOT);
  console.log("회의 상태 저장: " + STATE_FILE);
});
