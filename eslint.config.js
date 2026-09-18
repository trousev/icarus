// Плоский конфиг ESLint. Проверяем только наш код: node_modules, рантайм-данные
// (там живут сессии и память пользователей) и сгенерированное не трогаем.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'runtime/**',
      'data/**',
      'docker/**/node_modules/**',
      'packages/**/node_modules/**',
      '**/*.d.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
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
