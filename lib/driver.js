'use strict';

const { BaseDriver, errors } = require('@appium/base-driver');
const childProcess = require('node:child_process');
const { once } = require('node:events');
const { runJsonProcess, terminateProcess } = require('./process');
const path = require('path');

const HELPER = path.join(__dirname, 'atspi_helper.py');
const ATSPI_TIMEOUT = 20;

class LinuxDriver extends BaseDriver {
  constructor(opts = {}) {
    super(opts);
    this.appProcess = null;
    this.appPid = null;
    this.elements = new Map();
    this.nextElementId = 0;
    this.locatorStrategies = ['xpath', 'name', 'class name'];
  }

  // ── Session ──────────────────────────────────────────────────────────────

  async createSession(w3cCaps1, w3cCaps2, w3cCaps3) {
    const [sessionId, caps] = await super.createSession(w3cCaps1, w3cCaps2, w3cCaps3);
    try {
      const app = caps.app || this.opts.app;
      if (!app) throw new errors.InvalidArgumentError('Capability "app" (path to executable) is required');
      const appArgs = caps.appArguments || this.opts.appArguments || [];
      const args = Array.isArray(appArgs) ? appArgs : appArgs.split(' ').filter(Boolean);
      this._assertDisplay();
      this._enableAccessibility();
      const proc = childProcess.spawn(app, args, {
        cwd: caps.appWorkingDir || undefined,
        env: { ...process.env, ...(caps.appEnv || {}) },
      });
      this.appProcess = proc;
      proc.stdout?.on('data', data => this.log.info(`[app stdout] ${data.toString().trimEnd()}`));
      proc.stderr?.on('data', data => this.log.warn(`[app stderr] ${data.toString().trimEnd()}`));
      proc.on('error', error => this.log.warn(`Application process error: ${error.message}`));
      const startup = new AbortController();
      const exited = (code, signal) => startup.abort(new Error(`Application exited during startup: ${code ?? signal}`));
      proc.once('exit', exited);
      try {
        await once(proc, 'spawn');
        this.appPid = proc.pid;
        const result = await this._atspi(
          { action: 'wait_for_app', pid: this.appPid, timeout: ATSPI_TIMEOUT },
          { signal: startup.signal },
        );
        if (!result.ok) throw new Error(`App window did not appear in AT-SPI2 tree within ${ATSPI_TIMEOUT}s`);
      } finally {
        proc.removeListener('exit', exited);
      }
      return [sessionId, caps];
    } catch (error) {
      try { await this.deleteSession(); }
      catch (cleanupError) { this.log.warn(`Session cleanup failed: ${cleanupError.message}`); }
      throw error;
    }
  }

  async deleteSession() {
    if (this.appProcess) await terminateProcess(this.appProcess);
    this.appProcess = null;
    this.appPid = null;
    this.elements.clear();
    await super.deleteSession();
  }

  // ── Element finding ───────────────────────────────────────────────────────

  async findElOrEls(strategy, selector, mult) {
    this.log.info(`Finding element(s) by ${strategy}: "${selector}"`);
    const atspiStrategy = this._mapStrategy(strategy, selector);
    const deadline = Date.now() + this.implicitWaitMs;
    let result;
    do {
      const searchStartedAt = Date.now();
      result = await this._atspi({
        action: 'find_elements_once',
        pid: this.appPid,
        strategy: atspiStrategy.strategy,
        selector: atspiStrategy.selector,
        timeout: 1,
        max_results: mult ? 10 : 1,
      });
      if (!result.ok || result.elements.length > 0) break;
      if (Date.now() >= deadline) {
        if (searchStartedAt < deadline) {
          result = await this._atspi({
            action: 'find_elements_once',
            pid: this.appPid,
            strategy: atspiStrategy.strategy,
            selector: atspiStrategy.selector,
            timeout: 1,
            max_results: mult ? 10 : 1,
          });
        }
        break;
      }
      await this._sleep(200);
    } while (Date.now() < deadline);
    if (!result.ok) {
      if (result.error === 'app not found') {
        if (mult) return [];
        throw new errors.NoSuchElementError('Application is unavailable in the AT-SPI tree');
      }
      throw new Error(`findElOrEls failed: ${result.error}`);
    }
    if (result.elements.length === 0) {
      if (mult) return [];
      const source = await this._atspi({ action: 'page_source', pid: this.appPid });
      if (source.ok) {
        this.log.warn(`No element found for ${strategy}="${selector}". Page source:\n${this._treeToXml(source.tree, 0)}`);
      }
      throw new errors.NoSuchElementError(`No element found for ${strategy}="${selector}"`);
    }
    const els = result.elements.map((e, index) => {
      const encoded = String(this.nextElementId++);
      this.elements.set(encoded, {
        index,
        objectPath: e.path,
        strategy: atspiStrategy.strategy,
        selector: atspiStrategy.selector,
        cx: e.cx,
        cy: e.cy,
        name: e.name,
      });
      return {
        ELEMENT: encoded,
        'element-6066-11e4-a52e-4f735466cecf': encoded,
      };
    });
    return mult ? els : els[0];
  }

