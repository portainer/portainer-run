/**
 * Extract incremental text from /ai/triage SSE (Anthropic native or OpenAI-wrapped to same shapes).
 * @param {string} line
 * @returns {string}
 */
function textFromSseDataLine(line) {
  if (!line.startsWith('data: ')) return ''
  const data = line.slice(6).trim()
  if (!data || data === '[DONE]') return ''
  let evt
  try {
    evt = JSON.parse(data)
  } catch {
    return ''
  }
  if (
    evt.type === 'content_block_delta' &&
    evt.delta?.type === 'text_delta' &&
    evt.delta.text
  ) {
    return evt.delta.text
  }
  return ''
}

/**
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {(chunk: string) => void} [onDelta]
 * @returns {Promise<string>}
 */
export async function readTriageSseStream(body, onDelta) {
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const piece = textFromSseDataLine(line)
      if (piece) {
        full += piece
        onDelta?.(full)
      }
    }
  }
  for (const line of (buf || '').split('\n')) {
    const piece = textFromSseDataLine(line)
    if (piece) {
      full += piece
      onDelta?.(full)
    }
  }
  return full
}
