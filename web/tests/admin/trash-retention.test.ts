import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('!/admin/settings', () => ({ index: vi.fn(), update: vi.fn() }))

import { index, update } from '!/admin/settings'
import UserSettings from '../../src/views/admin/settings/UserSettings.vue'
import SettingsInner from '../../src/views/admin/settings/SettingsInner.vue'
import type { Data } from '../../types/admin/settings'

function settings(retention_days: unknown = 30): Data {
  return {
    users: {
      allow_register: true,
      enforce_email_activation: false,
      email_whitelist: { rules: [] },
      email_blacklist: { rules: [] }
    },
    sharing: { enabled: true, default_cipher: 'aegis256' },
    trash: { retention_days }
  } as Data
}

function saveButton(wrapper: ReturnType<typeof mount>) {
  const button = wrapper.findAll('button').find((b) => b.text() === 'Save Settings')
  if (!button) throw new Error('no save button')
  return button
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Admin trash retention', () => {
  it('binds the input to trash.retention_days', async () => {
    const data = settings(30)
    const wrapper = mount(UserSettings, { props: { modelValue: data, loading: false } })

    const input = wrapper.get('[data-testid="admin-trash-retention"]')
    expect((input.element as HTMLInputElement).value).toBe('30')

    await input.setValue('7')
    expect(data.trash.retention_days).toBe(7)
    expect(wrapper.find('[data-testid="admin-trash-retention-error"]').exists()).toBe(false)
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it.each([0, 3651, 1.5, ''])('blocks saving %j days', (days) => {
    const wrapper = mount(UserSettings, {
      props: { modelValue: settings(days), loading: false }
    })

    expect(wrapper.get('[data-testid="admin-trash-retention-error"]').text()).toBe(
      'Enter a whole number of days from 1 to 3650.'
    )
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('hides the section for a server without trash settings', () => {
    const data = settings()
    delete (data as Partial<Data>).trash
    const wrapper = mount(UserSettings, { props: { modelValue: data, loading: false } })

    expect(wrapper.find('[data-testid="admin-trash-retention"]').exists()).toBe(false)
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('names the retention field when the server rejects it', async () => {
    vi.mocked(index).mockResolvedValue(settings(30))
    vi.mocked(update).mockRejectedValue({
      kind: 'ErrorResponse',
      status: 422,
      description: 'Validation error',
      validation: { 'trash.retention_days': 'max' }
    })

    const wrapper = mount(
      { components: { SettingsInner }, template: '<Suspense><SettingsInner /></Suspense>' },
      { global: { stubs: { EmailSettings: true } } }
    )
    await flushPromises()

    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Enter a whole number of days from 1 to 3650.')
    expect(wrapper.text()).not.toContain('Validation error')
  })
})
