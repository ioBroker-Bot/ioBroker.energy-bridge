<img src="admin/energy-bridge.svg" width="64">

# iobroker.energy-bridge

![Number of Installations](http://iobroker.live/badges/energy-bridge-installed.svg)
![Number of Installations](http://iobroker.live/badges/energy-bridge-stable.svg)
[![NPM version](http://img.shields.io/npm/v/iobroker.energy-bridge.svg)](https://www.npmjs.com/package/iobroker.energy-bridge)

![Test and Release](https://github.com/NexoWatt/ioBroker.energy-bridge/workflows/Test%20and%20Release/badge.svg)
[![Translation status](https://weblate.iobroker.net/widgets/adapters/-/energy-bridge/svg-badge.svg)](https://weblate.iobroker.net/engage/adapters/?utm_source=widget)
[![Downloads](https://img.shields.io/npm/dm/iobroker.energy-bridge.svg)](https://www.npmjs.com/package/iobroker.energy-bridge)

# EnergyBridge Adapter

EnergyBridge integrates energy devices into **ioBroker** using templates (**Category → Manufacturer → Template**).

Supported transports (depends on the selected template): **Modbus TCP/RTU/ASCII**, **MQTT**, **HTTP/JSON**, **UDP**, **M‑Bus**, **Speedwire**, **1‑Wire**.

**Community edition scope:** Industrial/utility templates are intentionally excluded (for example **TESVOLT**, **SMA Core1 / STP125**, **Alpitronic** DC fast chargers, and industrial I/O modules).

For a German version of this documentation, see `README.de.md`.

## Implemented devices (overview)

> The list below is only a short overview. Template definitions are stored in `lib/templates.json`.

- **PV inverters:** FoxESS, Goodwe, KACO, Kostal, SMA (STPxx‑50, STPxx‑US‑41, Sunny Tripower X), SolaX, Solar‑Log, SunSpec, Victron
- **Meters:** Janitza, Socomec, Siemens, Eastron, ABB, Carlo Gavazzi, Victron, SunSpec, M‑Bus, …
- **EV chargers / wallboxes:** go‑e, KEBA, ABL, openWB, Webasto, Heidelberg, Mennekes, SolaX, Spelsberg
- **Battery / ESS:** FENECON, FoxESS, Kostal, SolaX, Tesla, BYD, Pylontech, SMA, Victron, REFU, Sinexcel, Samsung, ADS‑TEC, …
- **Heat / power‑to‑heat:** TECALOR, LAMBDA, myPV, Askoma
- **IO / sensors:** Shelly, 1‑Wire (DS18B20)

## Requirements

- **Node.js >= 20**
- **ioBroker js-controller >= 6.0.11**
- **ioBroker admin >= 7.6.20**
- Network access to the devices (IP/port, and Modbus Unit ID if applicable)

## Setup

1. Install the adapter via the ioBroker adapter list.
2. Create an instance and open its configuration in Admin UI.
3. In the **General** tab, adjust polling interval/timeouts as required.
4. In the **Devices** tab, add devices using the template wizard (**Category → Manufacturer → Template**).
5. Optionally use **Import/Export** to back up or migrate your device list.


## Notes

- Write access is optional and depends on the selected template.
- The adapter automatically creates the required objects/states in ioBroker.

It uses the libraries [modbus-serial](https://www.npmjs.com/package/modbus-serial), [mqtt](https://www.npmjs.com/package/mqtt) and [axios](https://www.npmjs.com/package/axios) to communicate with devices.

## Changelog

### 0.1.16 (2026-04-11)
- (ui) Modern Admin UI styling (responsive layout, proper modal, dark/light theme-aware colors)


### 0.1.15 (2026-04-11)
- (fix) Switch admin UI back to **React template wizard** (Category → Manufacturer → Template)
- (fix) Remove jsonConfig UI (device JSON editor was not usable for template selection)


### 0.1.14 (2026-04-11)
- (housekeeping) Prepare Admin UI refactoring (jsonConfig experiment)
- (housekeeping) Update linting setup to @iobroker/eslint-config (flat config)
- (housekeeping) Update CI test matrix (Node 20/22/24 + Linux/Windows/macOS)
- (fix) Normalize datapoint state IDs (more readable)
- (fix) Use node: imports for built-in modules
- (fix) Remove code that modified system objects


### 0.1.13 (2026-03-22)
* (Nexowatt) Maintenance: fix repository-checker warnings and stabilize CI.

### 0.1.12 (2026-03-22)

- (Nexowatt) CI/metadata: mark the React Admin UI as **html** (`common.adminUI`) and adjust linting/CI.

### 0.1.11 (2026-03-20)

- (Nexowatt) Admin UI migrated to React (restored device selection wizard).

### 0.1.9 (2026-03-19)

- (Nexowatt) Fix: add missing Admin i18n translation files and JSON config layout sizes (repository-checker compliance).


### 0.1.7 (2026-03-19)

- (Nexowatt) Switch configuration UI to Admin 5 JSON config and show live instance status.

### 0.1.6 (2026-03-18)

- (Nexowatt) Documentation update: README is now English-only (repository-checker compliance).

### 0.1.5 (2026-03-18)

- (Nexowatt) Version bump and maintenance updates.

### 0.1.4 (2026-03-17)

- (Nexowatt) Version sync (package.json/io-package.json) and add missing `common.news` entry for 0.1.4.

### 0.1.3 (2026-03-16)

- (Nexowatt) Repository-checker cleanup: Node.js >=20, update `@iobroker/adapter-core`, add missing translations, add `protectedNative` for encrypted config, update admin dependency, remove deprecated `common.title`.
- (Nexowatt) Dev tooling: add ESLint config, recommend VS Code JSON schemas, add `@iobroker/adapter-dev`.

### 0.1.2 (2026-03-16)

- (Nexowatt) Align repository metadata with NPM latest (0.1.2) and add missing `common.news` entry.

### 0.1.1 (2026-03-16)

- (Nexowatt) Repository-checker fixes and release-script setup.

### 0.1.0 (2026-02-23)

- (Nexowatt) Initial community release (industrial/utility templates intentionally excluded).

## License

The MIT License (MIT)

Copyright (c) 2026 Nexowatt <info@nexowatt.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
