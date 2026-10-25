import { test, expect, type Page } from '@playwright/test'
import path from 'path'
import { randomEmail, randomPassword, createUser, logout, loginAsUser } from './helpers/auth'

const imageFixture = path.join(__dirname, 'fixtures', 'test-image.png')

async function createFolder(page: Page, name: string) {
  await page.locator('[name="create-dir"]').click()
  await page.locator('#name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId(`file-row-${name}`)).toBeVisible()
}

async function uploadImage(page: Page) {
  await page.setInputFiles('[name="upload-file-input"]', imageFixture)
  await page.getByTestId('upload-active').waitFor({ state: 'hidden', timeout: 30_000 })
  await expect(page.getByTestId('file-row-test-image.png')).toBeVisible()
}

async function moveToTrash(page: Page, name: string) {
  const row = page.getByTestId(`file-row-${name}`)
  await row.locator('[name="actions-dropdown"]').click()
  await row.locator('[name="delete"]').first().click()

  const dialog = page.getByRole('dialog', { name: 'Move to trash' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Move to trash' }).click()
  await expect(dialog).toBeHidden()
  await expect(row).toHaveCount(0)
}

async function openTrash(page: Page) {
  await page.locator('aside').getByText('Trash', { exact: true }).first().click()
  await expect(page).toHaveURL(/\/trash$/)
  await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible()
}

async function openFiles(page: Page) {
  await page.locator('aside').getByText('Files', { exact: true }).first().click()
  await expect(page.getByLabel('Breadcrumb')).toBeVisible()
}

test.describe('Trash', () => {
  test('a deleted file goes to trash and restores to where it was', async ({ page }) => {
    await createUser(page, randomEmail(), randomPassword())
    await uploadImage(page)

    await moveToTrash(page, 'test-image.png')

    await openTrash(page)
    const trashRow = page.getByTestId('trash-row-test-image.png')
    await expect(trashRow).toBeVisible({ timeout: 15_000 })
    await expect(trashRow.getByTestId('trash-expires')).toContainText('in 30 days')

    await trashRow.locator('[name="trash-restore"]').click()
    await expect(trashRow).toHaveCount(0)
    await expect(page.getByTestId('trash-empty-state')).toBeVisible()

    await openFiles(page)
    await expect(page.getByTestId('file-row-test-image.png')).toBeVisible()
  })

  test('a folder and its contents round-trip through trash', async ({ page }) => {
    await createUser(page, randomEmail(), randomPassword())
    await createFolder(page, 'Parent')

    await page.getByTestId('file-row-Parent').dblclick()
    await expect(page).toHaveURL(/[0-9a-f-]{36}/)
    await createFolder(page, 'Child')
    await page.getByLabel('Breadcrumb').getByRole('link', { name: 'My Files' }).click()

    await moveToTrash(page, 'Parent')

    await openTrash(page)
    await expect(page.getByTestId('trash-row-Parent')).toBeVisible({ timeout: 15_000 })
    // Only the item the user deleted is listed; its contents travel with it.
    await expect(page.getByTestId('trash-row-Child')).toHaveCount(0)

    await page.getByTestId('trash-row-Parent').locator('[name="trash-restore"]').click()
    await expect(page.getByTestId('trash-empty-state')).toBeVisible()

    await openFiles(page)
    await page.getByTestId('file-row-Parent').dblclick()
    await expect(page.getByTestId('file-row-Child')).toBeVisible()
  })

  test('delete forever leaves the trash empty', async ({ page }) => {
    await createUser(page, randomEmail(), randomPassword())
    await createFolder(page, 'Doomed')
    await moveToTrash(page, 'Doomed')

    await openTrash(page)
    const row = page.getByTestId('trash-row-Doomed')
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.locator('[name="trash-delete-forever"]').click()

    const dialog = page.getByRole('dialog', { name: 'Delete forever' })
    await expect(dialog).toContainText("Delete 'Doomed' forever? This cannot be undone.")
    await dialog.getByRole('button', { name: 'Delete forever' }).click()

    await expect(page.getByTestId('trash-empty-state')).toBeVisible()

    // The purge is accepted, not reversible: a fresh load still shows nothing.
    await openFiles(page)
    await openTrash(page)
    await expect(page.getByTestId('trash-empty-state')).toBeVisible()
  })

  test('empty trash removes every item', async ({ page }) => {
    await createUser(page, randomEmail(), randomPassword())
    await createFolder(page, 'Folder_A')
    await createFolder(page, 'Folder_B')

    await page.getByTestId('file-row-Folder_A').locator('input[type="checkbox"]').check()
    await page.getByTestId('file-row-Folder_B').locator('input[type="checkbox"]').check()
    await page.keyboard.press('Delete')
    await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click()
    await expect(page.getByTestId('file-row-Folder_A')).toHaveCount(0)
    await expect(page.getByTestId('file-row-Folder_B')).toHaveCount(0)

    await openTrash(page)
    await expect(page.getByTestId('trash-row-Folder_A')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('trash-row-Folder_B')).toBeVisible()

    await page.getByTestId('trash-empty').click()
    const dialog = page.getByRole('dialog', { name: 'Empty trash' })
    await expect(dialog).toContainText('Delete all 2 items in trash forever?')
    await dialog.getByRole('button', { name: 'Empty trash' }).click()

    await expect(page.getByTestId('trash-empty-state')).toBeVisible()
  })

  test('restoring onto a taken name warns and keeps the item in trash', async ({ page }) => {
    await createUser(page, randomEmail(), randomPassword())
    await createFolder(page, 'Dup')
    await moveToTrash(page, 'Dup')
    await createFolder(page, 'Dup')

    await openTrash(page)
    const row = page.getByTestId('trash-row-Dup')
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.locator('[name="trash-restore"]').click()

    await expect(page.getByText('Some items were not restored')).toBeVisible()
    await expect(row).toBeVisible()
    await expect(row.getByTestId('trash-conflict')).toBeVisible()
  })

  test('a preview link to a trashed file shows the not-found state', async ({ page }) => {
    const user = await createUser(page, randomEmail(), randomPassword())
    await logout(page)
    // Remember Me keeps the private key across the full page load below.
    await loginAsUser(page, user.email, user.password, { remember: true })
    await uploadImage(page)

    const fileId = await page
      .getByTestId('file-row-test-image.png')
      .locator('[data-row-nav]')
      .getAttribute('data-file-id')
    expect(fileId).toMatch(/[0-9a-f-]{36}/)

    await moveToTrash(page, 'test-image.png')

    await page.goto(`/p/${fileId}`)
    await expect(page.getByTestId('file-preview-not-found')).toBeVisible({ timeout: 15_000 })
  })
})
