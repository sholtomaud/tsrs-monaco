import type { BrowserContext, Route } from '@playwright/test';

/** name -> version -> path -> contents */
export type Registry = Record<string, Record<string, Record<string, string>>>;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  });

const text = (route: Route, body: string, path: string) =>
  route.fulfill({
    contentType: /\.m?js$|^$/.test(path) ? 'text/javascript' : 'text/plain',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body,
  });

/** Splits 'name@version/rest' (name may be scoped). */
function parse(spec: string) {
  const m = spec.match(/^((?:@[^/]+\/)?[^/@]+)(?:@([^/]+))?(\/.*)?$/);
  return m ? { name: m[1], version: m[2], rest: (m[3] ?? '').slice(1) } : null;
}

/**
 * Serves `registry` in place of jsDelivr (its data API and files) and
 * esm.sh, for pages and their workers. `esm` holds what esm.sh would serve
 * for 'name@version'. Returns the URLs requested, in order.
 */
export async function mockCdn(
  context: BrowserContext,
  registry: Registry,
  esm: Record<string, string> = {}
) {
  const requests: string[] = [];
  const latest = (name: string) => Object.keys(registry[name] ?? {}).sort().at(-1);

  await context.route('https://data.jsdelivr.com/v1/packages/npm/**', (route) => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    const path = decodeURIComponent(url.pathname.replace('/v1/packages/npm/', ''));
    if (path.endsWith('/resolved')) {
      const version = latest(path.slice(0, -'/resolved'.length));
      return version ? json(route, { version }) : json(route, { status: 404 }, 404);
    }
    const p = parse(path);
    const files = p && registry[p.name]?.[p.version ?? ''];
    if (!files) return json(route, { status: 404 }, 404);
    return json(route, { files: Object.keys(files).map((name) => ({ name: `/${name}` })) });
  });

  await context.route('https://cdn.jsdelivr.net/npm/**', (route) => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    const p = parse(decodeURIComponent(url.pathname.replace('/npm/', '')));
    const body = p ? registry[p.name]?.[p.version ?? '']?.[p.rest] : undefined;
    return body === undefined
      ? route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'Not found' })
      : text(route, body, p!.rest);
  });

  await context.route('https://esm.sh/**', (route) => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    const body = esm[decodeURIComponent(url.pathname.slice(1))];
    return body === undefined
      ? route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'Not found' })
      : text(route, body, '');
  });

  return requests;
}
