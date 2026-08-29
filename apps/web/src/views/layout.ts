// Layout and page shell components for Web UI

export function htmlPage(title: string, bodyContent: string, orgId?: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - API Accord</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="page-shell">
    ${navbar(orgId)}
    <div class="page-content">${bodyContent}</div>
    ${footer()}
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
}

export function navbar(orgId?: string): string {
  const orgParam = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';
  const inboxHref = `/ui/inbox?recipient=team-merchant${orgId ? `&organizationId=${encodeURIComponent(orgId)}` : ''}`;
  return `
<nav class="navbar" role="navigation" aria-label="Main navigation">
  <a href="/ui/workspace${orgParam}" class="nav-brand" aria-label="API Accord Home">API Accord</a>
  <div class="nav-links">
    <a href="/ui/workspace${orgParam}">Workspace</a>
    <a href="${inboxHref}">Inbox</a>
    <a href="/">Home</a>
  </div>
</nav>`;
}

export function footer(): string {
  return `
<footer class="page-footer" role="contentinfo">
  API Accord &middot; Contract &middot; Context &middot; Decision &middot; Evidence
</footer>`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&').replace(/</gu, '<').replace(/>/gu, '>').replace(/"/gu, '"');
}