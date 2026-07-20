import { Check, Loader2, X } from 'lucide-react'

import { Button } from '@ds/v3-components/Button/Button'
import { Timeline, TimelineItem } from '@ds/v3-components/Timeline/Timeline'
import type { TimelineTone } from '@ds/v3-components/Timeline/Timeline'

import { StepHeading } from './DeployStepUi'
import type { StartupPhase } from './startup'

interface StartupPanelProps {
  phase: StartupPhase | null
  reason: string | null
  url: string | null
  errorMsg: string | null
  failStage: 'deploy' | 'start' | null
  onFinish: () => void
  onReset: () => void
  onKeepWaiting: () => void
}

interface TimelineStep {
  tone: TimelineTone
  bullet?: React.ReactNode
  desc: React.ReactNode
}

/** Post-deploy progress: a three-step timeline (deploy → start → ready) + actions. */
export function StartupPanel({
  phase,
  reason,
  url,
  errorMsg,
  failStage,
  onFinish,
  onReset,
  onKeepWaiting,
}: StartupPanelProps) {
  const spinner = <Loader2 size={12} className="animate-spin" />
  const check = <Check size={12} strokeWidth={2.5} />
  const cross = <X size={12} strokeWidth={2.5} />

  const deployFailed = phase === 'error' && failStage === 'deploy'
  const startFailed = phase === 'error' && failStage === 'start'

  // Step 1 — Deploying
  let s1: TimelineStep
  if (phase === 'deploying') {
    s1 = {
      tone: 'accent',
      bullet: spinner,
      desc: 'Saving your app and setting things up',
    }
  } else if (deployFailed) {
    s1 = {
      tone: 'danger',
      bullet: cross,
      desc: errorMsg || 'Something went wrong while setting up',
    }
  } else {
    s1 = { tone: 'success', bullet: check, desc: 'Saved and set up' }
  }

  // Step 2 — Starting
  let s2: TimelineStep
  if (phase === 'deploying' || deployFailed) {
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
      desc: reason || "Your app couldn't start",
    }
  } else {
    s2 = { tone: 'success', bullet: check, desc: 'Started successfully' }
  }

  // Step 3 — Ready
  const s3: TimelineStep =
    phase === 'ready'
      ? { tone: 'success', bullet: check, desc: 'Your app is up and running' }
      : { tone: 'neutral', desc: 'Your app will be live here' }

  return (
    <div>
      <StepHeading>
        {phase === 'ready' ? 'Your app is live' : 'Deploying your app'}
      </StepHeading>
      <div style={{ maxWidth: 460, padding: '8px 4px 4px' }}>
        <Timeline>
          <TimelineItem
            tone={s1.tone}
            bullet={s1.bullet}
            title="Deploying"
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
      <StartupActions
        phase={phase}
        url={url}
        onFinish={onFinish}
        onReset={onReset}
        onKeepWaiting={onKeepWaiting}
      />
    </div>
  )
}

function StartupActions({
  phase,
  url,
  onFinish,
  onReset,
  onKeepWaiting,
}: {
  phase: StartupPhase | null
  url: string | null
  onFinish: () => void
  onReset: () => void
  onKeepWaiting: () => void
}) {
  if (phase === 'ready') {
    return (
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        {url && (
          <Button
            onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
          >
            Open my app
          </Button>
        )}
        <Button variant={url ? 'ghost' : undefined} onClick={onFinish}>
          Go to my apps
        </Button>
      </div>
    )
  }
  if (phase === 'error') {
    return (
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        <Button onClick={onFinish}>View application</Button>
        <Button variant="ghost" onClick={onReset}>
          Start over
        </Button>
      </div>
    )
  }
  if (phase === 'timeout') {
    return (
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        <Button onClick={onKeepWaiting}>Keep waiting</Button>
        <Button variant="ghost" onClick={onFinish}>
          View application
        </Button>
      </div>
    )
  }
  return null
}
