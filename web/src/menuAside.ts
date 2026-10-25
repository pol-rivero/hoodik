import {
  mdiMonitor,
  mdiShareVariantOutline,
  mdiFileDocumentOutline,
  mdiTrashCanOutline
} from '@mdi/js'
import type { RouteLocation } from 'vue-router'
import { i18n } from '@/i18n'

export interface AsideMenuItemType {
  to: RouteLocation
  icon: string
  label: string
  roles?: string[]
  expandable?: boolean
}

export default [
  {
    to: { name: 'files' },
    icon: mdiMonitor,
    label: i18n.global.t('nav.menu.files'),
    expandable: true
  },
  {
    to: { name: 'notes' },
    icon: mdiFileDocumentOutline,
    label: i18n.global.t('nav.menu.notes')
  },
  {
    to: { name: 'trash' },
    icon: mdiTrashCanOutline,
    label: i18n.global.t('nav.menu.trash')
  },
  {
    to: { name: 'share' },
    icon: mdiShareVariantOutline,
    label: i18n.global.t('nav.menu.share')
  }
] as AsideMenuItemType[]
