import { Check, Loader2, X } from 'lucide-react'

import { Timeline, TimelineItem } from '@ds/v3-components/Timeline/Timeline'
import type { TimelineTone } from '@ds/v3-components/Timeline/Timeline'

/**
 * Migrate progress phases.
 *
 * `copying` covers the single server call that copies the source tree and
 * manifest into the target's Git location and creates the stack there. `starting`
 * is the long part — the target's init containers clone the source and install
 * dependencies before the app comes up — and is polled, so the status reason can
 * be shown live rather than leaving the dialog looking hung.
 */
export type MigratePhase =
  'copying' | 'starting' | 'ready' | 'error' | 'timeout'

export type MigrateFailStage = 'copy' | 'start' | null

interface Step {
  tone: TimelineTone
  bullet?: React.ReactNode
  desc: React.ReactNode
}

interface MigrateProgressProps {
  mode: 'clone' | 'move'
  phase: MigratePhase
  targetNs: string
  /** Live status reason for the target app while it starts. */
  reason: string | null
  errorMsg: string | null
  failStage: MigrateFailStage
  /** True once the source stack and its Git entries have been removed (move only). */
  sourceRemoved: boolean
}

/** Post-migrate progress timeline, mirroring the deploy wizard's final step. */
export function MigrateProgress({
  mode,
  phase,
  targetNs,
  reason,
  errorMsg,
  failStage,
  sourceRemoved,
}: MigrateProgressProps) {
  const spinner = <Loader2 size={12} className="animate-spin" />
  const check = <Check size={12} strokeWidth={2.5} />
  const cross = <X size={12} strokeWidth={2.5} />

  const copyFailed = phase === 'error' && failStage === 'copy'
  const startFailed = phase === 'error' && failStage === 'start'
  const verb = mode === 'move' ? 'Moving' : 'Cloning'

  // Step 1 — Copying source + manifest, creating the stack in the target.
  let s1: Step
  if (phase === 'copying') {
    s1 = {
      tone: 'accent',
      bullet: spinner,
      desc: `Copying your app's files and creating it in ${targetNs}`,
    }
  } else if (copyFailed) {
    s1 = {
      tone: 'danger',
      bullet: cross,
      desc: errorMsg || `Something went wrong while ${verb.toLowerCase()}`,
    }
  } else {
    s1 = {
      tone: 'success',
      bullet: check,
      desc: sourceRemoved
        ? `Copied to ${targetNs} and the original was removed`
        : `Copied to ${targetNs}`,
    }
  }

  // Step 2 — The target app coming up.
  let s2: Step
  if (phase === 'copying' || copyFailed) {
    s2 = { tone: 'neutral', desc: 'Waiting for your app to start' }
  } else if (phase === 'starting') {
    s2 = {
      tone: 'accent',
      bullet: spinner,
      desc: reason || 'Waiting for your app to start',
    }
  } else if (phase === 'timeout') {
    s2 = {
      tone: 'warning',
      bullet: spinner,
      desc: reason || 'This is taking longer than usual — still starting',
    }
  } else if (startFailed) {
    s2 = {
      tone: 'danger',
      bullet: cross,
      desc: reason || "Your app couldn't start in the new location",
    }
  } else {
    s2 = { tone: 'success', bullet: check, desc: 'Started successfully' }
  }

  const s3: Step =
    phase === 'ready'
      ? {
          tone: 'success',
          bullet: check,
          desc: `Your app is up and running in ${targetNs}`,
        }
      : { tone: 'neutral', desc: `Your app will be live in ${targetNs}` }

  return (
    <div style={{ padding: '4px 2px' }}>
      <Timeline>
        <TimelineItem
          tone={s1.tone}
          bullet={s1.bullet}
          title={mode === 'move' ? 'Moving' : 'Cloning'}
          description={s1.desc}
        />
        <TimelineItem
          tone={s2.tone}
          bullet={s2.bullet}
          title="Starting"
          description={s2.desc}
        />
        <TimelineItem
          tone={s3.tone}
          bullet={s3.bullet}
          title="Ready"
          description={s3.desc}
        />
      </Timeline>
    </div>
  )
}
