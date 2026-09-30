import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'

import {
  extractZip,
  readFileList,
  stripCommonRoot,
  type UploadedFile,
} from './fileIntake'
import type { ZipWorkerResponse } from './zip.worker'

const uploadedFile: UploadedFile = {
  name: 'index.html',
  size: 5,
  text: 'hello',
  webkitRelativePath: 'app/src/index.html',
}

let worker: {
  onmessage: ((event: MessageEvent<ZipWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: (() => void) | null
  postMessage: Mock<(buffer: ArrayBuffer, transfer: Array<ArrayBuffer>) => void>
  terminate: Mock<() => void>
}
let createWorker: Mock

beforeEach(() => {
  worker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  }
  createWorker = vi.fn(function (url: URL) {
    if (url.protocol === 'blob:') {
      throw new DOMException('Blocked by CSP', 'SecurityError')
    }
    return worker
  })
  vi.stubGlobal('Worker', createWorker)
  worker.postMessage.mockImplementation(() => {
    queueMicrotask(() => {
      worker.onmessage?.(
        new MessageEvent('message', {
          data: { status: 'success', files: [uploadedFile] },
        }),
      )
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('extractZip', () => {
  it('uses a bundled module worker and transfers the archive buffer without copying it', async () => {
    const buffer = new ArrayBuffer(0)

    expect(await extractZip(archiveFile(buffer))).toEqual([uploadedFile])

    const [url, options] = createWorker.mock.calls[0]
    expect(url.pathname).toMatch(/\/zip\.worker\.ts$/)
    expect(url.protocol).not.toBe('blob:')
    expect(options).toEqual({ type: 'module' })
    expect(worker.postMessage).toHaveBeenCalledWith(buffer, [buffer])
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('propagates extraction errors and terminates the worker', async () => {
    worker.postMessage.mockImplementation(() => {
      queueMicrotask(() => {
        worker.onmessage?.(
          new MessageEvent('message', {
            data: { status: 'error', message: 'invalid zip data' },
          }),
        )
      })
    })

    await expect(extractZip(archiveFile())).rejects.toThrow('invalid zip data')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('rejects worker startup failures instead of leaving intake pending', async () => {
    createWorker.mockImplementationOnce(function () {
      throw new DOMException('Blocked by CSP', 'SecurityError')
    })

    await expect(extractZip(archiveFile())).rejects.toThrow('Blocked by CSP')
  })

  it('propagates worker runtime errors and terminates the worker', async () => {
    worker.postMessage.mockImplementation(() => {
      queueMicrotask(() => {
        worker.onerror?.(new ErrorEvent('error', { message: 'Worker failed' }))
      })
    })

    await expect(extractZip(archiveFile())).rejects.toThrow('Worker failed')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('rejects unreadable worker responses and terminates the worker', async () => {
    worker.postMessage.mockImplementation(() => {
      queueMicrotask(() => worker.onmessageerror?.())
    })

    await expect(extractZip(archiveFile())).rejects.toThrow(
      'Unable to read the ZIP extraction result',
    )
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('terminates the worker if sending the archive fails', async () => {
    worker.postMessage.mockImplementationOnce(() => {
      throw new DOMException('Transfer failed', 'DataCloneError')
    })

    await expect(extractZip(archiveFile())).rejects.toThrow('Transfer failed')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})

describe('readFileList', () => {
  it('combines ordinary files with ZIP entries and supports stripping the common root', async () => {
    const plain = new File(['notes'], 'README.md')
    Object.defineProperty(plain, 'webkitRelativePath', {
      value: 'app/README.md',
    })

    const files = stripCommonRoot(
      await readFileList(fileList(plain, archiveFile())),
    )

    expect(files.map((file) => file.webkitRelativePath)).toEqual([
      'README.md',
      'src/index.html',
    ])
    expect(files.map((file) => file.text)).toEqual(['notes', 'hello'])
  })

  it('propagates ZIP errors to the caller', async () => {
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error('Unable to send archive')
    })

    await expect(readFileList(fileList(archiveFile()))).rejects.toThrow(
      'Unable to send archive',
    )
  })
})

function archiveFile(buffer = new ArrayBuffer(0)): File {
  const file = new File([buffer], 'app.ZIP', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => buffer })
  return file
}

function fileList(...files: Array<File>): FileList {
  return Object.assign(files, {
    item: (index: number) => files[index] ?? null,
  })
}
