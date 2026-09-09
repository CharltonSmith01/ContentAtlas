import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://localhost:5173";
const UPLOADS = path.join(process.cwd(), "data", "uploads");
const PW = "TenDelete";
const ok = (l, c) => console.log(`${c ? "PASS" : "FAIL"}  ${l}`);
const files = () => (fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : []);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

// two visually distinct mock screens
await page.goto("about:blank");
const png = (label, hue) => page.evaluate(({ label, hue }) => {
  const c = document.createElement("canvas");
  c.width = 800; c.height = 600;
  const x = c.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, 800, 600);
  x.fillStyle = hue; x.fillRect(0, 0, 800, 80);
  x.fillStyle = "#fff"; x.font = "bold 26px sans-serif"; x.fillText(label, 30, 50);
  x.strokeStyle = "#ccc"; x.lineWidth = 2; x.strokeRect(30, 140, 740, 70);
  return c.toDataURL("image/png");
}, { label, hue });
const shotA = (await png("Screen A", "#1e1b31")).split(",")[1];
const shotB = (await png("Screen B", "#0f766e")).split(",")[1];

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// Assert against our own baseline so this suite is order-independent: other
// projects may already exist on this server.
const baseFiles = files().length;
console.log(`uploads already on disk before this run: ${baseFiles}`);

async function upload(b64, name) {
  const [c] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('button[aria-label^="Upload screen to"]').first().click(),
  ]);
  await c.setFiles({ name, mimeType: "image/png", buffer: Buffer.from(b64, "base64") });
  await page.waitForTimeout(1600);
}

// helper: run a delete via the dialog
async function tryDelete(openDialog, password, { expectFail = false } = {}) {
  await openDialog();
  await page.waitForSelector("#confirm-dialog-password", { timeout: 5000 });
  await page.fill("#confirm-dialog-password", password);
  // Scope to the dialog: the trash icons behind the overlay also match /Delete/.
  const dialog = page.locator('[role="alertdialog"]');
  await dialog.locator("button").last().click();
  await page.waitForTimeout(1200);
  const stillOpen = (await page.locator("#confirm-dialog-password").count()) > 0;
  if (expectFail) return stillOpen;
  if (stillOpen) { // clean up so later steps aren't blocked
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(300);
  }
  return !stillOpen;
}

// ---------- setup: project with 2 pages, 2 screens, 1 hotspot ----------
await page.locator('button[aria-label="Create new project"]').click();
await page.waitForTimeout(200);
await page.fill("#new-project-name", "Delete Me");
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
await upload(shotA, "a.png");

await page.getByText("Add page").click();
await page.waitForTimeout(250);
await page.locator('input[placeholder="Page name"]').fill("Page 2");
await page.keyboard.press("Enter");
await page.waitForTimeout(600);
await page.locator('button[aria-label^="Upload screen to"]').nth(1).click().catch(() => {});
const [c2] = await Promise.all([
  page.waitForEvent("filechooser"),
  page.locator('button[aria-label^="Upload screen to"]').last().click(),
]);
await c2.setFiles({ name: "b.png", mimeType: "image/png", buffer: Buffer.from(shotB, "base64") });
await page.waitForTimeout(1600);

// hotspot on the current screen
await page.getByText("Add copy hotspot").first().click();
await page.waitForTimeout(300);
const box = await page.locator("img").first().boundingBox();
await page.mouse.move(box.x + 40, box.y + 130);
await page.mouse.down();
await page.mouse.move(box.x + 330, box.y + 190, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(800);

const filesAfterSetup = files();
console.log(`uploads on disk after setup: ${filesAfterSetup.length}`);
ok("this run added exactly two screenshots", filesAfterSetup.length === baseFiles + 2);

// ---------- 1. wrong password on a hotspot delete ----------
const openHotspotDelete = async () => {
  await page.getByText("New requirement").first().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.locator('button[aria-label="Delete this hotspot"]').click();
};
let stayedOpen = await tryDelete(openHotspotDelete, "wrongpassword", { expectFail: true });
ok("wrong password keeps dialog open", stayedOpen);
let err = await page.locator("#confirm-dialog-error").innerText().catch(() => "");
ok(`wrong password shows an error (${JSON.stringify(err)})`, /incorrect/i.test(err));
ok("hotspot still present after failed delete", (await page.locator("body").innerText()).includes("New requirement"));
await page.locator('[role="alertdialog"]').getByRole("button", { name: "Cancel" }).click();
await page.waitForTimeout(400);

// ---------- 2. empty password ----------
stayedOpen = await tryDelete(openHotspotDelete, "", { expectFail: true });
ok("empty password refused client-side", stayedOpen);
err = await page.locator("#confirm-dialog-error").innerText().catch(() => "");
ok(`empty password prompts for entry (${JSON.stringify(err)})`, /enter the admin password/i.test(err));
await page.locator('[role="alertdialog"]').getByRole("button", { name: "Cancel" }).click();
await page.waitForTimeout(400);

// ---------- 3. correct password deletes the hotspot ----------
const closed = await tryDelete(openHotspotDelete, PW);
ok("correct password closes dialog", closed);
await page.waitForTimeout(600);
ok("hotspot actually gone", !(await page.locator("body").innerText()).includes("New requirement"));

// ---------- 4. delete a screen -> its image must leave disk ----------
const before = files();
await tryDelete(async () => {
  await page.locator('button[aria-label^="Delete screen"]').first().click();
}, PW);
await page.waitForTimeout(1000);
const afterScreen = files();
ok(`screen delete removed its image from disk (${before.length} -> ${afterScreen.length})`,
   afterScreen.length === before.length - 1);

// ---------- 5. delete the whole project -> remaining image leaves disk ----------
await tryDelete(async () => {
  await page.locator('button[aria-label^="Delete project"]').first().click();
}, PW);
await page.waitForTimeout(1200);
ok("our project gone from sidebar", !(await page.locator("body").innerText()).includes("Delete Me"));
const afterProject = files();
ok(`project delete removed its remaining image (${afterScreen.length} -> ${afterProject.length})`,
   afterProject.length === baseFiles);

console.log("\nfiles left in uploads/:", afterProject);
console.log("page errors:", errs);
await browser.close();
