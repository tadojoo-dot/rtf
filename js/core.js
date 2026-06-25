// 상수
const MONTHS = ["2026-06","2026-07","2026-08","2026-09","2026-10","2026-11","2026-12"];
const MONTH_COLUMNS = ["판매계획","RTF","Shortage","매출","매출차질예상","기말재고","재고일수"];
const EXTRA_COLUMNS = ["매출","매출차질예상","기말재고","재고일수"];
const STATUS = { OK:"대응가능", WARN:"주의", SHORTAGE:"공급부족", UNKNOWN:"판단불가" };
const STATUS_RANK = { 공급부족:0, 주의:1, 판단불가:2, 대응가능:3 };
const NEED_MASTER = "기준정보 확인 필요";
const NEED_DATA = "데이터 연결 필요";
const NO_PLAN = "판매계획 없음";
const ERROR_TEXTS = new Set(["#REF!","#VALUE!","#DIV/0!","undefined","null","NaN","Infinity","-Infinity"]);
const SHORT_TEXT = { [NEED_DATA]:"연결필요", [NEED_MASTER]:"확인필요" };

// 메뉴
// [id, 탭 짧은명, 화면 본문 제목]
const menus = [
  ["meeting",            "회의체계", "수급관리 회의체계"],
  ["data-check",         "데이터점검", "데이터 정합성 점검"],
  ["summary",            "회의안건", "수급관리 회의안건"],
  ["rtf",                "RTF판정", "RTF(공급가능성 판정)"],
  ["constraint",         "공급원인", "공급제한 원인 분석"],
  ["inventory-forecast", "재고전망", "현재 계획 기준 재고금액·재고일수 전망"],
  ["inventory-variance", "재고변동", "재고금액 변동분석"],
  ["diagnosis",          "수급진단", "수급진단 및 조정 대상 선별"],
  ["adjustment",         "조정입력", "조정안 입력"],
  ["impact",             "조정영향", "조정 후 영향 분석"],
  ["minutes",            "회의록", "회의록 및 의견 관리"],
];

const requiredFiles = [
  { id:"salesSupplyPlan",   label:"판매계획_공급계획_RAW.xlsx" },
  { id:"materialInventory", label:"기초재고_자재_RAW.xlsx" },
  { id:"wipInventory",      label:"기초재고_재공품_RAW.xlsx" },
  { id:"itemMaster",        label:"사업부 별 품목 기준정보.xlsx" },
  { id:"bom",               label:"BOM_RAW.xlsx" },
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
  },
  rtfExpanded: false,
  expandedItemGroups: new Set(),
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
  validationPanelOpen: false,
  validationTab: 0,
  calcCriteriaOpen: false,
  cstDrilldown: null,   // RTF 화면에서 넘어온 드릴다운 컨텍스트
  matSimAdj: {},        // "compCode|plant|month" → 조정된 입고수량(number)
  minutesLog: [],       // 회의록 결정사항 배열
  rtfViewMode: "current", // "current" | "adjusted"
};

// DOM 참조
const screenTitle = document.querySelector("#screenTitle");
const tabNav      = document.querySelector("#tabNav");
const screenRoot  = document.querySelector("#screenRoot");
