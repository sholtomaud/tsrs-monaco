import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  SIDEBAR_WIDTH,
  buildTree,
  checkProjectName,
  freeProjectName,
  projectIds,
  projectTitle,
  templateFiles,
  initialState,
  isProtected,
  parentFolders,
  projectFiles,
  resolveNewPath,
  restore,
  tabLabels,
  type FolderNode,
} from './workspace.ts';
import { DEFAULT_EXAMPLE, findExample } from '../examples/index.ts';

const files = {
  'tsconfig.json': '{}',
  'src/index.ts': '',
  'src/b.ts': '',
  'src/lib/a.ts': '',
  'README.md': '',
};

describe('buildTree', () => {
  test('lists folders before files, each A–Z, with node ids under the project', () => {
    const root = buildTree('demo', files);
    assert.deepStrictEqual(
      root.children.map((c) => c.name),
      ['src', 'README.md', 'tsconfig.json']
    );
    const src = root.children[0] as FolderNode;
    assert.deepStrictEqual(src.children.map((c) => c.name), ['lib', 'b.ts', 'index.ts']);
    assert.strictEqual(src.children[0].id, 'demo/src/lib');
    assert.strictEqual((src.children[0] as FolderNode).children[0].id, 'demo/src/lib/a.ts');
  });

  test('parentFolders names every folder above a file', () => {
    assert.deepStrictEqual(parentFolders('demo', 'src/lib/a.ts'), ['demo/src', 'demo/src/lib']);
    assert.deepStrictEqual(parentFolders('demo', 'README.md'), []);
  });
});

describe('resolveNewPath', () => {
  test('creates a .ts file in the folder when no extension is typed', () => {
    assert.deepStrictEqual(resolveNewPath('src', 'math', files), { path: 'src/math.ts' });
    assert.deepStrictEqual(resolveNewPath('src', 'util/x.js', files), { path: 'src/util/x.js' });
    assert.deepStrictEqual(resolveNewPath('', 'package.json', files), { path: 'package.json' });
  });

  test('rejects existing names, folders and unusable names', () => {
    assert.deepStrictEqual(resolveNewPath('src', 'b.ts', files), { error: 'A file src/b.ts already exists.' });
    assert.deepStrictEqual(resolveNewPath('src', 'lib.ts', { 'src/lib.ts/x.ts': '' }), {
      error: 'A folder src/lib.ts already exists.',
    });
    assert.ok('error' in resolveNewPath('src', '../escape.ts', files));
    assert.ok('error' in resolveNewPath('src', '   ', files));
    assert.ok('error' in resolveNewPath('src', 'a:b.ts', files));
  });
});

test('tab labels add the folder, or the project, only where names clash', () => {
  assert.deepStrictEqual(
    tabLabels([
      { project: 'hello', path: 'src/index.ts' },
      { project: 'odum-cash', path: 'src/index.ts' },
      { project: 'hello', path: 'src/greet.ts' },
      { project: 'boba-app', path: 'src/components/a/a.ts' },
      { project: 'boba-app', path: 'src/components/b/a.ts' },
    ]),
    [
      { name: 'index.ts', description: 'hello/src' },
      { name: 'index.ts', description: 'odum-cash/src' },
      { name: 'greet.ts', description: '' },
      { name: 'a.ts', description: 'src/components/a' },
      { name: 'a.ts', description: 'src/components/b' },
    ]
  );
});

test('the entry, tsconfig.json and index.html are protected', () => {
  assert.ok(isProtected(files, 'src/index.ts'));
  assert.ok(isProtected(files, 'tsconfig.json'));
  assert.ok(isProtected({ ...files, 'index.html': '' }, 'index.html'));
  assert.ok(!isProtected(files, 'src/b.ts'));
});

