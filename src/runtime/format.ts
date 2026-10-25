// A small, dependency-free stand-in for util.inspect, used to turn console
// arguments into text inside the run worker before they cross postMessage.

export function formatValue(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (typeof value === 'string') return depth === 0 ? value : JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[Function: ${value.name || '(anonymous)'}]`;
  if (value === null || typeof value !== 'object') return String(value);
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (seen.has(value)) return '[Circular]';
  if (depth > 3) return Array.isArray(value) ? '[Array]' : '[Object]';

  seen.add(value);
  const inner = (v: unknown) => formatValue(v, depth + 1, seen);
  let text: string;
  if (Array.isArray(value)) {
    text = `[ ${value.map(inner).join(', ')} ]`;
    if (value.length === 0) text = '[]';
  } else if (value instanceof Map) {
    const entries = [...value].map(([k, v]) => `${inner(k)} => ${inner(v)}`);
    text = `Map(${value.size}) { ${entries.join(', ')} }`;
  } else if (value instanceof Set) {
    text = `Set(${value.size}) { ${[...value].map(inner).join(', ')} }`;
  } else {
    const entries = Object.entries(value).map(([k, v]) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
      return `${key}: ${inner(v)}`;
    });
    const name = value.constructor && value.constructor !== Object ? `${value.constructor.name} ` : '';
    text = entries.length ? `${name}{ ${entries.join(', ')} }` : `${name}{}`;
  }
  seen.delete(value);
  return text;
}

export function formatArgs(args: unknown[]): string {
  return args.map((arg) => formatValue(arg)).join(' ');
}
