import { test, expect, type Locator, type Page } from '@playwright/test'
import path from 'path'
import { createUser, loginAsUser, logout, randomEmail, randomPassword } from './helpers/auth'
import { discoverRecipient, openShareDialogFor, openSharedWithMe } from './helpers/shares'

const imageFixture = path.join(__dirname, 'fixtures', 'test-image.png')

async function setup(page: Page) {
  return createUser(page, randomEmail(), randomPassword())
}

async function createFolders(page: Page, names: string[]) {
  for (const name of names) {
    await page.locator('[name="create-dir"]').click()
    await page.locator('#name').fill(name)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(row(page, name)).toBeVisible()
  }
}

async function uploadImage(page: Page) {
  await page.setInputFiles('[name="upload-file-input"]', imageFixture)
  await page.getByTestId('upload-active').waitFor({ state: 'hidden', timeout: 30_000 })
  await expect(row(page, 'test-image.png')).toBeVisible()
}

const row = (page: Page, name: string) => page.getByTestId(`file-row-${name}`)
const treeFolder = (page: Page, name: string) => page.locator(`aside li[title="${name}"]`)
const menu = (page: Page) => page.getByTestId('context-menu')
const menuItem = (page: Page, action: string) => page.getByTestId(`context-menu-${action}`)

const selectedNames = (page: Page) =>
  page
    .getByRole('grid')
    .locator('[aria-selected="true"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')!.slice('file-row-'.length)))

const expectSelected = (page: Page, names: string[]) =>
  expect.poll(() => selectedNames(page)).toEqual(names)

async function belowTable(page: Page) {
  const box = (await page.getByRole('grid').boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height + 40 }
}

async function centerOf(locator: Locator) {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Presses on a row's name and starts a native drag of the selection. */
async function startDrag(page: Page, from: Locator) {
  const box = (await from.boundingBox())!
  const x = box.x + 60
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 8, y + 8, { steps: 4 })
}

async function hover(page: Page, target: Locator) {
  const { x, y } = await centerOf(target)
  await page.mouse.move(x, y, { steps: 10 })
  await page.mouse.move(x + 2, y + 1, { steps: 2 })
}

async function dragOnto(page: Page, from: Locator, to: Locator) {
  await startDrag(page, from)
  await hover(page, to)
  await page.mouse.up()
}

async function selectRows(page: Page, names: string[]) {
  await row(page, names[0]).click()
  for (const name of names.slice(1)) {
    await row(page, name).click({ modifiers: ['ControlOrMeta'] })
  }
  await expectSelected(page, names)
}

