import type { Page } from "@playwright/test";
import {
  test,
  expect,
  TEST_ADDRESS,
  DEFAULT_E2E_NETWORK,
  MISMATCHED_E2E_NETWORK,
  acknowledgeRiskDisclosure,
} from "./fixtures";

test.describe("network mismatch banner", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(`**/api/v1/positions/${TEST_ADDRESS}`, (route) =>
      route.fulfill({ json: { positions: [] } })
    );
  });

  async function connect(page: Page) {
    await page.goto("./");
    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();
    await acknowledgeRiskDisclosure(page);
  }

  test("is hidden when the wallet is on the app's network", async ({
    page,
    mockWallet,
  }) => {
    await mockWallet();
    await connect(page);

    await expect(page.getByTestId("vault-tab-deposit")).toBeVisible();
    await expect(page.getByTestId("network-mismatch-banner")).toHaveCount(0);
  });

  test("shows on a different network and clears after switching back", async ({
    page,
    mockWallet,
  }) => {
    await mockWallet({ network: MISMATCHED_E2E_NETWORK });
    await connect(page);

    const banner = page.getByTestId("network-mismatch-banner");
    await expect(banner).toBeVisible();

    // getNetwork() reads mock.network at call time, so Retry picks this up.
    await page.evaluate((network) => {
      (
        window as unknown as { __E2E_MOCK_WALLET__: { network: string } }
      ).__E2E_MOCK_WALLET__.network = network;
    }, DEFAULT_E2E_NETWORK);

    await banner.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(banner).toHaveCount(0);
  });

  test("shows when the wallet's network is unknown", async ({
    page,
    mockWallet,
  }) => {
    await mockWallet({ network: null });
    await connect(page);

    await expect(page.getByTestId("network-mismatch-banner")).toBeVisible();
  });
});
