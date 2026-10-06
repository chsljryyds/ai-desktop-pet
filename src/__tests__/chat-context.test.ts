import { describe, expect, it } from 'vitest'

import type { ChatMessage, MessageStatus } from '@/types/chat'

import { buildContext } from '@/utils/chat'

let seq = 0

function message(turnId: string, role: ChatMessage['role'], content: string, status: MessageStatus = 'complete'): ChatMessage {
  return { id: `m${seq++}`, petId: 'p', conversationId: 'c', turnId, role, content, status, createdAt: '' }
}

function round(turnId: string, question: string, answer: string) {
  return [message(turnId, 'user', question), message(turnId, 'assistant', answer)]
}

// U03 上下文组装
describe('buildContext', () => {
  it('puts the personality first, then ordered rounds, then the current question once', () => {
    const messages = [
      ...round('t1', 'q1', 'a1'),
      ...round('t2', 'q2', 'a2'),
      message('t3', 'user', 'q3', 'pending'),
    ]

    expect(buildContext({ systemPrompt: 'SYS', messages, currentTurnId: 't3', maxRounds: 10 })).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
    ])
  })

  it('excludes failed, cancelled and pending turns', () => {
    const messages = [
      ...round('t1', 'q1', 'a1'),
      message('t2', 'user', 'failed q', 'failed'),
      message('t3', 'user', 'cancelled q', 'cancelled'),
      message('t4', 'user', 'pending q', 'pending'),
      message('t5', 'user', 'now', 'pending'),
    ]

    const contents = buildContext({ systemPrompt: 'SYS', messages, currentTurnId: 't5', maxRounds: 10 }).map(item => item.content)

    expect(contents).toEqual(['SYS', 'q1', 'a1', 'now'])
  })

  it('keeps only the last N complete rounds without breaking pairs', () => {
    const messages = [
      ...round('t1', 'q1', 'a1'),
      ...round('t2', 'q2', 'a2'),
      ...round('t3', 'q3', 'a3'),
      message('t4', 'user', 'q4', 'pending'),
    ]

    const result = buildContext({ systemPrompt: 'SYS', messages, currentTurnId: 't4', maxRounds: 2 })

    expect(result.map(item => item.content)).toEqual(['SYS', 'q2', 'a2', 'q3', 'a3', 'q4'])
    expect(result.slice(1, -1).map(item => item.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('drops a user message whose assistant reply is missing', () => {
    const messages = [
      message('t1', 'user', 'orphan'),
      ...round('t2', 'q2', 'a2'),
      message('t3', 'user', 'q3', 'pending'),
    ]

    expect(buildContext({ systemPrompt: '', messages, currentTurnId: 't3', maxRounds: 10 }).map(item => item.content)).toEqual(['q2', 'a2', 'q3'])
  })

  it('a retried turn is sent once even if it was previously failed', () => {
    const messages = [...round('t1', 'q1', 'a1'), message('t2', 'user', 'retry me', 'pending')]

    const result = buildContext({ systemPrompt: 'SYS', messages, currentTurnId: 't2', maxRounds: 10 })

    expect(result.filter(item => item.content === 'retry me')).toHaveLength(1)
  })

  it('maxRounds 0 sends only the system prompt and the question', () => {
    const messages = [...round('t1', 'q1', 'a1'), message('t2', 'user', 'q2', 'pending')]

    expect(buildContext({ systemPrompt: 'SYS', messages, currentTurnId: 't2', maxRounds: 0 }).map(item => item.content)).toEqual(['SYS', 'q2'])
  })
})
