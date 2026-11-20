import { STAGES } from './domain/constants';
import type { Stage } from './domain/types';

export type Route = { name: 'dashboard' } | { name: 'project'; id: string; stage: Stage };

export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#/, '').replace(/^\/+/, '');
  if (clean === '') return { name: 'dashboard' };
  const parts = clean.split('/').filter((part) => part !== '');
  if (parts[0] === 'projects' && parts[1]) {
    const stagePart = parts[2] ?? '';
    const stage = (STAGES as readonly string[]).includes(stagePart)
      ? (stagePart as Stage)
      : 'brief';
    return { name: 'project', id: decodeURIComponent(parts[1]), stage };
  }
  return { name: 'dashboard' };
}

export function routeToHash(route: Route): string {
  if (route.name === 'dashboard') return '#/';
  return `#/projects/${encodeURIComponent(route.id)}/${route.stage}`;
}
