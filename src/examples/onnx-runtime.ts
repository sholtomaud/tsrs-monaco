import { DEFAULT_TSCONFIG, ENTRY, TSCONFIG, type ProjectFiles } from '../compiler/project.ts';
import { PLAYGROUND_DTS } from './playground-dts.ts';

export const files: ProjectFiles = {
  [TSCONFIG]: DEFAULT_TSCONFIG,
  [ENTRY]: `import * as ort from 'onnxruntime-web';
import { denseRelu, denseReluModel } from './onnx-model.ts';

// onnxruntime-web comes from npm: its types are fetched for tsrs, and its
// self-contained browser bundle (plus .wasm) loads from jsDelivr on Run.

// A dense layer with ReLU, y = relu(x · W + b), built as an ONNX model in memory.
const W = [
  [0.5, -1],
  [1, 0.25],
  [-0.5, 2],
];
const b = [0.1, -0.2];

// Multi-threaded wasm needs a cross-origin isolated page; use one thread.
ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(denseReluModel(W, b), {
  executionProviders: ['wasm'],
});
console.info(\`ONNX Runtime session: \${session.inputNames} -> \${session.outputNames}\`);

// Sweep x = [t, 1, -t] and record both outputs.
const ts = Array.from({ length: 41 }, (_, i) => -2 + i / 10);
const outputs: number[][] = [];
for (const t of ts) {
  const x = [t, 1, -t];
  const { y } = await session.run({
    x: new ort.Tensor('float32', Float32Array.from(x), [1, x.length]),
  });
  outputs.push(Array.from(y.data as Float32Array));
}

console.log('t = 1:', outputs[30], 'expected', denseRelu([1, 1, -1], W, b));

plot(
  [0, 1].map((j) => ({
    name: \`y[\${j}]\`,
    points: ts.map((t, i): [number, number] => [t, outputs[i][j]]),
  })),
  { title: 'relu(x · W + b) for x = [t, 1, -t]', xLabel: 't', yLabel: 'y' }
);
`,
  'src/onnx-model.ts': `/**
 * Builds a tiny ONNX model in memory, so this example needs no model file:
 *
 *     y = Relu(x · W + b)        x: [1, n], W: [n, m], b: [m]
 *
 * An .onnx file is a protobuf-encoded ModelProto. This writes the handful of
 * fields ONNX Runtime needs (field numbers from onnx/onnx.proto).
 */

class Writer {
  private bytes: number[] = [];

  varint(field: number, value: number) {
    this.tag(field, 0);
    this.rawVarint(value);
    return this;
  }

  string(field: number, value: string) {
    return this.bytesField(field, new TextEncoder().encode(value));
  }

  message(field: number, build: (w: Writer) => void) {
    const inner = new Writer();
    build(inner);
    return this.bytesField(field, inner.finish());
  }

  bytesField(field: number, value: Uint8Array) {
    this.tag(field, 2);
    this.rawVarint(value.length);
    for (const b of value) this.bytes.push(b);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  private tag(field: number, wireType: number) {
    this.rawVarint((field << 3) | wireType);
  }

  private rawVarint(value: number) {
    while (value > 0x7f) {
      this.bytes.push((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    this.bytes.push(value);
  }
}

/** Exposed for tests: protobuf's variable-length integer encoding. */
export function encodeVarint(value: number): number[] {
  return [...new Writer().varint(1, value).finish().slice(1)];
}

const FLOAT = 1; // TensorProto.DataType.FLOAT

function tensor(w: Writer, name: string, dims: number[], values: number[]) {
  for (const d of dims) w.varint(1, d); // dims
  w.varint(2, FLOAT); // data_type
  w.string(8, name); // name
  w.bytesField(9, new Uint8Array(Float32Array.from(values).buffer)); // raw_data
}

function valueInfo(w: Writer, name: string, dims: number[]) {
  w.string(1, name);
  w.message(2, (type) => // TypeProto
    type.message(1, (t) => { // tensor_type
      t.varint(1, FLOAT); // elem_type
      t.message(2, (shape) => { // shape
        for (const d of dims) shape.message(1, (dim) => dim.varint(1, d));
      });
    })
  );
}

function node(w: Writer, op: string, inputs: string[], output: string) {
  for (const i of inputs) w.string(1, i);
  w.string(2, output);
  w.string(3, \`\${op.toLowerCase()}_\${output}\`);
  w.string(4, op);
}

/** A dense layer with ReLU: W is n rows of m weights, b has m biases. */
export function denseReluModel(W: number[][], b: number[]): Uint8Array {
  const n = W.length;
  const m = b.length;
  if (W.some((row) => row.length !== m)) throw new Error('W must be n × m, b length m');
  return new Writer()
    .varint(1, 8) // ir_version
    .string(2, 'tsrs-monaco')
    .message(7, (graph) => {
      graph.message(1, (w) => node(w, 'MatMul', ['x', 'W'], 'xW'));
      graph.message(1, (w) => node(w, 'Add', ['xW', 'b'], 'z'));
      graph.message(1, (w) => node(w, 'Relu', ['z'], 'y'));
      graph.string(2, 'dense_relu');
      graph.message(5, (w) => tensor(w, 'W', [n, m], W.flat()));
      graph.message(5, (w) => tensor(w, 'b', [m], b));
      graph.message(11, (w) => valueInfo(w, 'x', [1, n]));
      graph.message(12, (w) => valueInfo(w, 'y', [1, m]));
    })
    .message(8, (opset) => opset.string(1, '').varint(2, 13))
    .finish();
}

/** The same computation in plain TypeScript, to check ONNX Runtime against. */
export function denseRelu(x: number[], W: number[][], b: number[]): number[] {
  return b.map((bias, j) =>
    Math.max(0, x.reduce((sum, xi, i) => sum + xi * W[i][j], bias))
  );
}
`,
  'src/onnx-model.test.ts': `import * as ort from 'onnxruntime-web';
import { denseRelu, denseReluModel, encodeVarint } from './onnx-model.ts';

test('encodes protobuf varints', () => {
  expect(encodeVarint(1)).toEqual([1]);
  expect(encodeVarint(300)).toEqual([172, 2]);
});

test('rejects weights and biases of different widths', () => {
  expect(() => denseReluModel([[1, 2]], [0])).toThrow('n × m');
});

test('ONNX Runtime agrees with the plain TypeScript layer', async () => {
  ort.env.wasm.numThreads = 1;
  const W = [
    [0.5, -1],
    [1, 0.25],
    [-0.5, 2],
  ];
  const b = [0.1, -0.2];
  const session = await ort.InferenceSession.create(denseReluModel(W, b));
  for (const x of [
    [1, 2, 3],
    [-3, 1, -1],
  ]) {
    const { y } = await session.run({
      x: new ort.Tensor('float32', Float32Array.from(x), [1, 3]),
    });
    expect(y.dims).toEqual([1, 2]);
    const expected = denseRelu(x, W, b);
    Array.from(y.data as Float32Array).forEach((v, j) => expect(v).toBeCloseTo(expected[j], 5));
  }
});
`,
  'src/playground.d.ts': PLAYGROUND_DTS,
};
