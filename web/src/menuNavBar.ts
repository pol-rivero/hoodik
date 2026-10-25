import {
  mdiAccountCircle,
  mdiCog,
  mdiHelpCircleOutline,
  mdiHuman,
  mdiHumanMaleFemale,
  mdiLock,
  mdiLogout,
  mdiThemeLightDark
} from '@mdi/js'
import type { RouteLocation } from 'vue-router'
import { i18n } from '@/i18n'

export interface NavBarItem {
  icon?: string
  label?: string
  isCurrentUser?: boolean
  isDesktopNoLabel?: boolean
  isTogglelight?: boolean
  isDivider?: boolean
  to?: RouteLocation
  isLogout?: boolean
  isHelp?: boolean
  isUpload?: boolean
  isCreateDirectory?: boolean
  menu?: NavBarItem[]
  roles?: string[]
  [key: string]: any
}

export default [
  {
    icon: mdiHelpCircleOutline,
    label: i18n.global.t('nav.menu.help'),
    isDesktopNoLabel: true,
    isHelp: true,
    testid: 'help-open'
  },
  {
    icon: mdiThemeLightDark,
    label: i18n.global.t('nav.menu.theme'),
    isDesktopNoLabel: true,
    isTogglelight: true,
    testid: 'theme-toggle'
  },
  {
    icon: mdiAccountCircle,
    label: i18n.global.t('nav.menu.account'),
    isCurrentUser: true,
    isDesktopNoLabel: true,
    testid: 'account-menu',
    menu: [
      {
        icon: mdiHuman,
        label: i18n.global.t('nav.menu.account'),
        to: { name: 'account' },
        testid: 'account-menu-account'
      },
      {
        icon: mdiHumanMaleFemale,
        label: i18n.global.t('nav.menu.adminUsers'),
        to: { name: 'manage-users' },
        roles: ['admin'],
        testid: 'account-menu-users'
      },
      {
        icon: mdiCog,
        label: i18n.global.t('nav.menu.adminSettings'),
        to: { name: 'manage-settings' },
        roles: ['admin'],
        testid: 'account-menu-settings'
      },
      { isDivider: true },
      {
        icon: mdiLock,
        label: i18n.global.t('nav.menu.lock'),
        to: { name: 'lock' },
        testid: 'account-menu-lock'
      },
      {
        icon: mdiLogout,
        label: i18n.global.t('common.logout'),
        isLogout: true,
        testid: 'account-menu-logout'
      }
    ]
  }
] as NavBarItem[]
