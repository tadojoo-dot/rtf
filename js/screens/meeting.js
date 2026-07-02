// ── 회의체계 화면 ──────────────────────────────────────────────────────────
function renderMeeting() {
  return `
  <section class="section-band">
    <div style="background:#1a3558;border-radius:12px;padding:32px 40px;color:#fff;">
      <h2 style="font-size:22px;font-weight:700;color:#93b8d8;margin-bottom:16px;letter-spacing:0.02em;">회의 목표</h2>
      <p style="font-size:21px;font-weight:800;color:#ffffff;line-height:1.6;margin-bottom:20px;">
        향후 <strong style="color:#7dd3fc;">6개월</strong> 품목별 공급부족을 <strong style="color:#7dd3fc;">RTF로 사전 판정</strong>하고, <strong style="color:#7dd3fc;">적정재고 초과분</strong>을 계획 단계에서 선제 조정하여 <strong style="color:#7dd3fc;">품절 Zero · 재고금액 최소화</strong>를 달성한다
      </p>
      <div style="display:flex;gap:32px;flex-wrap:wrap;border-top:1px solid rgba(255,255,255,0.15);padding-top:20px;">
        <div style="flex:1;min-width:200px;">
          <p style="font-size:13px;font-weight:700;color:#7dd3fc;margin-bottom:8px;letter-spacing:0.06em;">WHAT — 무엇을</p>
          <p style="font-size:17px;color:#e2eaf4;line-height:1.8;">당월 대응이 아닌 <strong style="color:#fff;">6개월 전방 수급</strong>을<br>RTF로 품목별 판정</p>
        </div>
        <div style="flex:1;min-width:200px;">
          <p style="font-size:13px;font-weight:700;color:#7dd3fc;margin-bottom:8px;letter-spacing:0.06em;">HOW — 어떻게</p>
          <p style="font-size:17px;color:#e2eaf4;line-height:1.8;"><strong style="color:#fff;">BOM 전개 기반</strong> 공급가능수량 산출,<br>적정재고 기준 초과분 선별 · 감축</p>
        </div>
        <div style="flex:1;min-width:200px;">
          <p style="font-size:13px;font-weight:700;color:#7dd3fc;margin-bottom:8px;letter-spacing:0.06em;">GOAL — 목표</p>
          <p style="font-size:17px;color:#e2eaf4;line-height:1.8;"><strong style="color:#fff;">품절 Zero</strong> 유지 + 재고금액 최소화,<br>사전 센싱 → 조기 의사결정 체계 정착</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section-band">
    <div class="section-header">
      <div><h2 style="font-size:24px;font-weight:800;">회의체계 변경</h2></div>
    </div>
    <div class="grid-2">
      <article class="card" style="border-left:5px solid #9ca3af;padding:26px 28px;">
        <h3 style="font-size:17px;font-weight:800;color:#6b7280;letter-spacing:0.04em;margin-bottom:18px;">기존 회의체계</h3>
        <ul style="font-size:17px;line-height:2.2;color:#4b5563;padding-left:20px;margin:0;">
          <li>당월 실적 분석 위주</li>
          <li>재고 많은 품목 순서로 체크</li>
          <li>품목별 개별 점검 → 전체 그림 파악 어려움</li>
          <li>부족 발생 후 <strong>사후 대응</strong></li>
        </ul>
      </article>
      <article class="card" style="border-left:5px solid #28278f;padding:26px 28px;">
        <h3 style="font-size:17px;font-weight:800;color:#28278f;letter-spacing:0.04em;margin-bottom:18px;">RTF 기반 회의체계</h3>
        <ul style="font-size:17px;line-height:2.2;color:#1f2933;padding-left:20px;margin:0;">
          <li><strong>RTF 판정</strong>으로 품절 가능성 <strong>사전 점검</strong></li>
          <li>공급가능수량 수치로 <strong>대응 가능 여부 확인</strong></li>
          <li><strong>적정재고 기준</strong> 초과 품목 선별 · 감축</li>
          <li>데이터 기반 <strong>예방적 의사결정</strong> 체계</li>
        </ul>
      </article>
    </div>
  </section>

  <section class="section-band">
    <div class="section-header">
      <div><h2 style="font-size:24px;font-weight:800;">오늘 회의 진행 순서</h2></div>
    </div>
    <div class="process-grid">
      <article class="card" style="border-top:4px solid #4f46e5;padding:26px 28px;">
        <p style="font-size:18px;font-weight:800;color:#4f46e5;letter-spacing:0.08em;margin-bottom:12px;">1 부</p>
        <h3 style="font-size:24px;font-weight:800;color:#1f2933;margin-bottom:16px;">품절 점검</h3>
        <p style="font-size:17px;line-height:2.0;color:#374151;">
          <strong>RTF 판정</strong> — 어디서 품절이 나는가<br>
          <strong>공급원인</strong> — 왜 품절이 나는가
        </p>
        <p style="font-size:21px;color:#1d4ed8;margin-top:18px;font-style:italic;font-weight:800;">
          "이번 달 품절 나는 곳 있습니까?"
        </p>
      </article>
      <article class="card" style="border-top:4px solid #0891b2;padding:26px 28px;">
        <p style="font-size:18px;font-weight:800;color:#0891b2;letter-spacing:0.08em;margin-bottom:12px;">2 부</p>
        <h3 style="font-size:24px;font-weight:800;color:#1f2933;margin-bottom:16px;">재고 확인</h3>
        <p style="font-size:17px;line-height:2.0;color:#374151;">
          <strong>재고전망</strong> — 재고금액이 얼마인가<br>
          <strong>과잉감축</strong> — 어디서 줄일 수 있는가
        </p>
        <p style="font-size:21px;color:#1d4ed8;margin-top:18px;font-style:italic;font-weight:800;">
          "재고가 지금 얼마입니까?"
        </p>
      </article>
      <article class="card" style="border-top:4px solid #16a34a;padding:26px 28px;">
        <p style="font-size:18px;font-weight:800;color:#16a34a;letter-spacing:0.08em;margin-bottom:12px;">3 부</p>
        <h3 style="font-size:24px;font-weight:800;color:#1f2933;margin-bottom:16px;">의사결정</h3>
        <p style="font-size:17px;line-height:2.0;color:#374151;">
          <strong>조정영향</strong> — 조정 시 효과가 얼마인가<br>
          <strong>회의록</strong> — 결정사항 · 액션오너 확정
        </p>
        <p style="font-size:21px;color:#1d4ed8;margin-top:18px;font-style:italic;font-weight:800;">
          "얼마나 줄일 수 있습니까?"
        </p>
      </article>
    </div>
  </section>`;
}

// ── 데이터점검 ────────────────────────────────────────────────────────────────
