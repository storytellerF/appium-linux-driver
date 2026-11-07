'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const cp = require('node:child_process');
const { LinuxDriver } = require('../lib/driver');
const { errors } = require('@appium/base-driver');

test('page source escapes XML names and values and preserves nested geometry', async () => {
  const driver = new LinuxDriver();
  driver._atspi = async () => ({ ok: true, tree: { role: 'push button', name: 'A<&"', value: '<value>',
    bounds: { x: 1, y: 2, w: 3, h: 4 }, children: [{ role: 'label', name: 'child' }] } });
  assert.equal(await driver.getPageSource(), '<push_button name="A&lt;&amp;&quot;" value="&lt;value&gt;" x="1" y="2" width="3" height="4">\n  <label name="child" value=""/>\n</push_button>');
});

test('page source collection failures are reported instead of returning an empty artifact', async () => {
  const driver = new LinuxDriver();
  driver._atspi = async () => ({ ok: false, error: 'app not found' });
  await assert.rejects(driver.getPageSource(), /Page source failed: app not found/);
});

test('missing single lookup returns the WebDriver no-such-element error', async () => {
  const driver = new LinuxDriver();
  driver._atspi = async cmd => cmd.action === 'page_source' ? { ok: true, tree: {} } : { ok: true, elements: [] };
  await assert.rejects(driver.findElOrEls('name', 'missing', false), errors.NoSuchElementError);
});

test('unknown element handles return the stale-element protocol error', async () => {
  await assert.rejects(new LinuxDriver().click('unknown'), errors.StaleElementReferenceError);
});

for (const [strategy, mapped] of [['xpath', 'xpath'], ['name', 'name'], ['class name', 'name']]) {
  test(`${strategy} lookups preserve the selector and protocol element handle`, async () => {
    const driver = new LinuxDriver();
    driver.appPid = 42;
    driver._atspi = async command => {
      assert.equal(command.strategy, mapped); assert.equal(command.selector, 'target'); assert.equal(command.pid, 42);
      return { ok: true, elements: [{ name: 'target', path: ':1.2/node' }] };
    };
    const item = await driver.findElOrEls(strategy, 'target', false);
    assert.equal(item.ELEMENT, item['element-6066-11e4-a52e-4f735466cecf']);
    assert.equal(driver.elements.get(item.ELEMENT).objectPath, ':1.2/node');
  });
}

test('helper lookup errors preserve their diagnostic', async () => {
  const driver = new LinuxDriver();
  driver._atspi = async () => ({ ok: false, error: 'bus disconnected' });
  await assert.rejects(driver.findElOrEls('name', 'target', false), /bus disconnected/);
});

test('non-PNG screenshot data is rejected', async () => {
  const driver = new LinuxDriver();
  driver._atspi = async () => ({ ok: true, data: Buffer.from('not png').toString('base64') });
  await assert.rejects(driver.getScreenshot(), /invalid PNG/);
});

test('window movement sends only the owned handle and preserves its dimensions', async () => {
  const driver = new LinuxDriver(); driver.appPid = 42;
  const calls = [];
  driver._windowTool = (...args) => {
    calls.push(args);
    return args[0] === 'search' ? '123' : 'X=10\nY=20\nWIDTH=640\nHEIGHT=480\n';
  };
  assert.deepEqual(await driver.setWindowRect(10, 20, null, null), { x: 10, y: 20, width: 640, height: 480 });
  assert.ok(calls.some(args => JSON.stringify(args) === JSON.stringify(['windowmove', '--sync', '123', 10, 20])));
  assert.equal(calls.filter(args => args[0] === 'windowsize').length, 0);
});

test('native window failures cannot masquerade as successful geometry', async t => {
  t.mock.method(cp, 'spawnSync', () => ({ status: 1, stderr: 'failed' }));
  const driver = new LinuxDriver(); driver.appPid = 42;
  await assert.rejects(driver.getWindowRect(), /Application window command failed/);
});

test('accessibility activation reports a failed session bus', t => {
  t.mock.method(cp, 'spawnSync', () => ({ status: 1, stderr: 'no session bus' }));
  assert.throws(() => new LinuxDriver()._enableAccessibility(), /no session bus/);
});

test('text reads resolve current accessible text instead of the lookup-time label', async () => {
  const driver = new LinuxDriver();
  driver.elements.set('1', { objectPath: ':1.2/input', name: 'old label' });
  driver._atspi = async command => {
    assert.equal(command.path, ':1.2/input');
    return { ok: true, text: 'updated text', attributes: { name: 'Message', value: 'updated text', enabled: true } };
  };
  assert.equal(await driver.getText('1'), 'updated text');
});

test('attribute reads distinguish values and unsupported attributes', async () => {
  const driver = new LinuxDriver(); driver.elements.set('1', { objectPath: ':1.2/input', name: 'old label' });
  driver._atspi = async () => ({ ok: true, attributes: { name: 'Message', value: 'changed', enabled: false } });
  assert.equal(await driver.getAttribute('name', '1'), 'Message');
  assert.equal(await driver.getAttribute('value', '1'), 'changed');
  assert.equal(await driver.getAttribute('enabled', '1'), 'false');
  assert.equal(await driver.getAttribute('unsupported', '1'), null);
});