test.describe('Drag and drop moves', () => {
  test('dragging the selection onto a folder row moves every selected item into it', async ({
    page
  }) => {
    await setup(page)
    await createFolders(page, ['Target', 'Item_A', 'Item_B', 'Item_C'])
    await selectRows(page, ['Item_A', 'Item_B'])

    await startDrag(page, row(page, 'Item_A'))
    await hover(page, row(page, 'Target'))
    await expect(row(page, 'Target')).toHaveAttribute('data-drop-over', 'true')
    // The rows being carried fade while the drag is on.
    await expect(row(page, 'Item_B')).toHaveClass(/opacity-50/)
    await page.mouse.up()

    await expect(page.getByText('Moved 2 items to Target')).toBeVisible()
    await expect(row(page, 'Item_A')).toHaveCount(0)
    await expect(row(page, 'Item_B')).toHaveCount(0)
    await expect(row(page, 'Item_C')).toBeVisible()
    await expect(row(page, 'Target')).not.toHaveAttribute('data-drop-over', 'true')

    await row(page, 'Target').dblclick()
    await expect(row(page, 'Item_A')).toBeVisible()
    await expect(row(page, 'Item_B')).toBeVisible()
  })

  test('only a selected row drags; an unselected one starts the band instead', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Target', 'Item_A'])

    await expect(row(page, 'Item_A')).not.toHaveAttribute('draggable', 'true')
    await row(page, 'Item_A').click()
    await expect(row(page, 'Item_A')).toHaveAttribute('draggable', 'true')

    // A plain click on the selected row still selects just it, and a double
    // click still opens it.
    await row(page, 'Target').click({ modifiers: ['ControlOrMeta'] })
    await expectSelected(page, ['Item_A', 'Target'])
    await row(page, 'Item_A').click()
    await expectSelected(page, ['Item_A'])
    await row(page, 'Item_A').dblclick()
    await expect(page).toHaveURL(/[0-9a-f-]{36}/)
  })

  test('dragging onto a folder in the sidebar tree moves the items there', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Target', 'Item_A'])
    await expect(treeFolder(page, 'Target')).toBeVisible()
    await row(page, 'Item_A').click()

    await dragOnto(page, row(page, 'Item_A'), treeFolder(page, 'Target'))

    await expect(page.getByText('Moved 1 item to Target')).toBeVisible()
    await expect(row(page, 'Item_A')).toHaveCount(0)
    await row(page, 'Target').dblclick()
    await expect(row(page, 'Item_A')).toBeVisible()
  })

  test('dragging onto a breadcrumb moves the items up to that folder', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Parent'])
    await row(page, 'Parent').dblclick()
    await expect(page.getByTestId('files-empty')).toBeVisible()
    await createFolders(page, ['Child'])
    await row(page, 'Child').click()

    await dragOnto(page, row(page, 'Child'), page.getByTestId('breadcrumb-root'))

    await expect(page.getByText('Moved 1 item to Home')).toBeVisible()
    await expect(row(page, 'Child')).toHaveCount(0)
    await page.getByTestId('breadcrumb-root').click()
    await expect(row(page, 'Child')).toBeVisible()
  })

  test('a folder is never dropped onto itself or the rest of the selection', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Item_A', 'Item_B'])
    await selectRows(page, ['Item_A', 'Item_B'])

    await startDrag(page, row(page, 'Item_A'))
    await hover(page, row(page, 'Item_B'))
    // The drag is on (the items fade), it is just refused here.
    await expect(row(page, 'Item_A')).toHaveClass(/opacity-50/)
    await expect(row(page, 'Item_B')).not.toHaveAttribute('data-drop-over', 'true')
    await expect(page.getByRole('grid')).not.toHaveAttribute('data-drop-over', 'true')
    await page.mouse.up()
    await expect(row(page, 'Item_A')).not.toHaveClass(/opacity-50/)

    await expect(row(page, 'Item_A')).toBeVisible()
    await expect(row(page, 'Item_B')).toBeVisible()
    await expect(page.getByText(/^Moved /)).toHaveCount(0)
  })

  test('a folder is never dropped into its own subfolder in the sidebar tree', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Outer'])
    await row(page, 'Outer').dblclick()
    await expect(page.getByTestId('files-empty')).toBeVisible()
    await createFolders(page, ['Inner'])
    await page.getByTestId('breadcrumb-root').click()
    await expect(row(page, 'Outer')).toBeVisible()

    if (!(await treeFolder(page, 'Inner').isVisible())) {
      // Clicking a tree folder expands it and opens it; come back to the root.
      await treeFolder(page, 'Outer').click()
      await expect(treeFolder(page, 'Inner')).toBeVisible()
      await page.getByTestId('breadcrumb-root').click()
      await expect(row(page, 'Outer')).toBeVisible()
    }

    await row(page, 'Outer').click()
    await startDrag(page, row(page, 'Outer'))
    await hover(page, treeFolder(page, 'Inner'))
    await expect(row(page, 'Outer')).toHaveClass(/opacity-50/)
    await expect(treeFolder(page, 'Inner')).not.toHaveAttribute('data-drop-over', 'true')
    await page.mouse.up()

    await expect(page.getByText(/^Moved /)).toHaveCount(0)
    await expect(row(page, 'Outer')).toBeVisible()
  })

  test('hovering a folder row mid-drag opens it, and the items drop into it', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Target', 'Item_A'])
    await row(page, 'Item_A').click()

    await startDrag(page, row(page, 'Item_A'))
    await hover(page, row(page, 'Target'))
    await expect(page).toHaveURL(/[0-9a-f-]{36}/, { timeout: 5_000 })
    await expect(page.getByTestId('files-empty')).toBeVisible()

    // The source row is gone with the old listing; the drag carries on.
    await hover(page, page.getByTestId('files-empty'))
    // An empty listing is no grid, but it still stands for the folder.
    await expect(page.locator('[data-drop-over="true"]')).toHaveCount(1)
    await page.mouse.up()

    await expect(page.getByText('Moved 1 item to Target')).toBeVisible()
    await expect(row(page, 'Item_A')).toBeVisible()
  })
})

