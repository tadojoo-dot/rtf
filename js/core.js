// 상수
const MONTHS = ["2026-06","2026-07","2026-08","2026-09","2026-10","2026-11","2026-12"];
const MONTH_COLUMNS = ["판매계획","RTF","Shortage","매출","매출차질예상","기말재고","재고일수"];
const EXTRA_COLUMNS = ["매출","매출차질예상","기말재고","재고일수"];
const STATUS = { OK:"대응가능", WARN:"주의", SHORTAGE:"공급부족", UNKNOWN:"판단불가" };
const STATUS_RANK = { 공급부족:0, 주의:1, 판단불가:2, 대응가능:3 };
const NEED_MASTER = "기준정보 확인 필요";
const NEED_DATA = "데이터없음";
const NO_PLAN = "판매계획 없음";
const ERROR_TEXTS = new Set(["#REF!","#VALUE!","#DIV/0!","undefined","null","NaN","Infinity","-Infinity"]);
const SHORT_TEXT = { [NEED_DATA]:"데이터없음", [NEED_MASTER]:"확인필요" };

// 메뉴
// [id, 탭 짧은명, 화면 본문 제목, nav에 표시 여부, 그룹("util"은 우측 도구 영역)]
const menus = [
  ["meeting",            "회의체계",  "학습과 소통 회의체계",                        true,  "도입"],
  ["inventory-forecast", "재고진단",  "재고진단 — 6월 결산 리뷰 및 하반기 전망",     true,  "도입"],
  ["summary",            "회의안건",  "회의안건",                                   true,  "도입"],
  ["rtf",                "RTF판정",   "RTF(공급가능성 판정)",                        true,  "1부 품절방어"],
  ["constraint",         "공급원인",  "공급제한 원인 분석",                          true,  "1부 품절방어"],
  ["inventory-variance", "과잉감축",  "적정재고 초과 품목 감축 계획",               true,  "2부 재고절감"],
  ["impact",             "조정총괄",  "세부 조정 총괄 — 품목·품목군·사업부별 정리", true,  "2부 재고절감"],
  ["minutes",            "회의록",    "회의록 및 결정사항",                         true,  "마무리"],
  ["bom-sim",            "BOM시뮬",   "BOM 전개 시뮬레이션",                         true,  "util"],
  ["download",           "다운로드",  "양식 다운로드",                               true,  "util"],
  ["data-check",         "데이터점검","데이터 정합성 점검",                         false],
  ["diagnosis",          "수급진단",  "수급진단 및 조정 대상 선별",                 false],
  ["adjustment",         "조정입력",  "조정안 입력",                                false],
];

const requiredFiles = [
  { id:"salesSupplyPlan",   label:"판매계획_공급계획_RAW.xlsx" },
  { id:"materialInventory", label:"기초재고_자재_RAW.xlsx" },
  { id:"wipInventory",      label:"기초재고_재공품_RAW.xlsx" },
  { id:"itemMaster",        label:"사업부 별 품목 기준정보.xlsx" },
  { id:"bom",               label:"BOM_RAW.xlsx" },
  { id:"targetInventory",   label:"적정재고_RAW.xlsx" },
  { id:"salesActual",       label:"매출_RAW.xlsx" },
  { id:"actuals",           label:"결산_RAW.xlsx" },
];

