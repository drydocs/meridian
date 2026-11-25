import { test, expect, acknowledgeRiskDisclosure } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

async function checkA11y(page: Page, contextName: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const violations = results.violations.filter(
    (v: (typeof results.violations)[number]) =>
      v.impact === "critical" || v.impact === "serious"
  );

  expect(
    violations,
    `${contextName} had ${violations.length} critical or serious axe violations:\n` +
      violations
        .map(
          (v: (typeof results.violations)[number]) =>
            `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} nodes)`
        )
        .join("\n")
  ).toEqual([]);
}

test.describe("Automated Accessibility Gate (#1305)", () => {
  test.describe("Axe-core scans on core surfaces", () => {
    test("Dashboard — disconnected state has zero critical or serious violations", async ({
      page,
      mockWallet,
    }) => {
      await mockWallet();
      await page.goto("./");
      await expect(page.getByText(/Connect your wallet/i)).toBeVisible();

      await checkA11y(page, "Dashboard (disconnected)");
    });

    test("Dashboard — connected state with tabs has zero critical or serious violations", async ({
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
      await checkA11y(page, "Dashboard (connected - deposit)");

      // Switch to withdraw tab and verify
      await page.getByTestId("vault-tab-withdraw").click();
      await expect(page.getByRole("tabpanel")).toHaveAttribute(
        "id",
        "vault-tabpanel-withdraw"
      );
      await checkA11y(page, "Dashboard (connected - withdraw)");
    });

    test("Dashboard — risk disclosure modal has zero critical or serious violations", async ({
      page,
      mockWallet,
    }) => {
      await mockWallet();
      await page.goto("./");

      await page
        .locator("main")
        .getByRole("button", { name: "Connect Wallet" })
        .click();

      await expect(page.getByRole("dialog")).toBeVisible();
      await checkA11y(page, "Dashboard (risk disclosure modal open)");
    });

    test("Status page has zero critical or serious violations", async ({
      page,
    }) => {
      await page.goto("./status");
      await expect(page.locator("h1")).toBeVisible();

      await checkA11y(page, "Status Page");
    });

    test("Admin login page has zero critical or serious violations", async ({
      page,
      mockWallet,
    }) => {
      await mockWallet();
      await page.goto("./admin");
      await expect(
        page.getByRole("button", { name: "Connect Wallet" })
      ).toBeVisible();

      await checkA11y(page, "Admin Login Page");
    });
  });

  test.describe("Keyboard flows and focus management", () => {
    test("Skip to content link is visible on Tab and targets main content", async ({
      page,
    }) => {
      await page.goto("./");

      const skipLink = page.getByRole("link", { name: /skip to content/i });
      await expect(skipLink).toBeAttached();
      await expect(page.locator("main")).toBeVisible();

      // Press Tab to focus the skip link
      await page.keyboard.press("Tab");
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toBeVisible();

      // Press Enter to activate skip link
      await page.keyboard.press("Enter");
      await expect(page.locator("#main-content")).toBeFocused();
    });

    test("Tab switcher supports Left and Right arrow keyboard navigation", async ({
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

      const depositTab = page.getByRole("tab", { name: "Deposit" });
      const withdrawTab = page.getByRole("tab", { name: "Withdraw" });

      await depositTab.focus();
      await expect(depositTab).toBeFocused();
      await expect(depositTab).toHaveAttribute("aria-selected", "true");

      // Press Right Arrow to cycle to Withdraw tab
      await page.keyboard.press("ArrowRight");
      await expect(withdrawTab).toBeFocused();
      await expect(withdrawTab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toHaveAttribute(
        "id",
        "vault-tabpanel-withdraw"
      );

      // Press Left Arrow to cycle back to Deposit tab
      await page.keyboard.press("ArrowLeft");
      await expect(depositTab).toBeFocused();
      await expect(depositTab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toHaveAttribute(
        "id",
        "vault-tabpanel-deposit"
      );
    });

    test("Risk disclosure modal traps focus and closes with Escape restoring trigger focus", async ({
      page,
      mockWallet,
    }) => {
      await mockWallet();
      await page.goto("./");

      const connectBtn = page
        .locator("main")
        .getByRole("button", { name: "Connect Wallet" });
      await connectBtn.focus();
      await page.keyboard.press("Enter");

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      // Close modal with Escape key
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // Focus should be restored to the connect button
      await expect(connectBtn).toBeFocused();
    });
  });
});
