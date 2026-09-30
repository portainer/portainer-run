import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readFileList, type UploadedFile } from '../../lib/fileIntake'
import { VibeEditTab } from './VibeEditTab'

vi.mock('../../lib/fileIntake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/fileIntake')>()),
  readFileList: vi.fn(),
}))

const uploadedFile: UploadedFile = {
  name: 'index.html',
  size: 5,
  text: 'hello',
  webkitRelativePath: 'index.html',
}
const selectedArchive = new File(['zip'], 'app.zip')
const selectedPath = 'C:\\fakepath\\app.zip'

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

describe('VibeEditTab file picker retries', () => {
  it.each([
    { hasFiles: false, folderPicker: false },
    { hasFiles: false, folderPicker: true },
    { hasFiles: true, folderPicker: false },
    { hasFiles: true, folderPicker: true },
  ])(
    'resets failed selections and allows retry (folder: $folderPicker, existing files: $hasFiles)',
    async ({ hasFiles, folderPicker }) => {
      await act(async () =>
        root.render(
          <VibeEditTab
            d={{ metadata: { name: 'app', namespace: 'default' } }}
            envId="1"
            namespace="default"
            name="app"
            gitOpsInfo={null}
          />,
        ),
      )
      if (hasFiles) {
        vi.mocked(readFileList).mockResolvedValueOnce([uploadedFile])
        await selectFiles(folderPicker)
      }
      vi.mocked(readFileList).mockRejectedValueOnce(
        new Error('invalid zip data'),
      )

      const input = await selectFiles(folderPicker)

      expect(input.value).toBe('')
      expect(container.textContent).toContain(
        'Unable to read uploaded files: invalid zip data',
      )

      vi.mocked(readFileList).mockResolvedValueOnce([uploadedFile])
      const retriedInput = await selectFiles(folderPicker)

      expect(retriedInput.value).toBe('')
      expect(container.textContent).not.toContain(
        'Unable to read uploaded files',
      )
      expect(container.textContent).toContain('index.html')
      expect(readFileList).toHaveBeenCalledTimes(hasFiles ? 3 : 2)
    },
  )
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
