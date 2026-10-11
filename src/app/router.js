/**
 * Router — hash-based, because ManiaFlow is a local tool.
 *
 * `#/practice` rather than `/practice`: it works from a static host with no rewrite rules,
 * it works when the folder is opened straight off disk, and a reload always lands where the
 * user was. There is no history stack to manage and nothing to synchronise with a server.
 *
 * The router owns the URL. It does not own the page: it reports a route id, and the App
 * mounts the matching page. Keeping those apart is what lets a page be swapped without the
 * router knowing what a page is.
 */

import { ROUTES, routeById, routeByPath } from './state.js';

const DEFAULT_ROUTE = ROUTES[0].id;

export class Router {
  /** @param {{ onChange: (routeId: string, params: URLSearchParams) => void }} config */
  constructor(config = {}) {
    if (typeof config.onChange !== 'function') throw new TypeError('A router needs an onChange handler');
    this.onChange = config.onChange;
    this.current = DEFAULT_ROUTE;
    this.params = new URLSearchParams();
    this._onHashChange = () => this._read();
    this._installed = false;
  }

  /**
   * Start listening and resolve whatever the URL already says.
   * Returns the handler's promise, so `await router.start()` means the first screen has
   * actually mounted rather than merely been requested.
   */
  start() {
    if (this._installed) return Promise.resolve();
    this._installed = true;
    window.addEventListener('hashchange', this._onHashChange);
    return Promise.resolve(this._read(true));
  }

  _read(initial = false) {
    const hash = window.location.hash || '';
    const [pathPart, queryPart] = hash.replace(/^#/, '').split('?');
    const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
    const route = routeByPath(path) || (path === '' || path === '/' ? routeByPath('/') : null);

    if (!route) {
      // An unknown hash is not an error worth a dialog; go somewhere useful and say where.
      this.navigate(DEFAULT_ROUTE, { replace: true, reason: `No screen at "${path}"` });
      return undefined;
    }
    this.current = route.id;
    this.params = new URLSearchParams(queryPart || '');
    return this.onChange(route.id, this.params, { initial });
  }

  /**
   * Move to a route. `params` become the query string, so a page can be deep-linked
   * (`#/library?chart=<id>`).
   */
  navigate(routeId, { params = null, replace = false } = {}) {
    const route = routeById(routeId);
    if (!route) {
      console.warn(`[ManiaFlow] no route called "${routeId}"`);
      return false;
    }
    const query = params ? `?${new URLSearchParams(params).toString()}` : '';
    const next = `#${route.path}${query}`;
    if (window.location.hash === next) {
      // Same destination: re-read so params-only changes still reach the page.
      this._read();
      return true;
    }
    if (replace) {
      const url = `${window.location.pathname}${window.location.search}${next}`;
      window.history.replaceState(null, '', url);
      this._read();
    } else {
      window.location.hash = next;
      // No hashchange event fires when only the query differs on some paths, so re-read.
      if (window.location.hash !== next) this._read();
    }
    return true;
  }

  /** The route id for a hash string, without navigating. Used by tests and the sidebar. */
  static routeForHash(hash) {
    const path = String(hash || '').replace(/^#/, '').split('?')[0];
    const normalised = path.startsWith('/') ? path : `/${path}`;
    return (routeByPath(normalised) || routeByPath('/')).id;
  }

  get path() { return routeById(this.current)?.path || '/'; }

  stop() {
    window.removeEventListener('hashchange', this._onHashChange);
    this._installed = false;
  }
}
