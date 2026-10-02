// lint-staged uses the closest config to each staged file, so everything under
// client/ is handled by client/lint-staged.config.js (eslint, tsc, prettier).
export default {
  // The root eslint.config.js covers server/, shared/, test/ and scripts/.
  '{server,shared,test,scripts}/**/*.{js,ts}': 'eslint --cache --fix',
  '*': 'prettier --write --ignore-unknown',
}
