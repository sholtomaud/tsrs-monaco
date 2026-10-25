import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Store } from './store.ts';

describe('Store', () => {
  test('should initialize with initial state', () => {
    const initialState = { count: 0 };
    const store = new Store(initialState);
    assert.deepStrictEqual(store.getState(), initialState);
  });

  test('should update state with setState', () => {
    const store = new Store({ count: 0 });
    store.setState({ count: 1 });
    assert.deepStrictEqual(store.getState(), { count: 1 });
  });

  test('should merge state with setState', () => {
    const store = new Store({ a: 1, b: 2 });
    store.setState({ b: 3 });
    assert.deepStrictEqual(store.getState(), { a: 1, b: 3 });
  });

  test('should emit change event on setState', (t, done) => {
    const store = new Store({ count: 0 });
    store.addEventListener('change', (event: any) => {
      assert.deepStrictEqual(event.detail, { count: 1 });
      done();
    });
    store.setState({ count: 1 });
  });
});
