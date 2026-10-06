export const GITHUB_LINK = 'https://github.com/ayangweb/BongoCat'

export const LISTEN_KEY = {
  SHOW_WINDOW: 'show-window',
  HIDE_WINDOW: 'hide-window',
  DEVICE_CHANGED: 'device-changed',
  GAMEPAD_CHANGED: 'gamepad-changed',
  START_MOTION: 'start-motion',
  SET_EXPRESSION: 'set-expression',
  AI_KEY_CHANGED: 'ai-key-changed',
  OPEN_PREFERENCE_TAB: 'open-preference-tab',
}

export const INVOKE_KEY = {
  COPY_DIR: 'copy_dir',
  START_DEVICE_LISTENING: 'start_device_listening',
  START_GAMEPAD_LISTING: 'start_gamepad_listing',
  STOP_GAMEPAD_LISTING: 'stop_gamepad_listing',
  SET_AI_KEY: 'set_ai_key',
  GET_AI_KEY: 'get_ai_key',
  GET_AI_KEY_STATUS: 'get_ai_key_status',
  CLEAR_AI_KEY: 'clear_ai_key',
}

export const LANGUAGE = {
  ZH_CN: 'zh-CN',
  ZH_TW: 'zh-TW',
  EN_US: 'en-US',
  VI_VN: 'vi-VN',
  PT_BR: 'pt-BR',
} as const

export const WINDOW_LABEL = {
  MAIN: 'main',
  PREFERENCE: 'preference',
  CHAT: 'chat',
} as const
