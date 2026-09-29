import { lazy } from 'react';
export const Wiki = lazy(() => import('./Wiki').then((module) => ({ default: module.Wiki })));
export { KnowledgePicker } from './KnowledgePicker';

export { parseWikiLocation, wikiHref } from './wiki-navigation';