test.describe('Spring-loading', () => {
  /** Opens each folder in turn and creates the next inside it, then goes home. */
  async function createNested(page: Page, names: string[]) {
    for (const name of names) {
      await createFolders(page, [name])
      await row(page, name).dblclick()
      await expect(page.getByTestId('files-empty')).toBeVisible()
    }
    await page.getByTestId('breadcrumb-root').click()
  }

  test('a resting pointer opens one folder, not the folders that open under it', async ({
    page
  }) => {
    await setup(page)
    await createFolders(page, ['Zitem'])
    // Each opened folder's only row sits where the folder's own row was.
    await createNested(page, ['Target', 'S2', 'D2'])
    await expect(row(page, 'Target')).toBeVisible()
    await row(page, 'Zitem').click()

    await startDrag(page, row(page, 'Zitem'))
    const at = await centerOf(row(page, 'Target'))
    await hover(page, row(page, 'Target'))
    await expect(row(page, 'S2')).toBeVisible({ timeout: 5_000 })
    const inTarget = page.url()

    // Hand tremor, not a move: nothing deeper opens.
    for (let i = 0; i < 15; i++) {
      await page.mouse.move(at.x + 3, at.y + (i % 2))
      await page.waitForTimeout(200)
    }
    expect(page.url()).toBe(inTarget)
    await expect(row(page, 'S2')).toBeVisible()

    await hover(page, page.locator('[data-table-header]'))
    await page.mouse.up()
    await expect(page.getByText('Moved 1 item to Target')).toBeVisible()
    expect(page.url()).toBe(inTarget)
    await expect(row(page, 'Zitem')).toBeVisible()
  })

  test('a drag abandoned after opening a folder leaves nothing behind', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Item_A'])
    await createNested(page, ['Target', 'Sub'])
    await expect(row(page, 'Target')).toBeVisible()
    await row(page, 'Item_A').click()

    await startDrag(page, row(page, 'Item_A'))
    await hover(page, row(page, 'Target'))
    await expect(row(page, 'Sub')).toBeVisible({ timeout: 5_000 })
    // Released over the navbar, where nothing takes it: the source row is
    // long gone, so its dragend fires on a detached node.
    await page.mouse.move(640, 20, { steps: 6 })
    await page.mouse.up()

    await page.keyboard.press('Alt+ArrowUp')
    await expect(row(page, 'Item_A')).toBeVisible()
    await expect(row(page, 'Item_A')).not.toHaveClass(/opacity-50/)
    await expect(page.getByText(/^Moved /)).toHaveCount(0)

    await row(page, 'Item_A').click()
    await dragOnto(page, row(page, 'Item_A'), row(page, 'Target'))
    await expect(page.getByText('Moved 1 item to Target')).toBeVisible()
    await expect(row(page, 'Item_A')).toHaveCount(0)
  })
})

