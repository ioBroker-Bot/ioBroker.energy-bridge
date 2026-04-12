<img src="admin/energy-bridge.svg" width="64">

# iobroker.energy-bridge

# EnergyBridge Adapter

EnergyBridge integriert Energiegeräte in **ioBroker** über Templates (**Kategorie → Hersteller → Template**).

Unterstützte Protokolle (abhängig vom Template): **Modbus TCP/RTU/ASCII**, **MQTT**, **HTTP/JSON**, **UDP**, **M‑Bus**, **Speedwire**, **1‑Wire**.

**Community‑Edition:** Industrie-/Utility-Templates sind bewusst **nicht** enthalten (z. B. **TESVOLT**, **SMA Core1 / STP125**, **Alpitronic** DC‑Schnelllader, industrielle I/O‑Module).

## Geräte (Kurzüberblick)

> Die komplette Liste findest du in der Admin‑UI: **Gerät hinzufügen → Kategorie / Hersteller / Template**.

- PV‑Wechselrichter: FoxESS, Goodwe, KACO, Kostal, SMA (STPxx‑50, STPxx‑US‑41, Sunny Tripower X), SolaX, Solar‑Log, SunSpec, Victron
- Zähler: Janitza, Socomec, Siemens, Eastron, ABB, Carlo Gavazzi, Victron, SunSpec, M‑Bus, …
- Wallboxen: go‑e, KEBA, ABL, openWB, Webasto, Heidelberg, Mennekes, SolaX, Spelsberg
- Speicher/ESS: FENECON, FoxESS, Kostal, SolaX, Tesla, BYD, Pylontech, SMA, Victron, REFU, Sinexcel, Samsung, ADS‑TEC, …
- Wärme / Power‑to‑Heat: TECALOR, LAMBDA, myPV, Askoma
- IO / Sensorik: Shelly, 1‑Wire (DS18B20)

## Voraussetzungen

- Node.js >= 20
- ioBroker js-controller >= 6.0.11
- ioBroker admin >= 7.6.20

## Einrichtung

1. Adapter über die ioBroker‑Adapterliste installieren.
2. Instanz anlegen und die Konfiguration in Admin öffnen.
3. Im Tab **Allgemein** Poll‑Intervall/Timeouts anpassen.
4. Im Tab **Geräte** Geräte über den Template‑Wizard hinzufügen (**Kategorie → Hersteller → Template**).
5. Optional kannst du **Import/Export** nutzen, um die Geräte‑Liste zu sichern oder zu migrieren.

