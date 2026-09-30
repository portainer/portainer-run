import { unzipSync } from 'fflate'

import { errMessage } from './errors'
import type { UploadedFile } from './fileIntake'

export type ZipWorkerResponse =
  | { status: 'success'; files: Array<UploadedFile> }
  | { status: 'error'; message: string }

self.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
  try {
    const files = unzipSync(new Uint8Array(data))
    const results: Array<UploadedFile> = []
    const decoder = new TextDecoder()

    for (const [relPath, contents] of Object.entries(files)) {
      if (relPath.endsWith('/')) continue
      if (relPath.startsWith('__MACOSX/') || relPath.includes('/__MACOSX/'))
        continue
      const parts = relPath.split('/')
      const name = parts[parts.length - 1]
      if (!name) continue
      results.push({
        name,
        size: contents.length,
        text: decoder.decode(contents),
        webkitRelativePath: relPath,
      })
    }

    self.postMessage({
      status: 'success',
      files: results,
    } satisfies ZipWorkerResponse)
  } catch (error) {
    self.postMessage({
      status: 'error',
      message: errMessage(error),
    } satisfies ZipWorkerResponse)
  }
}
