import { Preferences } from '@capacitor/preferences'
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anonKey) {
  throw new Error(
    'Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in mobile/.env.local',
  )
}

// Storage adapter: sessions persist in Capacitor Preferences (nativo, não no
// localStorage da WebView). Permite auto-login permanente e offline.
const capacitorStorage = {
  getItem: async (key: string) => (await Preferences.get({ key })).value,
  setItem: async (key: string, value: string) => {
    await Preferences.set({ key, value })
  },
  removeItem: async (key: string) => {
    await Preferences.remove({ key })
  },
}

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: capacitorStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})
