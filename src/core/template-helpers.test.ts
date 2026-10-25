import { test, describe } from 'node:test';
import assert from 'node:assert';
import { html, css } from './template-helpers.ts';

describe('Template Helpers', () => {
  test('html tagged template should return the correctly concatenated string', () => {
    const result = html`<div>${'content'}</div>`;
    assert.strictEqual(result, '<div>content</div>');
  });

  test('css tagged template should return the correctly concatenated string', () => {
    const result = css`.class { color: ${'red'}; }`;
    assert.strictEqual(result, '.class { color: red; }');
  });
});
