import { expect } from "@playwright/test";
export async function openStep(page, id) {
  await expect(page.locator("#toggle")).toBeEnabled();
  const step = page.locator(`#${id}`);
  if (!(await step.evaluate((el) => el.open)))
    await step.locator(":scope > summary").click();
}
