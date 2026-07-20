import type { Dispatch, SetStateAction } from 'react'

import { Button } from '@ds/v3-components/Button/Button'
import type { FileNode } from '@ds/v3-components/FilePicker/FilePicker'
import { FormControl, Input } from '@ds/v3-components/FormField/FormField'
import { SegmentedControl } from '@ds/v3-components/Segmented/Segmented'
import { Select } from '@ds/v3-components/Select/Select'

import { readFileList, type UploadedFile } from '../../lib/fileIntake'
import { MONO_FONT } from '../service-detail/detailUi'
import { GitFolderTree } from './GitFolderTree'
import { DropZone, FileRow } from './DeployStepUi'
import { HINT_STYLE } from './deployStyles'
import type { RuntimeDef } from './runtimes'

interface GitTargetOption {
  id: string
  name: string
  shared?: boolean
}

interface FilesStepProps {
  sourceType: string
  setSourceType: Dispatch<SetStateAction<string>>
  files: UploadedFile[]
  onFilesAdded: (files: UploadedFile[]) => void
  onResetFiles: () => void
  onRemoveFile: (idx: number) => void
  gitTargetsList: GitTargetOption[]
  gitSourceTargetId: string
  setGitSourceTargetId: Dispatch<SetStateAction<string>>
  gitSourceBranch: string
  setGitSourceBranch: Dispatch<SetStateAction<string>>
  gitSourceBranches: string[]
  setGitSourceBranches: Dispatch<SetStateAction<string[]>>
  gitSourceConfirmed: boolean
  setGitSourceConfirmed: Dispatch<SetStateAction<boolean>>
  gitSourcePath: string
  detectedRuntime: RuntimeDef | null
  setDetectedRuntime: Dispatch<SetStateAction<RuntimeDef | null>>
  loadGitSourceBranches: (targetId: string) => void
  loadGitDir: (path: string) => Promise<FileNode[]>
  onGitFolderSelect: (folderPath: string) => void
}

/** First wizard step: choose an upload or a git repository folder as the source. */
export function FilesStep({
  sourceType,
  setSourceType,
  files,
  onFilesAdded,
  onResetFiles,
  onRemoveFile,
  gitTargetsList,
  gitSourceTargetId,
  setGitSourceTargetId,
  gitSourceBranch,
  setGitSourceBranch,
  gitSourceBranches,
  setGitSourceBranches,
  gitSourceConfirmed,
  setGitSourceConfirmed,
  gitSourcePath,
  detectedRuntime,
  setDetectedRuntime,
  loadGitSourceBranches,
  loadGitDir,
  onGitFolderSelect,
}: FilesStepProps) {
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Source type toggle */}
        <div style={{ alignSelf: 'flex-start' }}>
          <SegmentedControl
            size="sm"
            options={[
              { value: 'upload', label: 'Upload files' },
              { value: 'git', label: 'From Git repository' },
            ]}
            value={sourceType}
            onChange={(val) => {
              setSourceType(val)
              setGitSourceConfirmed(false)
              setDetectedRuntime(null)
            }}
          />
        </div>

        {/* Upload source */}
        {sourceType === 'upload' && (
          <>
            {files.length === 0 ? (
              <DropZone onFiles={onFilesAdded} />
            ) : (
              <>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={HINT_STYLE}>
                    {files.length} file{files.length !== 1 ? 's' : ''} selected
                  </span>
                  <Button variant="ghost" onClick={onResetFiles}>
                    Remove all
                  </Button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {files.map((f, i) => (
                    <FileRow
                      key={f.webkitRelativePath || f.name}
                      file={f}
                      tag={
                        f.name === 'package.json' ||
                        f.name === 'requirements.txt' ||
                        f.name === 'Gemfile' ||
                        f.name === 'server.js'
                          ? 'runtime'
                          : f.name === '.env.example' || f.name.endsWith('.env.example')
                            ? 'env'
                            : null
                      }
                      onRemove={() => onRemoveFile(i)}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    id="vibe-add-folder"
                    type="file"
                    // @ts-expect-error non-standard folder-picker attribute
                    webkitdirectory=""
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      if (e.target.files?.length)
                        void readFileList(e.target.files).then(onFilesAdded)
                    }}
                  />
                  <input
                    id="vibe-add-files"
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      if (e.target.files?.length)
                        void readFileList(e.target.files).then(onFilesAdded)
                    }}
                  />
                  <Button
                    variant="ghost"
                    onClick={() => document.getElementById('vibe-add-folder')?.click()}
                  >
                    + Add folder
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => document.getElementById('vibe-add-files')?.click()}
                  >
                    + Add files
                  </Button>
                </div>
              </>
            )}
          </>
        )}

        {/* Git source */}
        {sourceType === 'git' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <FormControl label="Git target">
              <Select
                value={gitSourceTargetId}
                onChange={(e) => {
                  setGitSourceTargetId(e.target.value)
                  setGitSourceBranches([])
                  setGitSourceBranch('main')
                  setGitSourceConfirmed(false)
                  if (e.target.value) loadGitSourceBranches(e.target.value)
                }}
                options={[
                  { value: '', label: '— Select —' },
                  ...gitTargetsList.map((t) => ({
                    value: t.id,
                    label: `${t.name}${t.shared ? ' (shared)' : ''}`,
                  })),
                ]}
              />
            </FormControl>
            <FormControl label="Branch">
              {gitSourceBranches.length > 0 ? (
                <Select
                  value={gitSourceBranch}
                  onChange={(e) => setGitSourceBranch(e.target.value)}
                  options={gitSourceBranches.map((b) => ({ value: b, label: b }))}
                />
              ) : (
                <Input
                  type="text"
                  value={gitSourceBranch}
                  onChange={(e) => setGitSourceBranch(e.target.value)}
                  placeholder="main"
                />
              )}
            </FormControl>

            {!gitSourceTargetId || !gitSourceBranch.trim() ? (
              <div style={HINT_STYLE}>Choose a target and branch to browse the repository.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={HINT_STYLE}>
                  Expand folders to browse the repository and select the single folder that
                  contains your app. We&rsquo;ll deploy that folder and detect its runtime
                  automatically.
                </div>
                <GitFolderTree
                  key={`${gitSourceTargetId}:${gitSourceBranch}`}
                  loadChildren={loadGitDir}
                  selectedPath={gitSourceConfirmed ? gitSourcePath : null}
                  onSelect={onGitFolderSelect}
                  maxHeight={320}
                />
              </div>
            )}

            {gitSourceConfirmed && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 14px',
                  background: 'rgba(23,178,106,0.08)',
                  border: '1px solid rgba(23,178,106,0.3)',
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: MONO_FONT,
                  color: 'var(--status-success, #17b26a)',
                }}
              >
                ✓ Deploying{' '}
                <span style={{ color: 'var(--text)' }}>{gitSourcePath || 'repository root'}</span>
                {detectedRuntime ? ` as ${detectedRuntime.label}` : ''}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
