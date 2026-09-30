import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readDropEvent,
  readFileList,
  type UploadedFile,
} from '../../lib/fileIntake'
import { FilesStep } from './FilesStep'

vi.mock('../../lib/fileIntake', () => ({
  readFileList: vi.fn(),
  readDropEvent: vi.fn(),
}))

const uploadedFile: UploadedFile = {
  name: 'index.html',
  size: 5,
  text: 'hello',
  webkitRelativePath: 'index.html',
}

const selectedArchive = new File(['zip'], 'app.zip')
const selectedPath = 'C:\\fakepath\\app.zip'
const pickerCases = [
  { hasFiles: false, folderPicker: false },
  { hasFiles: false, folderPicker: true },
  { hasFiles: true, folderPicker: false },
  { hasFiles: true, folderPicker: true },
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

describe('FilesStep upload errors', () => {
  it.each(pickerCases)(
    'resets failed selections and allows retry (folder: $folderPicker, existing files: $hasFiles)',
    async ({ hasFiles, folderPicker }) => {
      const props = defaultProps(hasFiles ? [uploadedFile] : [])
      await act(async () => root.render(<FilesStep {...props} />))
      vi.mocked(readFileList).mockRejectedValueOnce(
        new Error('invalid zip data'),
      )

      const input = await selectFiles(folderPicker)

      expect(input.value).toBe('')
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Unable to read uploaded files: invalid zip data',
      )
      expect(props.onFilesAdded).not.toHaveBeenCalled()

      vi.mocked(readFileList).mockResolvedValueOnce([uploadedFile])
      const retriedInput = await selectFiles(folderPicker)

      expect(retriedInput.value).toBe('')
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(props.onFilesAdded).toHaveBeenCalledWith([uploadedFile])
      expect(readFileList).toHaveBeenCalledTimes(2)
    },
  )

  it.each(pickerCases)(
    'keeps the selection until reading settles (folder: $folderPicker, existing files: $hasFiles)',
    async ({ hasFiles, folderPicker }) => {
      const props = defaultProps(hasFiles ? [uploadedFile] : [])
      await act(async () => root.render(<FilesStep {...props} />))
      let resolveRead: (files: Array<UploadedFile>) => void = () => {}
      const pendingRead = new Promise<Array<UploadedFile>>((resolve) => {
        resolveRead = resolve
      })
      vi.mocked(readFileList).mockReturnValueOnce(pendingRead)

      const input = await selectFiles(folderPicker)

      expect(input.value).toBe(selectedPath)
      expect(props.onFilesAdded).not.toHaveBeenCalled()

      await act(async () => resolveRead([uploadedFile]))

      expect(input.value).toBe('')
      expect(props.onFilesAdded).toHaveBeenCalledWith([uploadedFile])
    },
  )

  it('shows drop errors without adding files', async () => {
    const props = defaultProps()
    await act(async () => root.render(<FilesStep {...props} />))
    vi.mocked(readDropEvent).mockRejectedValueOnce(
      new Error('invalid zip data'),
    )

    const dropZone = container.querySelector('[role="button"]')
    if (!dropZone) throw new Error('Drop zone not found')
    await act(async () => {
      dropZone.dispatchEvent(
        new Event('drop', { bubbles: true, cancelable: true }),
      )
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Unable to read uploaded files: invalid zip data',
    )
    expect(props.onFilesAdded).not.toHaveBeenCalled()
  })
})

async function selectFiles(folderPicker: boolean) {
  const input = container.querySelector<HTMLInputElement>(
    folderPicker
      ? 'input[type="file"][webkitdirectory]'
      : 'input[type="file"]:not([webkitdirectory])',
  )
  if (!input) throw new Error('File picker not found')
  if (input.value === selectedPath) return input
  Object.defineProperties(input, {
    value: { configurable: true, writable: true, value: selectedPath },
    files: { configurable: true, value: [selectedArchive] },
  })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  return input
}

function defaultProps(
  files: Array<UploadedFile> = [],
): ComponentProps<typeof FilesStep> {
  return {
    sourceType: 'upload',
    setSourceType: vi.fn(),
    files,
    onFilesAdded: vi.fn(),
    onResetFiles: vi.fn(),
    onRemoveFile: vi.fn(),
    gitTargetsList: [],
    gitSourceTargetId: '',
    setGitSourceTargetId: vi.fn(),
    gitSourceBranch: 'main',
    setGitSourceBranch: vi.fn(),
    gitSourceBranches: [],
    setGitSourceBranches: vi.fn(),
    gitSourceConfirmed: false,
    setGitSourceConfirmed: vi.fn(),
    gitSourcePath: '',
    detectedRuntime: null,
    setDetectedRuntime: vi.fn(),
    loadGitSourceBranches: vi.fn(),
    loadGitDir: vi.fn(),
    onGitFolderSelect: vi.fn(),
  }
}
