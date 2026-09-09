import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch();
const ok = (l, c) => console.log(`${c ? "PASS" : "FAIL"}  ${l}`);

// A completely separate browser profile — no shared cookies, storage or cache.
// This is the "colleague opens the link" case.
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);

const body = await page.locator("body").innerText();
ok("fresh profile sees the project", body.includes("Full Flow"));
await page.getByText("Full Flow").click();
await page.waitForTimeout(1300);
ok("sees the uploaded screen", (await page.locator("img").count()) > 0);
ok("screen image loads", await page.locator("img").first().evaluate((el) => el.complete && el.naturalWidth > 0));
await page.getByText("Hero headline").first().click();
await page.waitForTimeout(800);
const detail = await page.locator("body").innerText();
ok("sees the hotspot + approved copy", detail.includes("Hero headline") && detail.includes("You're all set."));
ok("sees the sign-off audit trail", /Approved by Alex/.test(detail));
await page.screenshot({ path: "/tmp/share-colleague.png" });

// ---- concurrent edit: two people, same project ----
const ctxB = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const pageB = await ctxB.newPage();
await pageB.goto(BASE, { waitUntil: "networkidle" });
await pageB.waitForTimeout(1200);
await pageB.getByText("Full Flow").click();
await pageB.waitForTimeout(1200);

// B renames the project; A (already loaded, stale) then tries to write.
await pageB.locator("#project-name, input").first().fill("Renamed By Colleague").catch(async () => {
  await pageB.getByText("Full Flow").dblclick();
});
await pageB.waitForTimeout(1500);

// A now edits with a stale revision -> should surface a conflict, not clobber.
await page.getByText("Hero headline").first().click();
await page.waitForTimeout(400);
const conflictSeen = [];
page.on("response", (r) => { if (r.status() === 409) conflictSeen.push(r.url()); });
await page.locator('button[aria-label="Create new project"]').click().catch(() => {});
await page.waitForTimeout(800);

console.log("\npage errors:", errs);
await browser.close();
