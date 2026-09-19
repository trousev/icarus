// Плоский конфиг ESLint. Проверяем только наш код: node_modules, рабочие копии
// dsh, рантайм-данные (там живут сессии и память пользователей) и сгенерированное
// не трогаем.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      // Рабочие копии dsh лежат внутри репозитория, и у каждой свой eslint.config.js
      // и tsconfig.json. ESLint сам по себе .gitignore не читает, поэтому без этой
      // строки он заходит в копии, подгружает их конфиги, а typescript-eslint
      // набирает несколько кандидатов в tsconfigRootDir — и роняет разбор всех
      // файлов подряд, включая наши собственные. В CI копий нет, там зелено.
      '.dsh-worktrees/**',
      'runtime/**',
      'data/**',
      'docker/**/node_modules/**',
      'packages/**/node_modules/**',
      '**/*.d.ts',
    ],
  },
  // Базовый набор правил самого ESLint. Без него остаются только правила
  // typescript-eslint, то есть мимо проходят no-duplicate-case, no-fallthrough,
  // no-constant-condition, no-useless-escape и прочее. Для .ts конфликтующие
  // правила следом гасит typescript-eslint/eslint-recommended: tsc строже.
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Скрипты и пробники — обычный node-код, им нужны node-глобали и общий набор.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        // Корень для поиска tsconfig задаём явно. Иначе typescript-eslint выводит его
        // из стека вызовов и падает, стоит в дереве появиться второму tsconfig.json
        // (worktree, копия репозитория, чужой клон). Наш конфиг один — корневой.
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Обработчикам и колбэкам иногда нужен «намеренно лишний» параметр.
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
    // Тесты подсовывают заглушки вместо pi, докера и сети: там `any` — это
    // осознанный инструмент, а не недосмотр. В боевом коде правило работает.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
