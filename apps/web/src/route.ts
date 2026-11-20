import { useEffect, useState } from 'react';
import { isCandleInterval, isExchangeId, type CandleInterval, type ExchangeId } from '@mip/core/types';

/**
 * The dashboard's pages live in the URL hash, so links can be shared and the browser's
 * back button works without a router or server-side routes:
 *   #/                                          home (market overview)
 *   #/dashboard                                 scanner dashboard
 *   #/terminal/<exchange>/<symbol>/<interval>   terminal (each part optional)
 */
export type Route =
  | { page: 'home' }
  | { page: 'dashboard' }
  | { page: 'terminal'; exchange?: ExchangeId; symbol?: string; interval?: CandleInterval };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'dashboard') return { page: 'dashboard' };
  if (parts[0] !== 'terminal') return { page: 'home' };
  const [, exchange, symbol, interval] = parts;
  return {
    page: 'terminal',
    ...(exchange && isExchangeId(exchange) ? { exchange } : {}),
    ...(symbol ? { symbol } : {}),
    ...(interval && isCandleInterval(interval) ? { interval } : {}),
  };
}

export function routeHash(route: Route): string {
  if (route.page === 'home') return '#/';
  if (route.page === 'dashboard') return '#/dashboard';
  const parts = ['terminal', route.exchange, route.symbol, route.interval].filter(
    (p): p is string => p !== undefined,
  );
  return `#/${parts.map(encodeURIComponent).join('/')}`;
}

export function navigate(route: Route, replace = false): void {
  const hash = routeHash(route);
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  // replaceState does not fire hashchange; tell listeners ourselves.
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
