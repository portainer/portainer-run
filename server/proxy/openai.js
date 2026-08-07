import https from 'node:https'
import { CORS } from '../lib/cors.js'
import { openaiKey, openaiModel } from '../settings.js'

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Buffer} body
 */
export function proxyToOpenAI(req, res, body) {
  if (!openaiKey()) {
    res.writeHead(503, { 'Content-Type': 'application/json', ...CORS })
    res.end(
      JSON.stringify({ error: 'OPENAI_API_KEY not configured on server' }),
    )
    return
  }
  let payload
  try {
    payload = JSON.parse(body.toString())
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const messages = []
  if (payload.system) messages.push({ role: 'system', content: payload.system })
  for (const m of payload.messages || [])
    messages.push({ role: m.role, content: m.content })

  const openaiPayload = {
    model: openaiModel(),
    max_tokens: payload.max_tokens || 1000,
    stream: !!payload.stream,
    messages,
  }

  const outBody = Buffer.from(JSON.stringify(openaiPayload))
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + openaiKey(),
    'Content-Length': outBody.length,
  }

  const upstream = https.request(
    {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers,
      port: 443,
    },
    (upRes) => {
      if (!openaiPayload.stream) {
        const chunks = []
        upRes.on('data', (c) => chunks.push(c))
        upRes.on('end', () => {
          try {
            const oai = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const text =
              oai.choices &&
              oai.choices[0] &&
              oai.choices[0].message &&
              oai.choices[0].message.content
                ? oai.choices[0].message.content
                : ''
            const anthropicResp = {
              id: oai.id || 'msg_openai',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text }],
              model: openaiModel(),
              stop_reason: 'end_turn',
              usage: {
                input_tokens: (oai.usage && oai.usage.prompt_tokens) || 0,
                output_tokens: (oai.usage && oai.usage.completion_tokens) || 0,
              },
            }
            const respBody = Buffer.from(JSON.stringify(anthropicResp))
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Content-Length': respBody.length,
              ...CORS,
            })
            res.end(respBody)
          } catch {
            if (!res.headersSent) {
              res.writeHead(502, {
                'Content-Type': 'application/json',
                ...CORS,
              })
              res.end(
                JSON.stringify({ error: 'Failed to parse OpenAI response' }),
              )
            }
          }
        })
        return
      }
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...CORS,
        })
      }
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_openai","type":"message","role":"assistant","content":[],"model":"' +
          openaiModel() +
          '"}}\n\n',
      )
      res.write(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      )
      let buffer = ''
      upRes.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            res.write(
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            )
            res.write(
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
            )
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
            return
          }
          try {
            const parsed = JSON.parse(data)
            const text =
              parsed.choices &&
              parsed.choices[0] &&
              parsed.choices[0].delta &&
              parsed.choices[0].delta.content
            if (text) {
              const evt = JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
              })
              res.write('event: content_block_delta\ndata: ' + evt + '\n\n')
            }
          } catch {
            // ignore
          }
        }
      })
      upRes.on('end', () => {
        try {
          res.end()
        } catch {
          // ignore
        }
      })
    },
  )
  upstream.on('error', (e) => {
    console.error('[openai proxy error]', e.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS })
      res.end(JSON.stringify({ error: e.message }))
    }
  })
  upstream.write(outBody)
  upstream.end()
}
