'use strict';

const path = require('node:path');


function normalizeStateSuffix(id) {
  let s = String(id ?? '').trim();
  if (!s) return 'dp';

  // Replace all non-alphanumeric characters with underscores
  s = s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) return 'dp';

  if (s.includes('_')) {
    const parts = s.split('_').filter(Boolean).map(p => p.toLowerCase());
    if (parts.length === 0) return 'dp';
    s = parts[0] + parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  } else {
    // Normalize weird "aCTIVEPOWER" / "SOC" cases
    if (/^[A-Z0-9]+$/.test(s) || /^[a-z][A-Z0-9]+$/.test(s)) {
      s = s.toLowerCase();
    } else {
      s = s.charAt(0).toLowerCase() + s.slice(1);
    }
  }

  // ioBroker ids must not start with a digit
  if (/^[0-9]/.test(s)) s = `dp${s}`;

  return s;
}
const { roundTo, normalizeValueByUnit } = require('./utils');
const { ModbusDriver } = require('./drivers/modbus');
const { MqttDriver } = require('./drivers/mqtt');
const { CanbusDriver } = require('./drivers/canbus');
const { HttpDriver } = require('./drivers/http');
const { UdpDriver } = require('./drivers/udp');
const { SpeedwireDriver } = require('./drivers/speedwire');
const { OneWireDriver } = require('./drivers/onewire');
const { MbusDriver } = require('./drivers/mbus');

class DeviceRuntime {
  constructor(adapter, deviceConfig, template, globalConfig) {
    this.adapter = adapter;
    this.cfg = deviceConfig;
    this.template = template;
    this.global = globalConfig || {};

    this.baseId = `devices.${this.cfg.id}`;
    this.dpByStateRelId = new Map(); // relId -> dpDef
    this.dpById = new Map(); // dpId -> dpDef

    // Alias states: stable datapoint names across different manufacturers/templates.
    // These are created under: devices.<id>.aliases.*
    this.aliasByStateRelId = new Map(); // relId -> aliasDef
    this.aliasDefs = []; // list of aliasDef

    this.driver = null;
    this.pollTimer = null;
    this._pollLoopActive = false;

    // Stop optional write loop and clear queued writes
    try {
      this._writeQueueEnabled = false;
      this._stopWriteLoop();
      if (this._writeQueue) this._writeQueue.clear();
      this._writeBusy = false;
    } catch (e) {
      // ignore
    }
    this.watchdogTimer = null;
    this.watchdogStartTimer = null;
    this._watchdogCounter = 0;
    this._watchdogBusy = false;
    this._connOk = false;

    // Track recent writes to datapoints. This enables safe watchdog behavior
    // where watchdog values are only refreshed while an external controller
    // is actively sending setpoints.
    this._lastWriteByDpId = new Map(); // dpId -> unix ms

    // Fail-safe control flags for watchdog-managed "VK" interfaces (e.g. TESVOLT).
    this._autoWatchdogControlEverActive = false;
    this._autoWatchdogControlDisabled = false;
    // Error log throttling (avoid log spam on persistent comm errors)
    this._lastErrorLogMsg = '';
    this._lastErrorLogTs = 0;

    // Optional write throttling / coalescing (needed for devices that require >=1s between Modbus commands).
    // Enabled via template driverHints.modbus.writeThrottleMs.
    this._writeThrottleMs = 0;
    this._writeQueueMaxPerTick = 1;
    this._writeQueue = new Map(); // dpId -> { dp, deviceValue, ackByRelId, attempts, isPreWrite, preWriteTriggerDpId }
    this._writeLoopActive = false;
    this._writeTimer = null;
    this._writeLoopBusy = false;

    // Pre-write throttling: remember when a preWrite sequence for a trigger datapoint was last executed.
    this._preWriteLastTsByTrigger = new Map();

    // Optional command cadence scheduler: on each cadence tick we perform either a poll (if due) or one queued write.
    // Enabled via template driverHints.modbus.commandCadenceMs (e.g. SolaX recommends >=1s between instructions).
    this._commandCadenceMs = 0;

    // --- Heartbeat / Liveness (safety-critical) ---
    // Always exposed via stable alias states:
    //   devices.<id>.aliases.r.heartbeat    (number counter)
    //   devices.<id>.aliases.r.lastSeenMs   (unix ms)
    //   devices.<id>.aliases.r.online       (boolean)
    // Updated ONLY on real incoming data:
    // - polling protocols: successful read cycle
    // - speedwire: only when a new telegram arrives (not when serving cached values)
    // - mqtt/canbus: incoming messages/frames
    this._hbCounter = 0;
    this._hbLastSeen = 0;
    this._hbOnline = false;
    this._hbTimeoutMs = 0;
    this._hbLastWriteAt = 0;
    this._hbCheckTimer = null;
    this._hbLastSourceStamp = 0;

    this.started = false;
  }

  getDatapoints() {
    return (this.template && Array.isArray(this.template.datapoints)) ? this.template.datapoints : [];
  }

  relStateId(dp) {
    return `${this.baseId}.${normalizeStateSuffix(dp.id)}`;
  }

  async initObjects() {
    await this.adapter.setObjectNotExistsAsync(this.baseId, {
      type: 'channel',
      common: { name: this.cfg.name || this.cfg.id },
      native: {
        deviceId: this.cfg.id,
        templateId: this.cfg.templateId,
        category: this.cfg.category,
        manufacturer: this.cfg.manufacturer,
      }
    });

    await this.adapter.setObjectNotExistsAsync(`${this.baseId}.info`, {
      type: 'channel',
      common: { name: 'Info' },
      native: {}
    });

    await this.adapter.setObjectNotExistsAsync(`${this.baseId}.info.connection`, {
      type: 'state',
      common: {
        name: 'Connection',
        type: 'boolean',
        role: 'indicator.connected',
        read: true,
        write: false,
        def: false
      },
      native: {}
    });

    await this.adapter.setObjectNotExistsAsync(`${this.baseId}.info.lastError`, {
      type: 'state',
      common: {
        name: 'Last error',
        type: 'string',
        role: 'text',
        read: true,
        write: false,
        def: ''
      },
      native: {}
    });

    const dps = this.getDatapoints();
    for (const dp of dps) {
      const relId = this.relStateId(dp);

      const src = dp.source || {};
      const common = {
        name: dp.name || dp.id,
        type: dp.type || 'number',
        role: dp.role || 'value',
        read: dp.rw !== 'wo',
        write: dp.rw === 'rw' || dp.rw === 'wo',
      };

      // Keep units consistent across protocols (important for alias normalization).
      if (dp.unit !== undefined && dp.unit !== null && dp.unit !== '') {
        common.unit = dp.unit;
      }

      // Provide deterministic display formatting in ioBroker front-ends.
      // (Value rounding is applied on every poll; this is the corresponding meta-data.)
      if ((common.type || '').toString().toLowerCase() === 'number') {
        const dec = this._getRoundingDecimals(dp);
        if (typeof dec === 'number' && Number.isFinite(dec) && dec >= 0 && dec <= 10) {
          common.decimals = dec;
        }
      }

      await this.adapter.setObjectNotExistsAsync(relId, {
        type: 'state',
        common,
        native: {
          deviceId: this.cfg.id,
          templateId: this.cfg.templateId,
          datapointId: dp.id,
          source: src,
        }
      });

      // Keep object meta-data (e.g. unit/role) in sync when templates evolve.
      // This is important for consistent units (e.g. kW instead of W) without forcing users to delete objects.
      await this.adapter.extendObjectAsync(relId, {
        common,
        native: {
          deviceId: this.cfg.id,
          templateId: this.cfg.templateId,
          datapointId: dp.id,
          source: src,
        }
      }).catch(() => {});

      this.dpByStateRelId.set(relId, dp);
      this.dpById.set(dp.id, dp);
    }

    // Create stable alias states (optional per template/category).
    try {
      await this._initAliasObjects();
    } catch (e) {
      // Alias creation must never break device start.
      this.adapter.log.debug(`[${this.cfg.id}] alias init failed: ${e && e.message ? e.message : e}`);
    }

    // Heartbeat alias states are always available for every device/template.
    // These are used by safety-critical higher-level logic (e.g. charge management fail-safe).
    try {
      await this._initHeartbeatAliasObjects();
    } catch (e) {
      this.adapter.log.debug(`[${this.cfg.id}] heartbeat alias init failed: ${e && e.message ? e.message : e}`);
    }
  }

  _getDpByRole(role) {
    const dps = this.getDatapoints();
    for (const dp of dps) {
      if (!dp || !dp.role) continue;
      if (dp.role === role) return dp;
    }
    return null;
  }

  _getDpById(id) {
    if (!id) return null;
    return this.dpById.get(id) || null;
  }

  _findFirstDatapoint(predicate) {
    const dps = this.getDatapoints();
    for (const dp of dps) {
      if (!dp) continue;
      try {
        if (predicate(dp)) return dp;
      } catch (e) {
        // ignore
      }
    }
    return null;
  }
  _getRoundingDecimals(dp) {
    // Adapter-wide rounding policy to keep state values readable and to avoid
    // Modbus/MQTT floating point artefacts (e.g. 0.30000000004).
    //
    // Rules:
    // - SoC (battery/storage): 1 decimal
    // - SoC (EV connector): 0 decimals
    // - Power: kW/kVA/kvar -> 2 decimals, W/VA/var -> 0 decimals
    // - Energy: kWh -> 2 decimals, Wh -> 0 decimals
    // - Everything else numeric: 2 decimals (default), except status-like unitless values -> 0

    if (!dp) return null;

    const unit = (dp.unit ?? '').toString().trim();
    const unitLower = unit.toLowerCase();
    const roleLower = (dp.role ?? '').toString().toLowerCase();

    const id = (dp.id ?? '').toString();
    const name = (dp.name ?? '').toString();

    // --- SoC ---
    const looksLikeSoc =
      /(^|[^a-z0-9])soc([^a-z0-9]|$)/i.test(id) ||
      /(^|[^a-z0-9])soc([^a-z0-9]|$)/i.test(name) ||
      roleLower === 'value.battery';

    const looksLikeEvConnectorSoc =
      /^c\d+_soc$/i.test(id) ||
      /connector\s*\d*\s*soc/i.test(name) ||
      /ev\s*connector/i.test(name);

    if (looksLikeSoc) {
      if (looksLikeEvConnectorSoc) return 0;
      return 1;
    }

    // --- Power ---
    const looksLikePower =
      roleLower.includes('power') ||
      ['w', 'kw', 'va', 'kva', 'var', 'kvar'].includes(unitLower);

    if (looksLikePower) {
      if (['w', 'va', 'var'].includes(unitLower)) return 0;
      if (['kw', 'kva', 'kvar'].includes(unitLower)) return 2;
      return 2;
    }

    // --- Energy ---
    const looksLikeEnergy =
      roleLower.includes('energy') ||
      ['wh', 'kwh'].includes(unitLower);

    if (looksLikeEnergy) {
      if (unitLower === 'wh') return 0;
      if (unitLower === 'kwh') return 2;
      return 2;
    }

    // --- Status / enums (unitless) ---
    const looksLikeStatus =
      roleLower.startsWith('indicator.') ||
      roleLower.includes('status') ||
      /status|state|mode|code|fault|error/i.test(id) ||
      /status|state|mode|code|fault|error/i.test(name);

    if (looksLikeStatus && !unitLower) return 0;

    // Default: 2 decimals for all other numeric values.
    return 2;
  }

  _aliasRelId(aliasPath) {
    // Always place aliases under: devices.<id>.aliases.<...>
    return `${this.baseId}.aliases.${aliasPath}`;
  }

  // --- Heartbeat alias helpers ---
  _hbRelId(name) {
    return this._aliasRelId(`r.${name}`);
  }

  _normalizeMs(v) {
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? Math.trunc(n) : 0;
  }

  async _initHeartbeatAliasObjects() {
    // Ensure channel path exists (devices.<id>.aliases.r)
    await this._ensureAliasPathChannels(this._hbRelId('heartbeat'));

    const defs = [
      {
        relId: this._hbRelId('heartbeat'),
        name: 'Heartbeat counter',
        role: 'value',
        type: 'number',
        def: 0,
      },
      {
        relId: this._hbRelId('lastSeenMs'),
        name: 'Last seen (unix ms)',
        role: 'value.time',
        type: 'number',
        def: 0,
      },
      {
        relId: this._hbRelId('online'),
        name: 'Online (heartbeat)',
        role: 'indicator.connected',
        type: 'boolean',
        def: false,
      },
    ];

    for (const def of defs) {
      const common = {
        name: def.name,
        type: def.type,
        role: def.role,
        read: true,
        write: false,
        def: def.def,
      };

      await this.adapter.setObjectNotExistsAsync(def.relId, {
        type: 'state',
        common,
        native: {
          deviceId: this.cfg.id,
          templateId: this.cfg.templateId,
          isAlias: true,
          aliasKind: 'heartbeat',
        }
      });

      // Keep meta-data in sync across updates
      await this.adapter.extendObjectAsync(def.relId, {
        common,
        native: {
          deviceId: this.cfg.id,
          templateId: this.cfg.templateId,
          isAlias: true,
          aliasKind: 'heartbeat',
        }
      }).catch(() => {});
    }
  }

  _computeHeartbeatTimeoutMs({ fastIntervalMs, isEventDriven } = {}) {
    // Priority:
    //  1) per-device override: cfg.heartbeatTimeoutMs
    //  2) template hint: driverHints.heartbeatTimeoutMs
    //  3) protocol-derived default
    const cfgMs = this._normalizeMs(this.cfg?.heartbeatTimeoutMs);
    if (cfgMs > 0) return cfgMs;

    const tplMs = this._normalizeMs(this.template?.driverHints?.heartbeatTimeoutMs);
    if (tplMs > 0) return tplMs;

    const proto = String(this.cfg?.protocol || '').toLowerCase();
    const isSpeedwire = proto === 'speedwire';

    if (isEventDriven || proto === 'mqtt' || proto === 'canbus') {
      return 30000;
    }

    if (isSpeedwire) {
      const stale = this._normalizeMs(this.cfg?.connection?.staleTimeoutMs) || 30000;
      return Math.max(stale, 30000);
    }

    const poll = this._normalizeMs(fastIntervalMs);
    if (poll > 0) return Math.max(3 * poll, 15000);
    return 30000;
  }

  async _loadHeartbeatStateFromDb() {
    // Best-effort: keep heartbeat counter monotonic across adapter restarts.
    try {
      const [hb, lastSeen] = await Promise.all([
        this.adapter.getStateAsync(this._hbRelId('heartbeat')).catch(() => null),
        this.adapter.getStateAsync(this._hbRelId('lastSeenMs')).catch(() => null),
      ]);

      const hbVal = hb && hb.val !== undefined ? Number(hb.val) : 0;
      if (Number.isFinite(hbVal) && hbVal >= 0) this._hbCounter = Math.trunc(hbVal);

      const lsVal = lastSeen && lastSeen.val !== undefined ? Number(lastSeen.val) : 0;
      if (Number.isFinite(lsVal) && lsVal > 0) this._hbLastSeen = Math.trunc(lsVal);
    } catch (_) {
      // ignore
    }
  }

  async _setHeartbeatOnline(nextOnline) {
    const b = !!nextOnline;
    if (b === this._hbOnline) return;
    this._hbOnline = b;
    await this.adapter.setStateAsync(this._hbRelId('online'), { val: b, ack: true }).catch(() => {});
  }

  async _tickHeartbeatFromIncomingData(sourceStamp) {
    // sourceStamp: optional monotonic marker that only changes when *new* data arrived
    // (e.g., Speedwire lastSeen timestamp). If provided, we only tick when it changes.
    if (!this.started) return;
    const now = Date.now();

    if (sourceStamp !== undefined && sourceStamp !== null) {
      const s = Number(sourceStamp) || 0;
      if (s <= 0) return;
      if (s === this._hbLastSourceStamp) {
        // No fresh data since last tick (e.g. Speedwire soft-stale serving cached values)
        this._hbLastSeen = Math.max(this._hbLastSeen, s);
        return;
      }
      this._hbLastSourceStamp = s;
      this._hbLastSeen = s;
    } else {
      this._hbLastSeen = now;
    }

    // Flip online immediately when we see the device alive
    if (!this._hbOnline) {
      await this._setHeartbeatOnline(true);
    }

    // Throttle writes to max 1 Hz per device
    if (this._hbLastWriteAt && (now - this._hbLastWriteAt) < 1000) return;
    this._hbLastWriteAt = now;

    this._hbCounter = (Number.isFinite(this._hbCounter) ? this._hbCounter : 0) + 1;
    if (this._hbCounter > 2147480000) this._hbCounter = 1;

    await this.adapter.setStateAsync(this._hbRelId('heartbeat'), { val: this._hbCounter, ack: true }).catch(() => {});
    await this.adapter.setStateAsync(this._hbRelId('lastSeenMs'), { val: this._hbLastSeen || now, ack: true }).catch(() => {});
  }

