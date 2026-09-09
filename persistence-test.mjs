import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
const conflicts = [];
page.on("response", (r) => { if (r.status() === 409) conflicts.push(r.url()); });

const ok = (label, cond) => console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);

// mock screen
await page.goto("about:blank");
const b64 = (await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 900; c.height = 1000;
  const x = c.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, 900, 1000);
  x.fillStyle = "#1e1b31"; x.fillRect(0, 0, 900, 90);
  x.fillStyle = "#fff"; x.font = "bold 28px sans-serif"; x.fillText("Welcome aboard", 40, 55);
  [160, 260, 360].forEach((y) => { x.strokeStyle = "#d4d4d8"; x.lineWidth = 2; x.strokeRect(40, y, 820, 70); });
  x.fillStyle = "#f97316"; x.fillRect(40, 480, 300, 60);
  x.fillStyle = "#fff"; x.font = "bold 20px sans-serif"; x.fillText("Get started", 120, 518);
  return c.toDataURL("image/png");
})).split(",")[1];

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// --- create project + upload screen ---
await page.locator('button[aria-label="Create new project"]').click();
await page.waitForTimeout(200);
await page.fill("#new-project-name", "Full Flow");
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser"),
  page.locator('button[aria-label^="Upload screen to"]').first().click(),
]);
await chooser.setFiles({ name: "s.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") });
await page.waitForTimeout(1800);

// --- draw hotspot ---
await page.getByText("Add copy hotspot").first().click();
await page.waitForTimeout(300);
const box = await page.locator("img").first().boundingBox();
await page.mouse.move(box.x + 55, box.y + 145);
await page.mouse.down();
await page.mouse.move(box.x + 400, box.y + 205, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(800);

// --- STAGE 1: fill EVERY required field ---
await page.fill("#hs-title", "Hero headline");
await page.fill("#hs-tone", "Warm, direct");
await page.fill("#hs-charlimit", "48");
await page.fill("#hs-intent", "Reassure the user they finished setup.");
await page.fill("#hs-notes", "Avoid the word 'onboarding'.");
await page.fill("#hs-name-1", "Charlton");
await page.waitForTimeout(400);
await page.getByRole("button", { name: /^Submit requirements$/ }).click();
await page.waitForTimeout(1200);

let body = await page.locator("body").innerText();
ok("stage 1 submitted (stage 2 unlocked)", !body.includes("Unlocks once requirements are submitted"));

// --- STAGE 2: draft the copy ---
await page.fill("#hs-final-copy", "You're all set.");
await page.fill("#hs-name-2", "Sam");
await page.waitForTimeout(300);
await page.getByRole("button", { name: /^Submit copy$/ }).click();
await page.waitForTimeout(1200);
body = await page.locator("body").innerText();
ok("stage 2 submitted (status Drafted)", body.includes("Drafted"));

// --- STAGE 3: approve ---
await page.fill("#hs-name-3", "Alex");
await page.waitForTimeout(300);
await page.getByRole("button", { name: /^Approve$/ }).click();
await page.waitForTimeout(1200);
ok("stage 3 approved", (await page.locator("body").innerText()).includes("Approved"));
await page.screenshot({ path: "/tmp/f1-before-reload.png" });

// ===== RELOAD =====
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.getByText("Full Flow").click();
await page.waitForTimeout(1200);
ok("project survived reload", (await page.locator("body").innerText()).includes("Full Flow"));
ok("image survived reload", (await page.locator("img").count()) > 0);

// image actually loads (not a broken 404)
const imgOk = await page.locator("img").first().evaluate((el) => el.complete && el.naturalWidth > 0);
ok("image bytes actually served", imgOk);

await page.getByText("Hero headline").first().click();
await page.waitForTimeout(800);
body = await page.locator("body").innerText();
ok("hotspot title survived", body.includes("Hero headline"));
const hist = /VERSION HISTORY \((\d+)\)/.exec(body)?.[1];
ok(`version history persisted (got ${hist})`, Number(hist) > 0);
await page.screenshot({ path: "/tmp/f2-after-reload.png" });

// --- server truth ---
const server = await page.evaluate(async () => {
  const idx = await (await fetch("/api/projects")).json();
  const p = await (await fetch(`/api/projects/${idx.find(i => i.name === "Full Flow").id}`)).json();
  const s = p.data.pages[0].screens[0];
  const h = s.hotspots[0];
  return { rev: p.rev, image: s.image, label: h.label, tone: h.tone, charLimit: h.charLimit,
           finalCopy: h.finalCopy, historyStages: h.history.map(e => `${e.stage}:${e.name}`),
           projectJsonBytes: JSON.stringify(p.data).length };
});
console.log("\n=== server state ===");
console.log(server);
ok("image stored as URL not base64", !server.image.startsWith("data:"));
ok("project JSON stayed small (no inlined image)", server.projectJsonBytes < 5000);

console.log("\n409 conflicts during run:", conflicts.length);
console.log("page errors:", errors);
await browser.close();