test.describe('Context menus', () => {
  test('right-clicking a file selects it and offers its actions; Rename renames it', async ({
    page
  }) => {
    await setup(page)
    await createFolders(page, ['Folder_A'])
    await uploadImage(page)
    await row(page, 'Folder_A').click()

    await row(page, 'test-image.png').click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await expectSelected(page, ['test-image.png'])
    for (const action of ['open', 'download', 'rename', 'move', 'details', 'remove']) {
      await expect(menuItem(page, action)).toBeVisible()
    }
    await expect(menuItem(page, 'rename')).toContainText('F2')

    await menuItem(page, 'rename').click()
    await expect(menu(page)).toHaveCount(0)
    await page.getByPlaceholder('new name').fill('renamed-image.png')
    await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click()

    await expect(row(page, 'renamed-image.png')).toBeVisible()
    await expect(row(page, 'test-image.png')).toHaveCount(0)
  })

  test('Move to… on a single row opens the move picker for just that row', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Folder_A', 'Folder_B'])
    await row(page, 'Folder_A').click()

    await row(page, 'Folder_B').click({ button: 'right' })
    await menuItem(page, 'move').click()

    await expect(page.getByRole('dialog')).toBeVisible()
    await expectSelected(page, ['Folder_B'])
  })

  test('right-clicking a multi-selection acts on all of it; Move to trash trashes it', async ({
    page
  }) => {
    await setup(page)
    await createFolders(page, ['Folder_A', 'Folder_B', 'Folder_C'])
    await selectRows(page, ['Folder_A', 'Folder_B'])

    await row(page, 'Folder_A').click({ button: 'right' })
    await expect(page.getByTestId('context-menu-selection-count')).toHaveText('2 selected')
    await expectSelected(page, ['Folder_A', 'Folder_B'])
    await expect(menuItem(page, 'move-all')).toBeVisible()

    await menuItem(page, 'remove-all').click()
    await page
      .getByRole('dialog', { name: 'Move to trash' })
      .getByRole('button', { name: 'Move to trash' })
      .click()

    await expect(row(page, 'Folder_A')).toHaveCount(0)
    await expect(row(page, 'Folder_B')).toHaveCount(0)
    await expect(row(page, 'Folder_C')).toBeVisible()
  })

  test('right-clicking blank space offers create and upload; New folder opens its dialog', async ({
    page
  }) => {
    await setup(page)
    await createFolders(page, ['Folder_A'])
    await row(page, 'Folder_A').click()

    const blank = await belowTable(page)
    await page.mouse.click(blank.x, blank.y, { button: 'right' })
    await expect(menu(page)).toBeVisible()
    for (const action of ['directory', 'file', 'browse', 'browse-folder', 'select-all']) {
      await expect(menuItem(page, action)).toBeVisible()
    }
    // As a click on nothing does, the right-click let go of the selection.
    await expectSelected(page, [])

    await menuItem(page, 'directory').click()
    await expect(page.getByRole('dialog', { name: 'Create a folder' })).toBeVisible()
  })

  test('Select all from the blank-space menu selects every row', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Folder_A', 'Folder_B'])

    const blank = await belowTable(page)
    await page.mouse.click(blank.x, blank.y, { button: 'right' })
    await menuItem(page, 'select-all').click()
    await expectSelected(page, ['Folder_A', 'Folder_B'])
  })

  test('the Menu key with focus on the page opens the menu of the selection', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Folder_A', 'Folder_B'])
    const menuKey = () =>
      page.evaluate(() => {
        ;(document.activeElement as HTMLElement | null)?.blur()
        document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      })

    await selectRows(page, ['Folder_A', 'Folder_B'])
    await menuKey()
    await expect(page.getByTestId('context-menu-selection-count')).toHaveText('2 selected')
    await expectSelected(page, ['Folder_A', 'Folder_B'])
    await page.keyboard.press('Escape')

    await row(page, 'Folder_B').click()
    await menuKey()
    await expect(menuItem(page, 'rename')).toBeVisible()
    await expect(menuItem(page, 'directory')).toHaveCount(0)
    await expectSelected(page, ['Folder_B'])
    await page.keyboard.press('Escape')

    // With nothing selected it is the blank-space menu.
    await page.keyboard.press('Escape')
    await expectSelected(page, [])
    await menuKey()
    await expect(menuItem(page, 'directory')).toBeVisible()
  })

  test('a press that wobbles on a ⋮ dropdown item picks it, not a drag', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Folder_A', 'Folder_B'])
    await row(page, 'Folder_A').click()

    await row(page, 'Folder_A').locator('[name="actions-dropdown"]').click()
    const details = row(page, 'Folder_A').locator('.floating-menu [name="details"]')
    await expect(details).toBeVisible()
    const at = await centerOf(details)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 6, at.y + 1, { steps: 4 })
    await expect(row(page, 'Folder_A')).not.toHaveClass(/opacity-50/)
    await page.mouse.up()

    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText(/^Moved /)).toHaveCount(0)
  })

  test('Escape closes the menu and keeps the selection', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Folder_A'])

    await row(page, 'Folder_A').click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await expectSelected(page, ['Folder_A'])
  })

  test('the ⋮ dropdown and the context menu never show at once', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Folder_A', 'Folder_B'])

    await row(page, 'Folder_B').locator('[name="actions-dropdown"]').click()
    const dropdown = row(page, 'Folder_B').locator('.floating-menu')
    await expect(dropdown).toBeVisible()

    await row(page, 'Folder_A').click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await expect(dropdown).toBeHidden()
  })

  test('a right-button drag does not draw a band', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Folder_A', 'Folder_B'])

    const from = await belowTable(page)
    const to = await centerOf(row(page, 'Folder_A'))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await expect(page.getByTestId('selection-marquee')).toHaveCount(0)
    await page.mouse.up({ button: 'right' })
  })
})

