import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.consecom.mobile',
  appName: 'Vyntra Mobile',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    backgroundColor: '#0a0a0f',
  },
}

export default config
