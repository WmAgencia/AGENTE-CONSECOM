# Consecom Alex — App mobile (Android)

App Android nativo (Capacitor) que acompanha a operação do painel: reuniões,
alarmes locais, notificações de eventos e status da operação.

## Como funciona

- **Mesmo backend e banco** do painel web: Supabase (auth, RLS, REST, realtime).
  Nenhum serviço novo. Nada de push externo — as notificações de eventos usam o
  **Supabase Realtime** já habilitado na publicação `supabase_realtime`.
- **Alarme de reunião** é **local** (AlarmManager nativo via
  `@capacitor/local-notifications`): agenda com `setExactAndAllowWhileIdle`
  (quando a permissão de alarme exato existe), cria canal dedicado de reuniões
  e **restaura os alarmes após reboot** (receiver `BOOT_COMPLETED` do plugin).
  Funciona com o app fechado e sem internet.
- **Auto-login via deep-link**: o usuário logado no painel toca em
  "Conectar neste aparelho" → o site abre `consecom://auth?access_token=...&refresh_token=...`
  → o app troca o link por sessão permanente e entra sem pedir senha.
- **Sync de reuniões → alarmes**: motor puro (`src/core/syncEngine.ts`) decide
  criar/alterar/cancelar/reagendar alarmes com ID determinístico por lead
  (não duplica). Roda ao abrir, ao voltar do background, em realtime e a cada
  60s (fallback offline).

## Estrutura

```
mobile/
  src/
    core/syncEngine.ts        motor de sincronização (puro, testável)
    lib/supabase.ts           client Supabase (sessão em Capacitor Preferences)
    lib/deeplink.ts           auto-login via consecom://auth
    lib/types.ts              tipos + preferências locais (alarmes/notificações)
    services/alarms.ts        Local Notifications (canais, permissões, sync)
    services/realtime.ts      Realtime -> notificações configuráveis
    services/data.ts          consultas REST do painel
    screens/                  Hoje, Reuniões, Meus alarmes, Notificações, Ajustes, Connect
  tests/syncEngine.test.ts    Vitest (15 testes)
  android/                    projeto nativo (gera o APK)
```

## Desenvolvimento

```bash
cd mobile
cp .env.example .env.local   # preencha VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY
npm install
npm run dev                  # dev web (Capacitor roda dentro do app Android)
npm run test                 # testes do motor de sync
npm run build                # build web (tsc + vite)
npx cap sync android         # copia dist + plugins para android/
```

Pré-requisitos de build (uma vez por máquina):
- **JDK 21** (Capacitor 8 exige Java 21)
- **Android SDK** com `platforms;android-36` e `build-tools;36.0.0`
  (compileSdk/targetSdk = 36)
- `ANDROID_HOME` e `JAVA_HOME` definidos; `android/local.properties` aponta o SDK

## Gerar o APK

### Debug (teste/instalação direta)

```bash
cd mobile/android
.\gradlew.bat assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

### Release (assinado — distribuição)

1. Gere o keystore uma única vez e guarde em local seguro (fora do git):

```bash
keytool -genkeypair -v -keystore consecom-release.keystore -alias consecom \
  -keyalg RSA -keysize 2048 -validity 10000
```

2. Crie `mobile/android/keystore.properties` (nunca commitar):

```properties
storeFile=..\\consecom-release.keystore
storePassword=SUA_SENHA
keyAlias=consecom
keyPassword=SUA_SENHA
```

3. Gere o APK assinado:

```bash
cd mobile/android
.\gradlew.bat assembleRelease
# APK: android/app/build/outputs/apk/release/app-release.apk
```

## Publicar atualização

1. Bump em `mobile/package.json` (versão) e `mobile/android/app/build.gradle`
   (`versionCode`/`versionName`).
2. `npm run build && npx cap sync android`
3. `.\gradlew.bat assembleRelease` (ou debug para teste).
4. Copie o APK para `frontend/public/apk/consecom-alex-<versão>.apk`.
5. Atualize `APK_URL` em `frontend/src/components/MobileAppView.tsx`.
6. Commit + push (backend deploys automático na Railway; frontend via
   `vercel --prod --yes --project frontend`).

> O usuário baixa o APK pela aba "App mobile" do painel (login obrigatório) e
> conecta o aparelho com um clique — sem digitar credenciais no app.

## Testes cobridos (Vitest)

- Criação de alarme com antecedência padrão e override por lead
- ID determinístico (sem duplicação) e dupla sincronização (unchanged)
- Reagendamento ao mudar horário (mesmo id, novo fireAt)
- Cancelamento ao sair de `reuniao_marcada` / lead removido
- Antecedência já passada (permissão negada/offline) → não agenda no passado
- `meeting_at` inválido e reunião no passado não quebram o sync
- Formatação do texto da notificação e timezone (ISO → horário local)
