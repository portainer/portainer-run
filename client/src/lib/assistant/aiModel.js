import { useAppStore } from '../../store/useAppStore.js'

export function getAssistantModel() {
  const p = useAppStore.getState().aiProvider
  return p === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-6'
}
