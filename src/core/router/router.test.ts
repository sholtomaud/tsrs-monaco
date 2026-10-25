import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Router } from './router.ts';

// Mock browser globals for testing the router logic
(global as any).window = {
  location: { pathname: '/' },
  addEventListener: () => {},
  history: { pushState: () => {} }
};
(global as any).document = {
  querySelector: () => ({ innerHTML: '' })
};
(global as any).CustomEvent = class {};
(global as any).customElements = { get: () => true };

describe('Router', () => {
  test('should match simple routes', () => {
    const router = new Router();
    router.registerRoute({ path: '/', component: 'home' });
    router.registerRoute({ path: '/about', component: 'about' });

    // Mock getAppPath to return different values
    (router as any).getAppPath = () => '/';
    let match = (router as any).findRoute('/');
    assert.strictEqual(match.route.component, 'home');

    (router as any).getAppPath = () => '/about';
    match = (router as any).findRoute('/about');
    assert.strictEqual(match.route.component, 'about');
  });

  test('should match dynamic routes', () => {
    const router = new Router();
    router.registerRoute({ path: '/user/:id', component: 'user-profile' });

    const match = (router as any).findRoute('/user/123');
    assert.ok(match);
    assert.strictEqual(match.route.component, 'user-profile');
    assert.strictEqual(match.params.id, '123');
  });

  test('should match multiple dynamic segments', () => {
    const router = new Router();
    router.registerRoute({ path: '/post/:year/:month/:day', component: 'blog-post' });

    const match = (router as any).findRoute('/post/2026/04/02');
    assert.ok(match);
    assert.strictEqual(match.params.year, '2026');
    assert.strictEqual(match.params.month, '04');
    assert.strictEqual(match.params.day, '02');
  });
});
