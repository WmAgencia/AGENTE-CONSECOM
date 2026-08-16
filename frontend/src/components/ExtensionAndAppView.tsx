import { ExtensionView } from './ExtensionView'
import { MobileAppView } from './MobileAppView'

/** Guia "Extensão e app" — junta extensão Chrome e app mobile num só lugar. */
export function ExtensionAndAppView() {
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-8">
        <div>
          <h1 className="text-xl font-semibold mb-1">Extensão e app</h1>
          <p className="text-sm text-muted">
            Baixe a extensão Chrome do Vyntra e o aplicativo mobile — tudo pronto para a sua conta.
          </p>
        </div>
        <ExtensionView />
        <MobileAppView />
      </div>
    </div>
  )
}
