import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'

import type { ZipWorkerResponse } from './zip.worker'

vi.mock('fflate', () => import('fflate/browser'))

const ASYNC_UNZIP_THRESHOLD = 512 * 1024
const LARGE_ENTRY_SIZE = 16 * 1024 * 1024
const workerScope = {
  onmessage: (_event: MessageEvent<ArrayBuffer>) => {},
  postMessage: vi.fn<(response: ZipWorkerResponse) => void>(),
}

beforeEach(async () => {
  vi.resetModules()
  workerScope.postMessage.mockClear()
  vi.stubGlobal('self', workerScope)
  vi.stubGlobal(
    'Worker',
    vi.fn(function () {
      throw new DOMException('Blob workers blocked by CSP', 'SecurityError')
    }),
  )
  await import('./zip.worker')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ZIP extraction worker', () => {
  it.each([ASYNC_UNZIP_THRESHOLD, ASYNC_UNZIP_THRESHOLD + 1, LARGE_ENTRY_SIZE])(
    'extracts a compressed %i-byte entry without nested workers',
    (size) => {
      const text = 'a'.repeat(size)
      const archive = zipSync({ 'app/bundle.js': strToU8(text) })
      expect(archive.length).toBeLessThan(size / 2)

      expect(extract(archive)).toEqual([
        {
          name: 'bundle.js',
          size,
          text,
          webkitRelativePath: 'app/bundle.js',
        },
      ])
      expect(Worker).not.toHaveBeenCalled()
    },
  )

  it('preserves nested paths and UTF-8 text while skipping directories and macOS metadata', () => {
    const text = 'Hello, 世界!'
    const archive = zipSync({
      'app/': new Uint8Array(),
      'app/src/index.html': strToU8(text),
      '__MACOSX/._app': strToU8('metadata'),
      'app/__MACOSX/._index.html': strToU8('metadata'),
    })

    expect(extract(archive)).toEqual([
      {
        name: 'index.html',
        size: strToU8(text).length,
        text,
        webkitRelativePath: 'app/src/index.html',
      },
    ])
  })

  it('extracts stored entries without nested workers', () => {
    const text = 'stored content'
    const archive = zipSync({ 'index.html': strToU8(text) }, { level: 0 })

    expect(extract(archive)).toEqual([
      {
        name: 'index.html',
        size: text.length,
        text,
        webkitRelativePath: 'index.html',
      },
    ])
    expect(Worker).not.toHaveBeenCalled()
  })

  it('reports invalid archives to the main thread', () => {
    workerScope.onmessage(
      new MessageEvent('message', { data: strToU8('not a zip').buffer }),
    )

    expect(workerScope.postMessage).toHaveBeenCalledWith({
      status: 'error',
      message: expect.stringContaining('invalid zip data'),
    })
  })

  it('returns no files for an empty archive', () => {
    expect(extract(zipSync({}))).toEqual([])
  })
})

function extract(archive: Uint8Array) {
  workerScope.onmessage(
    new MessageEvent('message', { data: archive.slice().buffer }),
  )
  const response = workerScope.postMessage.mock.calls[0][0]
  if (response.status === 'error') throw new Error(response.message)
  return response.files
}
