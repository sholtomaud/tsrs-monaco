export class Router {
  static instance;
  routes = [];
  currentPath = '';

  constructor() {
    window.addEventListener('popstate', this.handleRoute.bind(this));
  }

  static getInstance() {
    if (!Router.instance) {
      Router.instance = new Router();
    }
    return Router.instance;
  }

  getAppPath() {
    const pathname = window.location.pathname;
    const BASE_URL = (window as any).BOBA_BASE_URL || '/';
    const normalizedBaseUrl =
      BASE_URL.endsWith('/') || BASE_URL === '/' ? BASE_URL : BASE_URL + '/';

    if (
      pathname.startsWith(normalizedBaseUrl) &&
      normalizedBaseUrl.length > 1
    ) {
      let appPath = pathname.substring(normalizedBaseUrl.length);
      if (!appPath.startsWith('/')) {
        appPath = '/' + appPath;
      }
      return (appPath === '' ? '/' : appPath) + window.location.search;
    }
    return (pathname.startsWith('/') ? pathname : '/' + pathname) + window.location.search;
  }

  registerRoute(route) {
    const normalizedPath = route.path.startsWith('/')
      ? route.path
      : '/' + route.path;

    // Convert path like '/user/:id' to a regex and extract parameter names
    const paramNames = [];
    const regexSource = normalizedPath.replace(/:([^\/]+)/g, (_, paramName) => {
      paramNames.push(paramName);
      return '([^\\/]+)';
    });

    const regex = new RegExp(`^${regexSource}$`);
    this.routes.push({ ...route, path: normalizedPath, regex, paramNames });
  }

  navigate(appPath) {
    const pathAndQuery = appPath.startsWith('/') ? appPath : '/' + appPath;
    const BASE_URL = (window as any).BOBA_BASE_URL || '/';

    const [pathPart, queryString] = pathAndQuery.split('?');
    const dummyAbsoluteBase = 'http://dummy';
    const publicPath = new URL(
      pathPart.substring(1),
      dummyAbsoluteBase + (BASE_URL.endsWith('/') ? BASE_URL : BASE_URL + '/')
    ).pathname;

    const finalPath = publicPath + (queryString ? '?' + queryString : '');

    if (window.location.pathname + window.location.search !== finalPath) {
      window.history.pushState({}, '', finalPath);
    }
    this.handleRoute();
  }

  async handleRoute() {
    const appPathToMatch = this.getAppPath();
    const [pathPart, queryString] = appPathToMatch.split('?');
    
    const searchParams = new URLSearchParams(queryString || '');
    const query = Object.fromEntries(searchParams.entries());

    const match = this.findRoute(pathPart);

    if (match) {
      const to = { path: pathPart, params: match.params, query };

      if (match.route.beforeEnter) {
        const guardResult = await match.route.beforeEnter(to);
        if (guardResult === false) {
          if (this.currentPath && this.currentPath !== appPathToMatch) {
            this.navigate(this.currentPath);
          }
          return;
        } else if (typeof guardResult === 'string') {
          this.navigate(guardResult);
          return;
        }
      }

      this.currentPath = appPathToMatch;
      this.loadComponent(match.route.component, match.params, query);
    } else {
      this.show404();
    }
  }

  findRoute(path) {
    for (const route of this.routes) {
      const match = path.match(route.regex || new RegExp(`^${route.path}$`));
      if (match) {
        const params = {};
        if (route.paramNames) {
          route.paramNames.forEach((name, index) => {
            params[name] = decodeURIComponent(match[index + 1]);
          });
        }
        return { route, params };
      }
    }
    return null;
  }

  async loadComponent(tagName, params = {}, query = {}) {
    const outlet = document.querySelector('#router-outlet');
    if (!outlet) return;

    try {
      if (!customElements.get(tagName)) {
        await import(`../../components/${tagName}/${tagName}.ts`);
      }

      const element = document.createElement(tagName);
      Object.assign(element, params);
      (element as any).params = params;
      (element as any).query = query;

      outlet.innerHTML = '';
      outlet.appendChild(element);
    } catch (error) {
      console.error(`Failed to load component: ${tagName}`, error);
      this.show404();
    }
  }

  show404() {
    const outlet = document.querySelector('#router-outlet');
    if (outlet) {
      outlet.innerHTML = '<h1>404 - Page Not Found</h1>';
    }
  }
}
