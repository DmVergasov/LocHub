import { useCallback, useEffect, useState } from 'react';

export type View =
  | { name: 'grid' }
  | { name: 'card'; culture: string; unitId: string }
  | { name: 'queue' }
  | { name: 'glossary' }
  | { name: 'jobs' }
  | { name: 'coverage' }
  | { name: 'summary' }
  | { name: 'inbox' };

const SIMPLE_VIEWS = ['grid', 'queue', 'glossary', 'jobs', 'coverage', 'summary', 'inbox'] as const;

export function parseView(hash: string): View {
  let parts: string[];
  try {
    parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  } catch {
    return { name: 'grid' };
  }
  const [name, first, second] = parts;
  if (name === 'card' && first && second) return { name: 'card', culture: first, unitId: second };
  const simple = SIMPLE_VIEWS.find((candidate) => candidate === name);
  return simple ? ({ name: simple } as View) : { name: 'grid' };
}

export function viewHref(view: View): string {
  if (view.name === 'card') return `#/card/${encodeURIComponent(view.culture)}/${encodeURIComponent(view.unitId)}`;
  return `#/${view.name}`;
}

export function useView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => parseView(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setView(parseView(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const navigate = useCallback((next: View) => {
    window.location.hash = viewHref(next);
  }, []);
  return [view, navigate];
}