  _startHeartbeatChecker() {
    if (this._hbCheckTimer) {
      try { this.adapter.clearInterval(this._hbCheckTimer); } catch (_) {}
      this._hbCheckTimer = null;
    }

    if (!this._hbTimeoutMs || this._hbTimeoutMs <= 0) return;

    this._hbCheckTimer = this.adapter.setInterval(() => {
      try {
        if (!this.started) return;
        const now = Date.now();
        const last = Number(this._hbLastSeen) || 0;
        const age = last > 0 ? (now - last) : Number.POSITIVE_INFINITY;
        const nextOnline = (last > 0) && (age <= this._hbTimeoutMs);
        if (nextOnline !== this._hbOnline) {
          this._setHeartbeatOnline(nextOnline).catch(() => {});
        }
      } catch (_) {
        // ignore
      }
    }, 1000);
  }

  async _ensureChannel(relId, name) {
    await this.adapter.setObjectNotExistsAsync(relId, {
      type: 'channel',
      common: { name: name || relId.split('.').slice(-1)[0] },
      native: {
        deviceId: this.cfg.id,
        templateId: this.cfg.templateId,
        isAliasContainer: true,
      }
    });
  }

  async _ensureAliasPathChannels(stateRelId) {
    // Example: devices.<id>.aliases.ctrl.powerLimitPct
    // Create channels for: devices.<id>.aliases and devices.<id>.aliases.ctrl
    const parts = String(stateRelId).split('.');
    // Find index of "aliases" in the path
    const idx = parts.indexOf('aliases');
    if (idx < 0) return;

    const channels = [];
    // Build incremental channel ids up to the parent of the state
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (p === '') continue;
      const rel = parts.slice(0, i + 1).join('.');
      if (i >= idx) channels.push(rel);
    }

