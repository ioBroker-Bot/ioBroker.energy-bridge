/* global React, ReactDOM, socket, systemDictionary, systemLang */
'use strict';

(function () {
  const h = React.createElement;

  // Detect Admin theme (dark/light) and expose it as attribute for CSS.
  // We try to detect via computed background color first and fall back to prefers-color-scheme.
  function __eb_parseRgb(color) {
    if (!color) return null;
    const c = color.trim().toLowerCase();
    if (c === 'transparent') return null;
    const m = c.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/);
    if (!m) return null;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    const a = m[4] !== undefined ? Number(m[4]) : 1;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) return null;
    if (a === 0) return null;
    return { r, g, b, a };
  }

  function __eb_luminance(rgb) {
    // sRGB relative luminance (approx.)
    const srgb = [rgb.r, rgb.g, rgb.b].map(v => v / 255);
    const lin = srgb.map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  function __eb_detectTheme() {
    try {
      // Prefer the parent document (ioBroker Admin) because the config page
      // might have a transparent background.
      let refDoc = document;
      try {
        if (window.parent && window.parent.document && window.parent.document.body) {
          refDoc = window.parent.document;
        }
      } catch (e) {
        // cross-origin or blocked - ignore
      }

      // 1) Try background colors
      const bgBody = window.getComputedStyle(refDoc.body).backgroundColor;
      let rgb = __eb_parseRgb(bgBody);
      if (!rgb) {
        const bgHtml = window.getComputedStyle(refDoc.documentElement).backgroundColor;
        rgb = __eb_parseRgb(bgHtml);
      }
      if (rgb) {
        const lum = __eb_luminance(rgb);
        return lum < 0.5 ? 'dark' : 'light';
      }

      // 2) Fallback: infer from text color (light text usually means dark theme)
      const col = window.getComputedStyle(refDoc.body).color;
      const cRgb = __eb_parseRgb(col);
      if (cRgb) {
        const lum = __eb_luminance(cRgb);
        if (lum > 0.6) return 'dark';
        if (lum < 0.4) return 'light';
      }
    } catch (e) {
      // ignore
    }

    // 3) Last fallback: OS preference
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  function __eb_applyTheme() {
    const theme = __eb_detectTheme();
    document.documentElement.setAttribute('data-eb-theme', theme);
  }

  // Initial + live update
  __eb_applyTheme();
  try {
    if (window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      if (mql && typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', __eb_applyTheme);
      } else if (mql && typeof mql.addListener === 'function') {
        mql.addListener(__eb_applyTheme);
      }
    }
  } catch (e) {
    // ignore
  }


  function getLang() {
    return (typeof window !== 'undefined' && (window.systemLang || systemLang)) || 'en';
  }

  function t(key) {
    try {
      const lang = getLang();
      if (typeof systemDictionary === 'object' && systemDictionary && systemDictionary[key]) {
        return systemDictionary[key][lang] || systemDictionary[key].en || key;
      }
    } catch (e) {
      // ignore
    }
    return key;
  }

  function safeJsonParse(str, fallback) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return fallback;
    }
  }

  function isObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
  }

  function getInstanceId() {
    try {
      const params = new URLSearchParams(window.location.search);
      const inst = params.get('instance');
      if (inst !== null && inst !== undefined && inst !== '') return inst;
    } catch (e) {
      // ignore
    }
    return '0';
  }

  function maskSecrets(devices) {
    return (devices || []).map(d => {
      const clone = safeJsonParse(JSON.stringify(d || {}), {});
      if (clone && clone.connection) {
        if (clone.connection.password) clone.connection.password = '******';
        if (clone.connection.writePassword) clone.connection.writePassword = '******';
      }
      return clone;
    });
  }

  function normalizeDevices(devices) {
    if (!Array.isArray(devices)) return [];
    return devices
      .filter(d => isObject(d))
      .map(d => {
        const out = Object.assign({}, d);
        if (!isObject(out.connection)) out.connection = {};
        if (typeof out.enabled !== 'boolean') out.enabled = true;
        return out;
      });
  }


  function coerceInt(val) {
    if (val === null || val === undefined) return undefined;
    const s = String(val).trim();
    if (s === '') return undefined;
    const n = Number(s);
    if (!Number.isFinite(n)) return undefined;
    return Math.trunc(n);
  }
  function uniq(arr) {
    return Array.from(new Set(arr.filter(v => v !== undefined && v !== null && String(v).trim() !== '')));
  }

  function sortAlpha(arr) {
    return arr.slice().sort((a, b) => String(a).localeCompare(String(b)));
  }

  function suggestId(prefix, devices) {
    const used = new Set((devices || []).map(d => String(d.id || '').toLowerCase()));
    let n = 1;
    let id = `${prefix}${n}`;
    while (used.has(id.toLowerCase())) {
      n += 1;
      id = `${prefix}${n}`;
      if (n > 9999) break;
    }
    return id;
  }

  function categoryPrefix(category) {
    switch (category) {
      case 'PV_INVERTER':
        return 'inv';
      case 'METER':
        return 'meter';
      case 'EVCS':
      case 'EVSE':
      case 'CHARGER':
      case 'DC_CHARGER':
        return 'ev';
      case 'BATTERY':
      case 'BATTERY_INVERTER':
      case 'ESS':
        return 'ess';
      case 'HEAT':
        return 'heat';
      case 'IO':
        return 'io';
      default:
        return 'dev';
    }
  }

  function defaultConnection(protocol) {
    if (protocol === 'modbusTcp') {
      return {
        host: '',
        port: 502,
        unitId: 1,
        timeoutMs: undefined,
        addressOffset: undefined,
        wordOrder: 'be',
        byteOrder: 'be',
        writePassword: undefined,
      };
    }
    if (protocol === 'modbusRtu' || protocol === 'modbusAscii') {
      return {
        path: '',
        baudRate: 9600,
        parity: 'none',
        dataBits: 8,
        stopBits: 1,
        unitId: 1,
        timeoutMs: undefined,
        addressOffset: undefined,
        wordOrder: 'be',
        byteOrder: 'be',
        writePassword: undefined,
      };
    }
    if (protocol === 'mbus') {
      return {
        path: '',
        baudRate: 2400,
        parity: 'even',
        dataBits: 8,
        stopBits: 1,
        unitId: 1,
        timeoutMs: undefined,
        sendNke: false,
      };
    }
    if (protocol === 'mqtt') {
      return {
        url: '',
        username: undefined,
        password: undefined,
      };
    }
    if (protocol === 'http') {
      return {
        baseUrl: '',
        username: undefined,
        password: undefined,
        meterId: undefined,
        insecureTls: false,
      };
    }
    if (protocol === 'udp') {
      return {
        host: '',
        port: 7090,
        timeoutMs: undefined,
        commandPauseMs: 0,
      };
    }
    if (protocol === 'speedwire') {
      return {
        filterHost: '',
        multicastGroup: '239.12.255.254',
        port: 9522,
        interfaceAddress: '',
        staleTimeoutMs: 30000,
      };
    }
    if (protocol === 'onewire') {
      return {
        basePath: '/sys/bus/w1/devices',
        sensorId: '',
        file: 'w1_slave',
        parser: 'ds18b20',
      };
    }
    if (protocol === 'canbus') {
      return {
        interface: 'can0',
        candumpArgs: undefined,
        candumpPath: 'candump',
        cansendPath: 'cansend',
      };
    }
    return {};
  }

  function normalizeProtocolForTemplate(template, protocol) {
    if (!template || !Array.isArray(template.protocols) || template.protocols.length === 0) return protocol || '';
    if (protocol && template.protocols.includes(protocol)) return protocol;
    return template.protocols[0];
  }

  class EnergyBridgeAdmin extends React.Component {
    constructor(props) {
      super(props);

      this.state = {
        loaded: false,
        activeTab: 'general',
        global: {
          pollIntervalMs: 5000,
          modbusTimeoutMs: 2000,
          registerAddressOffset: 0,
        },
        templates: [],
        templatesById: {},
        categories: [],
        manufacturersByCategory: {},
        templatesByCatMan: {},
        devices: [],
        status: {
          alive: null,
          connection: null,
        },
        error: null,

        deviceModal: {
          open: false,
          mode: 'add',
          index: -1,
          draft: null,
          existingSecrets: null,
          errors: [],
        },

        jsonModal: {
          open: false,
          mode: 'export',
          text: '',
          error: null,
        },
      };

      this._onChange = null;
      this._stateChangeHandler = null;
    }

    componentDidMount() {
      this.loadTemplates();
      this.initStatusSubscription();

      // Apply pending load() call (if admin called load before React mounted)
      if (window.__energyBridgePendingSettings) {
        const pending = window.__energyBridgePendingSettings;
        const cb = window.__energyBridgePendingOnChange;
        delete window.__energyBridgePendingSettings;
        delete window.__energyBridgePendingOnChange;
        this.setLoadedSettings(pending, cb);
      }
    }

    componentWillUnmount() {
      try {
        if (this._stateChangeHandler && typeof socket !== 'undefined' && socket && socket.off) {
          socket.off('stateChange', this._stateChangeHandler);
        }
      } catch (e) {
        // ignore
      }
    }

    markChanged() {
      if (typeof this._onChange === 'function') {
        this._onChange(true);
      }
    }

    setLoadedSettings(settings, onChange) {
      this._onChange = onChange;

      const g = Object.assign({}, this.state.global);
      if (settings && settings.pollIntervalMs !== undefined) g.pollIntervalMs = settings.pollIntervalMs;
      if (settings && settings.modbusTimeoutMs !== undefined) g.modbusTimeoutMs = settings.modbusTimeoutMs;
      if (settings && settings.registerAddressOffset !== undefined) g.registerAddressOffset = settings.registerAddressOffset;

      let devices = [];
      if (settings && typeof settings.devicesJson === 'string') {
        devices = safeJsonParse(settings.devicesJson, []);
      } else if (settings && Array.isArray(settings.devicesJson)) {
        // When coming from jsonConfig, devicesJson is stored as an array
        devices = settings.devicesJson;
      } else if (settings && Array.isArray(settings.devices)) {
        devices = settings.devices;
      }
      devices = normalizeDevices(devices);

      this.setState({ global: g, devices, loaded: true }, () => {
        if (typeof this._onChange === 'function') this._onChange(false);
      });
    }

    getSaveConfig() {
      const g = this.state.global || {};
      const devices = normalizeDevices(this.state.devices);

      const out = {
        pollIntervalMs: Number.isFinite(Number(g.pollIntervalMs)) ? Math.trunc(Number(g.pollIntervalMs)) : 5000,
        modbusTimeoutMs: Number.isFinite(Number(g.modbusTimeoutMs)) ? Math.trunc(Number(g.modbusTimeoutMs)) : 2000,
        registerAddressOffset: Number.isFinite(Number(g.registerAddressOffset)) ? Math.trunc(Number(g.registerAddressOffset)) : 0,
        devicesJson: JSON.stringify(devices, null, 2),
      };

      return out;
    }

    loadTemplates() {
      fetch('templates.json')
        .then(res => res.json())
        .then(data => {
          const templates = (data && Array.isArray(data.templates)) ? data.templates : [];
          const byId = {};
          templates.forEach(tpl => {
            if (tpl && tpl.id) byId[tpl.id] = tpl;
          });

          const categories = sortAlpha(uniq(templates.map(tpl => tpl.category)));
          const manufacturersByCategory = {};
          const templatesByCatMan = {};

          categories.forEach(cat => {
            const mans = sortAlpha(uniq(templates.filter(tpl => tpl.category === cat).map(tpl => tpl.manufacturer)));
            manufacturersByCategory[cat] = mans;

            templatesByCatMan[cat] = {};
            mans.forEach(m => {
              templatesByCatMan[cat][m] = templates
                .filter(tpl => tpl.category === cat && tpl.manufacturer === m)
                .map(tpl => ({ id: tpl.id, name: tpl.name || tpl.id, protocols: tpl.protocols || [] }));
            });
          });

          this.setState({ templates, templatesById: byId, categories, manufacturersByCategory, templatesByCatMan });
        })
        .catch(err => {
          this.setState({ error: String(err && err.message ? err.message : err) });
        });
    }

    initStatusSubscription() {
      try {
        if (typeof socket === 'undefined' || !socket) return;

        const inst = getInstanceId();
        const aliveId = `system.adapter.energy-bridge.${inst}.alive`;
        const connId = `energy-bridge.${inst}.info.connection`;

        socket.emit('getState', aliveId, (err, state) => {
          if (!err && state) {
            this.setState({ status: Object.assign({}, this.state.status, { alive: !!state.val }) });
          }
        });

        socket.emit('getState', connId, (err, state) => {
          if (!err && state) {
            this.setState({ status: Object.assign({}, this.state.status, { connection: !!state.val }) });
          }
        });

        socket.emit('subscribe', aliveId);
        socket.emit('subscribe', connId);

        this._stateChangeHandler = (id, state) => {
          if (!state) return;
          if (id === aliveId) {
            this.setState({ status: Object.assign({}, this.state.status, { alive: !!state.val }) });
          } else if (id === connId) {
            this.setState({ status: Object.assign({}, this.state.status, { connection: !!state.val }) });
          }
        };

        socket.on('stateChange', this._stateChangeHandler);
      } catch (e) {
        // ignore
      }
    }

    setActiveTab(tab) {
      this.setState({ activeTab: tab });
    }

    updateGlobalField(field, value) {
      const g = Object.assign({}, this.state.global);
      g[field] = value;
      this.setState({ global: g }, () => this.markChanged());
    }

    openDeviceModal(mode, index) {
      const devices = normalizeDevices(this.state.devices);
      const templatesById = this.state.templatesById || {};

      let draft;
      let existingSecrets = null;

      if (mode === 'edit' && index >= 0 && index < devices.length) {
        draft = safeJsonParse(JSON.stringify(devices[index]), {});
        existingSecrets = {};
        if (draft && draft.connection) {
          if (draft.connection.password) existingSecrets.password = draft.connection.password;
          if (draft.connection.writePassword) existingSecrets.writePassword = draft.connection.writePassword;
        }
      } else {
        const defaultCategory = (this.state.categories && this.state.categories[0]) || '';
        const mans = (this.state.manufacturersByCategory && this.state.manufacturersByCategory[defaultCategory]) || [];
        const defaultMan = mans[0] || '';
        const tpls = (((this.state.templatesByCatMan || {})[defaultCategory] || {})[defaultMan]) || [];
        const defaultTplId = (tpls[0] && tpls[0].id) || '';
        const tpl = templatesById[defaultTplId];
        const protocol = normalizeProtocolForTemplate(tpl, (tpl && tpl.protocols && tpl.protocols[0]) || '');
        draft = {
          id: suggestId(categoryPrefix(defaultCategory), devices),
          name: (tpl && tpl.name) ? tpl.name : '',
          enabled: true,
          category: defaultCategory,
          manufacturer: defaultMan,
          templateId: defaultTplId,
          protocol,
          pollIntervalMs: undefined,
          heartbeatTimeoutMs: undefined,
          connection: defaultConnection(protocol),
        };
      }

      // Normalize draft based on template protocols
      const tpl = templatesById[draft.templateId];
      const normalizedProtocol = normalizeProtocolForTemplate(tpl, draft.protocol);
      if (normalizedProtocol !== draft.protocol) {
        draft.protocol = normalizedProtocol;
        draft.connection = Object.assign(defaultConnection(normalizedProtocol), draft.connection || {});
      }

      this.setState({
        deviceModal: {
          open: true,
          mode,
          index,
          draft,
          existingSecrets,
          errors: [],
        },
      });
    }

    closeDeviceModal() {
      this.setState({
        deviceModal: {
          open: false,
          mode: 'add',
          index: -1,
          draft: null,
          existingSecrets: null,
          errors: [],
        },
      });
    }

    updateDraftField(path, value) {
      const modal = Object.assign({}, this.state.deviceModal);
      const draft = Object.assign({}, modal.draft || {});
      const parts = String(path).split('.');
      let cur = draft;

      for (let i = 0; i < parts.length - 1; i += 1) {
        const p = parts[i];
        if (!isObject(cur[p])) cur[p] = {};
        cur = cur[p];
      }
      cur[parts[parts.length - 1]] = value;

      // Special handling when changing template or protocol
      if (path === 'templateId') {
        const tpl = (this.state.templatesById || {})[value];
        const protocol = normalizeProtocolForTemplate(tpl, draft.protocol);
        draft.category = (tpl && tpl.category) ? tpl.category : draft.category;
        draft.manufacturer = (tpl && tpl.manufacturer) ? tpl.manufacturer : draft.manufacturer;
        draft.protocol = protocol;
        draft.name = (tpl && tpl.name) ? tpl.name : draft.name;
        draft.connection = Object.assign(defaultConnection(protocol), draft.connection || {});
        if (!draft.id) draft.id = suggestId(categoryPrefix(draft.category), normalizeDevices(this.state.devices));
      }

      if (path === 'protocol') {
        const tpl = (this.state.templatesById || {})[draft.templateId];
        const protocol = normalizeProtocolForTemplate(tpl, value);
        draft.protocol = protocol;
        draft.connection = Object.assign(defaultConnection(protocol), draft.connection || {});
      }

      modal.draft = draft;
      this.setState({ deviceModal: modal });
    }

    validateDraft(draft, existingSecrets) {
      const errors = [];

      const id = String(draft.id || '').trim();
      if (!id) errors.push(t('Device ID is required.'));
      if (id && !/^[a-zA-Z0-9_\-]+$/.test(id)) errors.push(t('Invalid device ID. Allowed: letters, numbers, _ and -'));
      if (!draft.templateId) errors.push(t('Template is required.'));
      if (!draft.protocol) errors.push(t('Protocol is required.'));

      const tpl = (this.state.templatesById || {})[draft.templateId];
      if (tpl && Array.isArray(tpl.protocols) && draft.protocol && !tpl.protocols.includes(draft.protocol)) {
        errors.push(t('Template not supported by selected protocol.'));
      }

      const c = draft.connection || {};
      if (draft.protocol === 'modbusTcp' && !String(c.host || '').trim()) errors.push(t('Modbus TCP host is required.'));
      if ((draft.protocol === 'modbusRtu' || draft.protocol === 'modbusAscii' || draft.protocol === 'mbus') && !String(c.path || '').trim()) errors.push(t('Serial port is required.'));
      if (draft.protocol === 'mqtt' && !String(c.url || '').trim()) errors.push(t('MQTT broker URL is required.'));
      if (draft.protocol === 'canbus' && !String(c.interface || '').trim()) errors.push(t('CAN interface is required.'));
      if (draft.protocol === 'onewire' && !String(c.sensorId || '').trim()) errors.push(t('1-Wire sensor ID is required.'));
      if (draft.protocol === 'http' && !String(c.baseUrl || '').trim()) errors.push(t('HTTP base URL is required.'));
      if (draft.protocol === 'udp' && !String(c.host || '').trim()) errors.push(t('UDP host is required.'));

      // Preserve secrets if the fields are empty
      if (draft.protocol === 'mqtt') {
        if (!String(c.password || '').trim() && existingSecrets && existingSecrets.password) c.password = existingSecrets.password;
      }
      if (draft.protocol === 'http') {
        if (!String(c.password || '').trim() && existingSecrets && existingSecrets.password) c.password = existingSecrets.password;
      }
      if (draft.protocol === 'modbusTcp' || draft.protocol === 'modbusRtu' || draft.protocol === 'modbusAscii') {
        if (!String(c.writePassword || '').trim() && existingSecrets && existingSecrets.writePassword) c.writePassword = existingSecrets.writePassword;
      }


      // Coerce numeric fields to numbers (to keep the adapter config clean)
      if (draft.pollIntervalMs !== undefined) draft.pollIntervalMs = coerceInt(draft.pollIntervalMs);
      if (draft.heartbeatTimeoutMs !== undefined) draft.heartbeatTimeoutMs = coerceInt(draft.heartbeatTimeoutMs);

      if (draft.protocol === 'modbusTcp') {
        c.port = coerceInt(c.port);
        c.unitId = coerceInt(c.unitId);
        c.timeoutMs = coerceInt(c.timeoutMs);
        c.addressOffset = coerceInt(c.addressOffset);
      } else if (draft.protocol === 'modbusRtu' || draft.protocol === 'modbusAscii') {
        c.baudRate = coerceInt(c.baudRate);
        c.dataBits = coerceInt(c.dataBits);
        c.stopBits = coerceInt(c.stopBits);
        c.unitId = coerceInt(c.unitId);
        c.timeoutMs = coerceInt(c.timeoutMs);
        c.addressOffset = coerceInt(c.addressOffset);
      } else if (draft.protocol === 'mbus') {
        c.baudRate = coerceInt(c.baudRate);
        c.dataBits = coerceInt(c.dataBits);
        c.stopBits = coerceInt(c.stopBits);
        c.unitId = coerceInt(c.unitId);
        c.timeoutMs = coerceInt(c.timeoutMs);
      } else if (draft.protocol === 'udp') {
        c.port = coerceInt(c.port);
        c.timeoutMs = coerceInt(c.timeoutMs);
        c.commandPauseMs = coerceInt(c.commandPauseMs) || 0;
      } else if (draft.protocol === 'speedwire') {
        c.port = coerceInt(c.port);
        c.staleTimeoutMs = coerceInt(c.staleTimeoutMs);
      }

      return { errors, draft: Object.assign({}, draft, { id: id, connection: c }) };
    }

    saveDeviceFromModal() {
      const modal = this.state.deviceModal;
      if (!modal || !modal.draft) return;

      const v = this.validateDraft(Object.assign({}, modal.draft), modal.existingSecrets);
      if (v.errors.length) {
        this.setState({ deviceModal: Object.assign({}, modal, { errors: v.errors }) });
        return;
      }

      const devices = normalizeDevices(this.state.devices);
      if (modal.mode === 'edit' && modal.index >= 0 && modal.index < devices.length) {
        devices[modal.index] = v.draft;
      } else {
        devices.push(v.draft);
      }

      this.setState({ devices }, () => {
        this.markChanged();
        this.closeDeviceModal();
      });
    }

    deleteDevice(index) {
      const devices = normalizeDevices(this.state.devices);
      if (index < 0 || index >= devices.length) return;

      if (!window.confirm(t('Are you sure you want to delete this device?'))) return;

      devices.splice(index, 1);
      this.setState({ devices }, () => this.markChanged());
    }

    openJsonModal(mode) {
      const devices = normalizeDevices(this.state.devices);
      if (mode === 'export') {
        this.setState({
          jsonModal: {
            open: true,
            mode: 'export',
            text: JSON.stringify(maskSecrets(devices), null, 2),
            error: null,
          },
        });
      } else {
        this.setState({
          jsonModal: {
            open: true,
            mode: 'import',
            text: '',
            error: null,
          },
        });
      }
    }

    closeJsonModal() {
      this.setState({
        jsonModal: {
          open: false,
          mode: 'export',
          text: '',
          error: null,
        },
      });
    }

    applyJsonImport() {
      const txt = this.state.jsonModal.text;
      const parsed = safeJsonParse(txt, null);
      if (!Array.isArray(parsed)) {
        this.setState({ jsonModal: Object.assign({}, this.state.jsonModal, { error: t('Paste a JSON array of devices here.') }) });
        return;
      }
      const devices = normalizeDevices(parsed);
      this.setState({ devices }, () => {
        this.markChanged();
        this.closeJsonModal();
      });
    }

    renderStatusBadge(label, value) {
      let text;
      if (value === null) text = t('Unknown');
      else text = value ? t('Connected') : t('Disconnected');

      return h('span', { className: 'nexo-badge', style: { marginLeft: '6px' } }, `${label}: ${text}`);
    }

    renderTabs() {
      const tabBtn = (id, label) => {
        const isActive = this.state.activeTab === id;
        return h(
          'button',
          {
            type: 'button',
            className: `nexo-tab ${isActive ? 'active' : ''}`,
            onClick: () => this.setActiveTab(id),
          },
          label
        );
      };

      return h('div', { className: 'nexo-tabs' }, [
        tabBtn('general', t('General')),
        tabBtn('devices', t('Devices')),
      ]);
    }

    renderGeneralTab() {
      const g = this.state.global || {};
      const input = (label, field, type, help) =>
        h('div', { className: 'nexo-field' }, [
          h('label', { className: 'nexo-label' }, label),
          h('input', {
            className: 'nexo-input',
            type: type || 'number',
            value: g[field] !== undefined && g[field] !== null ? String(g[field]) : '',
            onChange: ev => this.updateGlobalField(field, ev.target.value),
          }),
          help ? h('div', { className: 'nexo-help' }, help) : null,
        ]);

      return h('div', { className: 'nexo-card' }, [
        h('h6', null, t('Global settings')),
        input(t('Poll interval (ms)'), 'pollIntervalMs', 'number'),
        input(t('Modbus timeout (ms)'), 'modbusTimeoutMs', 'number'),
        input(t('Register address offset'), 'registerAddressOffset', 'number'),
      ]);
    }

    renderDevicesTable() {
      const devices = normalizeDevices(this.state.devices);

      const rows = devices.map((d, idx) => {
        const tpl = (this.state.templatesById || {})[d.templateId] || {};
        return h('tr', { key: `${d.id || idx}` }, [
          h('td', { 'data-label': t('Enabled') }, h('input', {
            type: 'checkbox',
            checked: !!d.enabled,
            onChange: ev => {
              const list = normalizeDevices(this.state.devices);
              list[idx] = Object.assign({}, list[idx], { enabled: !!ev.target.checked });
              this.setState({ devices: list }, () => this.markChanged());
            },
          })),
          h('td', { 'data-label': t('Device ID') }, String(d.id || '')),
          h('td', { 'data-label': t('Name') }, String(d.name || tpl.name || '')),
          h('td', { 'data-label': t('Category') }, String(d.category || '')),
          h('td', { 'data-label': t('Manufacturer') }, String(d.manufacturer || '')),
          h('td', { 'data-label': t('Template') }, String(d.templateId || '')),
          h('td', { 'data-label': t('Protocol') }, String(d.protocol || '')),
          h('td', { 'data-label': t('Actions') },
            h('div', { className: 'nexo-actions' }, [
              h('button', { type: 'button', className: 'nexo-btn', onClick: () => this.openDeviceModal('edit', idx) }, t('Edit device')),
              h('button', { type: 'button', className: 'nexo-btn danger', onClick: () => this.deleteDevice(idx) }, t('Delete')),
            ])
          ),
        ]);
      });

      return h('div', { className: 'nexo-card' }, [
        h('div', { className: 'nexo-devices-header' }, [
          h('h6', null, t('Device list')),
          h('div', { className: 'nexo-actions' }, [
            h('button', { type: 'button', className: 'nexo-btn primary', onClick: () => this.openDeviceModal('add', -1) }, t('Add device')),
            h('button', { type: 'button', className: 'nexo-btn', onClick: () => this.openJsonModal('import') }, t('Import JSON')),
            h('button', { type: 'button', className: 'nexo-btn', onClick: () => this.openJsonModal('export') }, t('Export JSON')),
          ]),
        ]),
        devices.length === 0
          ? h('div', { className: 'nexo-muted' }, t('No devices configured yet.'))
          : h('table', { className: 'striped responsive-table' }, [
            h('thead', null, h('tr', null, [
              h('th', null, t('Enabled')),
              h('th', null, t('Device ID')),
              h('th', null, t('Name')),
              h('th', null, t('Category')),
              h('th', null, t('Manufacturer')),
              h('th', null, t('Template')),
              h('th', null, t('Protocol')),
              h('th', null, t('Actions')),
            ])),
            h('tbody', null, rows),
          ]),
      ]);
    }

    renderDevicesTab() {
      return h('div', null, this.renderDevicesTable());
    }

    renderDeviceModal() {
      const modal = this.state.deviceModal;
      if (!modal.open || !modal.draft) return null;

      const d = modal.draft;
      const tpl = (this.state.templatesById || {})[d.templateId] || null;
      const availableProtocols = (tpl && Array.isArray(tpl.protocols) && tpl.protocols.length) ? tpl.protocols : (d.protocol ? [d.protocol] : []);

      const categories = this.state.categories || [];
      const mans = (this.state.manufacturersByCategory && this.state.manufacturersByCategory[d.category]) || [];
      const tpls = (((this.state.templatesByCatMan || {})[d.category] || {})[d.manufacturer]) || [];

      const field = (label, value, onChange, type, placeholder) =>
        h('div', { className: 'nexo-field' }, [
          h('label', { className: 'nexo-label' }, label),
          h('input', {
            className: 'nexo-input',
            type: type || 'text',
            value: value !== undefined && value !== null ? String(value) : '',
            placeholder: placeholder || '',
            onChange: ev => onChange(ev.target.value),
          }),
        ]);

      const numberField = (label, value, onChange, placeholder) =>
        field(label, value, onChange, 'number', placeholder);

      const checkboxField = (label, checked, onChange) =>
        h('div', { className: 'nexo-field' }, [
          h('label', { className: 'nexo-label' }, label),
          h('label', { className: 'nexo-checkbox' }, [
            h('input', { type: 'checkbox', checked: !!checked, onChange: ev => onChange(!!ev.target.checked) }),
            h('span', null, ''),
          ]),
        ]);

      const selectField = (label, value, options, onChange) =>
        h('div', { className: 'nexo-field' }, [
          h('label', { className: 'nexo-label' }, label),
          h('select', { className: 'nexo-select', value: value || '', onChange: ev => onChange(ev.target.value) },
            options.map(o => h('option', { key: String(o.value || o), value: String(o.value || o) }, String(o.label || o)))
          ),
        ]);

      const protocolField = () => selectField(
        t('Protocol'),
        d.protocol,
        availableProtocols.map(p => ({ value: p, label: p })),
        v => this.updateDraftField('protocol', v)
      );

      const templateField = () => selectField(
        t('Template'),
        d.templateId,
        tpls.map(o => ({ value: o.id, label: `${o.name} (${o.id})` })),
        v => this.updateDraftField('templateId', v)
      );

      const categoryField = () => selectField(
        t('Category'),
        d.category,
        categories.map(c => ({ value: c, label: c })),
        v => {
          // When changing category, also reset manufacturer and template
          const mans2 = (this.state.manufacturersByCategory && this.state.manufacturersByCategory[v]) || [];
          const man2 = mans2[0] || '';
          const tpls2 = (((this.state.templatesByCatMan || {})[v] || {})[man2]) || [];
          const tpl2 = (tpls2[0] && tpls2[0].id) || '';
          const tplObj = (this.state.templatesById || {})[tpl2];
          const proto = normalizeProtocolForTemplate(tplObj, tplObj && tplObj.protocols && tplObj.protocols[0]);
          const draft = Object.assign({}, d, {
            category: v,
            manufacturer: man2,
            templateId: tpl2,
            protocol: proto,
            id: d.id || suggestId(categoryPrefix(v), normalizeDevices(this.state.devices)),
            name: (tplObj && tplObj.name) ? tplObj.name : d.name,
            connection: Object.assign(defaultConnection(proto), (d.connection || {})),
          });
          this.setState({ deviceModal: Object.assign({}, modal, { draft }) });
        }
      );

      const manufacturerField = () => selectField(
        t('Manufacturer'),
        d.manufacturer,
        mans.map(m => ({ value: m, label: m })),
        v => {
          const tpls2 = (((this.state.templatesByCatMan || {})[d.category] || {})[v]) || [];
          const tpl2 = (tpls2[0] && tpls2[0].id) || '';
          this.setState({ deviceModal: Object.assign({}, modal, { draft: Object.assign({}, d, { manufacturer: v, templateId: tpl2 }) }) }, () => {
            this.updateDraftField('templateId', tpl2);
          });
        }
      );

      const connectionFields = () => {
        const c = d.connection || {};
        if (d.protocol === 'modbusTcp') {
          return h('div', null, [
            h('h6', null, t('Modbus TCP connection')),
            field(t('Host/IP'), c.host, v => this.updateDraftField('connection.host', v)),
            numberField(t('Port'), c.port, v => this.updateDraftField('connection.port', v)),
            numberField(t('Unit ID'), c.unitId, v => this.updateDraftField('connection.unitId', v)),
            numberField(t('Timeout (ms)'), c.timeoutMs, v => this.updateDraftField('connection.timeoutMs', v)),
            numberField(t('Addr offset'), c.addressOffset, v => this.updateDraftField('connection.addressOffset', v)),
            field(t('Word order'), c.wordOrder, v => this.updateDraftField('connection.wordOrder', v)),
            field(t('Byte order'), c.byteOrder, v => this.updateDraftField('connection.byteOrder', v)),
            field(t('Write password (optional)'), '', v => this.updateDraftField('connection.writePassword', v), 'password'),
          ]);
        }
        if (d.protocol === 'modbusRtu' || d.protocol === 'modbusAscii') {
          return h('div', null, [
            h('h6', null, t('Serial port')),
            field(t('Serial port'), c.path, v => this.updateDraftField('connection.path', v), 'text', '/dev/ttyUSB0'),
            numberField(t('Baud rate'), c.baudRate, v => this.updateDraftField('connection.baudRate', v)),
            field(t('Parity'), c.parity, v => this.updateDraftField('connection.parity', v)),
            numberField(t('Data bits'), c.dataBits, v => this.updateDraftField('connection.dataBits', v)),
            numberField(t('Stop bits'), c.stopBits, v => this.updateDraftField('connection.stopBits', v)),
            numberField(t('Unit ID'), c.unitId, v => this.updateDraftField('connection.unitId', v)),
            numberField(t('Timeout (ms)'), c.timeoutMs, v => this.updateDraftField('connection.timeoutMs', v)),
            numberField(t('Addr offset'), c.addressOffset, v => this.updateDraftField('connection.addressOffset', v)),
            field(t('Word order'), c.wordOrder, v => this.updateDraftField('connection.wordOrder', v)),
            field(t('Byte order'), c.byteOrder, v => this.updateDraftField('connection.byteOrder', v)),
            field(t('Write password (optional)'), '', v => this.updateDraftField('connection.writePassword', v), 'password'),
          ]);
        }
        if (d.protocol === 'mbus') {
          return h('div', null, [
            h('h6', null, t('M-Bus connection')),
            field(t('Serial port'), c.path, v => this.updateDraftField('connection.path', v), 'text', '/dev/ttyUSB0'),
            numberField(t('Baud rate'), c.baudRate, v => this.updateDraftField('connection.baudRate', v)),
            field(t('Parity'), c.parity, v => this.updateDraftField('connection.parity', v)),
            numberField(t('Data bits'), c.dataBits, v => this.updateDraftField('connection.dataBits', v)),
            numberField(t('Stop bits'), c.stopBits, v => this.updateDraftField('connection.stopBits', v)),
            numberField(t('Unit ID'), c.unitId, v => this.updateDraftField('connection.unitId', v)),
            numberField(t('Timeout (ms)'), c.timeoutMs, v => this.updateDraftField('connection.timeoutMs', v)),
            checkboxField(t('Send NKE'), c.sendNke, v => this.updateDraftField('connection.sendNke', v)),
          ]);
        }
        if (d.protocol === 'mqtt') {
          return h('div', null, [
            h('h6', null, t('MQTT connection')),
            field(t('Broker URL'), c.url, v => this.updateDraftField('connection.url', v), 'text', 'mqtt://host:1883'),
            field(t('Username'), c.username, v => this.updateDraftField('connection.username', v)),
            field(t('Password'), '', v => this.updateDraftField('connection.password', v), 'password'),
          ]);
        }
        if (d.protocol === 'http') {
          return h('div', null, [
            h('h6', null, t('HTTP connection')),
            field(t('Base URL'), c.baseUrl, v => this.updateDraftField('connection.baseUrl', v), 'text', 'https://device/api'),
            field(t('Username'), c.username, v => this.updateDraftField('connection.username', v)),
            field(t('Password'), '', v => this.updateDraftField('connection.password', v), 'password'),
            field(t('Meter ID (optional)'), c.meterId, v => this.updateDraftField('connection.meterId', v)),
            checkboxField(t('Allow insecure TLS'), !!c.insecureTls, v => this.updateDraftField('connection.insecureTls', v)),
          ]);
        }
        if (d.protocol === 'udp') {
          return h('div', null, [
            h('h6', null, t('UDP connection')),
            field(t('Host/IP'), c.host, v => this.updateDraftField('connection.host', v)),
            numberField(t('Port'), c.port, v => this.updateDraftField('connection.port', v)),
            numberField(t('Timeout (ms)'), c.timeoutMs, v => this.updateDraftField('connection.timeoutMs', v)),
            numberField(t('Command pause (ms)'), c.commandPauseMs, v => this.updateDraftField('connection.commandPauseMs', v)),
          ]);
        }
        if (d.protocol === 'speedwire') {
          return h('div', null, [
            h('h6', null, t('Speedwire connection')),
            field(t('Filter host (optional)'), c.filterHost, v => this.updateDraftField('connection.filterHost', v)),
            field(t('Multicast group'), c.multicastGroup, v => this.updateDraftField('connection.multicastGroup', v)),
            numberField(t('Port'), c.port, v => this.updateDraftField('connection.port', v)),
            field(t('Interface address (optional)'), c.interfaceAddress, v => this.updateDraftField('connection.interfaceAddress', v)),
            numberField(t('Stale timeout (ms)'), c.staleTimeoutMs, v => this.updateDraftField('connection.staleTimeoutMs', v)),
          ]);
        }
        if (d.protocol === 'onewire') {
          return h('div', null, [
            h('h6', null, t('1-Wire connection')),
            field(t('Base path'), c.basePath, v => this.updateDraftField('connection.basePath', v)),
            field(t('Sensor ID'), c.sensorId, v => this.updateDraftField('connection.sensorId', v)),
            field(t('File'), c.file, v => this.updateDraftField('connection.file', v)),
            field(t('Parser'), c.parser, v => this.updateDraftField('connection.parser', v)),
          ]);
        }
        if (d.protocol === 'canbus') {
          return h('div', null, [
            h('h6', null, t('CANbus connection')),
            field(t('Interface'), c.interface, v => this.updateDraftField('connection.interface', v)),
            field(t('candump args'), c.candumpArgs, v => this.updateDraftField('connection.candumpArgs', v)),
            field(t('candump path'), c.candumpPath, v => this.updateDraftField('connection.candumpPath', v)),
            field(t('cansend path'), c.cansendPath, v => this.updateDraftField('connection.cansendPath', v)),
          ]);
        }
        return null;
      };

      return h('div', { className: 'nexo-modal-backdrop' }, [
        h('div', { className: 'nexo-modal' }, [
          h('div', { className: 'nexo-modal-header' }, [
            h('h5', null, modal.mode === 'edit' ? t('Edit device') : t('Add device')),
            h('button', { type: 'button', className: 'nexo-btn', onClick: () => this.closeDeviceModal() }, t('Close')),
          ]),

          modal.errors && modal.errors.length
            ? h('div', { className: 'nexo-error' }, [
              h('div', { style: { fontWeight: '600', marginBottom: '6px' } }, t('Validation error')),
              h('ul', null, modal.errors.map((e, i) => h('li', { key: `err${i}` }, e))),
            ])
            : null,

          checkboxField(t('Device enabled'), !!d.enabled, v => this.updateDraftField('enabled', v)),
          field(t('Device ID'), d.id, v => this.updateDraftField('id', v)),
          field(t('Name'), d.name, v => this.updateDraftField('name', v)),
          categoryField(),
          manufacturerField(),
          templateField(),
          protocolField(),
          numberField(t('Poll interval (ms, optional)'), d.pollIntervalMs, v => this.updateDraftField('pollIntervalMs', v)),
          numberField(t('Heartbeat timeout (ms, optional)'), d.heartbeatTimeoutMs, v => this.updateDraftField('heartbeatTimeoutMs', v)),
          h('div', { className: 'nexo-divider' }),
          connectionFields(),
          h('div', { className: 'nexo-modal-actions' }, [
            h('button', { type: 'button', className: 'nexo-btn', onClick: () => this.closeDeviceModal() }, t('Cancel')),
            h('button', { type: 'button', className: 'nexo-btn primary', onClick: () => this.saveDeviceFromModal() }, t('Save')),
          ]),
        ]),
      ]);
    }

    renderJsonModal() {
      const jm = this.state.jsonModal;
      if (!jm.open) return null;

      const title = jm.mode === 'export' ? t('JSON export') : t('JSON import');
      const hint = jm.mode === 'export'
        ? t('Copy the JSON below (passwords are masked).')
        : t('Paste a JSON array of devices here.');

      const footerButtons = jm.mode === 'export'
        ? [
          h('button', { type: 'button', className: 'nexo-btn', onClick: () => this.closeJsonModal() }, t('Close')),
        ]
        : [
          h('button', { type: 'button', className: 'nexo-btn', onClick: () => this.closeJsonModal() }, t('Cancel')),
          h('button', { type: 'button', className: 'nexo-btn primary', onClick: () => this.applyJsonImport() }, t('Apply')),
        ];

      return h('div', { className: 'nexo-modal-backdrop' }, [
        h('div', { className: 'nexo-modal' }, [
          h('div', { className: 'nexo-modal-header' }, [
            h('h5', null, title),
            h('button', { type: 'button', className: 'nexo-btn', onClick: () => this.closeJsonModal() }, t('Close')),
          ]),
          h('div', { className: 'nexo-hint' }, hint),
          jm.error ? h('div', { className: 'nexo-error' }, jm.error) : null,
          h('textarea', {
            className: 'nexo-textarea',
            value: jm.text,
            onChange: ev => this.setState({ jsonModal: Object.assign({}, jm, { text: ev.target.value, error: null }) }),
            rows: 18,
          }),
          h('div', { className: 'nexo-modal-actions' }, footerButtons),
        ]),
      ]);
    }

    render() {
      const status = this.state.status || {};
      const inst = getInstanceId();

      return h('div', { className: 'container' }, [
        h('div', { className: 'card nexo-header' }, [
          h('div', { className: 'card-content' }, [
            h('div', { className: 'nexo-header-row' }, [
              h('div', null, [
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
                  h('img', { src: 'energy-bridge.svg', className: 'nexo-icon', alt: 'EnergyBridge' }),
                  h('div', null, [
                    h('div', { className: 'nexo-title' }, 'EnergyBridge'),
                    h('div', { className: 'nexo-subtitle nexo-muted' }, t('Community multi-protocol adapter with templates for energy devices (Modbus TCP/RTU, MQTT, HTTP/JSON, UDP).')),
                  ]),
                ]),
              ]),
              h('div', { className: 'nexo-meta' }, [
                h('div', null, `${t('Instance')}: ${inst}`),
                h('div', null, [
                  this.renderStatusBadge(t('Alive'), status.alive),
                  this.renderStatusBadge(t('Connection'), status.connection),
                ]),
              ]),
            ]),
            this.renderTabs(),
          ]),
        ]),

        this.state.error ? h('div', { className: 'nexo-error' }, this.state.error) : null,

        this.state.activeTab === 'general' ? this.renderGeneralTab() : this.renderDevicesTab(),

        this.renderDeviceModal(),
        this.renderJsonModal(),
      ]);
    }
  }

  function mount() {
    const root = document.getElementById('root');
    if (!root) return;

    const app = ReactDOM.render(h(EnergyBridgeAdmin, null), root);

    // Expose hooks for admin load/save
    window.__energyBridgeApp = app;
  }

  // Admin integration (adapter-settings.js)
  window.load = function (settings, onChange) {
    if (window.__energyBridgeApp && typeof window.__energyBridgeApp.setLoadedSettings === 'function') {
      window.__energyBridgeApp.setLoadedSettings(settings, onChange);
    } else {
      window.__energyBridgePendingSettings = settings;
      window.__energyBridgePendingOnChange = onChange;
    }

    if (typeof onChange === 'function') onChange(false);
  };

  window.save = function (callback) {
    if (window.__energyBridgeApp && typeof window.__energyBridgeApp.getSaveConfig === 'function') {
      callback(window.__energyBridgeApp.getSaveConfig());
    } else {
      callback({});
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
