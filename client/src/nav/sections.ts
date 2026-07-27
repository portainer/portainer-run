import {
  MonitorPlay,
  Settings,
  ShieldCheck,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { ROUTES } from '../lib/routes.js'

export interface NavItem {
  id: string
  label: string
  icon: LucideIcon
  /** Internal route path. */
  path: string
}

export interface NavSection {
  id: string
  label: string
  items: NavItem[]
}

const WORKLOADS_SECTION: NavSection = {
  id: 'workloads',
  label: 'Workloads',
  items: [
    {
      id: 'applications',
      label: 'Applications',
      icon: MonitorPlay,
      path: ROUTES.services,
    },
  ],
}

const DEPLOY_SECTION: NavSection = {
  id: 'deploy',
  label: 'Deploy',
  items: [{ id: 'deploy', label: 'Deploy', icon: Zap, path: ROUTES.deploy }],
}

const ADMIN_SECTION: NavSection = {
  id: 'admin',
  label: 'Admin',
  items: [
    {
      id: 'git-targets',
      label: 'Git Targets',
      icon: Workflow,
      path: ROUTES.gitTargets,
    },
    {
      id: 'readiness',
      label: 'Cluster Readiness',
      icon: ShieldCheck,
      path: ROUTES.readiness,
    },
  ],
}

/** Non-admins get the Git Targets page under a "Settings" label. */
const SETTINGS_SECTION: NavSection = {
  id: 'settings',
  label: 'Settings',
  items: [
    {
      id: 'git-targets',
      label: 'Settings',
      icon: Settings,
      path: ROUTES.gitTargets,
    },
  ],
}

export function navSections(isAdmin: boolean): NavSection[] {
  return isAdmin
    ? [WORKLOADS_SECTION, DEPLOY_SECTION, ADMIN_SECTION]
    : [WORKLOADS_SECTION, DEPLOY_SECTION, SETTINGS_SECTION]
}
