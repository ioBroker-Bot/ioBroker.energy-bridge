'use strict';

const dgram = require('node:dgram');
const { sleep, getByJsonPath, applyNumericTransforms } = require('../utils');

/**
 * UDP driver for simple text-command -> JSON-response protocols.
 *
 * This is intentionally generic: each datapoint defines a read command and/or a write command template.
 *
 * Datapoint source schema:
 * {
 *   kind: 'udp',
 *   read:  { cmd: 'report 2', jsonPath: '$.State' },
 *   write: { cmdTemplate: 'ena ${value}' }
 * }
 */
class UdpDriver {
  constructor(adapter, deviceCfg, template, globalCfg) {
    this.adapter = adapter;
    this.cfg = deviceCfg;
    this.template = template;
    this.global = globalCfg || {};

    this.socket = null;
    this.connected = false;
    this.busy = false;

    this.host = (this.cfg.connection && this.cfg.connection.host) ? this.cfg.connection.host : '';
    this.port = (this.cfg.connection && this.cfg.connection.port) ? Number(this.cfg.connection.port) : 7090;
    this.timeoutMs = (this.cfg.connection && this.cfg.connection.timeoutMs) ? Number(this.cfg.connection.timeoutMs) : 1500;
    this.commandPauseMs = (this.cfg.connection && this.cfg.connection.commandPauseMs !== undefined) ? Number(this.cfg.connection.commandPauseMs) : 0;
  }

  async _ensureSocket() {
    if (this.socket) return;

    // A single socket per device; bind to an ephemeral port.
    this.socket = dgram.createSocket('udp4');

    this.socket.on('error', (err) => {
      this.adapter && this.adapter.log && this.adapter.log.warn(`[${this.cfg.id}] UDP socket error: ${err.message || err}`);
      // Recreate on next use
      try { this.socket.close(); } catch (_) {}
      this.socket = null;
      this.connected = false;
    });

    await new Promise((resolve) => {
      // Bind to any port; needed to receive responses.
      this.socket.bind(0, () => resolve());
    });

    this.connected = true;
  }

  async disconnect() {
    if (this.socket) {
      try {
        await new Promise((resolve) => this.socket.close(() => resolve()));
      } catch (_) {
        try { this.socket.close(); } catch (_) {}
      }
      this.socket = null;
    }
    this.connected = false;
  }

  async _sendAndReceive(cmd) {
    await this._ensureSocket();

    const payload = Buffer.from(String(cmd), 'utf8');

    // We serialize requests per-device (simpler and avoids response mixups).
    // NOTE: A more advanced implementation could match on source IP, but this is enough for now.
    return await new Promise((resolve, reject) => {
      let timer = null;
      const onMessage = (msg /*, rinfo */) => {
        cleanup();
        const text = msg.toString('utf8').trim();
        resolve(text);
      };
      const cleanup = () => {
        if (timer) this.adapter.clearTimeout(timer);
        timer = null;
        try { this.socket.off('message', onMessage); } catch (_) {}
      };

      timer = this.adapter.setTimeout(() => {
        cleanup();
        reject(new Error(`UDP timeout (${this.timeoutMs} ms) for cmd: ${cmd}`));
      }, Math.max(100, this.timeoutMs));

      this.socket.on('message', onMessage);

      this.socket.send(payload, 0, payload.length, this.port, this.host, (err) => {
        if (err) {
          cleanup();
          reject(err);
        }
      });
    });
  }

  _parseJsonReply(text) {
    if (!text) return null;

    // Some devices send pretty-printed JSON with line breaks; still valid JSON.
    const trimmed = text.trim();

    // Some replies are like: "TCH-OK :done"
    if (trimmed.startsWith('TCH-OK')) {
      return { ok: true, raw: trimmed };
    }

    // Some replies contain leading/trailing garbage; extract first {...} block
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const maybeJson = trimmed.substring(firstBrace, lastBrace + 1);
      try { return JSON.parse(maybeJson); } catch (_) { /* fallthrough */ }
    }

    try { return JSON.parse(trimmed); } catch (_) { /* ignore */ }
    return { raw: trimmed };
  }

  /**
   * Reads all datapoints of this device.
   * Returns a map { dpId: value }.
   */
  async readDatapoints(datapoints) {
    if (this.busy) return {};
    this.busy = true;

    try {
      const dps = (datapoints || []).filter(dp => (dp.source && dp.source.kind === 'udp' && dp.rw !== 'wo'));
      if (!dps.length) return {};

      // Group by read command
      const groups = new Map(); // cmd -> dps
      for (const dp of dps) {
        const src = dp.source || {};
        const r = src.read || {};
        const cmd = (r.cmd || '').trim();
        if (!cmd) continue;
        if (!groups.has(cmd)) groups.set(cmd, []);
        groups.get(cmd).push(dp);
      }

      const result = {};

      for (const [cmd, list] of groups.entries()) {
        const replyText = await this._sendAndReceive(cmd);
        const obj = this._parseJsonReply(replyText);

        for (const dp of list) {
          const src = dp.source || {};
          const r = src.read || {};
          const path = r.jsonPath || src.jsonPath;
          let val = path ? getByJsonPath(obj, path) : obj;

          // Apply common numeric transforms (scaleFactor, invert, etc.)
          val = applyNumericTransforms(val, src);

          result[dp.id] = val;
        }

        if (this.commandPauseMs > 0) {
          await sleep(this.commandPauseMs);
        }
      }

      return result;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Writes a single datapoint.
   */
  async writeDatapoint(dp, value) {
    const src = dp.source || {};
    if (src.kind !== 'udp') throw new Error('Invalid source kind');

    const w = src.write || {};
    let cmd = '';

    if (w.cmdTemplate) {
      cmd = String(w.cmdTemplate)
        .replace(/\$\{value\}/g, String(value))
        .replace(/\$\{unix\}/g, String(Math.floor(Date.now() / 1000)));
    } else if (w.cmd) {
      cmd = String(w.cmd);
    } else {
      throw new Error('No UDP write command defined');
    }

    const replyText = await this._sendAndReceive(cmd);
    // We treat any response as success; optionally parse.
    const parsed = this._parseJsonReply(replyText);
    if (parsed && parsed.ok === false) {
      throw new Error(`UDP write failed: ${replyText}`);
    }

    return true;
  }
}

module.exports = {
  UdpDriver,
};