  _mapStrategy(strategy, selector) {
    if (strategy === 'xpath') {
      return { strategy: 'xpath', selector };
    }
    if (strategy === 'name') {
      return { strategy: 'name', selector };
    }
    if (strategy === 'class name') {
      return { strategy: 'name', selector };
    }
    return { strategy: 'name', selector };
  }

  _parseElement(elId) {
    const decoded = decodeURIComponent(elId.replace(/\+/g, '%20'));
    const element = this.elements.get(decoded);
    if (!element) throw new errors.StaleElementReferenceError(`Unknown element id: ${decoded}`);
    return element;
  }

  // ── Element interaction ───────────────────────────────────────────────────

  async click(elementId) {
    const { index, objectPath, strategy, selector, cx, cy, name } = this._parseElement(elementId);
    const result = await this._atspi({
      action: 'click_element',
      path: objectPath,
      pid: this.appPid,
      strategy,
      selector,
      index,
      timeout: ATSPI_TIMEOUT,
    });
    if (result.stale || result.error === 'app not found') {
      throw new errors.StaleElementReferenceError(result.error);
    }
    if (result.ok) {
      this.log.info(`Clicked element "${name}" via AT-SPI action "${result.action}"`);
      return;
    }
    this.log.warn(`AT-SPI click failed for "${name}": ${result.error || 'unknown error'}`);
    // xdotool is a last-resort fallback. For Compose popup/scroll descendants AT-SPI may expose
    // DESKTOP_COORDS with an ancestor offset applied twice, so this coordinate can miss the real row.
    // Tests should prefer semantic descriptions or nodes with AT-SPI click actions.
    this.log.info(`Clicking at (${cx}, ${cy})`);
    this._xdotool('mousemove', '--sync', cx, cy);
    this._xdotool('click', 1);
  }

  async setValue(value, elementId) {
    const { index, objectPath, strategy, selector, name } = this._parseElement(elementId);
    const text = Array.isArray(value) ? value.join('') : String(value);
    const result = await this._atspi({
      action: 'set_text',
      path: objectPath,
      pid: this.appPid,
      strategy,
      selector,
      index,
      text,
      timeout: ATSPI_TIMEOUT,
    });
    if (result.stale || result.error === 'app not found') {
      throw new errors.StaleElementReferenceError(result.error);
    }
    if (result.ok) {
      this.log.info(`Set text via AT-SPI editable text${name ? ` for "${name}"` : ''}`);
      return;
    }
    throw new Error(`AT-SPI set text failed: ${result.error || 'unknown error'}`);
  }

  async getText(elementId) {
    return (await this._elementData('element_info', elementId)).text;
  }

  async getAttribute(attr, elementId) {
    const result = await this._elementData('element_info', elementId);
    const value = Object.hasOwn(result.attributes, attr) ? result.attributes[attr] : null;
    return value == null ? null : String(value);
  }

  async _elementData(action, elementId) {
    const { objectPath } = this._parseElement(elementId);
    const result = await this._atspi({ action, pid: this.appPid, path: objectPath });
    if (result.stale || result.error === 'app not found') {
      throw new errors.StaleElementReferenceError(result.error);
    }
    if (!result.ok) throw new Error(result.error || 'Element information is unavailable');
    return result;
  }

  async _elementGeometry(elementId) {
    return this._elementData('element_geometry', elementId);
  }

  async getElementRect(elementId) {
    return (await this._elementGeometry(elementId)).rect;
  }

  async getLocation(elementId) {
    const { x, y } = await this.getElementRect(elementId);
    return { x, y };
  }

  async getSize(elementId) {
    const { width, height } = await this.getElementRect(elementId);
    return { width, height };
  }

  async elementDisplayed(elementId) {
    return (await this._elementGeometry(elementId)).visible;
  }

