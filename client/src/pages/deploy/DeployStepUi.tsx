import { useRef, useState } from 'react'
import { FileText, Lock, Upload, X } from 'lucide-react'

import { Badge } from '@ds/v3-components/Badge/Badge'
import { Button } from '@ds/v3-components/Button/Button'

import {
  readDropEvent,
  readFileList,
  type UploadedFile,
} from '../../lib/fileIntake'
import { MONO_FONT } from '../service-detail/detailUi'

/** Drag-and-drop / browse target for uploading a project folder or files. */
export function DropZone({
  onFiles,
}: {
  onFiles: (files: UploadedFile[]) => void
}) {
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState(false)
  const folderRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const result = await readDropEvent(e)
    if (result) onFiles(result)
  }

  const active = dragging || hover
  const accent = 'var(--accent, #2e90fa)'

  return (
    <>
      {/* Hidden pickers live OUTSIDE the clickable dropzone below. A
          programmatic `input.click()` dispatches a click event that bubbles;
          if the input were nested in the dropzone, that event would reach the
          dropzone's onClick and re-open the folder picker — so "Upload files"
          would wrongly show the folder picker. Keeping them as siblings avoids
          that. */}
      <input
        ref={folderRef}
        type="file"
        // @ts-expect-error non-standard folder-picker attribute
        webkitdirectory=""
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length)
            void readFileList(e.target.files).then(onFiles)
        }}
      />
      <input
        ref={filesRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length)
            void readFileList(e.target.files).then(onFiles)
        }}
      />
      <div
        role="button"
        tabIndex={0}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => folderRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            folderRef.current?.click()
          }
        }}
        style={{
          border: `1.5px dashed ${active ? accent : 'var(--border)'}`,
          borderRadius: 12,
          padding: '40px 24px',
          textAlign: 'center',
          cursor: 'pointer',
          outline: 'none',
          background: dragging
            ? `color-mix(in srgb, ${accent} 8%, transparent)`
            : hover
              ? 'color-mix(in srgb, var(--text) 3%, transparent)'
              : 'transparent',
          transition: 'border-color 120ms ease, background-color 120ms ease',
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: '50%',
            margin: '0 auto 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `color-mix(in srgb, ${accent} 12%, transparent)`,
            color: accent,
            transition: 'transform 120ms ease',
            transform: active ? 'translateY(-2px)' : 'none',
          }}
        >
          <Upload size={22} />
        </div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: 'var(--text)',
            marginBottom: 4,
          }}
        >
          {dragging ? 'Drop to upload' : 'Drop your project folder here'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18 }}>
          or browse below — we&rsquo;ll detect the runtime automatically
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <Button
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation()
              folderRef.current?.click()
            }}
          >
            Upload folder
          </Button>
          <Button
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation()
              filesRef.current?.click()
            }}
          >
            Upload files
          </Button>
        </div>
      </div>
    </>
  )
}

/** A single uploaded-file row with a runtime/env tag and a remove control. */
export function FileRow({
  file,
  tag,
  onRemove,
}: {
  file: UploadedFile
  tag: 'runtime' | 'env' | null
  onRemove: () => void
}) {
  const sizeKb = (file.size / 1024).toFixed(1)
  const isEnvFile =
    file.name === '.env.example' || file.name.endsWith('.env.example')
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '7px 10px',
      }}
    >
      <FileText
        size={12}
        style={{
          color: isEnvFile
            ? 'var(--status-warning, #f79009)'
            : 'var(--accent, #2e90fa)',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: MONO_FONT,
          fontSize: 11,
          color: 'var(--text)',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {file.webkitRelativePath && file.webkitRelativePath !== file.name
          ? file.webkitRelativePath
          : file.name}
      </span>
      <span
        style={{
          fontFamily: MONO_FONT,
          fontSize: 10,
          color: 'var(--muted)',
          flexShrink: 0,
        }}
      >
        {sizeKb} KB
      </span>
      {tag && (
        <Badge tone={tag === 'runtime' ? 'success' : 'warning'} size="sm">
          {tag === 'runtime' ? 'runtime' : '.env detected'}
        </Badge>
      )}
      <button
        type="button"
        onClick={onRemove}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--muted)',
          display: 'flex',
          padding: 2,
          flexShrink: 0,
        }}
        aria-label={`Remove ${file.name}`}
      >
        <X size={11} />
      </button>
    </div>
  )
}

/** Locked single-choice value shown instead of a select. */
export function LockedValue({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '9px 12px',
        fontFamily: MONO_FONT,
        fontSize: 13,
        color: 'var(--text)',
      }}
    >
      <Lock size={11} style={{ color: 'var(--muted)' }} />
      {children}
    </div>
  )
}

/** Bold heading shown at the top of a wizard step body. */
export function StepHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--text)',
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  )
}
