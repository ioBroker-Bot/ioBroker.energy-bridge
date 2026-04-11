'use strict';

const fs = require('node:fs');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');

const { DeviceRuntime } = require('./lib/deviceRuntime');

function readTemplates(adapter) {
  try {
    const p = path.join(__dirname, 'lib', 'templates.json');
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    const templates = Array.isArray(data.templates) ? data.templates : [];
    const byId = {};
    for (const t of templates) byId[t.id] = t;
    return { templates, byId };
  } catch (e) {
    adapter.log.error(`Failed to load templates.json: ${e.message || e}`);
    return { templates: [], byId: {} };
  }
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}



class EnergyBridgeAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: 'energy-bridge',
    });

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));

    this.templateRegistry = { templates: [], byId: {} };
    this.deviceRuntimes = [];
    this.deviceById = new Map();
  }

  async onReady() {
    // Automatic environment migration (no manual user steps)
    // init info
    await this.setObjectNotExistsAsync('info.connection', {
      type: 'state',
      common: {
        name: 'Connected',
        type: 'boolean',
        role: 'indicator.connected',
        read: true,
        write: false,
        def: false
      },
      native: {}
    });

    await this.setObjectNotExistsAsync('devices', {
      type: 'channel',
      common: { name: 'Devices' },
      native: {}
    });

    this.templateRegistry = readTemplates(this);

    // parse devices config
    let devicesCfg;
    if (Array.isArray(this.config.devices)) {
      devicesCfg = this.config.devices;
    } else if (Array.isArray(this.config.devicesJson)) {
      devicesCfg = this.config.devicesJson;
    } else {
      devicesCfg = safeJsonParse(this.config.devicesJson || '[]', []);
    }
    const devices = Array.isArray(devicesCfg) ? devicesCfg : [];

    const globalConfig = {
      pollIntervalMs: Number(this.config.pollIntervalMs || 5000),
      modbusTimeoutMs: Number(this.config.modbusTimeoutMs || 2000),
      registerAddressOffset: Number(this.config.registerAddressOffset || 0),
    };

    if (!devices.length) {
      this.log.warn('No devices configured. Add devices in the admin UI.');
      await this.setStateAsync('info.connection', { val: false, ack: true });
      return;
    }

    // create runtimes
    for (const d of devices) {
      try {
        if (!d || !d.id) continue;
        const tpl = this.templateRegistry.byId[d.templateId];
        if (!tpl) {
          this.log.warn(`[${d.id}] Template not found: ${d.templateId}`);
          continue;
        }

        // ensure some defaults
        if (!d.category) d.category = tpl.category;
        if (!d.manufacturer) d.manufacturer = tpl.manufacturer;

        const rt = new DeviceRuntime(this, d, tpl, globalConfig);
        await rt.initObjects();
        await rt.start();

        this.deviceRuntimes.push(rt);
        this.deviceById.set(d.id, rt);
      } catch (e) {
        this.log.warn(`Failed to start device: ${e.message || e}`);
      }
    }

    // subscribe to all device states (writes)
    this.subscribeStates('devices.*');

    // overall connection: true if at least one enabled device exists
    const anyEnabled = devices.some(d => d && d.enabled !== false);
    await this.setStateAsync('info.connection', { val: anyEnabled, ack: true });
  }

  async onStateChange(id, state) {
    if (!id || !state) return;

    // dispatch to runtime by prefix match
    for (const rt of this.deviceRuntimes) {
      const prefix = this.namespace + '.' + rt.baseId + '.';
      if (id.startsWith(prefix) || id === this.namespace + '.' + rt.baseId) {
        await rt.handleStateChange(id, state);
        return;
      }
    }
  }

  async onUnload(callback) {
    try {
      for (const rt of this.deviceRuntimes) {
        try { await rt.stop(); } catch (e) { /* ignore */ }
      }
      this.deviceRuntimes = [];
      await this.setStateAsync('info.connection', { val: false, ack: true }).catch(() => {});
      callback();
    } catch (e) {
      callback();
    }
  }
}

if (module.parent) {
  module.exports = (options) => new EnergyBridgeAdapter(options);
} else {
  new EnergyBridgeAdapter();
}