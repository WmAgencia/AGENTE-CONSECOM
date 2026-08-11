import { registerPlugin, Capacitor } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'

// =====================================================================
// Bridge para o módulo nativo VyntraMic (mensagem de voz real).
//   - MediaRecorder (arquivo .m4a real) + SpeechRecognizer em paralelo
//   - Permissão RECORD_AUDIO tratada no nativo
//   - Eventos: `transcript` (texto parcial/final) e `micerror`
// =====================================================================

export interface MicRecordingResult {
  uri: string
  durationMs: number
  size: number
  text: string
  tooShort?: boolean
}

export interface MicTranscript {
  text: string
  isFinal: boolean
}

export interface MicError {
  message: string
}

export interface VyntraMicPlugin {
  checkPermissions(): Promise<{ granted: boolean; permanentDenied: boolean }>
  requestPermissions(): Promise<{ granted: boolean }>
  startRecording(): Promise<void>
  stopRecording(): Promise<MicRecordingResult>
  cancelRecording(): Promise<void>
  isRecording(): Promise<{ recording: boolean }>
  addListener(
    eventName: 'transcript',
    handler: (info: MicTranscript) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'micerror',
    handler: (info: MicError) => void,
  ): Promise<PluginListenerHandle>
}

export const VyntraMic = registerPlugin<VyntraMicPlugin>('VyntraMic')

/** true se estamos rodando dentro do Android nativo (não no browser). */
export function isMicNativeAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}
