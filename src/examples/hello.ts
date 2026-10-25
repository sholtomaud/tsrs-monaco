import { DEFAULT_TSCONFIG, ENTRY, TSCONFIG, type ProjectFiles } from '../compiler/project.ts';
import { PLAYGROUND_DTS } from './playground-dts.ts';

export const files: ProjectFiles = {
  [TSCONFIG]: DEFAULT_TSCONFIG,
  [ENTRY]: `import { greet, type User } from './greet.ts';

const users: User[] = [
  { name: 'Alice', languages: ['TypeScript', 'Rust'] },
  { name: 'Bob', languages: ['JavaScript'] },
];

for (const user of users) {
  console.log(greet(user));
}

// Try breaking a type: change 'Alice' to 42 and watch the squiggle appear.
const total = users.reduce((n, u) => n + u.languages.length, 0);
console.info(\`\${users.length} users know \${total} languages\`);
`,
  'src/greet.ts': `export interface User {
  name: string;
  languages: string[];
}

export function greet(user: User): string {
  return \`Hello, \${user.name}! You write \${user.languages.join(' and ')}.\`;
}
`,
  'src/greet.test.ts': `import { greet } from './greet.ts';

test('greets a user by name', () => {
  expect(greet({ name: 'Ada', languages: ['TypeScript'] })).toBe(
    'Hello, Ada! You write TypeScript.'
  );
});

test('joins several languages with "and"', () => {
  const text = greet({ name: 'Bob', languages: ['Rust', 'Go'] });
  expect(text.endsWith('Rust and Go.')).toBeTruthy();
});
`,
  'src/playground.d.ts': PLAYGROUND_DTS,
};
