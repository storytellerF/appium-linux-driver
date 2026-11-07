'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRelease } = require('../scripts/validate-release.cjs');

test('stable releases publish only with their exact version tag', () => {
  assert.equal(validateRelease('0.1.0', 'v0.1.0', 'false'), 'latest');
});
test('prereleases use a separate npm dist tag', () => {
  assert.equal(validateRelease('0.2.0-beta.1', 'v0.2.0-beta.1', 'true'), 'next');
});
for (const tag of ['v0.2.0', '0.1.0', undefined]) {
  test(`release version rejects mismatched tag ${tag}`, () => {
    assert.throws(() => validateRelease('0.1.0', tag, 'false'), /tag must be v0.1.0/);
  });
}
for (const [version, prerelease] of [['0.1.0', 'true'], ['0.2.0-beta.1', 'false']]) {
  test(`release status must agree with ${version}`, () => {
    assert.throws(() => validateRelease(version, `v${version}`, prerelease), /prerelease status must agree/);
  });
}
