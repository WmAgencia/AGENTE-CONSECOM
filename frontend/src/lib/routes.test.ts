import { describe, expect, test } from 'vitest'
import { resolveTabFromPath, resolveMemoryTabFromPath, TAB_PATHS } from './routes'

describe('rotas da aplicação', () => {
  test('cada tela tem uma rota real', () => {
    expect(TAB_PATHS.kanban).toBe('/kanban')
    expect(TAB_PATHS.ia).toBe('/central-ia')
  })

  test('raiz resolve para a aba padrão', () => {
    expect(resolveTabFromPath('/')).toBe('kanban')
  })

  test('pathname da sub-rota herda a aba do pai', () => {
    expect(resolveTabFromPath('/central-ia/memoria/aprendizados')).toBe('ia')
    expect(resolveTabFromPath('/central-ia/memoria/conversas')).toBe('ia')
  })

  test('pathname desconhecido vira null', () => {
    expect(resolveTabFromPath('/nao-existe')).toBe(null)
  })

  test('sub-abas da memória são resolvidas pela URL', () => {
    expect(resolveMemoryTabFromPath('/central-ia/memoria')).toBe('lotes')
    expect(resolveMemoryTabFromPath('/central-ia/memoria/lotes')).toBe('lotes')
    expect(resolveMemoryTabFromPath('/central-ia/memoria/conversas')).toBe('conversas')
    expect(resolveMemoryTabFromPath('/central-ia/memoria/aprendizados')).toBe('aprendizados')
  })
})
