// ── 회의안건 차트 ─────────────────────────────────────────────────────────────

var _summaryChartInst = null;

function bindSummary() {
  if (!window.Chart) return;
  var canvas = document.querySelector("#sumInvChart");
  if (!canvas) return;

  if (_summaryChartInst) { _summaryChartInst.destroy(); _summaryChartInst = null; }

  var allMonths = [];
  for (var m = 1; m <= 12; m++) allMonths.push("2026-" + (m < 10 ? "0" + m : "" + m));
  var rtfMonths   = getRtfMonths();
  var rtfItemsArr = computeRtfItems(undefined, true);

  // 실적 (전체 유형, plant="전체")
  var actualsRaw = allMonths.map(function(month) {
    var rows = (state.mappedData.actuals_monthly || []).filter(function(r) {
      return r.month === month && r.plant === "전체";
    });
    if (!rows.length) return null;
    return rows.reduce(function(s, r) { return s + (r.invAmt || 0); }, 0);
  });
  var lastActualIdx = -1;
  actualsRaw.forEach(function(v, i) { if (v !== null) lastActualIdx = i; });

  // 실적 데이터셋 (전망 월 null)
  var actualsData = allMonths.map(function(m, i) {
    return rtfMonths.includes(m) ? null : actualsRaw[i];
  });

  // 원계획 데이터셋 (실적 월 null, 연결점에서 시작)
  var baseData = allMonths.map(function() { return null; });
  if (lastActualIdx >= 0) baseData[lastActualIdx] = actualsRaw[lastActualIdx];
  rtfMonths.forEach(function(m, i) {
    var idx = allMonths.indexOf(m);
    if (idx < 0) return;
    var total = 0;
    rtfItemsArr.forEach(function(item) {
      var ms = item.monthlyStatus[i];
      if (ms && Number.isFinite(ms.endingAmount)) total += ms.endingAmount;
    });
    baseData[idx] = total / 100000000;
  });

  _summaryChartInst = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: allMonths.map(monthLabel),
      datasets: [
        {
          label: "실적",
          data: actualsData,
          borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,0.08)",
          borderWidth: 2.5, pointRadius: 4, tension: 0.3,
          fill: true, spanGaps: false,
        },
        {
          label: "원계획",
          data: baseData,
          borderColor: "#9ca3af", borderDash: [6, 3],
          borderWidth: 2, pointRadius: 3, tension: 0.3,
          fill: false, spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return ctx.raw !== null ? ctx.dataset.label + ": " + Math.round(ctx.raw) + "억" : null;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: "#f3f4f6" } },
        y: {
          title: { display: true, text: "재고금액 (억)", color: "#6b7280", font: { size: 11 } },
          grid: { color: "#f3f4f6" },
          ticks: { callback: function(v) { return Math.round(v) + "억"; } },
        },
      },
    },
  });
}
