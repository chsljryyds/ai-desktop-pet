// Local OpenAI-compatible mock used for manual / self-test verification of the AI chat flow.
// Usage: node scripts/mock-openai-server.mjs [port]
// The behaviour is selected by the `model` field so every error path can be reproduced
// without a real provider, real credentials or real cost.
import { createServer } from 'node:http'
import { argv, env } from 'node:process'

const port = Number(argv[2] ?? env.MOCK_PORT ?? 18080)
const expectedKey = env.MOCK_KEY ?? 'sk-mock-local-key-0000'
const requests = []

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function completion(content, finishReason = 'stop') {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
  }
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__requests') return send(res, 200, requests)

  if (req.method === 'DELETE' && req.url === '/__requests') {
    requests.length = 0

    return send(res, 200, { ok: true })
  }

  let raw = ''

  req.on('data', chunk => raw += chunk)

  req.on('end', async () => {
    let body = {}

    try {
      body = JSON.parse(raw)
    } catch {}

    const auth = req.headers.authorization ?? ''

    requests.push({
      at: new Date().toISOString(),
      url: req.url,
      model: body.model,
      stream: body.stream,
      messages: body.messages,
      keyMatches: auth === `Bearer ${expectedKey}`,
    })

    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      return send(res, 404, { error: { message: 'Not found' } })
    }

    if (auth !== `Bearer ${expectedKey}`) {
      return send(res, 401, { error: { message: `Incorrect API key provided: ${auth.slice(7)}`, type: 'invalid_request_error' } })
    }

    const messages = Array.isArray(body.messages) ? body.messages : []
    const lastUser = [...messages].reverse().find(item => item.role === 'user')?.content ?? ''

    switch (body.model) {
      case 'mock-slow':
        await new Promise(resolve => setTimeout(resolve, 8000))

        return send(res, 200, completion(`慢回复：${lastUser}`))
      case 'mock-404':
        return send(res, 404, { error: { message: 'The model does not exist' } })
      case 'mock-429':
        return send(res, 429, { error: { message: `Rate limit reached for key ${expectedKey}`, type: 'rate_limit' } })
      case 'mock-500':
        return send(res, 500, { error: { message: 'Internal server error' } })
      case 'mock-html':
        return send(res, 200, '<html><body>gateway</body></html>', 'text/html')
      case 'mock-badjson':
        return send(res, 200, '{"choices": [')
      case 'mock-nochoices':
        return send(res, 200, { id: 'x', object: 'chat.completion' })
      case 'mock-length':
        return send(res, 200, completion('被截断的回复', 'length'))
      case 'mock-context':
        return send(res, 400, { error: { message: 'This model\'s maximum context length is 8192 tokens', code: 'context_length_exceeded' } })
      case 'mock-redirect':
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/v1/chat/completions` })

        return res.end()
      default:
        return send(res, 200, completion(`收到：${lastUser}（本次请求共 ${messages.length} 条消息）`))
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock openai server listening on http://127.0.0.1:${port}/v1`)
})
