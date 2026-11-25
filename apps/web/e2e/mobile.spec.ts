import { test, expect, acknowledgeRiskDisclosure } from "./fixtures";
import type { Page } from "@playwright/test";

// Target viewports from #1428: low-end Android devices render at 320-390
// CSS pixels. These are the widths the dashboard must fit without horizontal
// scroll or clipped controls.
const MOBILE_WIDTHS = [320, 360, 390];
const MOBILE_HEIGHT = 780;
const MIN_TOUCH_TARGET = 44;

/**
 * Returns the largest overflow past either viewport edge, ignoring hidden
 * elements. `overflow-x: hidden` on <html>/<body> hides scroll rather than
 * preventing it, so measuring scrollWidth would miss a real overflow; this
 * checks every rendered box instead.
 */
async function maxHorizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    let worst = 0;
    for (const element of Array.from(document.querySelectorAll("body *"))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (getComputedStyle(element).display === "none") continue;
      worst = Math.max(worst, rect.right - viewport, -rect.left);
    }
    return worst;
  });
}

async function expectTouchTarget(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box, selector + " should be rendered").not.toBeNull();
  expect(box!.height, selector + " height").toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET
  );
  expect(box!.width, selector + " width").toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET
  );
}

for (const width of MOBILE_WIDTHS) {
  test.describe("Mobile dashboard at " + width + "px (#1428)", () => {
    test.use({ viewport: { width, height: MOBILE_HEIGHT } });

    test("disconnected dashboard fits the viewport with touch-sized controls", async ({
      page,
      mockWallet,
    }) => {
      await mockWallet();
      await page.goto("./");
      await expect(page.getByText(/Connect your wallet/i)).toBeVisible();

      expect(await maxHorizontalOverflow(page)).toBeLessThanOrEqual(1);

      const connect = page
        .locator("main")
        .getByRole("button", { name: "Connect Wallet" });
      const box = await connect.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(box!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    });

    test("connected tabs and action buttons are touch-sized", async ({
      page,
      mockWallet,
    }) => {
      await mockWallet();
      await page.goto("./");

      await page
        .locator("main")
        .getByRole("button", { name: "Connect Wallet" })
        .click();
      await acknowledgeRiskDisclosure(page);

      await expect(page.getByTestId("vault-tab-deposit")).toBeVisible();
      expect(await maxHorizontalOverflow(page)).toBeLessThanOrEqual(1);

      await expectTouchTarget(page, '[data-testid="vault-tab-deposit"]');
      await expectTouchTarget(page, '[data-testid="vault-tab-withdraw"]');

      await page.getByTestId("vault-tab-withdraw").click();
      await expect(page.getByRole("tabpanel")).toHaveAttribute(
        "id",
        "vault-tabpanel-withdraw"
      );
      expect(await maxHorizontalOverflow(page)).toBeLessThanOrEqual(1);
    });
  });
}