// 앱 상태
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
    target_inv: [],
    actuals_monthly: [],
    actuals_meta: [],
    sales_actual: [],
  },
  // 결산자료(1~6월 자재수불) — closing.js가 폴더에서 자동 로드. 재고전망 리뷰의 원천.
  closing: null,
  closingJson: null,      // 사용자가 직접 고른 data/closing.json (파일 모드용)
  revTab:  "fg",          // 재고 총괄장: "fg"(제·상품) | "mat"(원부자재)
  revView: "sum",         // "sum"(요약 뷰) | "mon"(월별 뷰)
  revOpen: new Set(),     // 펼쳐진 트리 노드 id (유형 > 품목군 > 품목)
  revOpenInit: false,     // 첫 렌더에서 유형 + 증가 상위 3개 품목군을 자동 펼침
  revSort: { key: "contrib", dir: -1 },  // 기본 = 증가 기여도 내림차순 (열자마자 주범이 맨 위)
  revSearch: "",          // 품목 검색 (코드·품목명·품목군)
  revOpinion: {},         // 담당자 의견: 품목코드 → 문자열. 회의 전에 미리 채운다.
  rtfExpanded: false,
  expandedItemGroups: new Set(),
  rtfSearch: "",            // RTF판정 매트릭스 품목 검색 (품목코드·품목명)
  rtfShortOnly: false,      // RTF판정 매트릭스: 공급부족 품목만 보기
  rtfDisplayMode: "qty",
  rtfSectionMode: "business",
  bomStatus: "idle",
  bomResult: null,
  bomProgressStep: "",
  constraintFilter: "all",
  constraintSearch: "",
  expandedConstraintRows: new Set(),
  constraintDetailMode: false,
  constraintImpactSort: 0,
  constraintShowAll: false,
  validationPanelOpen: false,
  validationTab: 0,
  calcCriteriaOpen: false,
  cstDrilldown: null,   // RTF 화면에서 넘어온 드릴다운 컨텍스트
  matSimAdj: {},        // "compCode|plant|month" → 조정된 입고수량(number)
  goodsSupplyAdj: {},   // "itemCode|plant|month" → 상품 조정 공급(입고)수량 (RTF 조정후에 반영)
  aiAppliedKeys: {},    // AI 권장안으로 적용한 matSimAdj 키 추적 (해제용)
  cstAnalysisOpen: false,    // 상세 분석 섹션 펼침 여부
  cstRtfExpanded: new Set(), // 펼쳐진 완제품 "itemCode|plantCode" 키
  minutesLog: [],       // 회의록 결정사항 배열
  rtfSubTab: "matrix",       // "matrix" | "inventory"
  rtfViewMode: "current",   // "current" | "adjusted"
  invSupplyAdj: {},         // "itemCode|plant|month" → 재고화면 직접조정 공급수량
  excessAdj: {},            // "itemCode|plant|month" → 과잉감축 조정 공급수량
  aiExcessKeys: {},         // AI 감축 선제안으로 적용한 excessAdj 키 추적 (해제용)
  excSearch: "",             // 과잉감축 검색어 (품목코드·품목명·품목군)
  excessTab: "fg",          // "fg" | "mat"
  excessShowOnly: false,    // false=전체품목 true=초과품목만
  excessDrillTabMap: {},    // rowKey → "psi" | "mat"
  bomSimTab:     "forward", // "forward" | "reverse"
  bomSimFgCode:  "",        // "itemCode|plant" (단일, 하위호환)
  bomSimFgCodes: [],        // ["itemCode|plant", ...] 멀티선택
  bomSimQty:     1000,      // 정전개 생산수량
  bomSimMatCode: "",        // 역전개 자재코드
  matExcessAdj: {},         // "matCode|plant|month" → 자재 입고 취소/조정 수량
  aiMatKeys: {},            // AI 자재 감축 선제안으로 적용한 matExcessAdj 키 추적 (해제용)
  invViewMode: "current",   // "current" | "rtf" | "excess"
  invFilter: "all",         // "all" | "excess"
  invSectionMode: "business",       // "business" | "plant" | "type"
  invExpanded: false,               // false=기본(발표용) true=확대(분석용)
  invExpandedItemGroups: new Set(), // 품목군 [+] 펼침 상태
  invExpandedRows: new Set(), // 드릴다운 펼쳐진 "itemCode|plant" 키
  excessExpandedRows: new Set(), // 완제품 드릴다운 펼쳐진 키
  matExcessExpandedRows: new Set(), // 자재 드릴다운 펼쳐진 키
  chartScenario: "기존", // 연간 수급 추이 차트(회의안건/재고진단 공용) 시나리오: "기존" | "RTF조정" | "과잉조정"
  cstBannerOpen: false,  // 공급원인 화면 상단 KPI 배너(3시나리오 월별표) 펼침 여부 — 기본 접힘
  cstAiOpen:     false,  // 공급원인 화면 AI 선제안 패널 펼침 여부 — 기본 접힘
  excBannerOpen: false,  // 과잉감축 화면 상단 KPI 배너 펼침 여부 — 기본 접힘
  excAiOpen:     false,  // 과잉감축 화면 AI 진단 패널 펼침 여부 — 기본 접힘
};

// DOM 참조
const screenTitle = document.querySelector("#screenTitle");
const tabNav      = document.querySelector("#tabNav");
const screenRoot  = document.querySelector("#screenRoot");
