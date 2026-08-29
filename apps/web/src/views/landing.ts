// Landing page renderer

import { htmlPage } from './layout.js';
import { Badge } from './components.js';

export function renderLanding(orgId?: string): string {
  const orgParam = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';

  const content = `
<div class="landing">
  <header class="hero">
    <p class="eyebrow">API-CENTERED COLLABORATION</p>
    <h1>API Accord</h1>
    <p class="lead">Contract · Context · Decision · Evidence</p>
    <p class="summary">
      서비스 제공자와 소비자 사이에서 API 계약의 이유, 숨은 기대, 변경 합의와 구현 증거를 시간에 따라 보존한다.
    </p>
    <div class="hero-actions">
      <a href="/ui/workspace${orgParam}" class="btn btn-primary btn-lg">Open Workspace</a>
      <a href="/ui/inbox?recipient=team-merchant${orgParam}" class="btn btn-secondary btn-lg">View Inbox</a>
    </div>
  </header>

  <section class="grid" aria-label="Product pillars">
    <article class="pillar">
      <div class="pillar-icon" aria-hidden="true">📋</div>
      <h2>Contract</h2>
      <p>스펙 파일만이 아니라 동작 의미와 호환성 정책을 관리한다.</p>
      <div class="pillar-tags">
        ${Badge.provider()} ${Badge.consumer()} ${Badge.custom('OpenAPI 3.0/3.1', 'info')}
      </div>
    </article>
    <article class="pillar">
      <div class="pillar-icon" aria-hidden="true">🧠</div>
      <h2>Context</h2>
      <p>모든 주장은 출처, 범위, 신뢰도와 정정 계보를 가진다.</p>
      <div class="pillar-tags">
        ${Badge.human()} ${Badge.ai()} ${Badge.custom('7 Sections', 'info')}
      </div>
    </article>
    <article class="pillar">
      <div class="pillar-icon" aria-hidden="true">⚖️</div>
      <h2>Decision</h2>
      <p>토론을 결정 기록과 검증 가능한 변경 제안으로 전환한다.</p>
      <div class="pillar-tags">
        ${Badge.custom('Blocking', 'error')} ${Badge.custom('Constraints', 'info')} ${Badge.custom('Lineage', 'info')}
      </div>
    </article>
    <article class="pillar">
      <div class="pillar-icon" aria-hidden="true">🔬</div>
      <h2>Evidence</h2>
      <p>코드, 테스트, 배포와 런타임 관찰을 계약 상태와 연결한다.</p>
      <div class="pillar-tags">
        ${Badge.custom('Tests', 'success')} ${Badge.custom('Deploy', 'info')} ${Badge.custom('Drift', 'warning')}
      </div>
    </article>
  </section>

  <section class="quick-start">
    <h2>Quick Start</h2>
    <div class="quick-start-grid">
      <a href="/ui/workspace${orgParam}" class="quick-start-card">
        <h3>Workspace</h3>
        <p>서비스, 계약, 변경 제안을 한눈에</p>
      </a>
      <a href="/ui/inbox?recipient=team-merchant${orgParam}" class="quick-start-card">
        <h3>Inbox</h3>
        <p>승인, 구현, 검토 할 일 통합 관리</p>
      </a>
      <a href="/ui/operations/contract-payments%3Aget-payments-paymentid/context${orgParam}" class="quick-start-card">
        <h3>Context Inspector</h3>
        <p>7섹션 컨텍스트 번들 탐색</p>
      </a>
    </div>
  </section>

  <footer class="page-footer">
    API Accord &middot; Contract &middot; Context &middot; Decision &middot; Evidence
  </footer>
</div>`;

  return htmlPage('API Accord', content, orgId);
}