// ESLint (flat config) com regras de segurança do projeto.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      // SQL cru não parametrizado é proibido (SQL injection). Use prisma.$queryRaw`...` (template tag).
      'no-restricted-properties': [
        'error',
        { property: '$queryRawUnsafe', message: 'Proibido: use $queryRaw com template tag (parametrizado).' },
        { property: '$executeRawUnsafe', message: 'Proibido: use $executeRaw com template tag (parametrizado).' },
      ],
      // exec/execSync passam por /bin/sh (command injection). Use spawn/execFile com array de argumentos.
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'node:child_process', importNames: ['exec', 'execSync'], message: 'Use spawn/execFile com argumentos em array.' }] },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
