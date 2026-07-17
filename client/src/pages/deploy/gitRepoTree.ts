import type { FileNode } from '@ds/v3-components/FilePicker/FilePicker'

export interface RepoEntry {
  path: string
  type: 'file' | 'dir'
}

/**
 * Convert a single directory listing (entry base names, as returned by the
 * non-recursive `/files` endpoint) into sorted FileNode[] whose ids are the
 * full repo-relative paths. Folders sort before files, then alphabetically.
 *
 * @param parentPath repo-relative folder being listed ('' for the root)
 * @param entries    the directory's immediate children
 */
export function dirEntriesToNodes(parentPath: string, entries: RepoEntry[]): FileNode[] {
  return entries
    .map((entry) => {
      const name = entry.path.replace(/^\/+|\/+$/g, '')
      const id = parentPath ? `${parentPath}/${name}` : name
      const type: FileNode['type'] = entry.type === 'dir' ? 'folder' : 'file'
      return { id, name, type }
    })
    .filter((node) => node.name)
    .sort((a, b) =>
      a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name),
    )
}
