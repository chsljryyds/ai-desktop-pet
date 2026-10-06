import type { AIErrorInfo } from '@/types/ai'

type Translate = (key: string, params?: Record<string, unknown>) => string

export function formatAIError(info: AIErrorInfo, t: Translate) {
  if (info.kind === 'network') {
    const cause = info.detail ?? 'connect'

    return t('utils.ai.errors.network', { cause: t(`utils.ai.networkCauses.${cause}`) })
  }

  const text = t(`utils.ai.errors.${info.kind}`, { status: info.status ?? '-' })

  if (!info.detail) return text

  return t('utils.ai.withDetail', { message: text, detail: info.detail })
}
