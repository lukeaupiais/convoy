/** Shareable hash routes for the app's pages. The Wiki keeps its own `#wiki?` links. */
export type AppPage =
  | 'Project board'
  | 'Chat'
  | 'Workflows'
  | 'Sessions'
  | 'Agents'
  | 'Project settings'
  | 'Integrations'
  | 'Providers'
  | 'Runners';

export type AppRoute = {
  page: AppPage;
  conversationId?: string;
  runId?: string;
  ticket?: number;
};

const pagePaths: [AppPage, string][] = [
  ['Project board', 'board'],
  ['Chat', 'chat'],
  ['Workflows', 'workflows'],
  ['Sessions', 'sessions'],
  ['Agents', 'settings/agents'],
  ['Project settings', 'settings/project'],
  ['Integrations', 'settings/integrations'],
  ['Providers', 'settings/providers'],
  ['Runners', 'settings/environments'],
];

export function isAppPage(page: string): page is AppPage {
  return pagePaths.some(([p]) => p === page);
}

export function parseAppRoute(hash: string): AppRoute | null {
  if (!hash.startsWith('#/')) return null;
  const [path, query = ''] = hash.slice(2).split('?', 2);
  let segments: string[];
  try {
    segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  let route: AppRoute | null = null;
  if (segments[0] === 'chat' && segments.length <= 2)
    route = segments[1] ? { page: 'Chat', conversationId: segments[1] } : { page: 'Chat' };
  else if (segments[0] === 'workflows' && segments.length === 3 && segments[1] === 'runs')
    route = { page: 'Workflows', runId: segments[2] };
  else {
    const match = pagePaths.find(([, p]) => p === segments.join('/'));
    if (match) route = { page: match[0] };
  }
  if (!route) return null;
  const ticket = Number(new URLSearchParams(query).get('ticket'));
  if (Number.isSafeInteger(ticket) && ticket > 0) route.ticket = ticket;
  return route;
}

export function appRouteHash(route: AppRoute) {
  let path = pagePaths.find(([p]) => p === route.page)?.[1] ?? 'board';
  if (route.page === 'Chat' && route.conversationId)
    path += '/' + encodeURIComponent(route.conversationId);
  if (route.page === 'Workflows' && route.runId) path += '/runs/' + encodeURIComponent(route.runId);
  return '#/' + path + (route.ticket ? `?ticket=${route.ticket}` : '');
}