test.describe('Keyboard', () => {
  test('F2 renames, Enter opens the selection and Alt+Up goes back up', async ({ page }) => {
    await setup(page)
    await createFolders(page, ['Folder_A'])
    await row(page, 'Folder_A').click()

    await page.keyboard.press('F2')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByPlaceholder('new name')).toHaveValue('Folder_A')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // A selection made with the mouse leaves focus on the page, not a row.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await expectSelected(page, ['Folder_A'])
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/[0-9a-f-]{36}/)
    await expect(page.getByTestId('files-empty')).toBeVisible()

    await page.keyboard.press('Alt+ArrowUp')
    await expect(row(page, 'Folder_A')).toBeVisible()
    await expect(page).not.toHaveURL(/[0-9a-f-]{36}/)
  })
})

test.describe('Context menus in shared content', () => {
  test('the Shared with me root has nothing to create, and its row only opens', async ({ page }) => {
    const alice = await createUser(page, randomEmail(), randomPassword())
    await logout(page)
    const bob = await createUser(page, randomEmail(), randomPassword())
    await logout(page)

    await loginAsUser(page, alice.email, alice.password)
    await uploadImage(page)
    await openShareDialogFor(page, 'test-image.png')
    await discoverRecipient(page, bob.email)
    await page.getByTestId('share-dialog-role-reader').check()
    await page.getByTestId('share-dialog-submit').click()
    await expect(page.getByTestId('share-dialog-target')).toHaveCount(0, { timeout: 30_000 })
    await page.keyboard.press('Escape')
    await logout(page)

    await loginAsUser(page, bob.email, bob.password)
    const sharedRoot = row(page, 'Shared with me')
    await expect(sharedRoot).toBeVisible({ timeout: 15_000 })
    await sharedRoot.click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await expect(menu(page).getByRole('menuitem')).toHaveCount(1)
    await expect(menuItem(page, 'open')).toBeVisible()
    await page.keyboard.press('Escape')

    await openSharedWithMe(page)
    await expect(row(page, 'test-image.png')).toBeVisible({ timeout: 15_000 })
    const blank = await belowTable(page)
    await page.mouse.click(blank.x, blank.y, { button: 'right' })
    await expect(menu(page)).toBeVisible()
    await expect(menuItem(page, 'select-all')).toBeVisible()
    for (const action of ['directory', 'file', 'browse', 'browse-folder']) {
      await expect(menuItem(page, action)).toHaveCount(0)
    }
  })
})
