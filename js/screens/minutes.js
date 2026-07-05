// ── 회의록 화면 ───────────────────────────────────────────────────────────
function renderMinutes() {
  var log = state.minutesLog || [];
  var header = "<div class=\"min-toolbar\">" +
    "<h2 class=\"min-title\">회의록 · 결정사항</h2>" +
    (log.length > 0 ? "<button class=\"min-clear-all-btn\">전체 삭제</button>" : "") +
    "</div>";
  if (log.length === 0) {
    return "<div class=\"min-screen\">" + header +
      "<div class=\"min-empty\">기록된 결정사항이 없습니다.<br>공급원인 화면 → 부족자재 리스트에서 입고계획을 조정하고 기록하세요.</div></div>";
  }
  var entries = log.slice().reverse().map(function(entry) {
    var ts = entry.timestamp instanceof Date
      ? entry.timestamp.toLocaleString("ko-KR", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" })
      : "-";
    // AI 진단 판정 기록 (과잉감축 진단 카드에서 자동 기록)
    if (entry.type === "aiDecision" && entry.decision) {
      var d = entry.decision;
      return "<div class=\"min-entry\" data-entry-id=\"" + entry.id + "\">" +
        "<div class=\"min-entry-header\">" +
          "<span class=\"min-ts\">" + escapeHtml(ts) + "</span>" +
          "<span class=\"min-entry-title\">" + escapeHtml(entry.title || "AI 진단 판정") + "</span>" +
          "<button class=\"min-delete-btn\" data-id=\"" + entry.id + "\">삭제</button>" +
        "</div>" +
        "<div class=\"min-entry-body\">" +
          "<table class=\"min-table\"><thead><tr>" +
          "<th>품목코드</th><th>액션</th><th>판정</th><th>AI 제안량</th><th>확정량</th><th>사유</th>" +
          "</tr></thead><tbody><tr>" +
          "<td>" + escapeHtml(d.itemCode || "-") + "</td>" +
          "<td>" + escapeHtml(d.section || "-") + "</td>" +
          "<td><strong>" + escapeHtml(d.status || "-") + "</strong></td>" +
          "<td>" + (d.aiCutQty != null ? "-" + formatNumber(Math.round(d.aiCutQty)) : "-") + "</td>" +
          "<td>" + (d.finalQty != null ? (d.finalQty > 0 ? "-" + formatNumber(Math.round(d.finalQty)) : "0") : "-") + "</td>" +
          "<td>" + escapeHtml(d.reason || "-") + "</td>" +
          "</tr></tbody></table>" +
        "</div></div>";
    }
    var adjRows = entry.entries.map(function(e) {
      var sign = e.delta > 0 ? "+" : "";
      return "<tr>" +
        "<td>" + escapeHtml(e.matCode) + "</td>" +
        "<td>" + escapeHtml(e.matName) + "</td>" +
        "<td>" + escapeHtml(e.month) + "</td>" +
        "<td>" + formatNumber(Math.round(e.orig)) + "</td>" +
        "<td>" + formatNumber(Math.round(e.adj)) + "</td>" +
        "<td class=\"" + (e.delta > 0 ? "min-delta-pos" : "min-delta-neg") + "\">" +
          sign + formatNumber(Math.round(e.delta)) + "</td>" +
        "<td>" + (e.addlEA > 0 ? "+" + formatNumber(e.addlEA) + " EA" : "-") + "</td>" +
        "</tr>";
    }).join("");
    return "<div class=\"min-entry\" data-entry-id=\"" + entry.id + "\">" +
      "<div class=\"min-entry-header\">" +
        "<span class=\"min-ts\">" + escapeHtml(ts) + "</span>" +
        "<span class=\"min-entry-title\">" + entry.title + "</span>" +
        "<button class=\"min-delete-btn\" data-id=\"" + entry.id + "\">삭제</button>" +
      "</div>" +
      "<div class=\"min-entry-body\">" +
        "<table class=\"min-table\"><thead><tr>" +
        "<th>자재코드</th><th>자재명</th><th>월</th><th>원 입고계획</th><th>조정 후</th><th>변동</th><th>추가 생산</th>" +
        "</tr></thead><tbody>" + adjRows + "</tbody></table>" +
      "</div></div>";
  }).join("");
  return "<div class=\"min-screen\"><div class=\"min-inner\">" + header + entries + "</div></div>";
}

function bindMinutes() {
  var root = document.querySelector("#screenRoot");
  if (!root) return;
  root.addEventListener("click", function(e) {
    var del = e.target.closest(".min-delete-btn");
    if (del) {
      var id = parseInt(del.dataset.id, 10);
      state.minutesLog = (state.minutesLog || []).filter(function(entry) { return entry.id !== id; });
      render("minutes"); return;
    }
    var clearAll = e.target.closest(".min-clear-all-btn");
    if (clearAll && confirm("전체 결정사항을 삭제하시겠습니까?")) {
      state.minutesLog = [];
      render("minutes");
    }
  });
}

