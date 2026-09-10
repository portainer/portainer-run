import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_RUNTIMES,
  RUNTIME_IDS,
  detectRuntime,
  resolveRuntime,
  getRuntime,
  installCommandFor,
  runtimeEnvFor,
  runtimeNeedsCaps,
  defaultPortFor,
  defaultWorkDirFor,
} from '../shared/runtimes.js'

const f = (...names) => names.map((name) => ({ name, text: '' }))

describe('runtime detection', () => {
  test('package.json is a Node app', () => {
    assert.equal(detectRuntime(f('package.json', 'index.js')).id, 'node')
  })

  // Regression: the MCP copy of this table only matched package.json, so a bare
  // server.js deployed as Node in the browser and as nginx via MCP — serving
  // the Express source as a text file instead of running it.
  test('a bare server.js is a Node app, with no package.json', () => {
    assert.equal(detectRuntime(f('server.js')).id, 'node')
  })

  test('requirements.txt or a .py file is Python', () => {
    assert.equal(detectRuntime(f('requirements.txt')).id, 'python')
    assert.equal(detectRuntime(f('main.py')).id, 'python')
  })

  test('a .php file is PHP', () => {
    assert.equal(detectRuntime(f('index.php')).id, 'php')
  })

  test('a Gemfile or .rb file is Ruby', () => {
    assert.equal(detectRuntime(f('Gemfile')).id, 'ruby')
    assert.equal(detectRuntime(f('app.rb')).id, 'ruby')
  })

  test('all-static files are nginx', () => {
    assert.equal(
      detectRuntime(f('index.html', 'style.css', 'app.js')).id,
      'nginx',
    )
  })

  test('nothing recognisable falls back to nginx', () => {
    assert.equal(detectRuntime(f('mystery.bin')).id, 'nginx')
    assert.equal(detectRuntime([]).id, 'nginx')
  })

  test('.env.example alone does not decide the runtime', () => {
    assert.equal(detectRuntime(f('index.html', '.env.example')).id, 'nginx')
  })
})

describe('explicit runtime override', () => {
  test('a forced runtime beats detection', () => {
    // The whole point of the override: a stray package.json must not turn a
    // static site into a Node app.
    assert.equal(resolveRuntime(f('package.json'), 'nginx').id, 'nginx')
  })

  test('auto and empty both detect', () => {
    assert.equal(resolveRuntime(f('index.php'), 'auto').id, 'php')
    assert.equal(resolveRuntime(f('index.php'), undefined).id, 'php')
  })

  test('an unknown runtime is rejected, and says what is valid', () => {
    assert.throws(() => resolveRuntime(f('a.html'), 'rust'), /Unknown runtime/)
    assert.throws(() => resolveRuntime(f('a.html'), 'rust'), /nginx/)
  })
})

describe('pod security baseline (#39)', () => {
  // The bug that started this: nginx:alpine on port 80 cannot start when ALL
  // capabilities are dropped. It fails on the chown of its cache dirs, and the
  // privileged bind would fail too since dropping ALL removes NET_BIND_SERVICE
  // from root as well.
  test('nginx uses the unprivileged image on an unprivileged port', () => {
    const nginx = getRuntime('nginx')
    assert.equal(nginx.image, 'nginxinc/nginx-unprivileged:alpine')
    assert.equal(nginx.port, 8080)
    assert.ok(nginx.port >= 1024, 'must not need NET_BIND_SERVICE to bind')
  })

  test('nginx therefore needs no capability grant', () => {
    assert.equal(runtimeNeedsCaps('nginx'), false)
  })

  test('php is the only runtime granted capabilities back', () => {
    const granted = ALL_RUNTIMES.filter((r) => r.needsCaps).map((r) => r.id)
    assert.deepEqual(granted, ['php'])
  })

  test('every runtime that binds a privileged port is granted caps', () => {
    for (const rt of ALL_RUNTIMES) {
      if (rt.port < 1024) {
        assert.equal(
          runtimeNeedsCaps(rt.id),
          true,
          `${rt.id} binds ${rt.port} but gets no NET_BIND_SERVICE`,
        )
      }
    }
  })
})

describe('catalogue completeness', () => {
  test('every runtime is deployable', () => {
    for (const rt of ALL_RUNTIMES) {
      assert.ok(rt.id, 'id')
      assert.ok(rt.label, `${rt.id} label`)
      assert.ok(rt.image, `${rt.id} image`)
      assert.ok(rt.workDir?.startsWith('/'), `${rt.id} absolute workDir`)
      assert.equal(typeof rt.port, 'number', `${rt.id} port`)
      assert.ok(rt.port > 0 && rt.port < 65536, `${rt.id} port in range`)
      assert.ok(rt.defaultCmd(f()), `${rt.id} start command`)
    }
  })

  test('ids are unique, and RUNTIME_IDS matches the catalogue', () => {
    assert.equal(new Set(RUNTIME_IDS).size, RUNTIME_IDS.length)
    assert.deepEqual(
      RUNTIME_IDS,
      ALL_RUNTIMES.map((r) => r.id),
    )
  })

  test('install commands cd into the workDir they are given', () => {
    for (const rt of ALL_RUNTIMES) {
      const cmd = installCommandFor(rt.id, '/somewhere')
      if (cmd !== null) assert.match(cmd, /^cd \/somewhere/, rt.id)
    }
  })

  test('static sites have nothing to install', () => {
    assert.equal(installCommandFor('nginx', '/usr/share/nginx/html'), null)
  })

  // getRuntimeEnv used to be a separate switch that had to be "kept in sync"
  // with getInstallCommand by hand. Same table now, so assert the pairing:
  // anything installing outside its workDir needs path hints to be found.
  test('runtimes installing outside the workDir export path hints', () => {
    for (const id of ['python', 'ruby']) {
      const cmd = installCommandFor(id, '/app')
      const env = runtimeEnvFor(id, '/app')
      assert.ok(cmd, `${id} installs`)
      assert.ok(env.length > 0, `${id} needs env hints`)
      assert.ok(
        env.some((e) => e.name === 'PATH'),
        `${id} must extend PATH`,
      )
    }
  })

  test('runtimes installing into the workDir need no env hints', () => {
    assert.deepEqual(runtimeEnvFor('node', '/app'), [])
    assert.deepEqual(runtimeEnvFor('php', '/var/www/html'), [])
  })
})

describe('unknown runtimes degrade safely', () => {
  // vibe.js calls these with whatever runtime id a caller supplied.
  test('lookups do not throw, and skip work rather than break the deploy', () => {
    assert.equal(getRuntime('rust'), undefined)
    assert.equal(installCommandFor('rust', '/app'), null)
    assert.deepEqual(runtimeEnvFor('rust', '/app'), [])
    assert.equal(runtimeNeedsCaps('rust'), false)
    assert.equal(runtimeNeedsCaps(undefined), false)
  })

  test('port and workDir fall back to the detection fallback', () => {
    assert.equal(defaultPortFor('rust'), 8080)
    assert.equal(defaultPortFor(undefined), 8080)
    assert.equal(defaultWorkDirFor('rust'), '/app')
  })
})
