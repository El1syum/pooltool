// A connected, authenticated home is observable through its real primary
// action. The healthy connection footer was deliberately removed from the UI.
export async function waitForConnectedHome(page) {
  await page.locator('.club-shell[data-club-view="menu"]').waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => {
    const play = document.querySelector('.club-main-menu .club-action-primary')
    return play instanceof HTMLButtonElement && !play.disabled
  }, undefined, { timeout: 30_000 })
}

// Use the actual foreground heading workflow, never force-click through the
// captured canvas or call exitPointerLock from test code.
export async function clickHudAction(page, locator) {
  await page.bringToFront()
  await page.waitForFunction(() => !document.querySelector('[aria-modal="true"]'))
  await page.keyboard.down('ControlLeft')
  try {
    // Ctrl releases pointer lock during heading too, where Figma has no
    // additional panels to observe. Check the actual browser lock instead.
    await page.waitForFunction(() => !document.pointerLockElement)
    await locator.click()
  }
  finally { await page.keyboard.up('ControlLeft') }
}
