import './styles/global.css';
import { Router } from './core/router/router.ts';
import './components/nav-page/nav-page.ts';

// Setup BASE_URL for the router
const isGitHubPages = window.location.hostname.endsWith('.github.io');
const pathSegments = window.location.pathname.split('/');
const repoName = isGitHubPages && pathSegments.length > 1 && pathSegments[1] ? pathSegments[1] : null;
(window as any).BOBA_BASE_URL = repoName ? `/${repoName}/` : '/';

function getInitialAppPath() {
  const pathname = window.location.pathname;
  const BASE_URL = window.BOBA_BASE_URL;
  const normalizedBaseUrl =
    BASE_URL.endsWith('/') || BASE_URL === '/' ? BASE_URL : BASE_URL + '/';

  if (pathname.startsWith(normalizedBaseUrl) && normalizedBaseUrl.length > 1) {
    let appPath = pathname.substring(normalizedBaseUrl.length);
    if (!appPath.startsWith('/')) {
      appPath = '/' + appPath;
    }
    return appPath === '' ? '/' : appPath;
  }
  return pathname.startsWith('/') ? pathname : '/' + pathname;
}

// Initialize router and register routes
const router = Router.getInstance();
router.registerRoute({ path: '/', component: 'playground-page' });
router.registerRoute({ path: '/about', component: 'about-page' });

// Initial load
router.navigate(getInitialAppPath());
