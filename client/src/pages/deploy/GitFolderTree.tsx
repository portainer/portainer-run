import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { File, Folder, FolderOpen, Loader2 } from 'lucide-react'

import type { FileNode } from '@ds/v3-components/FilePicker/FilePicker'

const ROW_H = 32
const INDENT_PX = 18
const MONO_FONT = "ui-monospace, 'SF Mono', 'Menlo', monospace"
/** Sentinel id for the repository-root selection (deploy the whole repo). */
const ROOT_ID = ''

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      style={{
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 120ms ease-out',
        flexShrink: 0,
      }}
    >
      <path
        d="M4.5 3L7.5 6L4.5 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Radio({ checked }: { checked: boolean }) {
  return (
    <span
      style={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        flexShrink: 0,
        border: `1.5px solid ${checked ? 'var(--accent, #2e90fa)' : 'var(--border, #ecedee)'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {checked ? (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--accent, #2e90fa)',
          }}
        />
      ) : null}
    </span>
  )
}

function selectedRowBg(selected: boolean): string {
  return selected
    ? 'color-mix(in srgb, var(--accent, #2e90fa) 12%, transparent)'
    : 'transparent'
}

/** A single indented "Loading…" placeholder shown while a folder's children load. */
function LoadingRow({ depth }: { depth: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: ROW_H,
        gap: 8,
        paddingRight: 12,
        paddingLeft: 8 + depth * INDENT_PX,
        fontSize: 13,
        color: 'var(--muted, #667085)',
      }}
    >
      <span style={{ width: 16, flexShrink: 0 }} />
      <span style={{ width: 14, flexShrink: 0 }} />
      <Loader2 size={13} className="animate-spin" style={{ flexShrink: 0 }} />
      <span>Loading…</span>
    </div>
  )
}

function FolderRow({
  node,
  depth,
  expanded,
  loadingPaths,
  selectedPath,
  onToggleExpand,
  onSelect,
}: {
  node: FileNode
  depth: number
  expanded: Set<string>
  loadingPaths: Set<string>
  selectedPath: string | null
  onToggleExpand: (id: string) => void
  onSelect: (id: string) => void
}) {
  const isFolder = node.type === 'folder'
  const isExpanded = expanded.has(node.id)
  const isSelected = isFolder && selectedPath === node.id
  // Children are lazily loaded: `children` is undefined until the folder's
  // listing arrives. Show a spinner row while an expanded folder is fetching.
  const childrenLoading = isFolder && isExpanded && !node.children && loadingPaths.has(node.id)

  return (
    <>
      <div
        role={isFolder ? 'button' : undefined}
        tabIndex={isFolder ? 0 : undefined}
        onClick={isFolder ? () => onSelect(node.id) : undefined}
        onKeyDown={
          isFolder
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(node.id)
                }
              }
            : undefined
        }
        style={{
          display: 'flex',
          alignItems: 'center',
          height: ROW_H,
          gap: 8,
          paddingRight: 12,
          paddingLeft: 8 + depth * INDENT_PX,
          cursor: isFolder ? 'pointer' : 'default',
          background: selectedRowBg(isSelected),
          userSelect: 'none',
        }}
      >
        {isFolder ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand(node.id)
            }}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--muted, #667085)',
              display: 'flex',
              width: 16,
              height: 16,
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Chevron open={isExpanded} />
          </button>
        ) : (
          <span style={{ width: 16, flexShrink: 0 }} />
        )}

        {isFolder ? (
          <Radio checked={isSelected} />
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}

        {isFolder ? (
          isExpanded ? (
            <FolderOpen size={15} color="var(--accent, #2e90fa)" style={{ flexShrink: 0 }} />
          ) : (
            <Folder size={15} color="var(--muted, #667085)" style={{ flexShrink: 0 }} />
          )
        ) : (
          <File size={14} color="var(--muted, #98a2b3)" style={{ flexShrink: 0 }} />
        )}

        <span
          style={{
            fontSize: 13,
            color: isFolder ? 'var(--text, #111827)' : 'var(--muted, #667085)',
            fontFamily: isFolder ? undefined : MONO_FONT,
            fontWeight: isSelected ? 600 : 400,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {node.name}
        </span>
      </div>

      {childrenLoading ? <LoadingRow depth={depth + 1} /> : null}

      {isFolder && isExpanded && node.children
        ? node.children.map((child) => (
            <FolderRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              loadingPaths={loadingPaths}
              selectedPath={selectedPath}
              onToggleExpand={onToggleExpand}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  )
}

/**
 * Repository folder browser with single-folder selection. Folders are loaded
 * lazily: only the repository root is fetched up front, and each folder's
 * contents are fetched the first time it is expanded (via `loadChildren`).
 * Pick exactly one folder (or the repository root) as the app root; files are
 * shown for context but are not selectable.
 *
 * The component is designed to be remounted (via `key`) when the target/branch
 * changes so all lazy-load state resets cleanly.
 */
export function GitFolderTree({
  loadChildren,
  selectedPath,
  onSelect,
  maxHeight = 320,
}: {
  /** Fetch the immediate children of a folder ('' for the repository root). */
  loadChildren: (path: string) => Promise<FileNode[]>
  /** Selected folder path, '' for repository root, or null when nothing chosen. */
  selectedPath: string | null
  onSelect: (path: string) => void
  maxHeight?: number | string
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [childrenByPath, setChildrenByPath] = useState<Map<string, FileNode[]>>(() => new Map())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set())
  const [rootError, setRootError] = useState('')

  // Dedupe in-flight/completed requests and avoid setState after unmount.
  const requestedRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(
    (path: string) => {
      if (requestedRef.current.has(path)) return
      requestedRef.current.add(path)
      setLoadingPaths((prev) => new Set(prev).add(path))
      loadChildren(path)
        .then((nodes) => {
          if (!mountedRef.current) return
          setChildrenByPath((prev) => new Map(prev).set(path, nodes))
        })
        .catch((e: unknown) => {
          if (!mountedRef.current) return
          // Allow a retry on the next expand.
          requestedRef.current.delete(path)
          if (path === ROOT_ID) {
            setRootError(e instanceof Error ? e.message : 'Failed to load repository')
          }
        })
        .finally(() => {
          if (!mountedRef.current) return
          setLoadingPaths((prev) => {
            const next = new Set(prev)
            next.delete(path)
            return next
          })
        })
    },
    [loadChildren],
  )

  // Load the repository root once on mount (a fresh mount per target/branch).
  useEffect(() => {
    load(ROOT_ID)
  }, [load])

  function toggleExpand(id: string) {
    const willExpand = !expanded.has(id)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (willExpand) load(id)
  }

  // Assemble a nested tree from the per-folder listings we have loaded so far.
  // A folder's `children` stays undefined until its listing arrives, which the
  // rows use to decide whether to show a loading placeholder.
  const buildNodes = useCallback(
    (path: string): FileNode[] | undefined => {
      const kids = childrenByPath.get(path)
      if (!kids) return undefined
      return kids.map((node) =>
        node.type === 'folder' ? { ...node, children: buildNodes(node.id) } : node,
      )
    },
    [childrenByPath],
  )

  const rootLoaded = childrenByPath.has(ROOT_ID)
  const rootNodes = useMemo(() => buildNodes(ROOT_ID) ?? [], [buildNodes])

  const rootSelected = selectedPath === ROOT_ID
  const rootLoading = loadingPaths.has(ROOT_ID)

  return (
    <div
      style={{
        border: '1px solid var(--border, #ecedee)',
        borderRadius: 'var(--radius-md, 6px)',
        overflow: 'hidden',
        background: 'var(--content-bg, #fff)',
      }}
    >
      <div style={{ maxHeight, overflowY: 'auto', padding: '4px 0' }}>
        {rootError ? (
          <div
            style={{
              padding: 16,
              fontSize: 13,
              color: 'var(--status-danger, #f04438)',
              textAlign: 'center',
            }}
          >
            {rootError}
          </div>
        ) : rootLoading && !rootLoaded ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: 16,
              fontSize: 13,
              color: 'var(--muted, #667085)',
            }}
          >
            <Loader2 size={14} className="animate-spin" />
            Loading repository…
          </div>
        ) : (
          <>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(ROOT_ID)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(ROOT_ID)
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: ROW_H,
                gap: 8,
                padding: '0 12px 0 8px',
                cursor: 'pointer',
                background: selectedRowBg(rootSelected),
                userSelect: 'none',
              }}
            >
              <span style={{ width: 16, flexShrink: 0 }} />
              <Radio checked={rootSelected} />
              <Folder size={15} color="var(--muted, #667085)" style={{ flexShrink: 0 }} />
              <span
                style={{
                  fontSize: 13,
                  color: 'var(--text, #111827)',
                  fontWeight: rootSelected ? 600 : 400,
                }}
              >
                Deploy entire repository
              </span>
            </div>

            {rootNodes.length === 0 ? (
              <div
                style={{
                  padding: 16,
                  fontSize: 13,
                  color: 'var(--muted, #667085)',
                  textAlign: 'center',
                }}
              >
                This branch has no files
              </div>
            ) : (
              rootNodes.map((node) => (
                <FolderRow
                  key={node.id}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  loadingPaths={loadingPaths}
                  selectedPath={selectedPath}
                  onToggleExpand={toggleExpand}
                  onSelect={onSelect}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}