  async elementEnabled(elementId) {
    return (await this._elementGeometry(elementId)).enabled;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  async execute(script) {
    if (script !== 'linux: dismissDialog') {
      throw new errors.UnknownCommandError(`Unsupported execute command: ${script}`);
    }
    this._xdotool('key', 'Escape');
  }

  async back() {
    this._xdotool('key', 'alt+Left');
  }

  // Window geometry belongs to the launched application, never the desktop's
  // currently focused window (which could be another process or a dialog).
  _currentWindowId() {
    if (!Number.isSafeInteger(this.appPid) || this.appPid <= 0) {
      throw new errors.NoSuchWindowError('No launched application window');
    }
    const output = this._windowTool('search', '--onlyvisible', '--pid', this.appPid);
    const ids = [...new Set(output.trim().split(/\s+/).filter(Boolean))];
    if (ids.length !== 1 || !/^\d+$/.test(ids[0])) {
      throw new errors.NoSuchWindowError('Expected exactly one visible window owned by the application');
    }
    return ids[0];
  }

  _windowTool(...args) {
    const result = childProcess.spawnSync('xdotool', args.map(String), { encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) {
      throw new errors.UnknownError(`Application window command failed: ${args[0]}`);
    }
    return result.stdout;
  }

  _windowRect(id) {
    const output = this._windowTool('getwindowgeometry', '--shell', id);
    const values = Object.fromEntries([...output.matchAll(/^(X|Y|WIDTH|HEIGHT)=(-?\d+)$/gm)]
      .map((match) => [match[1].toLowerCase(), Number(match[2])]));
    if (Object.keys(values).length !== 4 || values.width <= 0 || values.height <= 0) {
      throw new errors.NoSuchWindowError('Application window has no usable geometry');
    }
    return values;
  }

  async getWindowRect() {
    return this._windowRect(this._currentWindowId());
  }

  async getWindowSize(handle = 'current') {
    if (handle !== 'current') throw new errors.NoSuchWindowError('Only the current application window is supported');
    const { width, height } = await this.getWindowRect();
    return { width, height };
  }

  async setWindowSize(width, height, handle = 'current') {
    if (handle !== 'current') throw new errors.NoSuchWindowError('Only the current application window is supported');
    return this.setWindowRect(null, null, width, height);
  }

  async setWindowRect(x, y, width, height) {
    for (const [name, value] of Object.entries({ x, y, width, height })) {
      if (value != null && (!Number.isSafeInteger(value) ||
          ((name === 'width' || name === 'height') && value <= 0))) {
        throw new errors.InvalidArgumentError(`Invalid window ${name}`);
      }
    }
    const id = this._currentWindowId();
    const current = this._windowRect(id);
    if (width != null || height != null) {
      this._windowTool('windowsize', '--sync', id, width ?? current.width, height ?? current.height);
    }
    if (x != null || y != null) {
      this._windowTool('windowmove', '--sync', id, x ?? current.x, y ?? current.y);
    }
    return this._windowRect(id);
  }

  // ── Page source ───────────────────────────────────────────────────────────

  async getScreenshot() {
    const result = await this._atspi({ action: 'screenshot' });
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!result.ok || typeof result.data !== 'string' ||
        !Buffer.from(result.data, 'base64').subarray(0, 8).equals(signature)) {
      throw new errors.UnknownError(`Desktop screenshot failed: ${result.error || 'invalid PNG'}`);
    }
    return result.data;
  }

  async getPageSource() {
    const result = await this._atspi({ action: 'page_source', pid: this.appPid });
    if (!result.ok) throw new errors.UnknownError(`Page source failed: ${result.error || 'unknown error'}`);
    return this._treeToXml(result.tree, 0);
  }

  _treeToXml(node, depth) {
    if (!node) return '';
    const indent = '  '.repeat(depth);
    const role = (node.role || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const name = (node.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const value = (node.value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const boundsAttr = node.bounds
      ? ` x="${node.bounds.x}" y="${node.bounds.y}" width="${node.bounds.w}" height="${node.bounds.h}"`
      : '';
    const children = (node.children || []).map((c) => this._treeToXml(c, depth + 1)).join('\n');
    if (children) {
      return `${indent}<${role} name="${name}" value="${value}"${boundsAttr}>\n${children}\n${indent}</${role}>`;
    }
    return `${indent}<${role} name="${name}" value="${value}"${boundsAttr}/>`;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus() {
    return { ready: true, message: 'Linux driver ready' };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _enableAccessibility() {
    // AT clients activate the native AccessKit provider through the session bus.
    const result = childProcess.spawnSync('gdbus', [
      'call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus',
      '--method', 'org.freedesktop.DBus.Properties.Set', 'org.a11y.Status', 'IsEnabled', '<true>',
    ], { encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) {
      throw new Error(`Cannot enable session accessibility: ${result.error?.message || result.stderr}`);
    }
  }

  _assertDisplay() {
    const result = this._displayInfo();
    const dimensions = /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(result.stdout || '');
    if (result.status !== 0 || !dimensions || Number(dimensions[1]) === 0 || Number(dimensions[2]) === 0) {
      throw new Error('Linux desktop requires a display with nonzero dimensions; provide an active X11 session or an isolated virtual display with a window manager');
    }
  }

  _displayInfo() {
    return childProcess.spawnSync('xdpyinfo', [], { encoding: 'utf8' });
  }

  _xdotool(...args) {
    const strArgs = args.map(String);
    this.log.debug(`xdotool ${strArgs.join(' ')}`);
    const result = childProcess.spawnSync('xdotool', strArgs, { encoding: 'utf8' });
    if (result.status !== 0) {
      this.log.warn(`xdotool exited ${result.status}: ${result.stderr}`);
    }
    return result.stdout;
  }

  async _atspi(cmd, options = {}) {
    return runJsonProcess('python3', [HELPER], cmd, options);
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = { LinuxDriver };
