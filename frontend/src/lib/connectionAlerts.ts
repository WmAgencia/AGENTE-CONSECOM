import { supabase, type WhatsAppConnection } from './supabase'

// Configuração centralizada de áudios por conexão (ID -> URL do áudio).
// Preencha os caminhos quando os arquivos forem fornecidos.
const DEFAULT_AUDIO_MAP: Record<string, string> = {}

let audioMap: Record<string, string> = { ...DEFAULT_AUDIO_MAP }
const announced = new Set<string>()

export function setConnectionAudioMap(map: Record<string, string>) {
  audioMap = { ...DEFAULT_AUDIO_MAP, ...map }
}

export function getConnectionAudioMap() {
  return audioMap
}

function playAudioForConnection(connection: WhatsAppConnection) {
  const url = audioMap[connection.id] ?? audioMap[connection.instance_name]
  if (!url) return
  try {
    const audio = new Audio(url)
    void audio.play().catch(() => {})
  } catch {
    // ignore
  }
}

export function announceConnectionDown(connection: WhatsAppConnection) {
  if (announced.has(connection.id)) return
  announced.add(connection.id)
  playAudioForConnection(connection)
}

export function clearAnnounced(connectionId: string) {
  announced.delete(connectionId)
}

/** Assina mudanças de status das conexões e dispara alertas sonoros quando uma cai (connected -> outro). */
export function subscribeConnectionAlerts(getConnections: () => WhatsAppConnection[]) {
  const previous = new Map<string, string>()
  // inicializa estado atual
  for (const c of getConnections()) previous.set(c.id, c.status)

  const channel = supabase
    .channel('connection-alerts')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_connections' }, () => {
      const current = getConnections()
      for (const conn of current) {
        const prev = previous.get(conn.id)
        if (prev === 'connected' && conn.status !== 'connected') {
          announceConnectionDown(conn)
        }
        if (prev && prev !== 'connected' && conn.status === 'connected') {
          clearAnnounced(conn.id)
        }
        previous.set(conn.id, conn.status)
      }
    })
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}