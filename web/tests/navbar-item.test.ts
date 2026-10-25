import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import NavBarItem from '../src/components/ui/NavBarItem.vue'
import { store as loginStore } from '../services/auth/login'

const router = () =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/auth/pin/lock', name: 'lock', component: { template: '<div />' } },
      { path: '/admin/users', name: 'manage-users', component: { template: '<div />' } }
    ]
  })

describe('NavBarItem', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders route items as real links with a resolved href', () => {
    // An explicit href binding used to override RouterLink's own resolved
    // href in the attr merge, leaving an <a> with no href at all.
    const wrapper = mount(NavBarItem, {
      global: { plugins: [router()] },
      props: { item: { label: 'Lock', to: { name: 'lock' } } }
    })

    expect(wrapper.find('a').attributes('href')).toBe('/auth/pin/lock')
  })

  it('renders href items as plain anchors', () => {
    const wrapper = mount(NavBarItem, {
      global: { plugins: [router()] },
      props: { item: { label: 'Apps', href: 'https://hoodik.io/apps', target: '_blank' } }
    })

    const anchor = wrapper.find('a')
    expect(anchor.attributes('href')).toBe('https://hoodik.io/apps')
    expect(anchor.attributes('target')).toBe('_blank')
  })

  it('renders action items without a link role', () => {
    const wrapper = mount(NavBarItem, {
      global: { plugins: [router()] },
      props: { item: { label: 'Theme', isTogglelight: true, testid: 'theme-toggle' } }
    })

    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.find('[data-testid="theme-toggle"]').exists()).toBe(true)
  })

  const accountMenu = {
    label: 'Account',
    isDesktopNoLabel: true,
    testid: 'account-menu',
    menu: [
      { label: 'Users', to: { name: 'manage-users' }, roles: ['admin'], testid: 'users' },
      { label: 'Lock', to: { name: 'lock' }, testid: 'lock' }
    ]
  }

  const signInAs = (role: string) =>
    loginStore().set({ user: { email: 'me@test.com', role }, session: {} } as any)

  it('hides dropdown entries the user role does not allow', async () => {
    signInAs('user')
    const wrapper = mount(NavBarItem, {
      global: { plugins: [router()] },
      props: { item: accountMenu }
    })

    expect(wrapper.find('[data-testid="lock"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="users"]').exists()).toBe(false)

    signInAs('admin')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="users"]').exists()).toBe(true)
  })

  it('closes the dropdown once an entry is picked', async () => {
    signInAs('user')
    const wrapper = mount(NavBarItem, {
      global: { plugins: [router()] },
      props: { item: accountMenu }
    })
    const trigger = wrapper.find('[data-testid="account-menu"]')

    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')

    await wrapper.find('[data-testid="lock"]').trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })
})
