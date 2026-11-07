'use strict';
function validateRelease(version, tag, prerelease) {
  if (tag !== `v${version}`) throw new Error(`Release tag must be v${version}`);
  if (version.includes('-') !== (prerelease === 'true')) {
    throw new Error('Package version and GitHub Release prerelease status must agree');
  }
  return prerelease === 'true' ? 'next' : 'latest';
}
if (require.main === module) {
  validateRelease(require('../package.json').version, process.env.RELEASE_TAG, process.env.RELEASE_PRERELEASE);
}
module.exports = { validateRelease };
