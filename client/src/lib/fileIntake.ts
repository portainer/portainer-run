import { unzip } from 'fflate'

/**
 * File-intake helpers shared by the Deploy wizard and the service Edit tab.
 * Behaviour mirrors the original inline helpers exactly: text-decode every
 * file, expand .zip archives (skipping __MACOSX noise), and support folder
 * drops via the webkitGetAsEntry API.
 */

export interface UploadedFile {
  name: string
  size: number
  text: string
  webkitRelativePath: string
}

export async function extractZip(file: File): Promise<UploadedFile[]> {
  const arrayBuffer = await file.arrayBuffer()
  const uint8 = new Uint8Array(arrayBuffer)
  return new Promise((resolve, reject) => {
    unzip(uint8, (err, files) => {
      if (err) {
        reject(err)
        return
      }
      const results: UploadedFile[] = []
      for (const [relPath, data] of Object.entries(files)) {
        if (relPath.endsWith('/')) continue // directory entry
        if (relPath.startsWith('__MACOSX/') || relPath.includes('/__MACOSX/'))
          continue
        const parts = relPath.split('/')
        const name = parts[parts.length - 1]
        if (!name) continue
        results.push({
          name,
          size: data.length,
          text: new TextDecoder().decode(data),
          webkitRelativePath: relPath,
        })
      }
      resolve(results)
    })
  })
}

function readFileEntry(entry: FileSystemFileEntry): Promise<UploadedFile> {
  return new Promise((resolve) => {
    entry.file((file: File) => {
      const reader = new FileReader()
      reader.onload = (e) =>
        resolve({
          name: file.name,
          size: file.size,
          text: e.target?.result as string,
          webkitRelativePath: entry.fullPath.replace(/^\//, ''),
        })
      reader.onerror = () =>
        resolve({
          name: file.name,
          size: file.size,
          text: '',
          webkitRelativePath: entry.fullPath.replace(/^\//, ''),
        })
      reader.readAsText(file)
    })
  })
}

function readDirEntry(
  dirEntry: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader()
    const all: FileSystemEntry[] = []
    function batch() {
      reader.readEntries((entries: FileSystemEntry[]) => {
        if (!entries.length) {
          resolve(all)
          return
        }
        all.push(...entries)
        batch()
      })
    }
    batch()
  })
}

async function traverseEntry(entry: FileSystemEntry): Promise<UploadedFile[]> {
  if (entry.isFile) return [await readFileEntry(entry as FileSystemFileEntry)]
  if (entry.isDirectory) {
    const children = await readDirEntry(entry as FileSystemDirectoryEntry)
    const nested = await Promise.all(children.map(traverseEntry))
    return nested.flat()
  }
  return []
}

function readPlainFile(file: File): Promise<UploadedFile> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) =>
      resolve({
        name: file.name,
        size: file.size,
        text: e.target?.result as string,
        webkitRelativePath: file.webkitRelativePath || file.name,
      })
    reader.onerror = () =>
      resolve({
        name: file.name,
        size: file.size,
        text: '',
        webkitRelativePath: file.webkitRelativePath || file.name,
      })
    reader.readAsText(file)
  })
}

/** Read a FileList from an <input type="file">, expanding zip archives. */
export async function readFileList(
  fileList: FileList,
): Promise<UploadedFile[]> {
  const allFiles = Array.from(fileList)
  const zips = allFiles.filter((f) => f.name.toLowerCase().endsWith('.zip'))
  const rest = allFiles.filter((f) => !f.name.toLowerCase().endsWith('.zip'))

  const restPromise = Promise.all(rest.map(readPlainFile))
  const zipPromises = zips.map((f) => extractZip(f))
  const groups = await Promise.all([restPromise, ...zipPromises])
  return groups.flat()
}

/**
 * Extract files from a drop event, supporting folder drops via
 * webkitGetAsEntry. Returns null when the event carried nothing readable.
 */
export async function readDropEvent(
  e: React.DragEvent,
): Promise<UploadedFile[] | null> {
  const items = e.dataTransfer.items
  if (items && items.length) {
    const entries = Array.from(items)
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => Boolean(entry))
    if (entries.length) {
      const zipEntries = entries.filter(
        (entry) => entry.isFile && entry.name.toLowerCase().endsWith('.zip'),
      )
      const otherEntries = entries.filter(
        (entry) => !entry.isFile || !entry.name.toLowerCase().endsWith('.zip'),
      )
      const zipFiles = await Promise.all(
        zipEntries.map(
          (entry) =>
            new Promise<File>((resolve) =>
              (entry as FileSystemFileEntry).file(resolve),
            ),
        ),
      )
      const zipResults = await Promise.all(zipFiles.map(extractZip))
      const traversed = otherEntries.length
        ? (await Promise.all(otherEntries.map(traverseEntry))).flat()
        : []
      return [...traversed, ...zipResults.flat()]
    }
  }
  if (e.dataTransfer.files.length) return readFileList(e.dataTransfer.files)
  return null
}

/**
 * If all files share the same root folder (e.g. expense-tracker/server.js),
 * strip that root so paths are relative to the app root, not the folder name.
 */
export function stripCommonRoot(files: UploadedFile[]): UploadedFile[] {
  if (!files.length) return files
  const paths = files.map((f) => f.webkitRelativePath || f.name)
  const firstSeg = paths[0].split('/')[0]
  const allSameRoot = paths.every((p) => p.startsWith(firstSeg + '/'))
  if (!allSameRoot) return files
  return files.map((f) => ({
    ...f,
    webkitRelativePath: (f.webkitRelativePath || f.name).slice(
      firstSeg.length + 1,
    ),
  }))
}
