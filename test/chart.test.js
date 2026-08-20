/**
 * Chart rendering.
 *
 * `lookup` returns empty without a cluster, so only the no-live-Secret half of
 * secret.yaml is covered here. Carrying a key across an upgrade needs a real
 * release: package/server-ee/dev/incluster/scenario-encryption-key.sh.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHART = fileURLToPath(new URL('../chart', import.meta.url))

const hasHelm = spawnSync('helm', ['version']).status === 0

/** @param {string[]} args */
function render(...args) {
  return execFileSync('helm', ['template', 'portainer-run', CHART, ...args], {
    encoding: 'utf8',
  })
}

describe('chart', { skip: hasHelm ? false : 'helm is not installed' }, () => {
  test('a supplied key is rendered into the Secret', () => {
    const out = render('--set', 'secret.ENCRYPTION_KEY=abc123')

    assert.match(out, /kind: Secret/)
    assert.match(out, /name: portainer-run-secret/)
    assert.match(
      out,
      new RegExp(
        `ENCRYPTION_KEY: "${Buffer.from('abc123').toString('base64')}"`,
      ),
    )
  })

  // Without it, a later release that drops this template prunes the Secret.
  test('the Secret is annotated to survive a release that stops rendering it', () => {
    const out = render('--set', 'secret.ENCRYPTION_KEY=abc123')

    assert.match(out, /helm\.sh\/resource-policy: keep/)
  })

  test('no Secret is rendered when there is nothing to put in it', () => {
    const out = render()

    assert.doesNotMatch(out, /kind: Secret/)
  })

  test('the other supported keys are carried too', () => {
    const out = render('--set', 'secret.ANTHROPIC_API_KEY=sk-ant')

    assert.match(
      out,
      new RegExp(
        `ANTHROPIC_API_KEY: "${Buffer.from('sk-ant').toString('base64')}"`,
      ),
    )
    assert.doesNotMatch(out, /ENCRYPTION_KEY/)
  })

  test('an unsupported key is not carried', () => {
    const out = render('--set', 'secret.SOME_OTHER_KEY=nope')

    assert.doesNotMatch(out, /SOME_OTHER_KEY/)
  })

  // A fresh render cannot show why this is maxSurge and not Recreate — see the
  // template.
  test('the deployment replaces its pod rather than surging a second one', () => {
    const out = render()

    assert.match(out, /maxSurge: 0/)
  })
})
