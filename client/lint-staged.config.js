export default {
  '*.{js,ts,jsx,tsx}': 'eslint --cache --fix',
  '*.{ts,tsx}': () => 'tsc --noEmit',
  '*.{js,ts,jsx,tsx,css,md,html,json}': 'prettier --write',
}
