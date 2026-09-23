// lint-staged uses the closest config to each staged file, so everything under
// client/ is handled by client/lint-staged.config.js (eslint, tsc, prettier).
export default {
  '*': 'prettier --write --ignore-unknown',
}
