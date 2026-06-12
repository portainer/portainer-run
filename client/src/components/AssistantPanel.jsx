import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppStore, visibleDeployments } from '../store/useAppStore.js'
import { ROUTES, serviceDetailPath } from '../lib/routes.js'
import { getAssistantModel } from '../lib/assistant/aiModel.js'
import { mdToHtml } from '../lib/assistant/markdown.js'
import { readTriageSseStream } from '../lib/assistant/parseStream.js'
import { gatherServiceDiagnostics } from '../lib/assistant/diagnostics.js'
import { buildAssistantContext } from '../lib/assistant/buildContext.js'
import { buildDeployPreview, parseScaleAction } from '../lib/assistant/deployPreview.js'

const PLACEHOLDER =
  'Ask about your services, paste a docker-compose, or describe what you want to deploy...'

function newMsgId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'm-' + Date.now() + '-' + Math.random().toString(16).slice(2)
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 */
export function AssistantPanel({ open, onClose }) {
  const location = useLocation()
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const features = useAppStore((s) => s.features)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [rows, setRows] = useState(/** @type {Array<Record<string, unknown>>} */ ([]))
  const [thinking, setThinking] = useState(
    /** @type {null | { phase: 'fetch' | 'analyse', name?: string }} */ (null),
  )
  const inputRef = useRef(null)
  const scrollRef = useRef(null)
  const historyRef = useRef(/** @type {Array<{ role: string, content: string }>} */ ([]))
  const sendingRef = useRef(false)

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 200)
    }
  }, [open])

  useEffect(() => {
    scrollToBottom()
  }, [rows, thinking, open, scrollToBottom])

  const addUser = useCallback((text, userDisplay) => {
    setRows((r) => [
      ...r,
      { id: newMsgId(), role: 'user', text, userDisplay: userDisplay || text },
    ])
  }, [])

  const addError = useCallback((msg) => {
    setRows((r) => [...r, { id: newMsgId(), role: 'assistant', text: msg }])
  }, [])

  const sendChat = useCallback(async () => {
    const text = input.trim()
    if (!text || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setInput('')

    const isCompose =
      text.includes('services:') && (text.includes('image:') || text.includes('build:'))
    const imageMatches = text.match(/image:/g) || []
    const displayText = isCompose
      ? `Docker Compose pasted (${imageMatches.length} container${
          imageMatches.length !== 1 ? 's' : ''
        } detected)`
      : text

    addUser(text, isCompose ? displayText : text)
    historyRef.current = [...historyRef.current, { role: 'user', content: text }]

    if (isCompose && !features.simpleDeploy && !features.manifestBuilder) {
      // Vibe Deploy only — compose files aren't applicable. Let the normal
      // chat path handle it so the AI can explain that source files are needed.
      setThinking({ phase: 'think' })
    } else if (isCompose) {
      setThinking({ phase: 'analyse' })
      try {
        const ctx = buildAssistantContext(location.pathname)
        const response = await fetch('/ai/triage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: getAssistantModel(),
            max_tokens: 2000,
            stream: false,
            system: `Translate the Docker Compose file into a Portainer Run deployment config.

RULES:
- All services become separate containers in ONE deployment (sidecar model, shared localhost network)
- Each compose service maps to exactly ONE container object in the containers array
- Each container gets ONLY the environment variables defined for THAT service in the compose file — do NOT merge env vars across services
- The first service listed is the primary container, all others are sidecars
- volumes become storage config on the container that mounts them
- ports from the first service become the exposure config
- build directives cannot be mapped — add to warnings
- LOCALHOST REWRITE (critical): All containers in a Portainer Run deployment share the same network namespace — they communicate via localhost, not by service name. You MUST scan every env var value across every container and replace any value that is (or contains) the name of another service in this compose file with "localhost". This applies to ALL inter-container references regardless of variable name: DB_HOST, DATABASE_URL, REDIS_URL, RABBIT_HOST, API_HOST, WORDPRESS_DB_HOST, any connection string containing a service name, etc. Also applies to values like "mysql:3306" → "localhost:3306", "redis:6379" → "localhost:6379". Ignore dependsOn, links, and networks — they are irrelevant in a shared pod.

Return ONLY valid JSON in a code block tagged deploy-config like this — the fence tag must be exactly \`\`\`deploy-config with no trailing text, followed immediately by a newline, then valid JSON, then a closing \`\`\` on its own line. No other text before or after:
\`\`\`deploy-config
{...}
\`\`\`

Structure (example: wordpress + mysql, showing localhost rewrite):
{"name":"my-app","namespace":"default","instances":1,"exposure":{"type":"NodePort","ports":[80]},"containers":[{"name":"wordpress","image":"wordpress:latest","env":[{"name":"WORDPRESS_DB_HOST","value":"localhost:3306"},{"name":"WORDPRESS_DB_USER","value":"wordpress"},{"name":"WORDPRESS_DB_PASSWORD","value":"secret"}],"cpuReq":"100m","cpuLim":"500m","memReq":"128Mi","memLim":"512Mi","storage":null},{"name":"mysql","image":"mysql:8.0","env":[{"name":"MYSQL_ROOT_PASSWORD","value":"rootpassword"},{"name":"MYSQL_DATABASE","value":"wordpress"},{"name":"MYSQL_USER","value":"wordpress"},{"name":"MYSQL_PASSWORD","value":"secret"}],"cpuReq":"100m","cpuLim":"500m","memReq":"256Mi","memLim":"512Mi","storage":{"name":"mysql-data","size":"5Gi","mountPath":"/var/lib/mysql"}}],"warnings":[]}

Session: ${ctx}`,
            messages: [{ role: 'user', content: 'Translate:\n\n' + text }],
          }),
        })
        if (!response.ok) {
          let eb = {}
          try { eb = await response.json() } catch { /* ignore */ }
          const err = eb?.error
          const emsg = typeof err === 'string' ? err : err?.message || 'HTTP ' + response.status
          throw new Error(emsg)
        }
        const data = await response.json()
        const raw = (data.content || []).map((b) => b.text || '').join('')
        const m = raw.match(/```deploy-config[^\n`]*\n?([\s\S]*?)```/)
        if (m) {
          let cfg = null
          let parseErr = null
          try {
            cfg = JSON.parse(m[1].trim())
          } catch (e) {
            parseErr = e?.message || String(e)
            console.error('[AssistantPanel] compose deploy-config parse failed:', parseErr)
          }
          if (cfg) {
            const preview = buildDeployPreview(cfg)
            setRows((r) => [
              ...r,
              {
                id: newMsgId(),
                role: 'assistant',
                text: preview,
                isMd: true,
                actions: [
                  {
                    label: 'Open in Deploy form',
                    secondary: false,
                    onClick: () => {
                      // Route to first enabled deploy feature
                      const deployRoute = features.vibeDeploy
                        ? ROUTES.deployVibe
                        : features.simpleDeploy
                        ? ROUTES.deploy
                        : features.manifestBuilder
                        ? ROUTES.deployManifest
                        : ROUTES.dashboard
                      navigate(deployRoute, { state: { deployConfigFromAssistant: cfg } })
                    },
                  },
                  { label: 'Cancel', secondary: true, onClick: () => {} },
                ],
              },
            ])
            historyRef.current = [...historyRef.current, { role: 'assistant', content: raw }]
          } else {
            addError(`Compose translation returned invalid JSON (${parseErr}). Try pasting the Compose file again.`)
          }
        } else {
          addError('Could not parse the Compose file. Please check it and try again.')
        }
      } catch (e) {
        addError('Failed to translate Compose file: ' + (e?.message || 'Unknown'))
      } finally {
        setThinking(null)
        sendingRef.current = false
        setSending(false)
      }
      return
    }

    setThinking({ phase: 'analyse' })
    const ctx = buildAssistantContext(location.pathname)
    const lowerText = text.toLowerCase()
    const isScaleQ = /scale\s+[\w-]+\s+(?:(?:down|up)\s+to|to)\s+\d+/i.test(lowerText)
    const isHealthQ =
      !isScaleQ &&
      /(health|status|slow|broken|error|crash|fail|issue|problem|check|investigat|triage|log|metric|event)/i.test(
        lowerText,
      )

    let diagnosticData = ''
    const deps = visibleDeployments(useAppStore.getState())
    const segs = location.pathname.split('/').filter(Boolean)
    const fromRoute =
      segs[0] === 'applications' && segs.length >= 4
        ? deps.find(
            (d) =>
              d.metadata.name === segs[3] &&
              d.metadata.namespace === segs[2] &&
              String(d._envId) === String(segs[1]),
          )
        : null
    if (isHealthQ) {
      const targetDep =
        deps.find((d) => lowerText.includes(d.metadata.name.toLowerCase())) || fromRoute
      if (targetDep) {
        setThinking({ phase: 'fetch', name: targetDep.metadata.name })
        try {
          diagnosticData = await gatherServiceDiagnostics(token, targetDep)
        } catch {
          /* */
        }
        setThinking({ phase: 'analyse' })
      }
    }

    const diagnosticNote = diagnosticData
      ? 'LIVE DIAGNOSTIC DATA IS PROVIDED BELOW. You have direct access to the logs, events, and pod status. Analyse them and answer immediately. Do NOT say you lack access or ask the user to check anything themselves.'
      : ''
    const features = useAppStore.getState().features
    const vibeOnly = features.vibeDeploy && !features.simpleDeploy && !features.manifestBuilder

    const deployFeatures = [
      features.vibeDeploy      && '- Vibe Deploy: drop AI-generated source files (Node, Python, Ruby, PHP, static HTML) — runtime detected automatically, dependencies installed, deployed via GitOps. Best for apps from AI coding tools.',
      features.simpleDeploy    && '- Simple Deploy: a simplified form for single-service workloads (one or more containers sharing a pod). Good for stateless apps with a container image.',
      features.manifestBuilder && '- Manifest Builder: a guided form for any Kubernetes workload type — Deployments, StatefulSets, DaemonSets, CronJobs, Services, Ingresses, HPAs. Produces Kubernetes-native manifests committed to Git.',
      features.catalogue       && '- Catalogue: pre-built templates in three formats — Run (simple deploy), Kubernetes (native manifest), and Helm charts.',
    ].filter(Boolean).join('\n')

    const deployInstructions = vibeOnly
      ? `IMPORTANT RULES:
- If the user asks to deploy ANYTHING — an app, a service, wordpress, anything — do NOT attempt to generate a deployment config, search for docker-compose files, or suggest container images. Vibe Deploy is the only deployment method available on this instance.
- Instead, respond with this exact message: "To deploy an app here, use an AI coding tool (like Claude) to build your application, then go to **Vibe Deploy** and upload the generated files — Portainer Run handles the rest automatically."
- If the user asks what Vibe Deploy is or how it works, explain: it accepts source files (Node.js, Python, Ruby, PHP, or static HTML) generated by AI coding tools, detects the runtime automatically, installs dependencies, and deploys to Kubernetes via GitOps.
- If the user asks about scaling, health, logs, or status of existing services, answer normally.
- Never suggest using docker-compose, container images, or any other deployment method — they are not available.`
      : `IMPORTANT RULES:
- If the user asks to SCALE an existing service (e.g. "scale nginx to 3"), respond in plain English confirming what you will do. State clearly: "I'll scale [name] to [N] instances." Do NOT output a deploy-config block for scale requests.
- If the user asks to DEPLOY a NEW service that does not exist yet: FIRST use the web_search tool to find the vendor's official docker-compose.yml. Search priority order: (1) the vendor's own GitHub repo (e.g. "wordpress docker-compose.yml site:github.com/docker"), (2) Docker Hub official image page (e.g. "mysql docker hub official docker-compose"), (3) the vendor's official documentation. Use the REAL volumes, env vars, ports, and image tags from that official source — do NOT invent them from memory. After searching, output ONLY a deploy-config JSON block using this exact format — the code fence tag must be exactly \`\`\`deploy-config with no trailing text, followed immediately by a newline, then the JSON, then a closing \`\`\` on its own line. No prose before or after the fence. ALWAYS populate the env arrays with the correct environment variables for each container — never leave env as an empty array [] for containers that require configuration. Include ALL volumes defined in the official compose file. Example (WordPress + MySQL, two containers, env vars fully populated, localhost rewrite applied):
\`\`\`deploy-config
{"name":"wordpress","namespace":"default","instances":1,"exposure":{"type":"NodePort","ports":[80]},"containers":[{"name":"wordpress","image":"wordpress:latest","env":[{"name":"WORDPRESS_DB_HOST","value":"localhost:3306"},{"name":"WORDPRESS_DB_USER","value":"wordpress"},{"name":"WORDPRESS_DB_PASSWORD","value":"wordpress"},{"name":"WORDPRESS_DB_NAME","value":"wordpress"}],"cpuReq":"200m","cpuLim":"500m","memReq":"256Mi","memLim":"512Mi","storage":{"name":"wordpress-data","size":"5Gi","mountPath":"/var/www/html"}},{"name":"mysql","image":"mysql:8.0","env":[{"name":"MYSQL_ROOT_PASSWORD","value":"rootpassword"},{"name":"MYSQL_DATABASE","value":"wordpress"},{"name":"MYSQL_USER","value":"wordpress"},{"name":"MYSQL_PASSWORD","value":"wordpress"}],"cpuReq":"200m","cpuLim":"1000m","memReq":"512Mi","memLim":"1Gi","storage":{"name":"wordpress-mysql-data","size":"10Gi","mountPath":"/var/lib/mysql"}}],"warnings":["Default passwords used — change before production use"]}
\`\`\`
Use NodePort exposure by default unless the user specifies otherwise. All containers share the same network namespace — inter-container hostnames MUST be rewritten to localhost: "mysql" → "localhost", "redis" → "localhost:6379", "rabbitmq" → "localhost", etc. Each container must have its own env array with only its own variables — never merge env vars across containers.
- If LIVE DIAGNOSTIC DATA is provided above, you already have the logs, events, and pod status. Analyse them immediately and give a specific answer. NEVER ask the user to go check the logs or metrics themselves — you already have that data. NEVER output a JSON action plan. Just answer in plain English based on what you can see.
- Never use Kubernetes jargon. Say "instances" not "replicas", "stopped" not "CrashLoopBackOff", "restarting" not "CrashLoopBackOff".`

    const systemPrompt = `You are the built-in assistant for Portainer Run — a lightweight Internal Developer Portal (IDP) for Kubernetes, backed by Portainer. You help users deploy, manage, and troubleshoot containerised applications.

${diagnosticNote}

PORTAINER RUN OVERVIEW:
- All deployments go through GitOps. Portainer Run generates Kubernetes manifests, commits them to a user-configured Git target, and Portainer deploys via a GitOps stack that polls the repository for changes.
${deployFeatures}
- Git Targets: repositories where manifests are committed. Each deployment references its own Git target. Credentials stored encrypted server-side.
- Applications page: lists all deployments tagged managed-by=portainer-run. Shows status, replicas, exposure, and age.
- Editing a running application commits an updated manifest to Git — Portainer reconciles automatically on the next poll cycle.

SCOPE: Only answer questions about container operations, deployments, Kubernetes workloads, logs, metrics, application health, and Portainer Run features. Politely decline anything outside this scope.

Session context: ${ctx}${diagnosticData}

${deployInstructions}`

    const messages = diagnosticData
      ? historyRef.current.slice(-2)
      : historyRef.current.slice(-10)

    const assistantId = newMsgId()
    setRows((r) => [...r, { id: assistantId, role: 'assistant', text: '', stream: true, isMd: true }])
    setThinking(null)

    // Deploy requests use web search so the model can find official docker-compose files.
    // Not applicable in vibe-only mode — no deploy-config generation happens there.
    const isDeployRequest = !vibeOnly && !isScaleQ && !isHealthQ && !diagnosticData
    const toolsPayload = isDeployRequest
      ? [{ type: 'web_search_20250305', name: 'web_search' }]
      : undefined

    try {
      const response = await fetch('/ai/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: getAssistantModel(),
          max_tokens: isDeployRequest ? 4000 : 1500,
          stream: true,
          system: systemPrompt,
          messages,
          ...(toolsPayload ? { tools: toolsPayload } : {}),
        }),
      })
      if (!response.ok) {
        let eb = {}
        try {
          eb = await response.json()
        } catch {
          /* */
        }
        const err = eb?.error
        const emsg = typeof err === 'string' ? err : err?.message || 'HTTP ' + response.status
        throw new Error(emsg)
      }

      const fullText = await readTriageSseStream(response.body, (acc) => {
        setRows((r) =>
          r.map((row) =>
            row.id === assistantId
              ? { ...row, text: acc, isMd: true, stream: true }
              : row,
          ),
        )
      })

      // Lenient regex: optional whitespace after tag name, closing fence may have no preceding newline
      const deployMatch = !vibeOnly && fullText.match(/```deploy-config[^\n`]*\n?([\s\S]*?)```/)
      if (deployMatch) {
        let cfg = null
        let parseErr = null
        try {
          cfg = JSON.parse(deployMatch[1].trim())
        } catch (e) {
          parseErr = e?.message || String(e)
          console.error('[AssistantPanel] deploy-config parse failed:', parseErr, '\nRaw block:', deployMatch[1])
        }

        if (cfg) {
          const preview = buildDeployPreview(cfg)
          setRows((r) =>
            r.map((row) =>
              row.id === assistantId
                ? {
                    ...row,
                    text: preview,
                    isMd: true,
                    stream: false,
                    actions: [
                      {
                        label: 'Open in Deploy form',
                        secondary: false,
                        onClick: () =>
                          navigate(ROUTES.deploy, { state: { deployConfigFromAssistant: cfg } }),
                      },
                      { label: 'Cancel', secondary: true, onClick: () => {} },
                    ],
                  }
                : row,
            ),
          )
        } else {
          // Parse failed — strip the raw fence block from display so JSON never shows raw,
          // replace with a friendly inline error message
          const stripped = fullText
            .replace(/```deploy-config[^\n`]*\n?[\s\S]*?```/, '')
            .trim()
          const displayText =
            (stripped ? stripped + '\n\n' : '') +
            `⚠ Could not parse the deployment config (${parseErr}). Try rephrasing your request.`
          setRows((r) =>
            r.map((row) =>
              row.id === assistantId
                ? { ...row, text: displayText, isMd: true, stream: false }
                : row,
            ),
          )
        }
      } else {
        const scale = parseScaleAction(fullText)
        setRows((r) =>
          r.map((row) =>
            row.id === assistantId
              ? {
                  ...row,
                  text: fullText,
                  isMd: true,
                  stream: false,
                  actions: scale
                    ? [
                        {
                          label: `Open Edit tab for ${scale.serviceName}`,
                          secondary: false,
                          onClick: () => {
                            navigate(
                              serviceDetailPath(
                                scale.envId,
                                scale.namespace,
                                scale.serviceName,
                                'edit',
                              ),
                              { state: { assistantPrefillInstances: scale.instances } },
                            )
                            setRows((x) => [
                              ...x,
                              {
                                id: newMsgId(),
                                role: 'assistant',
                                text: `Opened the Edit tab for **${scale.serviceName}**. Instances set to **${scale.instances}**. Save when ready.`,
                                isMd: true,
                              },
                            ])
                          },
                        },
                      ]
                    : undefined,
                }
              : row,
          ),
        )
      }
      historyRef.current = [...historyRef.current, { role: 'assistant', content: fullText }]
    } catch (e) {
      setRows((r) =>
        r.map((row) =>
          row.id === assistantId
            ? { ...row, text: 'Sorry, I ran into an error: ' + (e?.message || 'Unknown') }
            : row,
        ),
      )
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [addError, addUser, input, location.pathname, navigate, token])

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendChat()
    }
  }

  if (!open) return null

  return (
    <div className="chat-panel open" role="complementary" aria-label="Assistant">
      <div className="chat-header">
        <span className="chat-title">Assistant</span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onClose}
          title="Close panel"
        >
          Close
        </button>
      </div>
      <div className="chat-input-wrap">
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={4}
          placeholder={PLACEHOLDER}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          style={{ alignSelf: 'flex-end' }}
          onClick={() => void sendChat()}
          disabled={sending || !input.trim()}
        >
          Send
        </button>
      </div>
      <div className="chat-messages" ref={scrollRef}>
        {rows.length === 0 && !thinking && (
          <div className="chat-empty">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              style={{ opacity: 0.3, marginBottom: 8 }}
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-dim)',
                lineHeight: 1.6,
                textAlign: 'center',
              }}
            >
              Ask about your services or describe what you want to deploy.
            </div>
          </div>
        )}
        {rows.map((row) => {
          if (row.role === 'user') {
            return (
              <div key={row.id} className="chat-msg">
                <div className="chat-msg-user">{String(row.userDisplay ?? row.text ?? '')}</div>
              </div>
            )
          }
          return (
            <div key={row.id} className="chat-msg">
              <div className="chat-msg-assistant">
                {row.isMd ? (
                  <div
                    style={{ minHeight: 8 }}
                    dangerouslySetInnerHTML={{ __html: mdToHtml(row.text || (row.stream ? '…' : '—')) }}
                  />
                ) : (
                  <span style={{ whiteSpace: 'pre-wrap' }}>{row.text}</span>
                )}
                {row.actions && row.actions.length > 0 ? (
                  <div
                    className="chat-action-row"
                    style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}
                  >
                    {row.actions.map((a) => (
                      <button
                        type="button"
                        key={a.label}
                        className={'chat-action-btn' + (a.secondary ? ' secondary' : '')}
                        onClick={a.onClick}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
        {thinking && (
          <div className="chat-msg" style={{ alignSelf: 'flex-start' }}>
            <div className="chat-thinking">
              <div className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} />
              {thinking.phase === 'fetch'
                ? 'Fetching diagnostics for ' + (thinking.name || 'application') + '...'
                : 'Analysing...'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
