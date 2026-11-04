import { ecosystem, parseNetwork } from './dialect.ts';
import { silverSprings } from './silver-springs.ts';

const chain = parseNetwork(`
storage a = 5, b
source sun
sink heat
sun -> a = 10
a -> b = 0.5 * a      # donor controlled
a -> heat = a / 4
b -> heat = 2 * b
`);

test('builds C and u from the flows', () => {
  expect(chain.storages).toEqual(['a', 'b']);
  expect(chain.x0).toEqual([5, 0]);
  // dx_a = 10 - 0.75 a,  dx_b = 0.5 a - 2 b
  expect(chain.C).toEqual([-0.75, 0, 0.5, -2]);
  expect(chain.u).toEqual([10, 0]);
  expect(chain.sinks).toEqual([{ name: 'heat', coefficients: [0.25, 2] }]);
});

test('every column of C sums to minus its losses to sinks', () => {
  const net = silverSprings();
  const n = net.storages.length;
  for (let j = 0; j < n; j++) {
    let column = 0;
    for (let i = 0; i < n; i++) column += net.C[i * n + j];
    const losses = net.sinks.reduce((sum, s) => sum + s.coefficients[j], 0);
    expect(column).toBeCloseTo(-losses, 12);
  }
});

test('params, arithmetic and interpolated values', () => {
  const k = 3;
  const net = ecosystem`
    storage x
    source s
    sink out
    param half = 1 / 2
    s -> x = ${k} * (1 + half)
    x -> out = -(-half) * x
  `;
  expect(net.u).toEqual([4.5]);
  expect(net.C).toEqual([-0.5]);
  expect(net.params).toEqual({ half: 0.5 });
});

test('keeps each source apart for the emergy pass', () => {
  const net = parseNetwork(`storage x, y\nsource sun, rain\nsink out\nsun -> x = 3\nrain -> x = 1\nrain -> y = 2\nx -> out = x\ny -> out = y`);
  expect(net.u).toEqual([4, 2]);
  expect(net.sources).toEqual([
    { name: 'sun', flows: [3, 0] },
    { name: 'rain', flows: [1, 2] },
  ]);
});

const parse = (text: string) => () => parseNetwork(text);

test('rejects nonlinear and non-donor-controlled flows', () => {
  const base = 'storage a, b\n';
  expect(parse(base + 'a -> b = a * b')).toThrow('line 2:12: a flow must be linear');
  expect(parse(base + 'a -> b = 0.1 * b')).toThrow("must be k * a (donor controlled), not depend on 'b'");
  expect(parse(base + 'a -> b = 3')).toThrow('a constant would drain it below zero');
  expect(parse(base + 'a -> b = -0.1 * a')).toThrow('flows must not be negative');
  expect(parse(base + 'a -> a = a')).toThrow('a flow must go to a different place');
});

test('reports unknown names with a suggestion and the position', () => {
  expect(parse('storage producers\nsink heat\nproducer -> heat = producers')).toThrow(
    "line 3:1: unknown name 'producer'; did you mean 'producers'?\n  producer -> heat = producers"
  );
  expect(parse('storage a\nstorage a')).toThrow("line 2:9: 'a' is already declared (line 1)");
  expect(parse('storage a\nsink s\ns -> a = 1')).toThrow("'s' is a sink: nothing flows out of it");
  expect(parse('storage a\na -> b = a ^ 2')).toThrow("line 2:12: unexpected '^'");
  expect(parse('# nothing here')).toThrow('a network needs at least one storage');
});
