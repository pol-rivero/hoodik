import { describe, it, expect, afterEach } from 'vitest'
import { i18n, setLocale, detectLocale, translateErrorCode } from '../src/i18n'
import { localeKey } from '../src/config'
import { formatRelative, formatSize } from '../services'
import en from '../src/locales/en.json'
import fr from '../src/locales/fr.json'
import de from '../src/locales/de.json'
import hr from '../src/locales/hr.json'

afterEach(() => {
  localStorage.removeItem(localeKey)
  i18n.global.locale.value = 'en'
})

describe('locale detection', () => {
  it('falls back to english when nothing is stored', () => {
    expect(detectLocale()).toBe('en')
  })

  it('prefers the stored locale over the browser language', () => {
    localStorage[localeKey] = 'hr'
    expect(detectLocale()).toBe('hr')
  })

  it('ignores stored values outside the supported set', () => {
    localStorage[localeKey] = 'xx'
    expect(detectLocale()).toBe('en')
  })

  it('persists the choice and switches the active locale', () => {
    setLocale('de')
    expect(localStorage[localeKey]).toBe('de')
    expect(i18n.global.locale.value).toBe('de')
  })
})

describe('server error codes', () => {
  it('translates known codes', () => {
    expect(translateErrorCode('quota_exceeded')).toBe(
      'Storage quota exceeded. Items in Trash still count toward it.'
    )
  })

  it('keeps the detail suffix of composite codes', () => {
    expect(translateErrorCode('invalid_id_provided_while_extracting:user')).toBe(
      'Invalid id provided (user)'
    )
  })

  it('returns unknown codes verbatim instead of hiding them', () => {
    expect(translateErrorCode('some_new_backend_code')).toBe('some_new_backend_code')
  })

  it('falls back to a generic message when there is no code', () => {
    expect(translateErrorCode(undefined)).toBe('Something went wrong')
  })
})

describe('croatian plural forms', () => {
  it('resolves singular, paucal and plural correctly', () => {
    setLocale('hr')
    const t = i18n.global.t
    expect(t('shares.groups.memberCount', 1)).toBe('1 član')
    expect(t('shares.groups.memberCount', 3)).toBe('3 člana')
    expect(t('shares.groups.memberCount', 5)).toBe('5 članova')
    expect(t('shares.groups.memberCount', 11)).toBe('11 članova')
    expect(t('shares.groups.memberCount', 21)).toBe('21 član')
  })
})

describe('trash strings', () => {
  const TRASH_KEYS = [
    'nav.menu.trash',
    'nav.title.trash',
    'trash.title',
    'trash.emptyState',
    'trash.columns.deleted',
    'trash.columns.expires',
    'trash.expiresIn',
    'trash.expiresToday',
    'trash.actions.restore',
    'trash.actions.deleteForever',
    'trash.actions.empty',
    'trash.confirm.deleteForeverTitle',
    'trash.confirm.deleteForever',
    'trash.confirm.deleteForeverMany',
    'trash.confirm.emptyTitle',
    'trash.confirm.empty',
    'trash.notify.restoredTitle',
    'trash.notify.restored',
    'trash.notify.relocated',
    'trash.notify.conflictTitle',
    'trash.notify.conflict',
    'trash.notify.missing',
    'trash.notify.relocatedMany',
    'trash.expiresLine',
    'files.delete.trashTitle',
    'files.delete.trashLabel',
    'files.delete.trashFile',
    'files.delete.trashDirectory',
    'files.delete.trashMany',
    'files.delete.sharedNote',
    'files.delete.movedTitle',
    'preview.markdown.trashConfirm',
    'admin.settings.trash',
    'admin.settings.trashRetention',
    'admin.settings.trashRetentionHint',
    'admin.settings.trashRetentionInvalid',
    'errors.restoreFailed',
    'errors.purgeFailed'
  ]

  const REMOVED_KEYS = [
    'files.delete.confirmFile',
    'files.delete.confirmDirectory',
    'files.delete.confirmLabel',
    'files.delete.confirmMany',
    'files.delete.confirmManyFolders',
    'files.delete.typeName',
    'files.delete.typeCount',
    'files.delete.selectedTitle',
    'preview.markdown.deleteConfirm',
    'preview.markdown.deleteTitle',
    'files.stats.inTrash'
  ]

  function lookup(messages: unknown, path: string): unknown {
    return path
      .split('.')
      .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], messages)
  }

  it.each(Object.entries({ en, fr, de, hr }))('%s has every trash key', (_, messages) => {
    for (const key of TRASH_KEYS) {
      expect(typeof lookup(messages, key), key).toBe('string')
    }
    for (const key of REMOVED_KEYS) {
      expect(lookup(messages, key), key).toBeUndefined()
    }
  })

  it('pluralizes the trash counters in croatian', () => {
    setLocale('hr')
    const t = i18n.global.t
    expect(t('trash.expiresIn', 1)).toBe('za 1 dan')
    expect(t('trash.expiresIn', 3)).toBe('za 3 dana')
    expect(t('trash.expiresIn', 5)).toBe('za 5 dana')
    expect(t('trash.expiresIn', 11)).toBe('za 11 dana')
    expect(t('trash.notify.restored', 1)).toBe('Vraćena 1 stavka')
    expect(t('trash.notify.restored', 3)).toBe('Vraćene 3 stavke')
    expect(t('trash.notify.restored', 5)).toBe('Vraćeno 5 stavki')
    expect(t('trash.notify.restored', 11)).toBe('Vraćeno 11 stavki')
    expect(t('trash.notify.missing', 1)).toBe(
      '1 stavku više nije moguće vratiti. Već je vraćena ili trajno obrisana.'
    )
    expect(t('trash.notify.missing', 3)).toContain('3 stavke')
    expect(t('trash.notify.missing', 5)).toContain('5 stavki')
  })

  it('pluralizes the trash counters in english', () => {
    const t = i18n.global.t
    expect(t('trash.expiresIn', 1)).toBe('in 1 day')
    expect(t('trash.expiresIn', 30)).toBe('in 30 days')
    expect(t('files.delete.trashMany', { count: 1 }, 1)).toBe(
      'Move 1 item to trash? You can restore it from Trash.'
    )
    expect(t('files.delete.trashMany', { count: 4 }, 4)).toBe(
      'Move 4 items to trash? You can restore them from Trash.'
    )
  })

  it('mentions the trash in the quota error in every locale', () => {
    expect(lookup(en, 'errors.quota_exceeded')).toContain('Trash')
    expect(lookup(fr, 'errors.quota_exceeded')).toContain('corbeille')
    expect(lookup(de, 'errors.quota_exceeded')).toContain('Papierkorb')
    expect(lookup(hr, 'errors.quota_exceeded')).toContain('smeću')
  })
})

describe('locale aware formatting', () => {
  it('formats relative time in the active locale', () => {
    const now = 1700000000
    expect(formatRelative(now - 30, now)).toBe('just now')
    expect(formatRelative(now - 120, now)).toBe('2 minutes ago')

    setLocale('fr')
    expect(formatRelative(now - 120, now)).toBe('il y a 2 minutes')

    setLocale('de')
    expect(formatRelative(now - 3600 * 5, now)).toBe('vor 5 Stunden')
  })

  it('formats sizes with the locale decimal separator', () => {
    expect(formatSize(1536)).toBe('1.50 KB')
    expect(formatSize(200 * 1024 ** 3)).toBe('200 GB')
    expect(formatSize(512)).toBe('512 B')

    setLocale('hr')
    expect(formatSize(1536)).toBe('1,50 KB')
  })
})
