// Flat ESLint config. We check only our code: node_modules, dsh working copies,
// runtime data (sessions and user memory live there) and generated files
// are left alone.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      // dsh working copies lie inside the repository, and each has its own eslint.config.js
      // and tsconfig.json. ESLint itself does not read .gitignore, so without this
      // line it enters the copies, loads their configs, and typescript-eslint
      // collects several candidates for tsconfigRootDir — and crashes the parsing of all
      // files in a row, including our own. In CI there are no copies, so it is green there.
      '.dsh-worktrees/**',
      'runtime/**',
      'data/**',
      'docker/**/node_modules/**',
      'packages/**/node_modules/**',
      '**/*.d.ts',
    ],
  },
  // The base rule set of ESLint itself. Without it only the rules of
  // typescript-eslint remain, so no-duplicate-case, no-fallthrough,
  // no-constant-condition, no-useless-escape and the like slip through. For .ts the conflicting
  // rules are then turned off by typescript-eslint/eslint-recommended: tsc is stricter.
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Scripts and probes are ordinary node code, they need node globals and the common set.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // Chat and MCP clients run in the browser: they have document, fetch and history
    // instead of process. These are classic scripts that the page inserts
    // in sequence, so here script, not module.
    files: [
      'packages/service/src/control/chat-client.js',
      'packages/service/src/control/chat-markdown.js',
      'packages/service/src/control/files-highlight.js',
      'packages/service/src/control/mcp-client.js',
      'packages/service/src/control/keys-client.js',
      'packages/service/src/control/artifacts-client.js',
      'packages/service/src/control/artifacts-markdown.js',
      'packages/service/src/control/artifacts-chat.js',
      'packages/service/src/control/artifacts-pick.js',
      'packages/service/src/control/tasks-client.js',
    ],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        // We set the root for finding tsconfig explicitly. Otherwise typescript-eslint derives it
        // from the call stack and crashes as soon as a second tsconfig.json appears in the tree
        // (a worktree, a repository copy, someone else's clone). Our config is single — the root one.
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Handlers and callbacks sometimes need an "intentionally extra" parameter.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },
  {
    // Tests substitute stubs instead of pi, docker and the network: there `any` is
    // a deliberate tool, not an oversight. In production code the rule applies.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
