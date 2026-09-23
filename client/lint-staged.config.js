export default {
  '*.{js,ts,jsx,tsx}': 'eslint --cache --fix',
  '*.{ts,tsx}': () => 'tsc --noEmit',
  // Every file, so nothing slips past the hook that CI's `prettier --check .`
  // would then reject.
  '*': 'prettier --write --ignore-unknown',
}
