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

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
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
});
