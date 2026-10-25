import { test } from '@playwright/test';
import { checkNpmExample } from './npm-examples.ts';

// Runs the npm examples against the real jsDelivr and esm.sh. Off by default
// so CI doesn't depend on third-party CDNs: LIVE_CDN=1 npx playwright test e2e/npm-examples.live.spec.ts
test.skip(!process.env.LIVE_CDN, 'set LIVE_CDN=1 to run against the real CDNs');
test.setTimeout(300_000);

test('ONNX Runtime Web example', async ({ page }) => {
  await checkNpmExample(page, 'onnx-runtime', {
    output: ['ONNX Runtime session: x -> y', 't = 1: [ 2.0999999046325684, 0 ]'],
    tests: 3,
  });
});

test('TensorFlow.js + WebGPU example', async ({ page }) => {
  await checkNpmExample(page, 'tfjs-webgpu', {
    output: [/tfjs 4\.\d+\.\d+ on the (webgpu|cpu) backend/, /y ≈ 1\.9\d+x \+ 1\.0\d+/],
    tests: 4,
  });
});