describe('restore', () => {
  test('a fresh workspace opens the default example at its entry', () => {
    const state = restore(null);
    assert.deepStrictEqual(state, initialState());
    assert.strictEqual(state.activeProject, DEFAULT_EXAMPLE.id);
    assert.deepStrictEqual(state.activeTab, { project: DEFAULT_EXAMPLE.id, path: 'src/index.ts' });
  });

  test('migrates the single-project playground', () => {
    const state = restore(null, {
      files: { 'tsconfig.json': '{}', 'src/index.ts': 'edited', 'src/math.ts': '' },
      activeFile: 'src/math.ts',
      exampleId: 'odum-cash',
    });
    assert.strictEqual(state.activeProject, 'odum-cash');
    assert.strictEqual(state.projects['odum-cash']['src/index.ts'], 'edited');
    assert.deepStrictEqual(state.tabs, [{ project: 'odum-cash', path: 'src/math.ts' }]);
    assert.ok(state.expanded.includes('odum-cash/src'));
  });

  test('drops removed projects and files, and clamps the layout', () => {
    const hello = { ...findExample('hello')!.files };
    const state = restore({
      projects: { hello, gone: { 'a.ts': '' } },
      activeProject: 'gone',
      tabs: [
        { project: 'hello', path: 'src/greet.ts' },
        { project: 'hello', path: 'src/deleted.ts' },
        { project: 'gone', path: 'a.ts' },
        'junk',
      ],
      activeTab: { project: 'gone', path: 'a.ts' },
      expanded: ['hello', 3],
      sidebarWidth: 10_000,
      sidebarVisible: false,
      panelFraction: 'wide',
    });
    assert.deepStrictEqual(Object.keys(state.projects), ['hello']);
    assert.deepStrictEqual(state.tabs, [{ project: 'hello', path: 'src/greet.ts' }]);
    assert.deepStrictEqual(state.activeTab, { project: 'hello', path: 'src/greet.ts' });
    assert.strictEqual(state.activeProject, 'hello');
    assert.deepStrictEqual(state.expanded, ['hello']);
    assert.strictEqual(state.sidebarWidth, SIDEBAR_WIDTH.max);
    assert.strictEqual(state.sidebarVisible, false);
    assert.strictEqual(state.panelFraction, initialState().panelFraction);
  });

  test('unopened projects read their example, without sharing its object', () => {
    const state = initialState();
    const odum = projectFiles(state, 'odum-cash');
    assert.deepStrictEqual(odum, findExample('odum-cash')!.files);
    odum['src/index.ts'] = 'changed';
    assert.notStrictEqual(findExample('odum-cash')!.files['src/index.ts'], 'changed');
  });
});

describe('user projects', () => {
  const withMine = () => ({
    ...initialState(),
    userProjects: [{ id: 'my-project', from: 'template:blank' }],
    projects: { ...initialState().projects, 'my-project': templateFiles('blank', 'my-project') },
  });

  test('names must be new, plain and short', () => {
    const state = withMine();
    assert.deepStrictEqual(checkProjectName(' rc-circuit ', state), { id: 'rc-circuit' });
    assert.deepStrictEqual(checkProjectName('My-Project', state), { error: 'A project My-Project already exists.' });
    assert.deepStrictEqual(checkProjectName('hello', state), { error: 'A project hello already exists.' });
    assert.ok('error' in checkProjectName('a/b', state));
    assert.ok('error' in checkProjectName('-x', state));
    assert.ok('error' in checkProjectName('', state));
    assert.strictEqual(freeProjectName('my-project', state), 'my-project-2');
    assert.strictEqual(freeProjectName('hello-copy', state), 'hello-copy');
  });

  test('the user\'s projects come first, then the examples', () => {
    const ids = projectIds(withMine());
    assert.strictEqual(ids[0], 'my-project');
    assert.ok(ids.includes('hello') && ids.includes('fluxkit'));
    assert.strictEqual(projectTitle('my-project', withMine()), 'My project (blank)');
  });

  test('templates are a runnable project', () => {
    for (const template of ['blank', 'fluxkit'] as const) {
      const files = templateFiles(template, 'demo');
      assert.deepStrictEqual(Object.keys(files).sort(), ['src/index.ts', 'src/playground.d.ts', 'tsconfig.json']);
    }
    assert.match(templateFiles('fluxkit', 'demo')['src/index.ts'], /new fx\.Model\('demo'/);
  });

  test('restore keeps the user\'s projects and drops ones without files', () => {
    const state = restore({
      ...withMine(),
      userProjects: [
        { id: 'my-project', from: 'template:blank' },
        { id: 'lost', from: 'template:blank' },
        { id: 'hello', from: 'template:blank' }, // an example's name can't be taken
        'junk',
      ],
      tabs: [{ project: 'my-project', path: 'src/index.ts' }],
      activeTab: { project: 'my-project', path: 'src/index.ts' },
    });
    assert.deepStrictEqual(state.userProjects, [{ id: 'my-project', from: 'template:blank' }]);
    assert.strictEqual(state.activeProject, 'my-project');
    assert.ok(state.projects['my-project']['src/index.ts'].includes('Hello from my-project'));
  });
});
