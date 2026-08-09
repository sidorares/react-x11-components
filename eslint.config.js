// eslint has only the JavaScript in this repo left to work with — this file,
// and anything else that stays `.js`/`.mjs`. The TypeScript is out of its
// reach: typescript-eslint's parser needs the classic `typescript` JS API,
// and TypeScript 7 (the native compiler this repo builds with) does not ship
// one. See AGENTS.md, "Linting", for when that changes.
//
// `tsc` carries the load in the meantime. `strict` plus `noUnusedLocals` in
// tsconfig.json is exactly what the `no-unused-vars` rule below was doing,
// and eslint-plugin-react is gone with the last `.jsx` file — the two rules
// it contributed only ever existed to stop `no-unused-vars` flagging an
// `import React` that the classic JSX transform needed.
import js from '@eslint/js';
import globals from 'globals';

export default [
  // Build output. Never linted, never formatted, never committed.
  { ignores: ['dist/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none' }],
    },
  },
];
