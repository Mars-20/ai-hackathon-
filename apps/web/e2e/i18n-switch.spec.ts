import { test, expect } from "@playwright/test";
test("switch keeps page and flips dir", async ({ page }) => {
  await page.goto("/en/dashboard");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page).toHaveURL(/\/ar\/dashboard/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});
