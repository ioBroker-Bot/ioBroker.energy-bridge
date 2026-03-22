# Changelog

## **WORK IN PROGRESS**

- (nothing yet)


## 0.1.12 (2026-03-22)

- CI/metadata: mark the React Admin UI as **html** (`common.adminUI`) and adjust linting/CI so "Test and Release" can pass.


## 0.1.11 (2026-03-20)

- Admin UI migrated to a React-based configuration page (device selection wizard restored).
- Version bump.


## 0.1.10 (2026-03-20)

- Admin UI migrated to a React-based configuration page (device selection wizard restored).

## 0.1.9 (2026-03-19)

- (Nexowatt) Fix: add missing Admin i18n translation files and JSON config layout sizes (repository-checker compliance).


## 0.1.7 (2026-03-19)

- Switch configuration UI to Admin 5 JSON config and show live instance status.

## 0.1.6 (2026-03-18)

- Documentation update: README is now English-only (repository-checker compliance).


## 0.1.5 (2026-03-18)

- Version bump and repository-checker maintenance updates.

## 0.1.4 (2026-03-17)

- Version sync (`package.json`/`io-package.json`) and add missing `common.news` entry for 0.1.4.

## 0.1.3 (2026-03-16)

- Repository-checker cleanup: Node.js >=20, update `@iobroker/adapter-core`, remove duplicate test deps, add missing translations, add `protectedNative`, update admin dependency, remove deprecated `common.title`.
- Dev tooling: add ESLint config, recommend VS Code JSON schemas, add `@iobroker/adapter-dev`.

## 0.1.2 (2026-03-16)

- Align repository metadata with NPM latest (0.1.2) and add missing `common.news` entry.
- Update README to ioBroker standard format (badges, DE/EN description, changelog + full MIT license).

## 0.1.1 (2026-03-16)

- Fix repository-checker compliance (version sync, `common.news`, README requirements).
- Add `@alcalzone/release-script` (+ ioBroker/license/manual-review plugins) and `.releaseconfig.json` for easier releases.
- Streamline README to a compact English overview (plus short device list).

## 0.1.0 (2026-02-23)

- Initial community release.
- **Community scope:** industrial/utility templates are intentionally excluded (e.g. **TESVOLT**, **SMA Core1/STP125**, **Alpitronic** DC fast chargers, and industrial I/O modules).
- Added CI test workflow (GitHub Actions) and ioBroker unit/integration test scaffolding.
- Stored device configuration (`devicesJson`) as encrypted native configuration and masked passwords in the Admin JSON preview.
