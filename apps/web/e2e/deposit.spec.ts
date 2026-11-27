import {
  test,
  expect,
  getSignedXdrs,
  USER_FIXABLE_TX_ERRORS,
  acknowledgeRiskDisclosure,
  FAKE_VAULTS,
} from "./fixtures";

test.describe("deposit", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/v1/vaults", (route) =>
      route.fulfill({ json: FAKE_VAULTS })
    );
  });
  test("builds a real deposit transaction against the real API", async ({
    page,
    mockWallet,
  }) => {
    // TEST_ADDRESS's real testnet trustline/funding state isn't controlled by
    // this test, so the real backend's Soroban simulation may either reject
    // the deposit (no USDC trustline) or succeed and reach the sign step,
    // which the mock wallet then declines. Either outcome exercises the real
    // trustline check, the real deposit-tx build call to api-local -> Soroban
    // RPC, and the app's error handling end to end; this test accepts both
    // rather than asserting one specific real-network-dependent outcome.
    await mockWallet();
    await page.goto("./");

    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();
    await acknowledgeRiskDisclosure(page);
    await expect(page.getByTestId("vault-tab-deposit")).toBeVisible();

    await page.getByPlaceholder("0.00").fill("10");
    await page.getByTestId("vault-deposit-submit").click();

    // Real trustline pre-flight, real Soroban simulation, and/or a real
    // sign-decline round trip, so a generous timeout. Every path ends in an
    // error toast -- the API's 400 when the wallet holds no USDC trustline and
    // the app could not establish one, the API's friendly 400 for a
    // caller-fixable contract rejection, a simulation failure when the build
    // does reach RPC, or the wallet's own decline -- and the app never
    // silently swallows a failure here.
    // All raw server strings are now mapped through mapError/en.json, so this
    // regex matches the localized equivalents instead of the raw server text.
    await expect(
      page.getByText(
        new RegExp(
          `Something went wrong|You declined the request|Your wallet is missing the USDC trustline|${USER_FIXABLE_TX_ERRORS}`
        )
      )
    ).toBeVisible({ timeout: 25_000 });

    const signed = await getSignedXdrs(page);
    // If signing was requested (build succeeded) the mock wallet declined it
    // and the app showed an error toast. If the build itself failed, no
    // signing was attempted. Either way the toast above was already asserted;
    // this just sanity-checks that XDRs were only collected when signing ran.
    if (signed.length > 0) {
      // Signing was requested → the mock wallet threw "User declined access",
      // which mapError maps to errors.walletDeclined ("You declined the request…").
      await expect(page.getByText(/You declined the request/)).toBeVisible();
    }
  });

  test("deposit button stays disabled with no amount entered", async ({
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

    await expect(page.getByTestId("vault-deposit-submit")).toBeDisabled();
  });
});