    // Ensure base aliases channel has a friendly name
    for (const ch of channels) {
      const chName = ch.endsWith('.aliases') ? 'Aliases' : ch.split('.').slice(-1)[0];
      await this._ensureChannel(ch, chName);
    }
  }

  _buildAliasDefinitions() {
    const defs = [];
    const relIds = new Set();
    const add = (def) => {
      if (!def || !def.relId) return;
      if (relIds.has(def.relId)) return;
      relIds.add(def.relId);
      defs.push(def);
    };

    const cat = (this.template && this.template.category) ? String(this.template.category) : '';
    const chargerCats = new Set(['EVCS', 'EVSE', 'CHARGER', 'DC_CHARGER']);

    const findByIdRe = (re) => this._findFirstDatapoint(dp => re.test(String(dp && dp.id ? dp.id : '')));
    const findByIdOrNameRe = (re) => this._findFirstDatapoint(dp =>
      re.test(String(dp && dp.id ? dp.id : '')) || re.test(String(dp && dp.name ? dp.name : ''))
    );

    const getAnyById = (...ids) => {
      for (const id of ids) {
        const dp = this._getDpById(id);
        if (dp) return dp;
      }
      return null;
    };

    // --- Always available (communication) ---
    add({
      relId: this._aliasRelId('comm.connected'),
      name: 'Device communication connected',
      role: 'indicator.connected',
      type: 'boolean',
      rw: 'ro',
      kind: 'computed',
      get: (_values, ctx) => !!(ctx && ctx.connected),
    });

    add({
      relId: this._aliasRelId('comm.lastError'),
      name: 'Device communication last error',
      role: 'text',
      type: 'string',
      rw: 'ro',
      kind: 'computed',
      get: (_values, ctx) => (ctx && typeof ctx.lastError === 'string') ? ctx.lastError : '',
    });

    add({
      relId: this._aliasRelId('alarm.offline'),
      name: 'Device offline',
      role: 'indicator.alarm',
      type: 'boolean',
      rw: 'ro',
      kind: 'computed',
      get: (_values, ctx) => !(ctx && ctx.connected),
    });

    // --- Generic role-based aliases (best-effort) ---
    // Only use these for categories where roles are typically reliable and where "first match wins" is acceptable.
    // For meters, chargers, batteries and ESS we create dedicated alias mapping further below.
    const allowGenericRoleAliases = !chargerCats.has(cat) && !['METER', 'BATTERY', 'ESS', 'BATTERY_INVERTER'].includes(cat);

    if (allowGenericRoleAliases) {
      const powerDp = getAnyById('W') || this._findFirstDatapoint(dp => dp.role === 'value.power' && dp.rw !== 'wo');
      if (powerDp) {
        add({
          relId: this._aliasRelId('r.power'),
          name: 'Active power',
          role: 'value.power',
          type: 'number',
          unit: powerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: powerDp.id,
        });
      }

      const energyDp = getAnyById('WH', 'TotWhOut') || this._findFirstDatapoint(dp => dp.role === 'value.energy' && dp.rw !== 'wo');
      if (energyDp) {
        add({
          relId: this._aliasRelId('r.energyTotal'),
          name: 'Total energy',
          role: 'value.energy',
          type: 'number',
          unit: energyDp.unit || 'Wh',
          rw: 'ro',
          kind: 'dp',
          dpId: energyDp.id,
        });
      }

      const statusDp = getAnyById('Health', 'St') || this._findFirstDatapoint(dp => dp.role === 'indicator.status' && dp.rw !== 'wo');
      if (statusDp) {
        add({
          relId: this._aliasRelId('r.statusCode'),
          name: 'Status code',
          role: 'indicator.status',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: statusDp.id,
        });
      }
    }



    // --- HEAT aliases (heat pumps / heating systems) ---
    // Provide a stable API for heat pumps so that higher-level control adapters can link
    // against consistent alias names even if manufacturers label datapoints differently.
    if (cat === 'HEAT') {
      const asNumber = (v) => {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') {
          const s = v.trim();
          if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
        }
        return undefined;
      };

      // Temperatures (best effort)
      const ambientTempDp = getAnyById(
        'ambient.actualAmbientTemp',
        'ambient.calculatedAmbientTemp',
        'ambient.avgAmbientTemp1h'
      ) || findByIdOrNameRe(/ambient.*temp|outside.*temp|outdoor.*temp|au[ßs]en.*temp/i);

      if (ambientTempDp) {
        add({
          relId: this._aliasRelId('r.ambientTemp'),
          name: 'Ambient temperature',
          role: 'value.temperature',
          type: 'number',
          unit: ambientTempDp.unit || '°C',
          rw: 'ro',
          kind: 'dp',
          dpId: ambientTempDp.id,
        });
      }

      const flowTempDp = getAnyById(
        'hc.flowTemp',
        'hp.sinkLineTemp',
        'buffer.tempHigh'
      ) || findByIdOrNameRe(/flow.*temp|vorlauf.*temp|supply.*temp/i);

      if (flowTempDp) {
        add({
          relId: this._aliasRelId('r.flowTemp'),
          name: 'Flow / supply temperature',
          role: 'value.temperature',
          type: 'number',
          unit: flowTempDp.unit || '°C',
          rw: 'ro',
          kind: 'dp',
          dpId: flowTempDp.id,
        });
      }

      const returnTempDp = getAnyById(
        'hc.returnTemp',
        'hp.sinkReturnLineTemp',
        'buffer.tempLow'
      ) || findByIdOrNameRe(/return.*temp|ruecklauf.*temp|rücklauf.*temp/i);

      if (returnTempDp) {
        add({
          relId: this._aliasRelId('r.returnTemp'),
          name: 'Return temperature',
          role: 'value.temperature',
          type: 'number',
          unit: returnTempDp.unit || '°C',
          rw: 'ro',
          kind: 'dp',
          dpId: returnTempDp.id,
        });
      }

      const roomTempDp = getAnyById('hc.roomTemp') || findByIdOrNameRe(/room.*temp|raum.*temp/i);
      if (roomTempDp) {
        add({
          relId: this._aliasRelId('r.roomTemp'),
          name: 'Room temperature',
          role: 'value.temperature',
          type: 'number',
          unit: roomTempDp.unit || '°C',
          rw: 'ro',
          kind: 'dp',
          dpId: roomTempDp.id,
        });
      }

      const bufferTempDp = getAnyById(
        'buffer.tempHigh',
        'buffer.tempMedium',
        'buffer.tempLow'
      ) || findByIdOrNameRe(/buffer.*temp|puffer.*temp/i);

      if (bufferTempDp) {
        add({
          relId: this._aliasRelId('r.bufferTemp'),
          name: 'Buffer temperature',
          role: 'value.temperature',
          type: 'number',
          unit: bufferTempDp.unit || '°C',
          rw: 'ro',
          kind: 'dp',
          dpId: bufferTempDp.id,
        });
      }

      // Controls (best effort)
      const operatingModeDp = getAnyById('hc.operatingMode') || this._findFirstDatapoint(dp =>
        /operatingMode|betriebsmodus/i.test(String(dp && dp.id ? dp.id : '')) && (dp.rw === 'rw' || dp.rw === 'wo')
      );

      if (operatingModeDp) {
        add({
          relId: this._aliasRelId('ctrl.operatingMode'),
          name: 'Set operating mode',
          role: 'level',
          type: 'number',
          rw: 'rw',
          kind: 'dp',
          dpId: operatingModeDp.id,
          writeDpId: operatingModeDp.id,
        });
      }

      const flowSetpointDp = getAnyById(
        'hc.setFlowTempRequest',
        'hp.requestFlowLineTemp',
        'buffer.requestFlowLineTemp'
      ) || this._findFirstDatapoint(dp =>
        /setFlow|flow.*request|vorlauf.*request/i.test(String(dp && dp.id ? dp.id : '')) && (dp.rw === 'rw' || dp.rw === 'wo')
      );

      if (flowSetpointDp) {
        add({
          relId: this._aliasRelId('ctrl.flowSetpoint'),
          name: 'Set flow/supply setpoint',
          role: 'level.temperature',
          type: 'number',
          unit: flowSetpointDp.unit || '°C',
          rw: 'rw',
          kind: 'dp',
          dpId: flowSetpointDp.id,
          writeDpId: flowSetpointDp.id,
        });
      }

      const roomHeatSpDp = getAnyById('hc.roomSetpointHeating') || this._findFirstDatapoint(dp =>
        /roomSetpointHeating|raum.*heizen/i.test(String(dp && dp.id ? dp.id : '')) && (dp.rw === 'rw' || dp.rw === 'wo')
      );

      if (roomHeatSpDp) {
        add({
          relId: this._aliasRelId('ctrl.roomSetpointHeating'),
          name: 'Set room setpoint (heating)',
          role: 'level.temperature',
          type: 'number',
          unit: roomHeatSpDp.unit || '°C',
          rw: 'rw',
          kind: 'dp',
          dpId: roomHeatSpDp.id,
          writeDpId: roomHeatSpDp.id,
        });
      }

      const roomCoolSpDp = getAnyById('hc.roomSetpointCooling') || this._findFirstDatapoint(dp =>
        /roomSetpointCooling|raum.*kuehlen|raum.*kühlen/i.test(String(dp && dp.id ? dp.id : '')) && (dp.rw === 'rw' || dp.rw === 'wo')
      );

      if (roomCoolSpDp) {
        add({
          relId: this._aliasRelId('ctrl.roomSetpointCooling'),
          name: 'Set room setpoint (cooling)',
          role: 'level.temperature',
          type: 'number',
          unit: roomCoolSpDp.unit || '°C',
          rw: 'rw',
          kind: 'dp',
          dpId: roomCoolSpDp.id,
          writeDpId: roomCoolSpDp.id,
        });
      }

      const heatingCapacityDp = getAnyById('buffer.requestHeatingCapacity') || this._findFirstDatapoint(dp =>
        /heatingCapacity|heizleistung/i.test(String(dp && dp.id ? dp.id : '')) && (dp.rw === 'rw' || dp.rw === 'wo')
      );

      if (heatingCapacityDp) {
        add({
          relId: this._aliasRelId('ctrl.requestHeatingCapacity'),
          name: 'Set requested heating capacity',
          role: 'level.power',
          type: 'number',
          unit: heatingCapacityDp.unit || 'kW',
          rw: 'rw',
          kind: 'dp',
          dpId: heatingCapacityDp.id,
          writeDpId: heatingCapacityDp.id,
        });
      }

      // Optional: feed an external power signal into the heat pump's energy manager module
      const externalPowerDp = getAnyById('emanager.actualPowerInputOrExcess') || this._findFirstDatapoint(dp =>
        /inputOrExcess|excess/i.test(String(dp && dp.id ? dp.id : '')) && (dp.rw === 'rw' || dp.rw === 'wo')
      );

      if (externalPowerDp) {
        add({
          relId: this._aliasRelId('ctrl.externalPower'),
          name: 'Set external power signal (input/excess)',
          role: 'level.power',
          type: 'number',
          unit: externalPowerDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: externalPowerDp.id,
          writeDpId: externalPowerDp.id,
        });
      }

      // Fault alarm: best-effort based on any error number/state datapoints
      const errorDps = this.getDatapoints().filter(dp => dp && dp.id && /error(Number|State)$/i.test(String(dp.id)) && dp.rw !== 'wo');
      if (errorDps.length) {
        add({
          relId: this._aliasRelId('alarm.fault'),
          name: 'Device fault',
          role: 'indicator.alarm',
          type: 'boolean',
          rw: 'ro',
          kind: 'computed',
          get: (values) => {
            for (const dp of errorDps) {
              const v = values[dp.id];
              const n = asNumber(v);
              if (n === undefined) continue;
              if (/errorState$/i.test(String(dp.id))) {
                if (n >= 4) return true;
              } else if (n !== 0) {
                return true;
              }
            }
            return false;
          },
        });
      }
    }
    // --- IO aliases (digital inputs/outputs/counters) ---
    // Provide a stable API for I/O components so that other adapters can link against
    // consistent alias names even if manufacturers label channels differently.
    //
    // Aliases created:
    //  - devices.<id>.aliases.r.inputs.in0..inN
    //  - devices.<id>.aliases.r.outputs.out0..outN
    //  - devices.<id>.aliases.ctrl.outputs.out0..outN (write)
    //  - devices.<id>.aliases.r.counters.count0..countN (optional)
    if (cat === 'IO') {
      const boolFrom = (v) => {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
        if (typeof v === 'string') {
          const s = v.trim().toLowerCase();
          if (s === 'true' || s === 'on' || s === '1') return true;
          if (s === 'false' || s === 'off' || s === '0') return false;
        }
        return undefined;
      };

      const boolTo = (v) => {
        const b = boolFrom(v);
        if (b === undefined) return false;
        return b;
      };

      const inputs = [];
      const outputs = [];
      const counters = [];

      const dps = this.getDatapoints();
      for (const dp of dps) {
        if (!dp || !dp.id) continue;
        const id = String(dp.id);

        // Input patterns (0-based preferred)
        let m = id.match(/^(?:Input|IN|input|in)[_ ]?(\d+)$/i) || id.match(/^(?:DI|Din)[_ ]?(\d+)$/i);
        if (m && (dp.type === 'boolean' || dp.type === 'bool')) {
          const idx = Number(m[1]);
          if (Number.isFinite(idx)) inputs.push({ idx, dp });
          continue;
        }

        // Output patterns
        m = id.match(/^(?:Output|OUT|output|out)[_ ]?(\d+)$/i) || id.match(/^(?:DO|Dout)[_ ]?(\d+)$/i);
        if (m && (dp.type === 'boolean' || dp.type === 'bool')) {
          const idx = Number(m[1]);
          if (Number.isFinite(idx)) outputs.push({ idx, dp });
          continue;
        }

        // Relay patterns: rELAY_1..rELAY_N (1-based -> map to 0-based)
        m = id.match(/^rELAY_(\d+)$/i);
        if (m && (dp.type === 'boolean' || dp.type === 'bool')) {
          const idx = Number(m[1]);
          if (Number.isFinite(idx) && idx > 0) outputs.push({ idx: idx - 1, dp });
          continue;
        }

        // Counter patterns
        m = id.match(/^Counter[_ ]?(\d+)$/i) || id.match(/^counter[_ ]?(\d+)$/i);
        if (m && (dp.type === 'number' || dp.type === 'string')) {
          const idx = Number(m[1]);
          if (Number.isFinite(idx)) counters.push({ idx, dp });
          continue;
        }
      }

      inputs.sort((a, b) => a.idx - b.idx);
      outputs.sort((a, b) => a.idx - b.idx);
      counters.sort((a, b) => a.idx - b.idx);

      for (const it of inputs) {
        add({
          relId: this._aliasRelId(`r.inputs.in${it.idx}`),
          name: `Digital input ${it.idx}`,
          role: 'sensor',
          type: 'boolean',
          rw: 'ro',
          kind: 'dp',
          dpId: it.dp.id,
          fromDevice: boolFrom,
        });
      }

      for (const it of outputs) {
        // readback
        add({
          relId: this._aliasRelId(`r.outputs.out${it.idx}`),
          name: `Digital output ${it.idx}`,
          role: 'switch',
          type: 'boolean',
          rw: 'ro',
          kind: 'dp',
          dpId: it.dp.id,
          fromDevice: boolFrom,
        });

        // control
        if (it.dp.rw === 'rw' || it.dp.rw === 'wo') {
          add({
            relId: this._aliasRelId(`ctrl.outputs.out${it.idx}`),
            name: `Set digital output ${it.idx}`,
            role: 'switch',
            type: 'boolean',
            rw: 'rw',
            kind: 'dp',
            dpId: it.dp.id,
            writeDpId: it.dp.id,
            toDevice: boolTo,
            fromDevice: boolFrom,
          });
        }
      }

      for (const it of counters) {
        add({
          relId: this._aliasRelId(`r.counters.count${it.idx}`),
          name: `Counter ${it.idx}`,
          role: 'value',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: it.dp.id,
        });
      }
    }

    // --- PV inverter specific controls & alarms ---
    if (cat === 'PV_INVERTER') {
      // grid state (raw)
      const gridStateDp = getAnyById('PVConn', 'PvGriConn', 'GriSwStt');
      if (gridStateDp) {
        add({
          relId: this._aliasRelId('r.gridConnectionState'),
          name: 'Grid connection state (raw)',
          role: 'indicator',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: gridStateDp.id,
        });
      }

      // grid connected (boolean) - computed from known SMA codes where possible
      add({
        relId: this._aliasRelId('r.gridConnected'),
        name: 'Grid connected',
        role: 'indicator.connected',
        type: 'boolean',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          if (!values) return undefined;
          if (typeof values.PvGriConn === 'number') return values.PvGriConn === 1780;
          if (typeof values.GriSwStt === 'number') return values.GriSwStt === 51;
          if (typeof values.PVConn === 'number') return values.PVConn !== 0;
          return undefined;
        }
      });

      // power limit percent setpoint
      const limitPctDp = getAnyById('WMaxLimPct', 'WLimPct') || this._findFirstDatapoint(dp =>
        (dp.unit === '%' || dp.unit === ' %' || dp.unit === '% ') &&
        (dp.rw === 'rw' || dp.rw === 'wo') &&
        /lim/i.test(String(dp.id))
      );
      if (limitPctDp) {
        add({
          relId: this._aliasRelId('ctrl.powerLimitPct'),
          name: 'Active power limit (%)',
          role: 'level',
          type: 'number',
          unit: '%',
          // Expose as read+write even if the underlying register is write-only.
          // In that case we keep the last commanded value until the device provides a readable feedback register.
          rw: 'rw',
          kind: 'dp',
          dpId: limitPctDp.id,
          // allow writes through the alias even if the underlying datapoint is write-only
          writeDpId: limitPctDp.id,
        });
      }

      // power limit enable
      const limitEnaDp = getAnyById('WMaxLim_Ena') || this._findFirstDatapoint(dp =>
        (dp.type === 'boolean') &&
        (dp.rw === 'rw') &&
        /lim/i.test(String(dp.id)) &&
        /ena/i.test(String(dp.id))
      );
      if (limitEnaDp) {
        add({
          relId: this._aliasRelId('ctrl.powerLimitEnable'),
          name: 'Active power limit enable',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: limitEnaDp.id,
          writeDpId: limitEnaDp.id,
        });
      }

      // run/stop command
      // Preference order:
      //  1) boolean "Conn" (true/false)
      //  2) "FstStop" (fast shut-down command, often Start=1467 / Stop=381)
      //  3) "OpMod" (operating mode codes)
      const connDp = getAnyById('Conn');
      const fstStopDp = getAnyById('FstStop');
      const opModDp = getAnyById('OpMod');
      let runAliasAdded = false;
      if (connDp && (connDp.rw === 'rw' || connDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.run'),
          name: 'Run (connect/start)',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: connDp.id,
          writeDpId: connDp.id,
          toDevice: (v) => !!v,
          fromDevice: (v) => !!v,
        });
        runAliasAdded = true;
      } else if (fstStopDp && (fstStopDp.rw === 'rw' || fstStopDp.rw === 'wo')) {
        // Some SMA devices expose a "Fast shut-down" command that doubles as start/stop control.
        // Typical codes:
        //  - 1467: Start
        //  - 381 : Stop
        //  - 1749: Full stop
        add({
          relId: this._aliasRelId('ctrl.run'),
          name: 'Run (start/stop)',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: fstStopDp.id,
          writeDpId: fstStopDp.id,
          toDevice: (v) => (v ? 1467 : 381),
          fromDevice: (v) => {
            if (v === 1467) return true;
            if (v === 381 || v === 1749) return false;
            return undefined;
          }
        });
        runAliasAdded = true;
      } else if (opModDp && (opModDp.rw === 'rw' || opModDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.run'),
          name: 'Run (start/stop)',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: opModDp.id,
          writeDpId: opModDp.id,
          toDevice: (v) => (v ? 1467 : 381),
          fromDevice: (v) => {
            if (v === 1467) return true;
            if (v === 381) return false;
            return undefined;
          }
        });
        runAliasAdded = true;
      }

      // Vendor specific ON/OFF command register (e.g., SolaX X3-MEGA/X3-FORTH: 0xAF=start, 0xAE=stop)
      if (!runAliasAdded) {
        const cmdOnOffDp = getAnyById('CmdOnOff', 'CMD_ON_OFF', 'COMMAND_ON_OFF');
        if (cmdOnOffDp && (cmdOnOffDp.rw === 'rw' || cmdOnOffDp.rw === 'wo')) {
          add({
            relId: this._aliasRelId('ctrl.run'),
            name: 'Run (start/stop)',
            role: 'switch',
            type: 'boolean',
            rw: 'rw',
            kind: 'dp',
            dpId: cmdOnOffDp.id,
            writeDpId: cmdOnOffDp.id,
            toDevice: (v) => (v ? 0xAF : 0xAE),
            fromDevice: (v) => {
              const n = Number(v);
              if (!Number.isFinite(n)) return undefined;
              if (n === 0xAF) return true;
              if (n === 0xAE) return false;
              return undefined;
            }
          });
        }
      }

      // alarm.fault / alarm.warning (best-effort)
      add({
        relId: this._aliasRelId('alarm.fault'),
        name: 'Fault active',
        role: 'indicator.alarm',
        type: 'boolean',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          // Offline should not automatically equal "fault"; keep separate.
          if (!values) return false;
          let fault = false;
          if (typeof values.Health === 'number') fault = fault || (values.Health === 35);
          if (typeof values.St === 'number') fault = fault || (values.St === 7);
          if (typeof values.Evt1 === 'number') fault = fault || (values.Evt1 !== 0);
          return fault;
        }
      });

      add({
        relId: this._aliasRelId('alarm.warning'),
        name: 'Warning active',
        role: 'indicator.alarm',
        type: 'boolean',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          if (!values) return false;
          if (typeof values.Health === 'number') return values.Health === 455;
          return false;
        }
      });
    }

    // --- Battery / ESS aliases (BATTERY, ESS, BATTERY_INVERTER) ---
    // These categories often use vendor-specific datapoint IDs and generic ioBroker roles are not reliable.
    // We therefore derive a stable alias API primarily from datapoint IDs (best-effort).
    const batteryCats = new Set(['BATTERY', 'ESS', 'BATTERY_INVERTER']);
    if (batteryCats.has(cat)) {
      const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;
      const asBool01 = (v) => {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
        return undefined;
      };

      // --- Core read signals ---
      const socDp =
        getAnyById('sOC', 'bATTERY_SOC', 'bATTERY_TOTAL_SOC') ||
        findByIdRe(/(^|_)soc($|_)/i) ||
        this._findFirstDatapoint(dp => /soc/i.test(String(dp.id || '')));

      if (socDp) {
        add({
          relId: this._aliasRelId('r.soc'),
          name: 'State of charge',
          role: 'value.battery',
          type: 'number',
          unit: socDp.unit || '%',
          rw: 'ro',
          kind: 'dp',
          dpId: socDp.id,
        });
      }

      const sohDp =
        getAnyById('sOH') ||
        findByIdRe(/(^|_)soh($|_)/i) ||
        this._findFirstDatapoint(dp => /soh/i.test(String(dp.id || '')));

      if (sohDp) {
        add({
          relId: this._aliasRelId('r.soh'),
          name: 'State of health',
          role: 'value',
          type: 'number',
          unit: sohDp.unit || '%',
          rw: 'ro',
          kind: 'dp',
          dpId: sohDp.id,
        });
      }

      const battVoltDp =
        getAnyById('bATTERY_VOLTAGE', 'dC_BATTERY_VOLTAGE', 'vOLTAGE', 'lINK_VOLTAGE', 'iNTERNAL_VOLTAGE') ||
        this._findFirstDatapoint(dp => /battery_.*voltage/i.test(String(dp.id || ''))) ||
        this._findFirstDatapoint(dp => /voltage/i.test(String(dp.id || '')) && !/grid_/i.test(String(dp.id || '')));

      if (battVoltDp) {
        add({
          relId: this._aliasRelId('r.voltage'),
          name: 'Battery voltage',
          role: 'value.voltage',
          type: 'number',
          unit: battVoltDp.unit || 'V',
          rw: 'ro',
          kind: 'dp',
          dpId: battVoltDp.id,
        });
      }

      const battCurrDp =
        getAnyById('bATTERY_CURRENT', 'dC_BATTERY_CURRENT', 'cURRENT') ||
        this._findFirstDatapoint(dp => /battery_.*current/i.test(String(dp.id || ''))) ||
        this._findFirstDatapoint(dp => /current/i.test(String(dp.id || '')) && !/input_/i.test(String(dp.id || '')) && !/output_/i.test(String(dp.id || '')));

      if (battCurrDp) {
        add({
          relId: this._aliasRelId('r.current'),
          name: 'Battery current',
          role: 'value.current',
          type: 'number',
          unit: battCurrDp.unit || 'A',
          rw: 'ro',
          kind: 'dp',
          dpId: battCurrDp.id,
        });
      }

      const battTempDp =
        getAnyById('bATTERY_TEMPERATURE', 'aVG_BATTERY_TEMPERATURE') ||
        this._findFirstDatapoint(dp => /^bATTERY_.*tEMPERATURE$/i.test(String(dp.id || ''))) ||
        this._findFirstDatapoint(dp => /battery_.*temperature/i.test(String(dp.id || '')));

      if (battTempDp) {
        add({
          relId: this._aliasRelId('r.temperature'),
          name: 'Battery temperature',
          role: 'value.temperature',
          type: 'number',
          unit: battTempDp.unit || '°C',
          rw: 'ro',
          kind: 'dp',
          dpId: battTempDp.id,
        });
      }

      // --- Power (W): prefer measured DC battery power, else AC active power, else compute from V*I ---
      const activePowerDp =
        getAnyById('bATTERY_POWER', 'aCTIVE_POWER') ||
        this._findFirstDatapoint(dp => /^bATTERY_.*pOWER$/i.test(String(dp.id || '')) && dp.rw !== 'wo') ||
        this._findFirstDatapoint(dp => /^aCTIVE_POWER$/i.test(String(dp.id || '')) && dp.rw !== 'wo');

      // Some SMA batteries provide separate charge/discharge currents (unsigned). Use these when present.
      const chargeCurrentDp = getAnyById('cUR_BAT_CHA');
      const dischargeCurrentDp = getAnyById('cUR_BAT_DSCH');

      // Per-phase active power (common in ESS/battery inverter)
      const pL1 = getAnyById('aCTIVE_POWER_L1');
      const pL2 = getAnyById('aCTIVE_POWER_L2');
      const pL3 = getAnyById('aCTIVE_POWER_L3');

      const powerUnit =
        (activePowerDp && activePowerDp.unit) ||
        (pL1 && pL1.unit) ||
        (pL2 && pL2.unit) ||
        (pL3 && pL3.unit) ||
        'W';


      const computeBatteryPowerW = (values) => {
        if (!values) return undefined;

        // Prefer explicit measured power datapoint
        if (activePowerDp) {
          const v = asNumber(values[activePowerDp.id]);
          if (v !== undefined) return v;
        }

        // Sum per-phase active powers if present
        const v1 = pL1 ? asNumber(values[pL1.id]) : undefined;
        const v2 = pL2 ? asNumber(values[pL2.id]) : undefined;
        const v3 = pL3 ? asNumber(values[pL3.id]) : undefined;
        if (v1 !== undefined || v2 !== undefined || v3 !== undefined) return (v1 || 0) + (v2 || 0) + (v3 || 0);

        // If we have separate charge/discharge currents and a battery voltage, compute net power.
        if (battVoltDp && (chargeCurrentDp || dischargeCurrentDp)) {
          const u = asNumber(values[battVoltDp.id]);
          const icha = chargeCurrentDp ? asNumber(values[chargeCurrentDp.id]) : undefined;
          const idsch = dischargeCurrentDp ? asNumber(values[dischargeCurrentDp.id]) : undefined;
          if (u !== undefined && (icha !== undefined || idsch !== undefined)) {
            const pCharge = (icha || 0) * u;
            const pDischarge = (idsch || 0) * u;
            // Convention: discharge positive, charge negative
            return pDischarge - pCharge;
          }
        }

        // Fallback: compute from signed battery current * voltage
        if (battVoltDp && battCurrDp) {
          const u = asNumber(values[battVoltDp.id]);
          const i = asNumber(values[battCurrDp.id]);
          if (u !== undefined && i !== undefined) return u * i;
        }

        return undefined;
      };

      add({
        relId: this._aliasRelId('r.power'),
        name: 'Battery power (net)',
        role: 'value.power',
        type: 'number',
        unit: powerUnit || 'W',
        rw: 'ro',
        kind: 'computed',
        get: (values) => computeBatteryPowerW(values),
      });

      // Split into charge/discharge power (absolute)
      add({
        relId: this._aliasRelId('r.powerCharge'),
        name: 'Battery charge power',
        role: 'value.power',
        type: 'number',
        unit: powerUnit || 'W',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          const p = computeBatteryPowerW(values);
          if (p === undefined) return undefined;
          return p < 0 ? Math.abs(p) : 0;
        }
      });

      add({
        relId: this._aliasRelId('r.powerDischarge'),
        name: 'Battery discharge power',
        role: 'value.power',
        type: 'number',
        unit: powerUnit || 'W',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          const p = computeBatteryPowerW(values);
          if (p === undefined) return undefined;
          return p > 0 ? p : 0;
        }
      });

      // --- PV power (for hybrid inverters) ---
      const pvPowerDp =
        getAnyById('pV_POWER', 'pV_POWER_SUM') ||
        this._findFirstDatapoint(dp => /^pV_.*pOWER/i.test(String(dp.id || '')) && dp.rw !== 'wo') ||
        this._findFirstDatapoint(dp => /pv.*power/i.test(String(dp.id || '')) && dp.rw !== 'wo');

      if (pvPowerDp) {
        add({
          relId: this._aliasRelId('r.pvPower'),
          name: 'PV power',
          role: 'value.power',
          type: 'number',
          unit: pvPowerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: pvPowerDp.id,
        });
      }

      // --- Energy counters (Wh) ---
      const chargeEnergyDp =
        getAnyById('aCTIVE_CHARGE_ENERGY', 'dC_CHARGED_ENERGY', 'dC_CHARGE_ENERGY', 'aCT_BAT_CHRG') ||
        this._findFirstDatapoint(dp => /charge.*energy/i.test(String(dp.id || '')) && !/parameter/i.test(String(dp.id || '')));

      const dischargeEnergyDp =
        getAnyById('aCTIVE_DISCHARGE_ENERGY', 'dC_DISCHARGED_ENERGY', 'dC_DISCHARGE_ENERGY', 'aCT_BAT_DSCH') ||
        this._findFirstDatapoint(dp => /discharge.*energy/i.test(String(dp.id || '')) && !/parameter/i.test(String(dp.id || '')));

      const safeU64ToNumber = (raw) => {
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string') {
          const n = Number(raw);
          if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
        }
        return undefined;
      };

      if (chargeEnergyDp) {
        add({
          relId: this._aliasRelId('r.energyCharge'),
          name: 'Charge energy (total)',
          role: 'value.energy',
          type: 'number',
          unit: chargeEnergyDp.unit || 'Wh',
          rw: 'ro',
          kind: 'dp',
          dpId: chargeEnergyDp.id,
          fromDevice: (v) => safeU64ToNumber(v),
        });
      }

      if (dischargeEnergyDp) {
        add({
          relId: this._aliasRelId('r.energyDischarge'),
          name: 'Discharge energy (total)',
          role: 'value.energy',
          type: 'number',
          unit: dischargeEnergyDp.unit || 'Wh',
          rw: 'ro',
          kind: 'dp',
          dpId: dischargeEnergyDp.id,
          fromDevice: (v) => safeU64ToNumber(v),
        });
      }

      // --- BMS allow charge/discharge (read) ---
      const allowChargeDp = getAnyById('bP_CHARGE_BMS', 'vE_BUS_BMS_ALLOW_BATTERY_CHARGE');
      if (allowChargeDp) {
        add({
          relId: this._aliasRelId('r.allowCharge'),
          name: 'BMS allows charge',
          role: 'indicator',
          type: 'boolean',
          rw: 'ro',
          kind: 'dp',
          dpId: allowChargeDp.id,
          fromDevice: (v) => asBool01(v),
        });
      }

      const allowDischargeDp = getAnyById('bP_DISCHARGE_BMS', 'vE_BUS_BMS_ALLOW_BATTERY_DISCHARGE');
      if (allowDischargeDp) {
        add({
          relId: this._aliasRelId('r.allowDischarge'),
          name: 'BMS allows discharge',
          role: 'indicator',
          type: 'boolean',
          rw: 'ro',
          kind: 'dp',
          dpId: allowDischargeDp.id,
          fromDevice: (v) => asBool01(v),
        });
      }

      // --- Allowed charge/discharge power (W) ---
      const allowedChargePowerDp = getAnyById('aLLOWED_CHARGE_POWER', 'oRIGINAL_ALLOWED_CHARGE_POWER');
      if (allowedChargePowerDp) {
        add({
          relId: this._aliasRelId('r.allowedChargePower'),
          name: 'Allowed charge power',
          role: 'value.power',
          type: 'number',
          unit: allowedChargePowerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: allowedChargePowerDp.id,
        });
      }

      const allowedDischargePowerDp = getAnyById('aLLOWED_DISCHARGE_POWER', 'oRIGINAL_ALLOWED_DISCHARGE_POWER', 'eSS_MAX_DISCHARGE_POWER');
      if (allowedDischargePowerDp) {
        add({
          relId: this._aliasRelId('r.allowedDischargePower'),
          name: 'Allowed discharge power',
          role: 'value.power',
          type: 'number',
          unit: allowedDischargePowerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: allowedDischargePowerDp.id,
        });
      }

      // --- Control: active power setpoint (W) ---
      const setActivePowerDp =
        getAnyById('sET_ACTIVE_POWER') ||
        this._findFirstDatapoint(dp => /^sET_ACTIVE_POWER$/i.test(String(dp.id || '')) && (dp.rw === 'rw' || dp.rw === 'wo')) ||
        this._findFirstDatapoint(dp => /^sET_ACTIVE_POWER(_6_\d+)?$/i.test(String(dp.id || '')) && (dp.rw === 'rw' || dp.rw === 'wo'));

      if (setActivePowerDp) {
        add({
          relId: this._aliasRelId('ctrl.powerSetpointW'),
          name: 'Active power setpoint (battery/ESS)',
          role: 'level.power',
          type: 'number',
          unit: setActivePowerDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: setActivePowerDp.id,
          writeDpId: setActivePowerDp.id,
        });

        // Convenience aliases: split-direction power setpoints.
        // Standard: charge power is written as positive value and mapped to a NEGATIVE setpoint,
        // discharge power is written as positive value and mapped to a POSITIVE setpoint.
        // This is especially useful for devices like SolaX where one register controls both directions.
        add({
          relId: this._aliasRelId('ctrl.chargePowerW'),
          name: 'Charge power setpoint',
          role: 'level.power',
          type: 'number',
          unit: setActivePowerDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: setActivePowerDp.id,
          writeDpId: setActivePowerDp.id,
          toDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return -Math.abs(n);
          },
          fromDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return undefined;
            return n < 0 ? Math.abs(n) : 0;
          }
        });

        add({
          relId: this._aliasRelId('ctrl.dischargePowerW'),
          name: 'Discharge power setpoint',
          role: 'level.power',
          type: 'number',
          unit: setActivePowerDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: setActivePowerDp.id,
          writeDpId: setActivePowerDp.id,
          toDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return Math.abs(n);
          },
          fromDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return undefined;
            return n > 0 ? Math.abs(n) : 0;
          }
        });
      }


      // --- Control: max charge/discharge power limits (optional) ---
      const maxDischargePowerDp =
        getAnyById('sET_MAX_DISCHARGE_POWER', 'sET_MAX_DISCHARGE_POWER_W', 'sET_MAX_DISCHARGE', 'sET_DISCHARGE_LIMIT') ||
        this._findFirstDatapoint(dp =>
          (dp.rw === 'rw' || dp.rw === 'wo') &&
          /(max|limit).*(discharge|dsch|entlad).*power/i.test(String(dp.id || ''))
        );

      if (maxDischargePowerDp) {
        add({
          relId: this._aliasRelId('ctrl.maxDischargePowerW'),
          name: 'Max discharge power limit',
          role: 'level.power',
          type: 'number',
          unit: maxDischargePowerDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: maxDischargePowerDp.id,
          writeDpId: maxDischargePowerDp.id,
          toDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return Math.abs(n);
          },
          fromDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return undefined;
            return Math.abs(n);
          }
        });
      }

      const maxChargePowerDp =
        getAnyById('sET_MAX_CHARGE_POWER', 'sET_MAX_CHARGE_POWER_W', 'sET_MAX_CHARGE', 'sET_CHARGE_LIMIT') ||
        this._findFirstDatapoint(dp =>
          (dp.rw === 'rw' || dp.rw === 'wo') &&
          /(max|limit).*(charge|cha|belad).*power/i.test(String(dp.id || ''))
        );

      if (maxChargePowerDp) {
        add({
          relId: this._aliasRelId('ctrl.maxChargePowerW'),
          name: 'Max charge power limit',
          role: 'level.power',
          type: 'number',
          unit: maxChargePowerDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: maxChargePowerDp.id,
          writeDpId: maxChargePowerDp.id,
          toDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return Math.abs(n);
          },
          fromDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return undefined;
            return Math.abs(n);
          }
        });
      }

      // Per-phase setpoints (if available)
      const setPL1 = getAnyById('sET_ACTIVE_POWER_L1');
      const setPL2 = getAnyById('sET_ACTIVE_POWER_L2');
      const setPL3 = getAnyById('sET_ACTIVE_POWER_L3');
      if (setPL1 && (setPL1.rw === 'rw' || setPL1.rw === 'wo')) add({ relId: this._aliasRelId('ctrl.powerSetpointL1'), name: 'Active power setpoint L1', role: 'level.power', type: 'number', unit: setPL1.unit || 'W', rw: 'rw', kind: 'dp', dpId: setPL1.id, writeDpId: setPL1.id });
      if (setPL2 && (setPL2.rw === 'rw' || setPL2.rw === 'wo')) add({ relId: this._aliasRelId('ctrl.powerSetpointL2'), name: 'Active power setpoint L2', role: 'level.power', type: 'number', unit: setPL2.unit || 'W', rw: 'rw', kind: 'dp', dpId: setPL2.id, writeDpId: setPL2.id });
      if (setPL3 && (setPL3.rw === 'rw' || setPL3.rw === 'wo')) add({ relId: this._aliasRelId('ctrl.powerSetpointL3'), name: 'Active power setpoint L3', role: 'level.power', type: 'number', unit: setPL3.unit || 'W', rw: 'rw', kind: 'dp', dpId: setPL3.id, writeDpId: setPL3.id });

      // Control: control mode (vendor-specific but stable location)
      const controlModeDp = getAnyById('sET_CONTROL_MODE');
      if (controlModeDp && (controlModeDp.rw === 'rw' || controlModeDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.controlMode'),
          name: 'Control mode',
          role: 'level',
          type: 'number',
          rw: 'rw',
          kind: 'dp',
          dpId: controlModeDp.id,
          writeDpId: controlModeDp.id,
        });
      }


      // --- Grid / NAP power & setpoints (Energy Managers / Hybrid systems) ---
      // Some systems (e.g., TESVOLT Energy Manager Vermarkter-Schnittstelle) expose the grid connection point as "NAP".
      // We provide a stable read alias for the current grid/NAP power and a stable write alias for the grid/NAP setpoint.
      const gridPowerDp =
        getAnyById('gRID_POWER', 'nAP_POWER') ||
        this._findFirstDatapoint(dp => /(^|_)(grid|nap).*power/i.test(String(dp.id || '')) && dp.rw !== 'wo');

      if (gridPowerDp) {
        add({
          relId: this._aliasRelId('r.gridPower'),
          name: 'Grid / NAP power',
          role: 'value.power',
          type: 'number',
          unit: gridPowerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: gridPowerDp.id,
        });
      }

      const gridSetpointDp =
        getAnyById('nAP_POWER_SETPOINT', 'sET_NAP_POWER', 'gRID_POWER_SETPOINT') ||
        this._findFirstDatapoint(dp =>
          (dp.rw === 'rw' || dp.rw === 'wo') &&
          /(nap|grid).*(set|target|limit).*power/i.test(String(dp.id || ''))
        );

      if (gridSetpointDp) {
        add({
          relId: this._aliasRelId('ctrl.gridSetpointW'),
          name: 'Grid / NAP power setpoint',
          role: 'level.power',
          type: 'number',
          unit: gridSetpointDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: gridSetpointDp.id,
          writeDpId: gridSetpointDp.id,
        });

        // Synonym (more explicit)
        add({
          relId: this._aliasRelId('ctrl.napSetpointW'),
          name: 'NAP power setpoint',
          role: 'level.power',
          type: 'number',
          unit: gridSetpointDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: gridSetpointDp.id,
          writeDpId: gridSetpointDp.id,
        });
      }



      // --- PV / export power limiting (best-effort) ---
      const exportPowerPctDp = getAnyById('eXPORT_POWER_PERCENTAGE', 'wMaxLimPct', 'wMAXLIMPCT');
      if (exportPowerPctDp && (exportPowerPctDp.rw === 'rw' || exportPowerPctDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.powerLimitPct'),
          name: 'PV/export power limit (%)',
          role: 'level',
          type: 'number',
          unit: exportPowerPctDp.unit || '%',
          rw: 'rw',
          kind: 'dp',
          dpId: exportPowerPctDp.id,
          writeDpId: exportPowerPctDp.id,
        });

        // More explicit synonym (useful when multiple device categories are merged downstream)
        add({
          relId: this._aliasRelId('ctrl.exportLimitPct'),
          name: 'Export power limit (%)',
          role: 'level',
          type: 'number',
          unit: exportPowerPctDp.unit || '%',
          rw: 'rw',
          kind: 'dp',
          dpId: exportPowerPctDp.id,
          writeDpId: exportPowerPctDp.id,
        });
      }

      const exportPowerLimitDp = getAnyById('eXPORT_POWER_LIMIT', 'wMaxLim', 'wMAXLIM');
      if (exportPowerLimitDp && (exportPowerLimitDp.rw === 'rw' || exportPowerLimitDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.powerLimitW'),
          name: 'PV/export power limit (W)',
          role: 'level.power',
          type: 'number',
          unit: exportPowerLimitDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: exportPowerLimitDp.id,
          writeDpId: exportPowerLimitDp.id,
        });

        add({
          relId: this._aliasRelId('ctrl.exportLimitW'),
          name: 'Export power limit (W)',
          role: 'level.power',
          type: 'number',
          unit: exportPowerLimitDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: exportPowerLimitDp.id,
          writeDpId: exportPowerLimitDp.id,
        });
      }

      // Control: charge enable (best-effort)
      const disableChargeDp = getAnyById('eSS_DISABLE_CHARGE_FLAG');
      if (disableChargeDp && (disableChargeDp.rw === 'rw' || disableChargeDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.chargeEnable'),
          name: 'Charge enable',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: disableChargeDp.id,
          writeDpId: disableChargeDp.id,
          toDevice: (v) => (v ? 0 : 1),
          fromDevice: (v) => {
            const b = asBool01(v);
            if (b === undefined) return undefined;
            // dp is DISABLE flag -> invert
            return !b;
          }
        });
      }

      // --- Status & alarms (best-effort, conservative) ---
      const statusDp =
        getAnyById('bAT_STATUS', 'bATTERY_STATE', 'bATTERY_WORK_STATE', 'sYSTEM_STATE', 'cLUSTER_RUN_STATE', 'sYSTEM_RUNNING_STATE', 'vE_BUS_STATE', 'sWITCH_POSITION') ||
        this._findFirstDatapoint(dp => /(^|_)(state|status|health)($|_)/i.test(String(dp.id || '')) && !/parameter/i.test(String(dp.id || '')));

      if (statusDp) {
        add({
          relId: this._aliasRelId('r.statusCode'),
          name: 'Status code',
          role: 'indicator.status',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: statusDp.id,
        });
      }

      const errorCodeDp =
        getAnyById('vE_BUS_ERROR', 'vE_BUS_BMS_ERROR', 'iNSULATION_RESISTANCE_ERROR_LEVEL') ||
        this._findFirstDatapoint(dp => /(^|_)(error|fault)($|_)/i.test(String(dp.id || '')) && !/parameter/i.test(String(dp.id || '')));

      if (errorCodeDp) {
        add({
          relId: this._aliasRelId('r.errorCode'),
          name: 'Error code',
          role: 'indicator',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: errorCodeDp.id,
        });
      }

      // Conservative fault detection: explicit error codes or active alarm/protect flag registers (non-zero)
      const faultFlagDps = this.getDatapoints().filter(dp => {
        const id = String(dp && dp.id ? dp.id : '');
        if (!id) return false;
        // exclude configuration thresholds
        if (/(parameter|limit|recover|threshold)/i.test(id)) return false;
        return /(vE_BUS_ERROR|vE_BUS_BMS_ERROR|ALARM_FLAG_REGISTER|PROTECT_FLAG_REGISTER|SYSTEM_FAULT_COUNTERS|INSULATION_RESISTANCE_ERROR_LEVEL)/i.test(id);
      });

      add({
        relId: this._aliasRelId('alarm.fault'),
        name: 'Fault active',
        role: 'indicator.alarm',
        type: 'boolean',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          if (!values) return false;

          // EMS1000: System operating status uses 4 = Failure
          // (1 = On-grid, 2 = Off-grid, 3 = Standby, 4 = Failure)
          if (typeof values.sYSTEM_OPERATING_STATUS === 'number' && values.sYSTEM_OPERATING_STATUS === 4) {
            return true;
          }
          // explicit error code
          if (errorCodeDp) {
            const v = values[errorCodeDp.id];
            if (typeof v === 'number') return v !== 0;
          }

          for (const dp of faultFlagDps) {
            const v = values[dp.id];
            if (typeof v === 'boolean' && v) return true;
            if (typeof v === 'number' && v !== 0) return true;
          }
          return false;
        }
      });

      // Warning (best-effort): look for active warning registers (exclude parameters)
      const warnFlagDps = this.getDatapoints().filter(dp => {
        const id = String(dp && dp.id ? dp.id : '');
        if (!id) return false;
        if (/(parameter|limit|recover|threshold)/i.test(id)) return false;
        return /(warning|warn)/i.test(id);
      });

      if (warnFlagDps && warnFlagDps.length) {
        add({
          relId: this._aliasRelId('alarm.warning'),
          name: 'Warning active',
          role: 'indicator.alarm',
          type: 'boolean',
          rw: 'ro',
          kind: 'computed',
          get: (values) => {
            if (!values) return false;
            for (const dp of warnFlagDps) {
              const v = values[dp.id];
              if (typeof v === 'boolean' && v) return true;
              if (typeof v === 'number' && v !== 0) return true;
            }
            return false;
          }
        });
      }
    }

    // --- Meter aliases (read-only, stable API) ---
    if (cat === 'METER') {
      // Identify datapoints (best-effort)
      const netPowerDp =
        getAnyById('aCTIVE_POWER') ||
        findByIdRe(/^aCTIVE_POWER$/i);

      const importPowerDp =
        getAnyById('aCTIVE_CONSUMPTION_POWER') ||
        findByIdRe(/^aCTIVE_CONSUMPTION_POWER(?!_L[123])/i);

      const exportPowerDp =
        getAnyById('aCTIVE_PRODUCTION_POWER') ||
        findByIdRe(/^aCTIVE_PRODUCTION_POWER(?!_L[123])/i);

      const posPowerDp =
        getAnyById('aCTIVE_POWER_POS') ||
        findByIdRe(/^aCTIVE_POWER_POS$/i);

      const negPowerDp =
        getAnyById('aCTIVE_POWER_NEG') ||
        findByIdRe(/^aCTIVE_POWER_NEG$/i);

      const pL1 = getAnyById('aCTIVE_POWER_L1');
      const pL2 = getAnyById('aCTIVE_POWER_L2');
      const pL3 = getAnyById('aCTIVE_POWER_L3');

      const importEnergyDp =
        getAnyById('aCTIVE_CONSUMPTION_ENERGY') ||
        findByIdRe(/^aCTIVE_CONSUMPTION_ENERGY(?!_L[123])/i);

      const exportEnergyDp =
        getAnyById('aCTIVE_PRODUCTION_ENERGY') ||
        findByIdRe(/^aCTIVE_PRODUCTION_ENERGY(?!_L[123])/i);

      const importEnergyL1 = findByIdRe(/^aCTIVE_CONSUMPTION_ENERGY_L1/i) || getAnyById('aCTIVE_CONSUMPTION_ENERGY_L1');
      const importEnergyL2 = findByIdRe(/^aCTIVE_CONSUMPTION_ENERGY_L2/i) || getAnyById('aCTIVE_CONSUMPTION_ENERGY_L2');
      const importEnergyL3 = findByIdRe(/^aCTIVE_CONSUMPTION_ENERGY_L3/i) || getAnyById('aCTIVE_CONSUMPTION_ENERGY_L3');

      const exportEnergyL1 = findByIdRe(/^aCTIVE_PRODUCTION_ENERGY_L1/i) || getAnyById('aCTIVE_PRODUCTION_ENERGY_L1');
      const exportEnergyL2 = findByIdRe(/^aCTIVE_PRODUCTION_ENERGY_L2/i) || getAnyById('aCTIVE_PRODUCTION_ENERGY_L2');
      const exportEnergyL3 = findByIdRe(/^aCTIVE_PRODUCTION_ENERGY_L3/i) || getAnyById('aCTIVE_PRODUCTION_ENERGY_L3');

      const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;

      const computeNetPower = (values) => {
        if (!values) return undefined;

        const pNet = netPowerDp ? asNumber(values[netPowerDp.id]) : undefined;
        if (pNet !== undefined) return pNet;

        const imp = importPowerDp ? asNumber(values[importPowerDp.id]) : undefined;
        const exp = exportPowerDp ? asNumber(values[exportPowerDp.id]) : undefined;
        if (imp !== undefined || exp !== undefined) return (imp || 0) - (exp || 0);

        const pos = posPowerDp ? asNumber(values[posPowerDp.id]) : undefined;
        const neg = negPowerDp ? asNumber(values[negPowerDp.id]) : undefined;
        if (pos !== undefined || neg !== undefined) return (pos || 0) - (neg || 0);

        const p1 = pL1 ? asNumber(values[pL1.id]) : undefined;
        const p2 = pL2 ? asNumber(values[pL2.id]) : undefined;
        const p3 = pL3 ? asNumber(values[pL3.id]) : undefined;
        if (p1 !== undefined || p2 !== undefined || p3 !== undefined) return (p1 || 0) + (p2 || 0) + (p3 || 0);

        return undefined;
      };

      const computeImportPower = (values) => {
        if (!values) return undefined;

        const imp = importPowerDp ? asNumber(values[importPowerDp.id]) : undefined;
        if (imp !== undefined) return imp;

        const pos = posPowerDp ? asNumber(values[posPowerDp.id]) : undefined;
        if (pos !== undefined) return pos;

        const net = computeNetPower(values);
        if (net === undefined) return undefined;
        return net > 0 ? net : 0;
      };

      const computeExportPower = (values) => {
        if (!values) return undefined;

        const exp = exportPowerDp ? asNumber(values[exportPowerDp.id]) : undefined;
        if (exp !== undefined) return exp;

        const neg = negPowerDp ? asNumber(values[negPowerDp.id]) : undefined;
        if (neg !== undefined) return neg;

        const net = computeNetPower(values);
        if (net === undefined) return undefined;
        return net < 0 ? Math.abs(net) : 0;
      };

      const computeImportEnergy = (values) => {
        if (!values) return undefined;
        const e = importEnergyDp ? asNumber(values[importEnergyDp.id]) : undefined;
        if (e !== undefined) return e;

        const e1 = importEnergyL1 ? asNumber(values[importEnergyL1.id]) : undefined;
        const e2 = importEnergyL2 ? asNumber(values[importEnergyL2.id]) : undefined;
        const e3 = importEnergyL3 ? asNumber(values[importEnergyL3.id]) : undefined;
        if (e1 !== undefined || e2 !== undefined || e3 !== undefined) return (e1 || 0) + (e2 || 0) + (e3 || 0);

        return undefined;
      };

      const computeExportEnergy = (values) => {
        if (!values) return undefined;
        const e = exportEnergyDp ? asNumber(values[exportEnergyDp.id]) : undefined;
        if (e !== undefined) return e;

        const e1 = exportEnergyL1 ? asNumber(values[exportEnergyL1.id]) : undefined;
        const e2 = exportEnergyL2 ? asNumber(values[exportEnergyL2.id]) : undefined;
        const e3 = exportEnergyL3 ? asNumber(values[exportEnergyL3.id]) : undefined;
        if (e1 !== undefined || e2 !== undefined || e3 !== undefined) return (e1 || 0) + (e2 || 0) + (e3 || 0);

        return undefined;
      };

      const hasAnyPower = !!(netPowerDp || importPowerDp || exportPowerDp || posPowerDp || negPowerDp || pL1 || pL2 || pL3);

      // net power (W) - prefer direct active power, else compute from available signals
      if (hasAnyPower) {
        if (netPowerDp) {
          add({
            relId: this._aliasRelId('r.power'),
            name: 'Net active power',
            role: 'value.power',
            type: 'number',
            unit: netPowerDp.unit || 'W',
            rw: 'ro',
            kind: 'dp',
            dpId: netPowerDp.id,
          });
        } else {
          add({
            relId: this._aliasRelId('r.power'),
            name: 'Net active power',
            role: 'value.power',
            type: 'number',
            unit: 'W',
            rw: 'ro',
            kind: 'computed',
            get: (values) => computeNetPower(values),
          });
        }

        // powerImport (W)
        if (importPowerDp || posPowerDp) {
          const dp = importPowerDp || posPowerDp;
          add({
            relId: this._aliasRelId('r.powerImport'),
            name: 'Import power',
            role: 'value.power',
            type: 'number',
            unit: dp.unit || 'W',
            rw: 'ro',
            kind: 'dp',
            dpId: dp.id,
          });
        } else {
          add({
            relId: this._aliasRelId('r.powerImport'),
            name: 'Import power',
            role: 'value.power',
            type: 'number',
            unit: 'W',
            rw: 'ro',
            kind: 'computed',
            get: (values) => computeImportPower(values),
          });
        }

        // powerExport (W)
        if (exportPowerDp || negPowerDp) {
          const dp = exportPowerDp || negPowerDp;
          add({
            relId: this._aliasRelId('r.powerExport'),
            name: 'Export power',
            role: 'value.power',
            type: 'number',
            unit: dp.unit || 'W',
            rw: 'ro',
            kind: 'dp',
            dpId: dp.id,
          });
        } else {
          add({
            relId: this._aliasRelId('r.powerExport'),
            name: 'Export power',
            role: 'value.power',
            type: 'number',
            unit: 'W',
            rw: 'ro',
            kind: 'computed',
            get: (values) => computeExportPower(values),
          });
        }
      }

      // energy import/export (Wh) - use totals when available, else sum per phase
      const hasAnyEnergy = !!(importEnergyDp || exportEnergyDp || importEnergyL1 || importEnergyL2 || importEnergyL3 || exportEnergyL1 || exportEnergyL2 || exportEnergyL3);

      if (hasAnyEnergy) {
        if (importEnergyDp) {
          add({
            relId: this._aliasRelId('r.energyImport'),
            name: 'Import energy',
            role: 'value.energy',
            type: 'number',
            unit: importEnergyDp.unit || 'Wh',
            rw: 'ro',
            kind: 'dp',
            dpId: importEnergyDp.id,
          });
        } else {
          add({
            relId: this._aliasRelId('r.energyImport'),
            name: 'Import energy',
            role: 'value.energy',
            type: 'number',
            unit: 'Wh',
            rw: 'ro',
            kind: 'computed',
            get: (values) => computeImportEnergy(values),
          });
        }

        if (exportEnergyDp) {
          add({
            relId: this._aliasRelId('r.energyExport'),
            name: 'Export energy',
            role: 'value.energy',
            type: 'number',
            unit: exportEnergyDp.unit || 'Wh',
            rw: 'ro',
            kind: 'dp',
            dpId: exportEnergyDp.id,
          });
        } else {
          add({
            relId: this._aliasRelId('r.energyExport'),
            name: 'Export energy',
            role: 'value.energy',
            type: 'number',
            unit: 'Wh',
            rw: 'ro',
            kind: 'computed',
            get: (values) => computeExportEnergy(values),
          });
        }
      }

      // Phase voltages/currents (V/A) and frequency (Hz)
      const vL1 = getAnyById('vOLTAGE_L1') || getAnyById('vOLTAGE');
      const vL2 = getAnyById('vOLTAGE_L2');
      const vL3 = getAnyById('vOLTAGE_L3');

      const cL1 = getAnyById('cURRENT_L1') || getAnyById('cURRENT');
      const cL2 = getAnyById('cURRENT_L2');
      const cL3 = getAnyById('cURRENT_L3');

      if (vL1) add({ relId: this._aliasRelId('r.voltageL1'), name: 'Voltage L1', role: 'value.voltage', type: 'number', unit: vL1.unit || 'V', rw: 'ro', kind: 'dp', dpId: vL1.id });
      if (vL2) add({ relId: this._aliasRelId('r.voltageL2'), name: 'Voltage L2', role: 'value.voltage', type: 'number', unit: vL2.unit || 'V', rw: 'ro', kind: 'dp', dpId: vL2.id });
      if (vL3) add({ relId: this._aliasRelId('r.voltageL3'), name: 'Voltage L3', role: 'value.voltage', type: 'number', unit: vL3.unit || 'V', rw: 'ro', kind: 'dp', dpId: vL3.id });

      if (cL1) add({ relId: this._aliasRelId('r.currentL1'), name: 'Current L1', role: 'value.current', type: 'number', unit: cL1.unit || 'A', rw: 'ro', kind: 'dp', dpId: cL1.id });
      if (cL2) add({ relId: this._aliasRelId('r.currentL2'), name: 'Current L2', role: 'value.current', type: 'number', unit: cL2.unit || 'A', rw: 'ro', kind: 'dp', dpId: cL2.id });
      if (cL3) add({ relId: this._aliasRelId('r.currentL3'), name: 'Current L3', role: 'value.current', type: 'number', unit: cL3.unit || 'A', rw: 'ro', kind: 'dp', dpId: cL3.id });

      const freqDp = getAnyById('fREQUENCY');
      if (freqDp) {
        add({
          relId: this._aliasRelId('r.frequency'),
          name: 'Frequency',
          role: 'value.frequency',
          type: 'number',
          unit: freqDp.unit || 'Hz',
          rw: 'ro',
          kind: 'dp',
          dpId: freqDp.id,
        });
      }
    }

    // --- Charging station aliases (EVCS/EVSE/CHARGER/DC_CHARGER) ---
    if (chargerCats.has(cat)) {
      // Read: power
      const chargingPowerDp =
        getAnyById('aCTIVE_POWER') ||
        findByIdRe(/charging_power/i) ||
        findByIdRe(/power_W$/i) ||
        this._findFirstDatapoint(dp => dp.role === 'value.power' && dp.rw !== 'wo' && !/^station_/i.test(String(dp.id))) ||
        this._findFirstDatapoint(dp => dp.role === 'value.power' && dp.rw !== 'wo');

      if (chargingPowerDp) {
        add({
          relId: this._aliasRelId('r.power'),
          name: 'Charging power',
          role: 'value.power',
          type: 'number',
          unit: chargingPowerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: chargingPowerDp.id,
        });
      }

      // Read: energy session / total
      const energySessionDp =
        getAnyById('eNERGY_SESSION', 'lAST_ENERGY_SESSION') ||
        findByIdRe(/charged_energy_session/i) ||
        findByIdRe(/energy.*session/i) ||
        findByIdOrNameRe(/energy.*session/i);

      if (energySessionDp) {
        add({
          relId: this._aliasRelId('r.energySession'),
          name: 'Energy (session)',
          role: 'value.energy',
          type: 'number',
          unit: energySessionDp.unit || 'Wh',
          rw: 'ro',
          kind: 'dp',
          dpId: energySessionDp.id,
        });
      }

      const energyTotalDp =
        findByIdRe(/total.*charged.*energy/i) ||
        findByIdRe(/total_charged_energy/i) ||
        findByIdRe(/total.*energy/i) ||
        getAnyById('aCTIVE_PRODUCTION_ENERGY') ||
        this._findFirstDatapoint(dp => dp.role === 'value.energy' && dp.rw !== 'wo' && !/session/i.test(String(dp.id || '') + ' ' + String(dp.name || '')));

      if (energyTotalDp) {
        add({
          relId: this._aliasRelId('r.energyTotal'),
          name: 'Energy (total)',
          role: 'value.energy',
          type: 'number',
          unit: energyTotalDp.unit || 'Wh',
          rw: 'ro',
          kind: 'dp',
          dpId: energyTotalDp.id,
        });
      }

      // Read: status code (best-effort)
      const statusDp =
        getAnyById('eVSE_STATE', 'cHARGE_POINT_STATE', 'gOE_STATE') ||
        this._findFirstDatapoint(dp => /(^state$|_state$)/i.test(String(dp.id || '')) && dp.rw !== 'wo' && !/^station_/i.test(String(dp.id))) ||
        getAnyById('station_state') ||
        this._findFirstDatapoint(dp => /state/i.test(String(dp.id || '')) && dp.rw !== 'wo');

      if (statusDp) {
        add({
          relId: this._aliasRelId('r.statusCode'),
          name: 'Status code',
          role: 'indicator.status',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: statusDp.id,
        });
      }

      // Read: error code -> alarm.fault
      const errorDp =
        getAnyById('eVSE_ERROR_CODE', 'eRROR_CODE') ||
        findByIdRe(/error_code/i) ||
        this._findFirstDatapoint(dp => /error/i.test(String(dp.id || '')) && dp.rw !== 'wo');

      if (errorDp) {
        add({
          relId: this._aliasRelId('r.errorCode'),
          name: 'Error code',
          role: 'indicator',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: errorDp.id,
        });

        add({
          relId: this._aliasRelId('alarm.fault'),
          name: 'Fault active',
          role: 'indicator.alarm',
          type: 'boolean',
          rw: 'ro',
          kind: 'computed',
          get: (values) => {
            if (!values) return false;
            const v = values[errorDp.id];
            if (typeof v !== 'number') return false;
            return v !== 0;
          }
        });
      }


      // --- ABL EVCC2/3 (eMH1) special aliases (Modbus ASCII) ---
      // ABL exposes the max charging current (Icmax) as IEC 61851 PWM duty cycle (%).
      // For a stable, user-friendly API we expose:
      //  - ctrl.currentLimitA  (A)  -> maps to SET_ICMAX_DUTY_CYCLE_PCT
      //  - ctrl.currentLimitPct (%) -> direct duty cycle access
      //  - ctrl.run (boolean) -> maps to MODIFY_STATE (A1/E0)
      //
      // Note: This is best-effort. Some state transitions depend on the current EVSE state.
      try {
        const tplIdLower = String(this.template?.id || '').toLowerCase();
        const mfrLower = String(this.template?.manufacturer || '').toLowerCase();
        const isAbl = (mfrLower === 'abl') || tplIdLower.startsWith('evcs.abl.');
        if (isAbl) {
          const icmaxDutyPctDp = getAnyById('iCMAX_DUTY_CYCLE_PCT');
          const setIcmaxDutyPctDp = getAnyById('sET_ICMAX_DUTY_CYCLE_PCT');

          const evseStateDpAbl = getAnyById('eVSE_STATE');
          const modifyStateDp = getAnyById('mODIFY_STATE');

          const toNum = (v) => {
            if (typeof v === 'number' && Number.isFinite(v)) return v;
            if (typeof v === 'string') {
              const s = v.trim();
              if (!s) return undefined;
              const n = Number(s);
              return Number.isFinite(n) ? n : undefined;
            }
            return undefined;
          };
          const round1 = (v) => {
            if (typeof v !== 'number' || !Number.isFinite(v)) return v;
            return Math.round(v * 10) / 10;
          };

          // Expose a readable state string for UIs / scripts
          if (evseStateDpAbl) {
            add({
              relId: this._aliasRelId('r.statusText'),
              name: 'Status text',
              role: 'text',
              type: 'string',
              rw: 'ro',
              kind: 'computed',
              get: (values) => {
                if (!values) return '';
                const n = toNum(values[evseStateDpAbl.id]);
                if (!Number.isFinite(n)) return '';
                const code = (Math.trunc(n) & 0xFF);
                const map = {
                  0xA1: 'A1 Waiting for EV',
                  0xB1: 'B1 EV is asking for charging',
                  0xB2: 'B2 EV has the permission to charge',
                  0xC2: 'C2 EV is charged/charging',
                  0xC3: 'C3 Reduced current (error)',
                  0xC4: 'C4 Reduced current (imbalance)',
                  0xE0: 'E0 Outlet disabled',
                  0xE1: 'E1 Production test',
                  0xE2: 'E2 EVCC setup mode',
                  0xE3: 'E3 Bus idle',
                  0xF1: 'F1 Welding (contactor)',
                  0xF2: 'F2 Internal error',
                  0xF3: 'F3 DC residual current detected',
                  0xF4: 'F4 Upstream communication timeout',
                  0xF5: 'F5 Lock of socket failed',
                  0xF6: 'F6 CS out of range',
                  0xF7: 'F7 State D requested by EV',
                  0xF8: 'F8 CP out of range',
                  0xF9: 'F9 Overcurrent detected',
                  0xFA: 'F10 Temperature outside limits',
                  0xFB: 'F11 Unintended opened contact',
                };
                const label = map[code];
                const hex = code.toString(16).toUpperCase().padStart(2, '0');
                return label ? label : `Unknown (0x${hex})`;
              }
            });
          }

          // Control: current limit (A) <-> duty cycle (%)
          if (icmaxDutyPctDp && setIcmaxDutyPctDp) {
            // Expose direct duty-cycle control as % (stable alias)
            add({
              relId: this._aliasRelId('ctrl.currentLimitPct'),
              name: 'Charging current limit (duty cycle)',
              role: 'level',
              type: 'number',
              unit: '%',
              rw: 'rw',
              kind: 'dp',
              dpId: icmaxDutyPctDp.id,
              writeDpId: setIcmaxDutyPctDp.id,
            });

            // Expose current limit as A (IEC 61851 PWM mapping)
            add({
              relId: this._aliasRelId('ctrl.currentLimitA'),
              name: 'Charging current limit',
              role: 'level.current',
              type: 'number',
              unit: 'A',
              rw: 'rw',
              kind: 'dp',
              // Read from measured duty cycle, write to duty cycle setpoint
              dpId: icmaxDutyPctDp.id,
              writeDpId: setIcmaxDutyPctDp.id,
              toDevice: (v) => {
                const aIn = toNum(v);
                if (!Number.isFinite(aIn)) return v;

                // 0A -> no current allowed (100% duty cycle)
                if (aIn <= 0) return 100;

                // IEC 61851: below 6A is not valid for analog PWM charging -> clamp to 6A (=10%)
                let a = aIn;
                if (a < 6) a = 6;

                let pct;
                if (a <= 51) {
                  // 6A..51A -> D = I/0.6
                  pct = a / 0.6;
                } else {
                  // 51A..80A -> D = I/2.5 + 64
                  pct = (a / 2.5) + 64;
                }

                // Avoid 100% for real charging current (100% is a special meaning).
                if (pct > 96) pct = 96;
                if (pct < 10) pct = 10;

                return round1(pct);
              },
              fromDevice: (v) => {
                const pctIn = toNum(v);
                if (!Number.isFinite(pctIn)) return v;

                // 100% (or more) is used as "no current allowed"
                if (pctIn >= 100) return 0;

                let a;
                if (pctIn >= 85) {
                  // Inverse of: D = I/2.5 + 64  -> I = 2.5*(D-64)
                  a = 2.5 * (pctIn - 64);
                } else {
                  // Inverse of: D = I/0.6 -> I = 0.6*D
                  a = 0.6 * pctIn;
                }

                if (a < 0) a = 0;
                return round1(a);
              }
            });
          }

          // Control: run/stop (enable/disable) via MODIFY_STATE
          if (modifyStateDp && evseStateDpAbl) {
            add({
              relId: this._aliasRelId('ctrl.run'),
              name: 'Run (enable/start)',
              role: 'switch',
              type: 'boolean',
              rw: 'rw',
              kind: 'dp',
              // Read from EVSE state, write to modify-state register
              dpId: evseStateDpAbl.id,
              writeDpId: modifyStateDp.id,
              toDevice: (v) => {
                // True -> jump to A1, False -> jump to E0 (disabled)
                if (typeof v === 'boolean') return v ? 0xA1A1 : 0xE0E0;
                return v;
              },
              fromDevice: (v) => {
                const n = toNum(v);
                if (!Number.isFinite(n)) return undefined;
                const code = (Math.trunc(n) & 0xFF);
                // Consider "running" when the outlet is in A/B/C states.
                return [0xA1, 0xB1, 0xB2, 0xC2, 0xC3, 0xC4].includes(code);
              }
            });
          }
        }
      } catch (e) {
        // Never break alias generation due to special-case logic
      }

      // Control: current limit (A) (best-effort)
      const currentLimitDp =
        getAnyById('sET_CHARGING_CURRENT', 'cHARGE_CURRENT', 'cHARGING_CURRENT', 'currentUser_mA', 'aPPLY_CHARGE_CURRENT_LIMIT') ||
        this._findFirstDatapoint(dp =>
          (dp.rw === 'rw' || dp.rw === 'wo') &&
          /current/i.test(String(dp.id || '')) &&
          !/timeout/i.test(String(dp.id || '')) &&
          !/failsafe/i.test(String(dp.id || ''))
        );

      if (currentLimitDp) {
        const unit = (currentLimitDp.unit === 'mA') ? 'A' : (currentLimitDp.unit || 'A');
        const isMilliAmp = currentLimitDp.unit === 'mA';

        add({
          relId: this._aliasRelId('ctrl.currentLimitA'),
          name: 'Charging current limit',
          role: 'level.current',
          type: 'number',
          unit,
          rw: 'rw',
          kind: 'dp',
          dpId: currentLimitDp.id,
          writeDpId: currentLimitDp.id,
          toDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return isMilliAmp ? Math.round(n * 1000) : n;
          },
          fromDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return isMilliAmp ? (n / 1000) : n;
          }
        });
      }

      // Control: power limit (W) (best-effort)
      const powerLimitDp =
        getAnyById('eV_SET_CHARGE_POWER_LIMIT', 'aPPLY_CHARGE_POWER_LIMIT', 'set_station_max_power') ||
        findByIdRe(/set_c\d+_max_power/i) ||
        findByIdRe(/set_.*max_power/i);

      if (powerLimitDp && (powerLimitDp.rw === 'rw' || powerLimitDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.powerLimitW'),
          name: 'Charging power limit',
          role: 'level.power',
          type: 'number',
          unit: powerLimitDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: powerLimitDp.id,
          writeDpId: powerLimitDp.id,
        });
      }
      // Control: run/stop (enable/disable) (best-effort)
      // Some EV chargers use a "control_command" holding register where:
      //  3 = stop charging, 4 = start charging.
      // In that case we expose ctrl.run as boolean and map to those command values.
      const controlCommandDp =
        getAnyById('cONTROL_COMMAND', 'control_command') ||
        findByIdRe(/control_command/i);

      if (controlCommandDp && statusDp) {
        add({
          relId: this._aliasRelId('ctrl.run'),
          name: 'Run (enable/start)',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          // Read from status code (more accurate), write to control command register
          dpId: statusDp.id,
          writeDpId: controlCommandDp.id,
          toDevice: (v) => {
            if (typeof v === 'boolean') return v ? 4 : 3;
            return v;
          },
          fromDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return undefined;
            // EVSE_State (SolaX HAC): 1=Preparing,2=Charging,7/8=Suspended,11=StartDelay,12=Pause,13=Stopping
            return [1, 2, 7, 8, 11, 12, 13].includes(n);
          }
        });
      } else {
        const enableDp =
          getAnyById('sET_ENABLE', 'enableUser', 'sTART_CANCEL_CHARGING_SESSION') ||
          this._findFirstDatapoint(dp =>
            (dp.rw === 'rw' || dp.rw === 'wo') &&
            (/enable/i.test(String(dp.id || '')) || /start/i.test(String(dp.id || '')) || /stop/i.test(String(dp.id || '')))
          );

        if (enableDp) {
          add({
            relId: this._aliasRelId('ctrl.run'),
            name: 'Run (enable/start)',
            role: 'switch',
            type: 'boolean',
            rw: 'rw',
            kind: 'dp',
            dpId: enableDp.id,
            writeDpId: enableDp.id,
            toDevice: (v) => {
              // Many EVCS implementations use 0/1 integer flags for enable/start.
              if (typeof v === 'boolean') return v ? 1 : 0;
              return v;
            },
            fromDevice: (v) => {
              if (typeof v === 'number') return v !== 0;
              if (typeof v === 'boolean') return v;
              return undefined;
            }
          });
        }
      }

      // Control: unlock plug (best-effort)

      const unlockDp = getAnyById('sET_UNLOCK_PLUG');
      if (unlockDp && (unlockDp.rw === 'rw' || unlockDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.unlockPlug'),
          name: 'Unlock plug',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: unlockDp.id,
          writeDpId: unlockDp.id,
          toDevice: (v) => (v ? 1 : 0),
          fromDevice: (v) => {
            if (typeof v === 'number') return v !== 0;
            if (typeof v === 'boolean') return v;
            return undefined;
          }
        });
      }
    }

    return defs;
  }




  async _initAliasObjects() {
    // Build and validate alias definitions
    const defs = this._buildAliasDefinitions();
    if (!Array.isArray(defs) || !defs.length) return;

    for (const def of defs) {
      if (!def || !def.relId) continue;
      await this._ensureAliasPathChannels(def.relId);

      const common = {
        name: def.name || def.relId.split('.').slice(-1)[0],
        type: def.type || 'string',
        role: def.role || 'state',
        read: def.rw !== 'wo',
        write: def.rw === 'rw' || def.rw === 'wo',
      };
      if (def.unit) common.unit = def.unit;

      await this.adapter.setObjectNotExistsAsync(def.relId, {
        type: 'state',
        common,
        native: {
          deviceId: this.cfg.id,
          templateId: this.cfg.templateId,
          isAlias: true,
          aliasKind: def.kind,
          dpId: def.dpId,
          writeDpId: def.writeDpId,
        }
      });

      // Keep alias object meta-data (e.g. unit/role) in sync across updates.
      // Otherwise users would have to delete alias objects manually when templates change.
      await this.adapter.extendObjectAsync(def.relId, {
        common,
        native: {
          deviceId: this.cfg.id,
          templateId: this.cfg.templateId,
          isAlias: true,
          aliasKind: def.kind,
          dpId: def.dpId,
          writeDpId: def.writeDpId,
        }
      }).catch(() => {});

      this.aliasByStateRelId.set(def.relId, def);
      this.aliasDefs.push(def);
    }
  }

  async _updateAliases(values, ctx) {
    if (!Array.isArray(this.aliasDefs) || !this.aliasDefs.length) return;
    const v = values || {};
    const c = ctx || {};

    for (const def of this.aliasDefs) {
      if (!def || !def.relId) continue;

      let outVal;

      if (def.kind === 'dp') {
        if (!def.dpId) continue;
        if (!Object.prototype.hasOwnProperty.call(v, def.dpId)) {
          // Write-only datapoints won't be present in the poll result. In this case we keep
          // the last commanded value (state stays as-is).
          continue;
        }
        const raw = v[def.dpId];
        if (typeof def.fromDevice === 'function') {
          outVal = def.fromDevice(raw);
          if (outVal === undefined) continue;
        } else {
          outVal = raw;
        }
      } else if (def.kind === 'computed') {
        if (typeof def.get !== 'function') continue;
        outVal = def.get(v, c);
        if (outVal === undefined) continue;
      } else {
        continue;
      }

      await this.adapter.setStateAsync(def.relId, { val: outVal, ack: true }).catch(() => {});
    }
  }

  _createDriver() {
    const proto = this.cfg.protocol;
    if (proto === 'modbusTcp' || proto === 'modbusRtu' || proto === 'modbusAscii') {
      return new ModbusDriver(this.adapter, this.cfg, this.template, this.global);
    }
    if (proto === 'mbus') {
      return new MbusDriver(this.adapter, this.cfg, this.template, this.global);
    }
    if (proto === 'onewire') {
      return new OneWireDriver(this.adapter, this.cfg, this.template, this.global);
    }
    if (proto === 'speedwire') {
      return new SpeedwireDriver(this.adapter, this.cfg, this.template, this.global);
    }
    if (proto === 'mqtt') {
      // MQTT driver needs mapping dp -> state id
      return new MqttDriver(
        this.adapter,
        this.cfg,
        this.template,
        this.global,
        (dp) => this.relStateId(dp),
        (dp) => this._getRoundingDecimals(dp),
        () => { this._tickHeartbeatFromIncomingData().catch(() => {}); }
      );
    }
    if (proto === 'canbus') {
      // CANbus driver needs mapping dp -> state id + baseId for info.* states
      return new CanbusDriver(
        this.adapter,
        this.cfg,
        this.template,
        this.global,
        (dp) => this.relStateId(dp),
        (dp) => this._getRoundingDecimals(dp),
        this.baseId,
        () => { this._tickHeartbeatFromIncomingData().catch(() => {}); }
      );
    }
    if (proto === 'http') {
      return new HttpDriver(this.adapter, this.cfg, this.template, this.global);
    }
    if (proto === 'udp') {
      return new UdpDriver(this.adapter, this.cfg, this.template, this.global);
    }
    throw new Error(`Unsupported protocol: ${proto}`);
  }

  async start() {
    if (this.started) return;
    this.started = true;

    if (this.cfg.enabled === false) {
      this.adapter.log.info(`[${this.cfg.id}] disabled - skipping`);
      return;
    }

    this.driver = this._createDriver();

    // Heartbeat session init: start "offline" until we receive *real* data.
    // (We still keep the counter monotonic across restarts.)
    await this._loadHeartbeatStateFromDb().catch(() => {});
    this._hbLastSeen = 0;
    this._hbLastSourceStamp = 0;
    this._hbLastWriteAt = 0;
    this._hbOnline = false;
    await this.adapter.setStateAsync(this._hbRelId('online'), { val: false, ack: true }).catch(() => {});
    await this.adapter.setStateAsync(this._hbRelId('lastSeenMs'), { val: 0, ack: true }).catch(() => {});

    // Event-driven protocols (no polling)
    if (this.cfg.protocol === 'mqtt' || this.cfg.protocol === 'canbus') {
      try {
        await this.driver.connect(this.getDatapoints());
      } catch (e) {
        await this._setError(e);
      }

      // Heartbeat timeout for push protocols
      this._hbTimeoutMs = this._computeHeartbeatTimeoutMs({ isEventDriven: true });
      this._startHeartbeatChecker();

      // no polling required, but keep connection state
      await this.adapter.setStateAsync(`${this.baseId}.info.connection`, { val: true, ack: true }).catch(() => {});
      await this.adapter.setStateAsync(`${this.baseId}.info.lastError`, { val: '', ack: true }).catch(() => {});
      await this._updateAliases({}, { connected: true, lastError: '' }).catch(() => {});
      return;
    }

    // polling (most protocols)
    const allDps = this.getDatapoints();

    const normMs = (v) => {
      const n = Number(v);
      return (Number.isFinite(n) && n > 0) ? n : 0;
    };

    // Highest priority: per-device UI override
    const cfgPollMs = normMs(this.cfg.pollIntervalMs);

    // Template-specific recommendation (useful when global poll interval is slow)
    const tplPollMs =
      normMs(this.template?.driverHints?.pollIntervalMs) ||
      normMs(this.template?.pollIntervalMs) ||
      0;

    // Global default from adapter instance
    const globalPollMs = normMs(this.global.pollIntervalMs);

    // Optional split polling: fast subset every X ms + full refresh every Y ms.
    // This keeps key control signals (e.g. PV/grid/battery power) highly responsive
    // without spamming the device with a full register map on every cycle.
    const tplPolling = (this.template && this.template.driverHints) ? this.template.driverHints.polling : null;

    let fastIntervalMs = cfgPollMs || normMs(tplPolling && tplPolling.fastIntervalMs) || tplPollMs || globalPollMs || 5000;
    let slowIntervalMs = normMs(tplPolling && tplPolling.slowIntervalMs);

    let fastDps = allDps;
    let useSplitPolling = false;

    if (tplPolling && Array.isArray(tplPolling.fastDpIds) && tplPolling.fastDpIds.length) {
      const idSet = new Set(tplPolling.fastDpIds.map(x => String(x)));
      fastDps = allDps.filter(dp => dp && idSet.has(String(dp.id)));
      useSplitPolling = (fastDps.length > 0) && (slowIntervalMs > 0);
    }

    const clampInterval = (ms) => {
      const n = normMs(ms);
      return Math.max(250, n || 0);
    };

    fastIntervalMs = clampInterval(fastIntervalMs);
    if (useSplitPolling) slowIntervalMs = clampInterval(slowIntervalMs);

    // Heartbeat timeout derived from polling interval (unless overridden).
    this._hbTimeoutMs = this._computeHeartbeatTimeoutMs({ fastIntervalMs, isEventDriven: false });
    this._startHeartbeatChecker();

    // Optional write throttling & command cadence scheduling (template hinted).
    //
    // SolaX Modbus specs recommend a minimum 1s interval between instructions; enabling a 1Hz command cadence
    // lets us interleave reads (e.g. every 3s) and writes (1Hz) without overloading or locking up the device.
    const tplModbusHints = this.template?.driverHints?.modbus;

    const writeThrottleMs = normMs(tplModbusHints && (tplModbusHints.writeThrottleMs || tplModbusHints.writeIntervalMs));
    const writeMaxPerTickRaw = Number(tplModbusHints && tplModbusHints.writeMaxPerTick);

    this._writeThrottleMs = (writeThrottleMs > 0) ? clampInterval(writeThrottleMs) : 0;
    this._writeQueueEnabled = this._writeThrottleMs > 0;
    this._writeQueueMaxPerTick = (Number.isFinite(writeMaxPerTickRaw) && writeMaxPerTickRaw > 0) ? Math.max(1, Math.floor(writeMaxPerTickRaw)) : 1;

    const isModbus = String(this.cfg.protocol || '').startsWith('modbus');
    const commandCadenceRaw = normMs(tplModbusHints && tplModbusHints.commandCadenceMs);
    this._commandCadenceMs = (isModbus && commandCadenceRaw > 0) ? clampInterval(commandCadenceRaw) : 0;
    this._useCommandCadenceScheduler = this._commandCadenceMs > 0;

    // Reset per-start runtime state
    this._writeQueue.clear();
    this._writeBusy = false;

    const doPoll = async (dps) => {
      if (!this.driver) return;
      const pollDps = Array.isArray(dps) ? dps : allDps;
      try {
        const values = await this.driver.readDatapoints(pollDps);
        this._connOk = true;
        await this.adapter.setStateAsync(`${this.baseId}.info.connection`, { val: true, ack: true }).catch(() => {});
        await this.adapter.setStateAsync(`${this.baseId}.info.lastError`, { val: '', ack: true }).catch(() => {});

        // Heartbeat tick: mark device alive only when we received real data.
        // Special case Speedwire: only tick when a NEW telegram arrived (driver.lastSeen changed).
        try {
          const proto = String(this.cfg?.protocol || '').toLowerCase();
          if (proto === 'speedwire') {
            const stamp = Number(this.driver?.lastSeen || 0);
            const staleMs = Number(this.driver?.staleTimeoutMs || this.cfg?.connection?.staleTimeoutMs || 30000);
            const age = stamp > 0 ? (Date.now() - stamp) : Number.POSITIVE_INFINITY;
            // Only tick if the telegram is still considered fresh.
            if (stamp > 0 && (!Number.isFinite(staleMs) || staleMs <= 0 || age <= staleMs)) {
              await this._tickHeartbeatFromIncomingData(stamp);
            }
          } else {
            await this._tickHeartbeatFromIncomingData();
          }
        } catch (_) {
          // ignore
        }

        for (const [dpId, rawVal] of Object.entries(values)) {
          const dp = this.dpById.get(dpId);
          if (!dp) continue;

          let val = rawVal;

          // Unit-specific normalization (no address changes, only value formatting)
          val = normalizeValueByUnit(val, dp);

          // Rounding of numeric values (avoid Modbus scaling artefacts, keep consistent UI output).
          const decimals = this._getRoundingDecimals(dp);
          if (typeof val === 'number' && Number.isFinite(val) && typeof decimals === 'number' && decimals >= 0 && decimals <= 10) {
            val = roundTo(val, decimals);
          }

          // Ensure aliases get the same processed value (unit conversion happens in the driver, rounding here).
          values[dpId] = val;

          const relId = this.relStateId(dp);
          await this.adapter.setStateAsync(relId, { val, ack: true });
        }

        await this._updateAliases(values, { connected: true, lastError: '' });
      } catch (e) {
        await this._setError(e);
      }
    };

    // Initial poll: refresh all datapoints once.
    await doPoll(allDps);

    // Self-scheduling poll loop (prevents overlaps/backlog and keeps cadence stable).
    this._pollLoopActive = true;

    const self = this;
    let nextFastAt = Date.now() + fastIntervalMs;
    let nextSlowAt = useSplitPolling ? (Date.now() + slowIntervalMs) : Number.POSITIVE_INFINITY;

    let loopFn = null;

    function scheduleNext(delay) {
      if (!self._pollLoopActive) return;
      const d = Math.max(0, Number(delay) || 0);
      if (self.pollTimer) {
        this.adapter.clearTimeout(self.pollTimer);
        self.pollTimer = null;
      }
      self.pollTimer = this.adapter.setTimeout(() => {
        if (loopFn) loopFn().catch(() => {});
      }, Math.max(250, d));
    }

    async function pollLoop() {
      if (!self._pollLoopActive || !self.driver) return;

      const now = Date.now();
      const runSlow = useSplitPolling && now >= nextSlowAt;

      // Schedule the next poll based on *completion time* to prevent catch-up loops
      // when Modbus commands are rate-limited or temporarily slow.
      if (runSlow) {
        await doPoll(allDps);
      } else {
        await doPoll(fastDps);
      }

      const finishedAt = Date.now();
      if (runSlow) {
        nextSlowAt = finishedAt + slowIntervalMs;
        nextFastAt = finishedAt + fastIntervalMs;
      } else {
        nextFastAt = finishedAt + fastIntervalMs;
      }

      if (!self._pollLoopActive || !self.driver) return;

      const nextAt = Math.min(nextFastAt, nextSlowAt);
      scheduleNext(nextAt - Date.now());
    }

    async function cadenceLoop() {
      if (!self._pollLoopActive || !self.driver) return;

      const now = Date.now();
      const runSlow = useSplitPolling && now >= nextSlowAt;
      const runFast = now >= nextFastAt;

      if (runSlow) {
        await doPoll(allDps);
        const finishedAt = Date.now();
        nextSlowAt = finishedAt + slowIntervalMs;
        nextFastAt = finishedAt + fastIntervalMs;
      } else if (runFast) {
        await doPoll(fastDps);
        const finishedAt = Date.now();
        nextFastAt = finishedAt + fastIntervalMs;
      } else {
        // No poll due in this tick -> process queued writes
        const maxWrites = Math.max(1, Number(self._writeQueueMaxPerTick || 1));
        for (let i = 0; i < maxWrites; i++) {
          await self._flushWriteQueueOnce();
          if (!self._writeQueue || self._writeQueue.size === 0) break;
        }
      }

      if (!self._pollLoopActive || !self.driver) return;
      scheduleNext(self._commandCadenceMs);
    }

    // Decide which scheduler to use
    loopFn = self._useCommandCadenceScheduler ? cadenceLoop : pollLoop;

    if (self._useCommandCadenceScheduler) {
      // Tick-based cadence scheduler (e.g., 1000ms) to stay within strict Modbus timing constraints.
      scheduleNext(self._commandCadenceMs);
    } else {
      // Start after the fast interval (initial full refresh has already happened).
      scheduleNext(nextFastAt - Date.now());

      // If writes are throttled via queue and we do not use the cadence scheduler, start the write loop.
      if (self._writeQueueEnabled) self._startWriteLoop();
    }

    // Optional template-defined Modbus watchdog auto-writes (e.g., TESVOLT VK interface).
    await this._startAutoWatchdogs();
  }

  async _setError(e) {
    const err = e || {};
    this._connOk = false;
    const code = (err && err.code) ? String(err.code) : '';
    let msg = (err && err.message) ? err.message : String(err);

    const host = this.cfg?.connection?.host;
    const port = Number(this.cfg?.connection?.port || 502);

    const addHint = (hint) => {
      if (!hint) return;
      // Avoid hint duplication on repeated retries.
      if (msg.includes(`| Hint:`) && msg.includes(hint)) return;
      msg = `${msg} | Hint: ${hint}`;
    };

    // --- Transport-layer hints ---
    if (code === 'ECONNREFUSED') {
      addHint(
        `TCP connection to ${host || 'device'}:${port} was refused. ` +
        `This usually means the Modbus TCP server is disabled on the device, the IP/port is wrong, ` +
        `or a firewall/ACL actively rejects the connection. ` +
        `For SMA: ensure SMA Modbus/SunSpec Modbus is enabled and verify whether you must connect to a Data Manager instead of the inverter.`
      );
    } else if (code === 'ETIMEDOUT') {
      addHint(
        `TCP connection timed out (no response). This typically indicates packet filtering (firewall), wrong IP/route, ` +
        `or that port ${port} is not reachable from the ioBroker host.`
      );
    } else if (code === 'ENOTFOUND') {
      addHint(`Host name could not be resolved. Check the Host/IP field.`);
    } else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      addHint(`Network unreachable. Check routing/VLAN/gateway and that the device is powered on.`);
    }

    // --- Modbus-layer hints (best-effort) ---
    const lower = String(msg).toLowerCase();

    // modbus-serial commonly reports this when the underlying TCP socket/serial port is closed
    if (lower.includes('port not open')) {
      addHint(
        `The Modbus client port is not open (socket/serial closed). ` +
        `If this is Modbus TCP, the device or network likely closed the connection; the adapter will reconnect automatically. ` +
        `If this is Modbus RTU, check the serial path/permissions and whether the USB/RS485 adapter is still present.`
      );
    }
    if (lower.includes('illegal data address') || lower.includes('exception code') || lower.includes('illegal function')) {
      addHint(
        `Modbus responded but the register address/function is invalid. ` +
        `Check Address-Offset (often -1 vs 0), ensure the correct template/profile (SMA Modbus vs SunSpec), and verify Unit-ID.`
      );
    }
    if (lower.includes('timed out') && code !== 'ETIMEDOUT') {
      addHint(
        `Modbus timeout. If TCP connects but reads time out, check Unit-ID, allowed Modbus clients, and whether another client (e.g., Data Manager/SCADA) is already connected.`
      );
    }

    // --- Speedwire (UDP multicast) hints ---
    if (code === 'E_SPEEDWIRE_NO_DATA' || code === 'E_SPEEDWIRE_STALE' || lower.includes('speedwire')) {
      addHint(
        `Speedwire uses UDP multicast (typically 239.12.255.254:9522). ` +
        `Ensure the ioBroker host is in the same L2 network, multicast is not blocked, and your switch/router supports IGMP (v2). ` +
        `In virtualized setups (Docker/LXC/VM), ensure multicast traffic reaches the container/VM (bridge/host-networking).`
      );
    }

    // SMA Energy Meter note (common pitfall): it is Speedwire-based, not Modbus TCP on port 502.
    if (code === 'ECONNREFUSED' && String(this.cfg?.manufacturer || '').toUpperCase() === 'SMA' && String(this.cfg?.category || '').toUpperCase() === 'METER') {
      addHint(
        `If this is an SMA Energy Meter: it usually does NOT provide a Modbus TCP server on port 502. ` +
        `Use the Speedwire (UDP) protocol/template instead, or connect to Sunny Home Manager/Data Manager if you need Modbus.`
      );
    }

    
    // For transport layer errors we proactively close the driver so the next poll triggers a clean reconnect.
    try {
      const transportCodes = new Set(['ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','ENOTFOUND','ERR_SOCKET_CLOSED']);
      // Some Modbus libraries report timeouts via the message string without an error code.
      // Treat those as transport failures too so we force a clean reconnect.
      const isTransport = transportCodes.has(code) || lower.includes('port not open') || lower.includes('timed out') || lower.includes('timeout');
      if (isTransport && this.driver && typeof this.driver.disconnect === 'function') {
        // Don't await: keep polling loop responsive.
        this.driver.disconnect().catch(() => {});

        // If we lost transport, re-apply any required pre-writes after reconnect.
        if (this._preWriteLastTsByTrigger) this._preWriteLastTsByTrigger.clear();
      }
    } catch (_) {
      // ignore
    }

    // Throttle repetitive error logs (same message) to avoid flooding the log.
    const now = Date.now();
    const throttleMs = Number(this.global.errorLogThrottleMs || 30000);
    const shouldLog = (msg !== this._lastErrorLogMsg) || (!this._lastErrorLogTs) || ((now - this._lastErrorLogTs) > throttleMs);
    if (shouldLog) {
      this._lastErrorLogMsg = msg;
      this._lastErrorLogTs = now;
      this.adapter.log.warn(`[${this.cfg.id}] ${msg}`);
    }

    await this.adapter.setStateAsync(`${this.baseId}.info.connection`, { val: false, ack: true }).catch(() => {});
    await this.adapter.setStateAsync(`${this.baseId}.info.lastError`, { val: msg, ack: true }).catch(() => {});
    await this._updateAliases({}, { connected: false, lastError: msg }).catch(() => {});
  }

  async stop() {
    this._pollLoopActive = false;
    if (this.pollTimer) {
      this.adapter.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watchdogTimer) {
      this.adapter.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.watchdogStartTimer) {
      this.adapter.clearTimeout(this.watchdogStartTimer);
      this.watchdogStartTimer = null;
    }

    // Stop heartbeat checker
    if (this._hbCheckTimer) {
      try { this.adapter.clearInterval(this._hbCheckTimer); } catch (_) {}
      this._hbCheckTimer = null;
    }
    // Mark offline on stop (fail-safe)
    await this.adapter.setStateAsync(this._hbRelId('online'), { val: false, ack: true }).catch(() => {});
    this._hbOnline = false;

    // Stop optional write loop and clear queued writes
    try {
      this._writeQueueEnabled = false;
      this._stopWriteLoop();
      if (this._writeQueue) this._writeQueue.clear();
      this._writeBusy = false;
    } catch (e) {
      // ignore
    }
    if (this.driver) {
      try { await this.driver.disconnect(); } catch (e) { /* ignore */ }
      this.driver = null;
    }
    this.started = false;
  }

  _recordWrite(dpId) {
    if (!dpId) return;
    try {
      this._lastWriteByDpId.set(String(dpId), Date.now());
    } catch (e) {
      // ignore
    }
  }

  _isWriteQueueEnabled() {
    return !!(this._writeQueueEnabled && this._writeThrottleMs > 0);
  }

  _enqueuePreWritesForDp(dpId) {
    // In throttled mode we enqueue pre-writes as separate queued writes, so we keep a strict
    // one-modbus-command-per-cadence behaviour (SolaX doc: >=1s between instructions).
    const plan = this._getPreWritesForDp(dpId);
    if (!plan.length) return;

    const triggerKey = String(dpId).toLowerCase();
    const now = Date.now();
    const cooldownMs = plan.reduce((m, s) => Math.max(m, Number(s.cooldownMs || 0)), 0);

    const lastTs = this._preWriteLastTsByTrigger.get(triggerKey) || 0;
    if (cooldownMs > 0 && lastTs && now - lastTs < cooldownMs) return;

    for (const step of plan) {
      const stepId = String(step.dpId);
      const stepDp = this._getDpById(stepId);
      if (!stepDp) continue;
      if (!(stepDp.rw === 'rw' || stepDp.rw === 'wo')) continue;

      // Don't override an already queued user-write for the same datapoint.
      if (this._writeQueue.has(String(stepDp.id))) continue;

      this._writeQueue.set(String(stepDp.id), {
        dp: stepDp,
        deviceValue: step.value,
        ackByRelId: new Map(),
        attempts: 0,
        meta: {
          isPreWrite: true,
          preWriteTriggerKey: triggerKey,
          preWriteCooldownMs: cooldownMs,
        },
      });
    }
  }

  _enqueueWrite(ackRelId, dp, deviceValue, ackVal) {
    if (!dp || !dp.id) return;

    // Ensure required pre-writes are queued first (if any).
    this._enqueuePreWritesForDp(dp.id);

    const key = String(dp.id);
    let entry = this._writeQueue.get(key);
    if (!entry) {
      entry = {
        dp,
        deviceValue,
        ackByRelId: new Map(),
        attempts: 0,
        meta: {},
      };
      this._writeQueue.set(key, entry);
    } else {
      entry.dp = dp;
      entry.deviceValue = deviceValue;
    }

    if (ackRelId) {
      entry.ackByRelId.set(String(ackRelId), ackVal);
    }

    // If we are NOT using a command-cadence poll loop, start a dedicated write loop.
    if (this._isWriteQueueEnabled() && !this._useCommandCadenceScheduler) {
      this._startWriteLoop();
    }
  }

  _pickNextQueuedWrite() {
    if (!this._writeQueue || this._writeQueue.size === 0) return null;

    // Priority: pre-writes first
    for (const [k, v] of this._writeQueue.entries()) {
      if (v?.meta?.isPreWrite) return [k, v];
    }

    const it = this._writeQueue.entries().next();
    if (it.done) return null;
    return it.value;
  }

  async _flushWriteQueueOnce() {
    if (!this._isWriteQueueEnabled() || this._writeBusy) return;
    if (!this.driver || typeof this.driver.writeDatapoint !== 'function') return;
    if (!this._writeQueue || this._writeQueue.size === 0) return;

    this._writeBusy = true;
    let picked = null;
    try {
      picked = this._pickNextQueuedWrite();
      if (!picked) return;
      const [key, entry] = picked;
      if (!entry || !entry.dp) {
        this._writeQueue.delete(key);
        return;
      }

      await this.driver.writeDatapoint(entry.dp, entry.deviceValue);
      this._recordWrite(entry.dp.id);

      // Best-effort: keep underlying datapoint + other alias states in sync.
      await this._ackWrittenValue(entry.dp, entry.deviceValue);

      // Ack any states that were written by a user/script (dp state and/or alias state).
      if (entry.ackByRelId && entry.ackByRelId.size) {
        for (const [relId, val] of entry.ackByRelId.entries()) {
          await this.adapter.setStateAsync(relId, { val, ack: true }).catch(() => {});
        }
      }

      // Mark prewrite as done (to avoid repeating it too often).
      if (entry.meta?.isPreWrite && entry.meta.preWriteTriggerKey) {
        this._preWriteLastTsByTrigger.set(String(entry.meta.preWriteTriggerKey), Date.now());
      }

      this._writeQueue.delete(key);
    } catch (e) {
      if (picked) {
        const [key, entry] = picked;
        if (entry) {
          entry.attempts = (entry.attempts || 0) + 1;
          if (entry.attempts >= 10) this._writeQueue.delete(key);
        }
      }
      await this._setError(e);
    } finally {
      this._writeBusy = false;
    }
  }

  _startWriteLoop() {
    if (this._writeTimer || !this._isWriteQueueEnabled() || this._useCommandCadenceScheduler) return;
    const intervalMs = this._writeThrottleMs;
    if (!intervalMs || intervalMs < 250) return;

    const self = this;
    const loop = async () => {
      if (!self._isWriteQueueEnabled() || self._useCommandCadenceScheduler) return;
      await self._flushWriteQueueOnce().catch(() => {});
      self._writeTimer = this.adapter.setTimeout(loop, intervalMs);
    };
    this._writeTimer = this.adapter.setTimeout(loop, intervalMs);
  }

  _stopWriteLoop() {
    if (this._writeTimer) {
      this.adapter.clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
  }

  async handleStateChange(fullId, state) {
    if (!state || state.ack) return;
    // Convert full id -> relative id
    const relPrefix = this.adapter.namespace + '.';
    const relId = fullId.startsWith(relPrefix) ? fullId.substring(relPrefix.length) : fullId;

    // 1) alias write handling (stable interface)
    const aliasDef = this.aliasByStateRelId.get(relId);
    if (aliasDef) {
      if (!(aliasDef.rw === 'rw' || aliasDef.rw === 'wo')) return;
      if (!this.driver || typeof this.driver.writeDatapoint !== 'function') return;

      try {
        const targetId = aliasDef.writeDpId || aliasDef.dpId;
        const dp = this._getDpById(targetId);
        if (!dp) throw new Error(`Alias target datapoint not found: ${targetId}`);

        const toDev = (typeof aliasDef.toDevice === 'function') ? aliasDef.toDevice(state.val) : state.val;

        // For sensitive devices (e.g. SolaX), coalesce/throttle writes instead of sending them immediately.
        if (this._isWriteQueueEnabled()) {
          this._enqueueWrite(relId, dp, toDev, state.val);
          return;
        }

        // Optional pre-writes (template hinted), e.g. writing a control mode before an active power setpoint.
        await this._maybeExecutePreWritesForDp(dp.id);
        await this.driver.writeDatapoint(dp, toDev);

        // Track that this datapoint was actively written (used for watchdog fail-safe).
        this._recordWrite(dp.id);

        // ack alias with the user value
        await this.adapter.setStateAsync(relId, { val: state.val, ack: true }).catch(() => {});

        // best-effort: keep underlying datapoint + other alias states in sync with the written raw value
        await this._ackWrittenValue(dp, toDev);

        return;
      } catch (e) {
        await this._setError(e);
        return;
      }
    }

    // 2) regular datapoint write handling
    const dp = this.dpByStateRelId.get(relId);
    if (!dp) return;
    if (!(dp.rw === 'rw' || dp.rw === 'wo')) return;
    if (!this.driver || typeof this.driver.writeDatapoint !== 'function') return;

    try {
      // For sensitive devices (e.g. SolaX), coalesce/throttle writes instead of sending them immediately.
      if (this._isWriteQueueEnabled()) {
        this._enqueueWrite(relId, dp, state.val, state.val);
        return;
      }

      // Optional pre-writes (template hinted), e.g. writing a control mode before an active power setpoint.
      await this._maybeExecutePreWritesForDp(dp.id);
      await this.driver.writeDatapoint(dp, state.val);

      // Track that this datapoint was actively written (used for watchdog fail-safe).
      this._recordWrite(dp.id);
      // ack the written value
      await this.adapter.setStateAsync(relId, { val: state.val, ack: true });
    } catch (e) {
      await this._setError(e);
    }
  }


  _getAutoWatchdogConfig() {
    const hints = this.template?.driverHints?.modbus;
    const cfg = hints?.autoWatchdog || hints?.autoWatchdogs || hints?.watchdog;
    if (!cfg) return null;

    if (cfg === true) {
      // Boolean true is ambiguous without dpIds; require explicit list
      return null;
    }

    const enabled = (cfg.enabled !== false);
    if (!enabled) return null;

    const periodMs = Number(cfg.periodMs ?? cfg.intervalMs ?? 60000);
    const startDelayMs = Number(cfg.startDelayMs ?? 1000);
    const sequenceMin = Number(cfg.sequenceMin ?? 1);
    const sequenceMax = Number(cfg.sequenceMax ?? 1000);

    const activeForMsRaw = Number(cfg.activeForMs ?? cfg.activeWindowMs ?? cfg.activeAfterWriteMs ?? 0);
    const activeForMs = (Number.isFinite(activeForMsRaw) && activeForMsRaw > 0) ? activeForMsRaw : null;

    const globalActivation = Array.isArray(cfg.activateOnWriteDpIds || cfg.activationDpIds)
      ? (cfg.activateOnWriteDpIds || cfg.activationDpIds)
      : [];
    const globalActivationDpIds = globalActivation.map(v => String(v)).filter(v => v && v.trim());

    // Targets can be defined as:
    //  - cfg.targets: [ { dpId, activateOnWriteDpIds }, ... ]
    //  - cfg.dpIds: [ 'DP1', 'DP2', ... ] (legacy)
    //  - cfg as array: [ 'DP1', ... ] (legacy)
    const rawTargets = Array.isArray(cfg.targets)
      ? cfg.targets
      : Array.isArray(cfg.dpIds)
        ? cfg.dpIds
        : Array.isArray(cfg)
          ? cfg
          : [];

    const targets = [];
    for (const t of rawTargets) {
      if (!t) continue;
      if (typeof t === 'string' || typeof t === 'number') {
        const dpId = String(t);
        if (!dpId.trim()) continue;
        targets.push({ dpId, activationDpIds: globalActivationDpIds });
        continue;
      }
      if (typeof t === 'object') {
        const dpId = String(t.dpId ?? t.watchdogDpId ?? t.id ?? '');
        if (!dpId.trim()) continue;
        const act = Array.isArray(t.activateOnWriteDpIds || t.activationDpIds || t.activeOnWriteDpIds)
          ? (t.activateOnWriteDpIds || t.activationDpIds || t.activeOnWriteDpIds)
          : globalActivationDpIds;
        const activationDpIds = (act || []).map(v => String(v)).filter(v => v && v.trim());
        targets.push({ dpId, activationDpIds });
      }
    }
    if (!targets.length) return null;

    // Optional: Disable a control register when setpoints are no longer refreshed (fail-safe).
    let disable = null;
    const disableWhenInactive = cfg.disableWhenInactive === true;
    if (disableWhenInactive) {
      const disableDpId = String(cfg.disableDpId ?? '').trim();
      const disableValue = (cfg.disableValue !== undefined) ? cfg.disableValue : 0;
      const disableAfterMsRaw = Number(cfg.disableAfterMs ?? activeForMsRaw ?? 0);
      const disableAfterMs = (Number.isFinite(disableAfterMsRaw) && disableAfterMsRaw > 0) ? disableAfterMsRaw : null;
      const disableActRaw = Array.isArray(cfg.disableActivationDpIds)
        ? cfg.disableActivationDpIds
        : [];
      const disableActivationDpIds = disableActRaw.map(v => String(v)).filter(v => v && v.trim());
      if (disableDpId && disableAfterMs && disableActivationDpIds.length) {
        disable = {
          dpId: disableDpId,
          value: disableValue,
          afterMs: disableAfterMs,
          activationDpIds: disableActivationDpIds,
        };
      }
    }

    return {
      periodMs: Number.isFinite(periodMs) ? periodMs : 60000,
      startDelayMs: Number.isFinite(startDelayMs) ? startDelayMs : 1000,
      sequenceMin: Number.isFinite(sequenceMin) ? sequenceMin : 1,
      sequenceMax: Number.isFinite(sequenceMax) ? sequenceMax : 1000,
      activeForMs,
      targets,
      disable,
    };
  }

  async _startAutoWatchdogs() {
    // Only applies to Modbus devices
    const proto = this.cfg?.protocol;
    if (proto !== 'modbusTcp' && proto !== 'modbusRtu') return;

    const cfg = this._getAutoWatchdogConfig();
    if (!cfg) return;

    if (this.watchdogTimer || this.watchdogStartTimer) return;

    // Resolve writable watchdog datapoints
    const targets = [];
    for (const t of cfg.targets) {
      const dpId = t?.dpId;
      if (!dpId) continue;
      const dp = this._getDpById(dpId);
      if (!dp) {
        this.adapter.log.debug(`[${this.cfg.id}] AutoWatchdog: datapoint not found: ${dpId}`);
        continue;
      }
      if (!(dp.rw === 'rw' || dp.rw === 'wo')) {
        this.adapter.log.debug(`[${this.cfg.id}] AutoWatchdog: datapoint not writable: ${dpId}`);
        continue;
      }
      targets.push({ dp, activationDpIds: Array.isArray(t.activationDpIds) ? t.activationDpIds : [] });
    }

    if (!targets.length) return;

    // Optional fail-safe: disable a control register when setpoints are no longer refreshed.
    let disable = null;
    if (cfg.disable && cfg.disable.dpId) {
      const dp = this._getDpById(cfg.disable.dpId);
      if (dp && (dp.rw === 'rw' || dp.rw === 'wo')) {
        disable = {
          dp,
          value: cfg.disable.value,
          afterMs: cfg.disable.afterMs,
          activationDpIds: Array.isArray(cfg.disable.activationDpIds) ? cfg.disable.activationDpIds : [],
        };
      }
    }

    const periodMs = Math.max(10000, Number(cfg.periodMs || 60000));
    const startDelayMs = Math.max(0, Number(cfg.startDelayMs || 1000));

    const minVal = Math.trunc(Number(cfg.sequenceMin || 1));
    const maxValRaw = Math.trunc(Number(cfg.sequenceMax || 1000));
    const maxVal = Number.isFinite(maxValRaw) && maxValRaw >= minVal ? maxValRaw : 1000;

    // Initialize counter so the first tick yields minVal
    if (!Number.isFinite(this._watchdogCounter) || this._watchdogCounter < minVal || this._watchdogCounter > maxVal) {
      this._watchdogCounter = minVal - 1;
    }

    const tick = async () => {
      if (this._watchdogBusy) return;
      this._watchdogBusy = true;
      try {
        if (!this.driver || typeof this.driver.writeDatapoint !== 'function') return;
        if (!this._connOk) return; // only when connected

        // Avoid colliding with ongoing read polls
        if (this.driver && this.driver._busy) return;

        const now = Date.now();

        // Fail-safe: disable VK control if no recent setpoint updates (and if it was ever used).
        if (disable && disable.afterMs && disable.activationDpIds.length) {
          const hasEver = disable.activationDpIds.some(id => this._lastWriteByDpId.has(String(id)));
          const recent = disable.activationDpIds.some(id => {
            const ts = this._lastWriteByDpId.get(String(id));
            return ts && (now - ts) <= disable.afterMs;
          });

          if (hasEver && recent) {
            this._autoWatchdogControlEverActive = true;
            this._autoWatchdogControlDisabled = false;
          }

          if (hasEver && this._autoWatchdogControlEverActive && !recent && !this._autoWatchdogControlDisabled) {
            try {
              await this.driver.writeDatapoint(disable.dp, disable.value);
              this._recordWrite(disable.dp.id);
              await this._ackWrittenValue(disable.dp, disable.value);
              this._autoWatchdogControlDisabled = true;
              this.adapter.log.info(`[${this.cfg.id}] AutoWatchdog fail-safe: wrote ${disable.dp.id}=${disable.value}`);
            } catch (e) {
              this.adapter.log.debug(`[${this.cfg.id}] AutoWatchdog fail-safe write error: ${e && e.message ? e.message : e}`);
            }
          }
        }

        // Determine which watchdogs are active.
        const activeTargets = [];
        for (const t of targets) {
          const activationDpIds = t.activationDpIds || [];
          if (!cfg.activeForMs || !activationDpIds.length) {
            activeTargets.push(t);
            continue;
          }
          let isActive = false;
          for (const id of activationDpIds) {
            const ts = this._lastWriteByDpId.get(String(id));
            if (ts && (now - ts) <= cfg.activeForMs) {
              isActive = true;
              break;
            }
          }
          if (isActive) activeTargets.push(t);
        }

        if (!activeTargets.length) return;

        // Ramp min..max (loop)
        let next = this._watchdogCounter + 1;
        if (next > maxVal) next = minVal;
        this._watchdogCounter = next;

        for (const t of activeTargets) {
          await this.driver.writeDatapoint(t.dp, next);
          this._recordWrite(t.dp.id);
          await this._ackWrittenValue(t.dp, next);
        }
        this.adapter.log.debug(`[${this.cfg.id}] AutoWatchdog tick -> ${next} (targets=${activeTargets.map(x => x.dp.id).join(',')})`);
      } catch (e) {
        // Best-effort: do not spam warnings; poll loop will surface transport errors.
        this.adapter.log.debug(`[${this.cfg.id}] AutoWatchdog error: ${e && e.message ? e.message : e}`);
      } finally {
        this._watchdogBusy = false;
      }
    };

    // Fire once shortly after start, then periodically
    this.watchdogStartTimer = this.adapter.setTimeout(() => { tick(); }, startDelayMs);
    this.watchdogTimer = this.adapter.setInterval(() => { tick(); }, periodMs);

    this.adapter.log.info(`[${this.cfg.id}] AutoWatchdog enabled: dpIds=[${targets.map(t => t.dp.id).join(', ')}], periodMs=${periodMs}, activeForMs=${cfg.activeForMs || 0}`);
  }

  _getPreWritesForDp(dpId) {
    const id = (dpId ?? '').toString();
    if (!id) return [];
    const hints = this.template?.driverHints?.modbus;
    const cfg = hints?.preWrites;
    if (!Array.isArray(cfg) || !cfg.length) return [];

    const wanted = id.toLowerCase();
    const out = [];
    for (const rule of cfg) {
      if (!rule) continue;
      const trig = (rule.triggerDpId ?? rule.onWriteDpId ?? '').toString().toLowerCase();
      if (!trig || trig !== wanted) continue;

      const cooldownMsRaw = Number(rule.cooldownMs ?? rule.throttleMs ?? rule.minIntervalMs ?? 0);
      const cooldownMs = Number.isFinite(cooldownMsRaw) && cooldownMsRaw > 0 ? cooldownMsRaw : 0;

      const writes = Array.isArray(rule.writes) ? rule.writes : [];
      for (const w of writes) {
        if (!w || !w.dpId) continue;
        if (w.value === undefined) continue;
        out.push({ dpId: String(w.dpId), value: w.value, triggerDpId: wanted, cooldownMs });
      }
    }
    return out;
  }

  async _maybeExecutePreWritesForDp(dpId) {
    if (!this.driver || typeof this.driver.writeDatapoint !== 'function') return;
    const plan = this._getPreWritesForDp(dpId);
    if (!plan.length) return;

    const triggerKey = (dpId ?? '').toString().toLowerCase();
    const cooldownMs = plan.reduce((m, s) => Math.max(m, Number(s.cooldownMs || 0)), 0);
    if (cooldownMs > 0) {
      const lastTs = this._preWriteLastTsByTrigger.get(triggerKey) || 0;
      const now = Date.now();
      if (lastTs && now - lastTs < cooldownMs) return;
    }

    for (const step of plan) {
      try {
        const dp = this._getDpById(step.dpId);
        if (!dp) continue;
        if (!(dp.rw === 'rw' || dp.rw === 'wo')) continue;
        await this.driver.writeDatapoint(dp, step.value);
        // Track pre-write activity as well (important for fail-safe logic).
        this._recordWrite(dp.id);
        await this._ackWrittenValue(dp, step.value);
      } catch (e) {
        // Pre-write failure should surface clearly (it affects the main command).
        throw e;
      }
    }

    if (cooldownMs > 0) this._preWriteLastTsByTrigger.set(triggerKey, Date.now());
  }

  async _ackWrittenValue(dp, rawValue) {
    if (!dp || !dp.id) return;

    // Update underlying datapoint state
    const dpRelId = this.relStateId(dp);
    await this.adapter.setStateAsync(dpRelId, { val: rawValue, ack: true }).catch(() => {});

    // Update all alias states that reference this datapoint (best-effort)
    if (!Array.isArray(this.aliasDefs) || !this.aliasDefs.length) return;
    for (const def of this.aliasDefs) {
      try {
        if (!def || def.kind !== 'dp' || def.dpId !== dp.id) continue;
        let outVal = rawValue;
        if (typeof def.fromDevice === 'function') {
          outVal = def.fromDevice(rawValue);
          if (outVal === undefined) continue;
        }
        await this.adapter.setStateAsync(def.relId, { val: outVal, ack: true }).catch(() => {});
      } catch (_) {
        // ignore
      }
    }
  }
}

module.exports = {
  DeviceRuntime,
};