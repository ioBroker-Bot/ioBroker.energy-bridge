'use strict';

const mqtt = require('mqtt');
const { getByJsonPath, applyNumericTransforms, coerceBoolean } = require('../utils');

function applyValueMap(value, valueMap) {
  if (!valueMap || typeof valueMap !== 'object') return value;
  const k = String(value);
  if (Object.prototype.hasOwnProperty.call(valueMap, k)) return valueMap[k];
  return value;
}

class MqttDriver {
  constructor(adapter, deviceCfg, template, globalCfg, relStateIdFn, roundingDecimalsFn, onAliveFn) {
    this.adapter = adapter;
    this.device = deviceCfg || {};
    this.template = template || {};
    this.global = globalCfg || {};
    this.relStateId = relStateIdFn;
    this.roundingDecimals = roundingDecimalsFn;

    // Optional callback to signal "incoming data" (heartbeat)
    this.onAlive = (typeof onAliveFn === 'function') ? onAliveFn : null;

    this.client = null;
    this.connected = false;

    // cache topic -> dp
    this.dpByTopic = new Map();
  }

  async connect() {
    const c = this.device.connection || {};
    const url = c.url || '';
    if (!url) throw new Error('Missing MQTT url');

    this.client = mqtt.connect(url, {
      username: c.username || undefined,
      password: c.password || undefined,
      clientId: c.clientId || `energy-bridge-${Math.random().toString(16).slice(2)}`,
      reconnectPeriod: 5000,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.adapter.log.info(`[${this.device.id}] MQTT connected`);
      this._subscribeAll();
    });

    this.client.on('error', (err) => {
      this.adapter.log.warn(`[${this.device.id}] MQTT error: ${err.message || err}`);
    });

    this.client.on('message', async (topic, payload) => {
      const dp = this.dpByTopic.get(topic);
      if (!dp) return;
      try {
        let val = this._parsePayload(dp, payload);

        // Optional rounding based on role/unit
        const dec = this.roundingDecimals ? this.roundingDecimals(dp) : null;
        if (typeof val === 'number' && dec !== null && dec !== undefined) {
          const f = Math.pow(10, dec);
          val = Math.round(val * f) / f;
        }

        const sid = this.relStateId ? this.relStateId(dp) : dp.id;
        await this.adapter.setStateAsync(sid, { val, ack: true }).catch(() => {});

        // Heartbeat: only tick on successfully parsed incoming data.
        try { this.onAlive && this.onAlive(); } catch (_) { /* ignore */ }
      } catch (e) {
        this.adapter.log.warn(`[${this.device.id}] MQTT parse failed for ${topic}: ${e.message || e}`);
      }
    });

    // initial subscribe will happen on connect
  }

  _subscribeAll() {
    if (!this.client) return;
    this.dpByTopic.clear();

    const dps = (this.template.datapoints || []).filter(dp => dp.source && dp.source.kind === 'mqtt' && dp.source.topic);
    for (const dp of dps) {
      const topic = dp.source.topic;
      this.dpByTopic.set(topic, dp);
      this.client.subscribe(topic, { qos: 0 }, (err) => {
        if (err) this.adapter.log.warn(`[${this.device.id}] MQTT subscribe error: ${err.message || err}`);
      });
    }
  }

  async disconnect() {
    try {
      if (this.client) {
        await new Promise(resolve => this.client.end(false, {}, resolve));
      }
    } catch (e) {
      // ignore
    } finally {
      this.connected = false;
      this.client = null;
    }
  }

  _parsePayload(dp, payload) {
    const src = dp.source || {};
    const fmt = (src.format || dp.type || 'string').toString().toLowerCase();
    const expectedType = (dp.type || '').toString().toLowerCase();
    const s = payload.toString('utf8');

    const needsJson = (src.format || '').toString().toLowerCase() === 'json' || !!src.jsonPath;

    let val;

    if (needsJson) {
      const obj = JSON.parse(s);
      val = src.jsonPath ? getByJsonPath(obj, src.jsonPath) : obj;
    } else if (fmt === 'number' || fmt === 'float' || fmt === 'int') {
      const n = Number(s);
      if (isNaN(n)) throw new Error(`Not a number: ${s}`);
      val = n;
    } else if (fmt === 'boolean' || fmt === 'bool') {
      if (s === '1' || s.toLowerCase() === 'true' || s.toLowerCase() === 'on') val = true;
      else if (s === '0' || s.toLowerCase() === 'false' || s.toLowerCase() === 'off') val = false;
      else val = !!s;
    } else {
      val = s;
    }

    // Apply numeric transforms (scaleFactor, multiplier, divisor, offset, invert, ...)
    val = applyNumericTransforms(val, src);

    // Optional boolean coercion by datapoint type
    if (expectedType === 'boolean') {
      val = coerceBoolean(val);
    }

    if (val === undefined) return undefined;

    // If a datapoint expects a string but JSONPath returned an object/array, store it as JSON string.
    if (expectedType === 'string' && val && typeof val === 'object') {
      try { val = JSON.stringify(val); } catch (e) { /* ignore */ }
    }

    return val;
  }

  _formatPayload(dp, value) {
    const src = dp.source || {};
    const fmt = (src.format || dp.type || 'string').toString().toLowerCase();

    // Optional value map for writing
    const mapped = applyValueMap(value, src.valueMap);

    if (fmt === 'json') return JSON.stringify(mapped);
    if (fmt === 'boolean' || fmt === 'bool') return (mapped ? '1' : '0');
    if (fmt === 'number' || fmt === 'float' || fmt === 'int') return String(Number(mapped));
    return String(mapped);
  }

  async readDatapoints(/* datapoints */) {
    // MQTT is event-driven; nothing to poll here.
    return {};
  }

  async writeDatapoint(dp, value) {
    const src = dp.source || {};
    if (!this.client) throw new Error('MQTT not connected');
    const topic = src.topic;
    if (!topic) throw new Error('Missing topic');

    const payload = this._formatPayload(dp, value);
    await new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 0, retain: false }, (err) => err ? reject(err) : resolve());
    });
  }
}

module.exports = {
  MqttDriver,
};
