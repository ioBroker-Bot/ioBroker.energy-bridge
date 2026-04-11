import config from '@iobroker/eslint-config';

export default [
  ...config,
  {
    ignores: [
      'admin/**',
      // Large template file - not relevant for linting
      'lib/templates.json',
      'CHANGELOG_OLD.md',
    ],
  },
];
