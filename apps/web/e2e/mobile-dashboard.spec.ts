import {
  test,
  expect,
  FAKE_VAULTS,
  acknowledgeRiskDisclosure,
} from "./fixtures";
import type { Page } from "@playwright/test";

// #1428: the three widths called out by the issue. Height is a typical
// portrait viewport for each; the assertions are width-driven.
const MOBILE_VIEWPORTS = [
  { label: "320px", width: 320, height: 740 },
  { label: "360px", width: 360, height: 800 },
  { label: "390px", width: 390, height: 844 },
] as const;

async function stubVaults(page: Page): Promise<void> {
  await page.route("**/api/v1/vaults", (route) =>
    route.fulfill({ json: FAKE_VAULTS })
  );
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));

  expect(
    widths.document,
    `document scrollWidth ${widths.document} exceeds viewport ${widths.viewport}`
  ).toBeLessThanOrEqual(widths.viewport);
  expect(
    widths.body,
    `body scrollWidth ${widths.body} exceeds viewport ${widths.viewport}`
  ).toBeLessThanOrEqual(widths.viewport);
}

async function expectTouchTargets(page: Page): Promise<void> {
  const undersized = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [role='tab'], [role='menuitem'], a[href], input:not([type='hidden'])"
      )
    );

    return candidates.flatMap((element) => {
      // The skip link is intentionally 1px until focused.
      if (element.classList.contains("sr-only")) return [];
      if (element.closest('[aria-hidden="true"]')) return [];

      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) {
        return [];
      }

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return [];
      if (rect.width >= 43.5 && rect.height >= 43.5) return [];

      return [
        {
          tag: element.tagName,
          label: (
            element.getAttribute("aria-label") ??
            element.textContent ??
            ""
          )
            .trim()
            .slice(0, 40),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      ];
    });
  });

  expect(undersized).toEqual([]);
}

test.describe("mobile dashboard (#1428)", () => {
  for (const viewport of MOBILE_VIEWPORTS) {
    test(`${viewport.label} has no overflow, no watermark, and 44px touch targets`, async ({
      page,
      mockWallet,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await stubVaults(page);
      await mockWallet();
      await page.goto("./");

      await expect(
        page.locator("main").getByRole("button", { name: "Connect Wallet" })
      ).toBeVisible();
      await expect(page.getByTestId("dashboard-watermark")).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      await expectTouchTargets(page);

      await page
        .locator("main")
        .getByRole("button", { name: "Connect Wallet" })
        .click();
      await acknowledgeRiskDisclosure(page);
      await expect(page.getByTestId("vault-tab-deposit")).toBeVisible();

      await expectNoHorizontalOverflow(page);
      await expectTouchTargets(page);

      // Disconnecting pushes an info toast; it must fit inside the viewport
      // rather than run off the right edge at a fixed width.
      await page.getByRole("button", { name: "Disconnect" }).click();
      await expect(page.getByText("Wallet Disconnected")).toBeVisible();

      const toastBox = await page
        .locator('[aria-label="Notifications"]')
        .boundingBox();
      expect(toastBox).not.toBeNull();
      expect(toastBox!.x).toBeGreaterThanOrEqual(0);
      expect(toastBox!.x + toastBox!.width).toBeLessThanOrEqual(
        viewport.width + 0.5
      );

      await expectNoHorizontalOverflow(page);
      await expectTouchTargets(page);
    });
  }

  test("watermark renders only on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await stubVaults(page);
    await page.goto("./");

    await expect(page.getByTestId("dashboard-watermark")).toHaveCount(1);
  });
});
