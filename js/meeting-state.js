// ── 회의 상태 영속화 ─────────────────────────────────────────────────────────
//
// 왜 필요한가: 담당자 의견·판정·조정값을 브라우저(localStorage)에만 두면 브라우저가
// 죽거나, 캐시를 지우거나, PC를 옮기는 순간 회의 몇 시간치가 통째로 날아간다.
// 100명 앞에서 그러면 회의가 끝난다.
//
// 그래서 파일로 남긴다.
//   서버 모드(start.bat) → POST /api/meeting → data/meeting.json  (+ 자동 백업 30개)
//   파일 모드(file://)   → localStorage 폴백  (경고 표시)
//
// 저장은 자동이다. 사용자가 버튼을 눌러야 한다면 4시간 중 반드시 한 번은 까먹는다.

var MEETING_LS_KEY = "rtfMeeting.v1";
var _saveTimer = null;
var _saveState = { at: null, ok: null, mode: null };

function meetingCanSaveToFile() {
  return typeof location !== "undefined" && location.protocol !== "file:";
}

// 저장할 것 — 사람이 만든 것만. 계산으로 다시 나오는 건 저장하지 않는다.
function collectMeetingState() {
  return {
    savedAt:   new Date().toISOString(),
    version:   1,
    opinion:   state.revOpinion   || {},   // 담당자 의견 (재고 총괄장)
    decisions: state.aiDecisions   || {},   // 과잉감축 판정 (수용/조정/불가/보류)
    secApplied:state.aiSecApplied  || {},   // 섹션 일괄 적용 여부
    excessAdj: state.excessAdj     || {},   // 과잉감축 조정 공급량
    excSearch: state.excSearch     || "",   // 과잉감축 검색어 (재고진단 드릴다운 연동)
    matSimAdj: state.matSimAdj     || {},   // 자재 조정
    fgProdAdj: state.fgProdAdj     || {},   // 완제품 생산계획 조정
    goodsSupplyAdj: state.goodsSupplyAdj || {},
    matExcessAdj:   state.matExcessAdj   || {},
    minutes:   state.minutesLog    || [],   // 회의록
  };
}

function applyMeetingState(d) {
  if (!d) return;
  state.revOpinion     = d.opinion    || {};
  state.aiDecisions    = d.decisions  || {};
  state.aiSecApplied   = d.secApplied || {};
  state.excessAdj      = d.excessAdj  || {};
  state.excSearch      = d.excSearch  || "";
  state.matSimAdj      = d.matSimAdj  || {};
  state.fgProdAdj      = d.fgProdAdj  || {};
  state.goodsSupplyAdj = d.goodsSupplyAdj || {};
  state.matExcessAdj   = d.matExcessAdj   || {};
  state.minutesLog     = d.minutes    || [];
}

// 저장 — 연달아 부르면 마지막 것만 실제로 쓴다(디바운스). 입력 한 글자마다 파일을 쓰면 안 된다.
function saveMeetingState() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_doSave, 600);
}

async function _doSave() {
  var payload = JSON.stringify(collectMeetingState());

  // 파일 모드에서는 서버가 없다 → localStorage로 떨어진다
  if (!meetingCanSaveToFile()) {
    try { localStorage.setItem(MEETING_LS_KEY, payload); } catch (e) {}
    _saveState = { at: new Date(), ok: true, mode: "local" };
    renderSaveBadge();
    return;
  }

  try {
    var res = await fetch("./api/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    var j = await res.json();
    if (!j.ok) throw new Error(j.error || "저장 실패");
    _saveState = { at: new Date(), ok: true, mode: "file" };
  } catch (e) {
    // 서버 저장이 실패해도 브라우저에는 남긴다 — 잃는 것보다 낫다
    try { localStorage.setItem(MEETING_LS_KEY, payload); } catch (e2) {}
    _saveState = { at: new Date(), ok: false, mode: "local" };
    console.error("[회의 상태] 파일 저장 실패 → localStorage로 대체:", e.message);
  }
  renderSaveBadge();
}

// 복구 — 파일이 우선. 파일이 없으면 브라우저에 남은 것.
async function loadMeetingState() {
  if (meetingCanSaveToFile()) {
    try {
      var res = await fetch("./data/meeting.json", { cache: "no-store" });
      if (res.ok) {
        applyMeetingState(await res.json());
        _saveState = { at: null, ok: true, mode: "file" };
        renderSaveBadge();
        return "file";
      }
    } catch (e) { /* 파일이 아직 없다 — 첫 회의 */ }
  }
  try {
    var raw = localStorage.getItem(MEETING_LS_KEY);
    if (raw) {
      applyMeetingState(JSON.parse(raw));
      _saveState = { at: null, ok: true, mode: "local" };
      renderSaveBadge();
      return "local";
    }
  } catch (e) {}
  return null;
}

// 상단바에 저장 상태를 띄운다 — 저장이 되고 있는지 보이지 않으면 불안해서 회의가 안 굴러간다
function renderSaveBadge() {
  var el = document.getElementById("saveBadge");
  if (!el) return;
  var s = _saveState;
  if (!s.at && !s.mode) { el.innerHTML = ""; return; }

  var t = s.at
    ? s.at.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
  if (s.mode === "file" && s.ok) {
    el.className = "save-badge save-ok";
    el.innerHTML = "저장됨" + (t ? " · " + t : "") + " <small>data/meeting.json</small>";
  } else {
    el.className = "save-badge save-warn";
    el.innerHTML = "⚠ 브라우저에만 저장됨" + (t ? " · " + t : "") +
      " <small>start.bat으로 실행해야 파일로 남습니다</small>";
  }
}
