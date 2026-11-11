// Run after `python3 docs-site/build.py`: node --test docs-site/test_ui.cjs
// PLAYWRIGHT_MODULE_PATH may point to another checkout's @playwright/test.
// UI_QA_OUTPUT_DIR optionally selects the screenshot destination.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { readFile, stat } = require("node:fs/promises");
const { existsSync, mkdirSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH ||
    "../Frontend_py_whatsaapweb/node_modules/@playwright/test",
);

const dist = path.join(__dirname, "dist");
const output =
  process.env.UI_QA_OUTPUT_DIR ||
  mkdtempSync(path.join(tmpdir(), "whatsap-showcase-ui-"));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
  ".apk": "application/vnd.android.package-archive",
};

async function serveBuild() {
  assert.ok(
    existsSync(path.join(dist, "index.html")),
    "Build docs-site/dist before running UI tests.",
  );
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
      let file = path.resolve(dist, `.${pathname}`);
      if (file !== dist && !file.startsWith(dist + path.sep)) {
        response.writeHead(403).end();
        return;
      }
      if ((await stat(file)).isDirectory())
        file = path.join(file, "index.html");
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": mime[path.extname(file)] || "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function revealPage(page) {
  await page.evaluate(async () => {
    for (
      let y = 0;
      y < document.documentElement.scrollHeight;
      y += innerHeight
    ) {
      scrollTo({ top: y, behavior: "instant" });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    }
    scrollTo({ top: 0, behavior: "instant" });
  });
}

async function assertNoOverflow(page) {
  const size = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(
    size.content <= size.viewport + 1,
    `Horizontal overflow: ${JSON.stringify(size)}`,
  );
  const clippedControls = await page.evaluate(() => {
    const header = document
      .querySelector(".site-header")
      .getBoundingClientRect();
    return [".wordmark", ".nav-download", ".menu-toggle"].filter((selector) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === "none")
        return false;
      const rect = element.getBoundingClientRect();
      return rect.top < header.top - 1 || rect.bottom > header.bottom + 1;
    });
  });
  assert.deepEqual(
    clippedControls,
    [],
    "Header controls extend outside the header",
  );
  const menuAlignment = await page.evaluate(() => {
    const menu = document.querySelector(".menu-toggle");
    if (
      !document.documentElement.classList.contains("js") ||
      getComputedStyle(menu).display === "none"
    )
      return null;
    const logo = document.querySelector(".wordmark").getBoundingClientRect();
    const button = menu.getBoundingClientRect();
    return {
      logoCenter: logo.top + logo.height / 2,
      menuCenter: button.top + button.height / 2,
    };
  });
  if (menuAlignment)
    assert.ok(
      Math.abs(menuAlignment.logoCenter - menuAlignment.menuCenter) <= 3,
      `Mobile menu wraps below the logo: ${JSON.stringify(menuAlignment)}`,
    );
  const titleEdges = await page.locator("#hero-title").evaluate((title) => {
    const range = document.createRange();
    range.selectNodeContents(title);
    return [...range.getClientRects()].map((rect) => ({
      left: rect.left,
      right: rect.right,
    }));
  });
  assert.ok(
    titleEdges.every((rect) => rect.left >= 0 && rect.right <= size.viewport),
    `Hero title is clipped: ${JSON.stringify(titleEdges)}`,
  );
}

test(
  "showcase works across desktop, tablet, mobile and browser preferences",
  { timeout: 120000 },
  async (t) => {
    mkdirSync(output, { recursive: true });
    const { server, origin } = await serveBuild();
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const browser = await chromium.launch();
    t.after(() => browser.close());

    for (const width of [1440, 768, 320, 375, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 1440 ? 1000 : 900 },
        reducedMotion: "reduce",
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("response", (response) => {
        if (response.status() >= 400)
          errors.push(`${response.status()} ${response.url()}`);
      });
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);

      await t.test(`${width}: assets and fonts load`, async () => {
        const broken = await page
          .locator("img")
          .evaluateAll((images) =>
            images
              .filter((image) => image.complete && !image.naturalWidth)
              .map((image) => image.src),
          );
        assert.deepEqual(broken, []);
        assert.equal(
          await page.evaluate(() => document.fonts.check("16px Geist")),
          true,
        );
        assert.deepEqual(errors, []);
      });
      await t.test(
        `${width}: no horizontal overflow or clipped hero title`,
        () => assertNoOverflow(page),
      );
      await t.test(`${width}: reduced motion applies initially`, async () => {
        assert.equal(
          await page
            .locator("html")
            .evaluate((element) => element.classList.contains("motion-off")),
          true,
        );
        assert.equal(
          await page.locator(".motion-toggle").getAttribute("aria-pressed"),
          "true",
        );
        assert.equal(
          await page
            .locator(".glass-art")
            .evaluate((element) => getComputedStyle(element).animationName),
          "none",
        );
        assert.equal(
          await page
            .locator("html")
            .evaluate((element) => getComputedStyle(element).scrollBehavior),
          "auto",
        );
      });
      await t.test(
        `${width}: product tabs support pointer and keyboard`,
        async () => {
          const tabs = page.locator("[data-product-tab]");
          await tabs.nth(1).click();
          assert.equal(await page.locator("#panel-studio").isVisible(), true);
          assert.equal(await page.locator("#panel-inbox").isVisible(), false);
          await tabs.nth(1).press("ArrowLeft");
          assert.equal(await tabs.nth(0).getAttribute("aria-selected"), "true");
          assert.equal(
            await tabs
              .nth(0)
              .evaluate((element) => element === document.activeElement),
            true,
          );
          await tabs.nth(0).press("End");
          assert.equal(await tabs.nth(1).getAttribute("tabindex"), "0");
          await tabs.nth(1).press("Home");
          assert.equal(await tabs.nth(0).getAttribute("tabindex"), "0");
        },
      );
      await t.test(
        `${width}: assisted and automatic modes update`,
        async () => {
          await page.locator("[data-mode=auto]").click();
          assert.match(
            await page.locator("#mode-title").textContent(),
            /dentro de tus reglas/,
          );
          assert.equal(
            await page.locator("[data-mode=auto]").getAttribute("aria-pressed"),
            "true",
          );
          await page.locator("[data-mode=suggest]").click();
          assert.match(
            await page.locator("#mode-title").textContent(),
            /Tu equipo responde/,
          );
          assert.equal(
            await page
              .locator("[data-mode=suggest]")
              .getAttribute("aria-pressed"),
            "true",
          );
        },
      );
      await t.test(
        `${width}: code tabs, labels and clipboard work`,
        async () => {
          const tabs = page.locator("[data-code-tab]");
          await tabs.nth(1).click();
          assert.match(
            await page.locator("#code-example").textContent(),
            /import os/,
          );
          await tabs.nth(1).press("ArrowRight");
          assert.match(
            await page.locator("#code-example").textContent(),
            /curl --request GET/,
          );
          assert.equal(
            await page
              .locator("#integration-code")
              .getAttribute("aria-labelledby"),
            await tabs.nth(2).getAttribute("id"),
          );
          await page.locator(".copy-code").click();
          await page.getByText("Copiado", { exact: true }).waitFor();
          assert.equal(
            await page.evaluate(() => navigator.clipboard.readText()),
            await page.locator("#code-example").textContent(),
          );
          await tabs.nth(2).press("Home");
        },
      );
      if (width < 620) {
        await t.test(
          `${width}: mobile menu closes on Escape and navigation`,
          async () => {
            await page.evaluate(() =>
              scrollTo({ top: 0, behavior: "instant" }),
            );
            const menu = page.locator(".menu-toggle");
            await menu.click();
            assert.equal(await menu.getAttribute("aria-expanded"), "true");
            await page
              .locator("#primary-nav a")
              .first()
              .waitFor({ state: "visible" });
            await page.keyboard.press("Escape");
            assert.equal(await menu.getAttribute("aria-expanded"), "false");
            assert.equal(
              await menu.evaluate(
                (element) => element === document.activeElement,
              ),
              true,
            );
            await menu.click();
            await page.locator("#primary-nav a").first().click();
            assert.equal(await menu.getAttribute("aria-expanded"), "false");
          },
        );
      }
      await t.test(`${width}: section anchors have targets`, async () => {
        const missing = await page
          .locator('a[href^="#"]')
          .evaluateAll((anchors) =>
            anchors
              .map((anchor) => anchor.getAttribute("href"))
              .filter(
                (href) =>
                  href !== "#" && !document.getElementById(href.slice(1)),
              ),
          );
        assert.deepEqual(missing, []);
      });
      await revealPage(page);
      await t.test(
        `${width}: layout remains contained after interactions`,
        async () => {
          await assertNoOverflow(page);
          assert.deepEqual(errors, []);
        },
      );
      await page.screenshot({
        path: path.join(output, `full-${width}.png`),
        fullPage: true,
      });
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.screenshot({ path: path.join(output, `hero-${width}.png`) });
      await context.close();
    }

    for (const width of [1440, 375]) {
      await t.test(
        `${width}: readable content and navigation without JavaScript`,
        async () => {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            javaScriptEnabled: false,
            reducedMotion: "reduce",
          });
          try {
            const page = await context.newPage();
            await page.goto(origin, { waitUntil: "networkidle" });
            for (const selector of [
              "#hero-title",
              "#product-title",
              "#primary-nav a",
              "#panel-inbox",
            ]) {
              assert.equal(
                await page.locator(selector).first().isVisible(),
                true,
                `${selector} should remain visible`,
              );
            }
            assert.match(
              await page.locator("#code-example").textContent(),
              /AutomatClient/,
            );
            for (const selector of [
              ".menu-toggle",
              ".motion-toggle",
              ".copy-code",
              "[data-product-tab]",
              "[data-code-tab]",
              "[data-mode]",
            ]) {
              assert.equal(
                await page.locator(selector).first().isVisible(),
                false,
                `${selector} must not expose an inert control`,
              );
            }
            const bounds = await page.evaluate(() => ({
              header: document
                .querySelector(".site-header")
                .getBoundingClientRect().bottom,
              nav: document
                .querySelector("#primary-nav")
                .getBoundingClientRect().bottom,
            }));
            assert.ok(
              bounds.nav <= bounds.header + 1,
              "Navigation extends outside the header without JavaScript",
            );
            await assertNoOverflow(page);
            if (width === 375)
              await page.screenshot({
                path: path.join(output, "no-js-375.png"),
                fullPage: true,
              });
          } finally {
            await context.close();
          }
        },
      );
    }

    await t.test(
      "motion toggle persists and follows runtime reduced-motion preference",
      async () => {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
        });
        try {
          const page = await context.newPage();
          await page.goto(origin, { waitUntil: "networkidle" });
          const button = page.locator(".motion-toggle");
          assert.equal(await button.getAttribute("aria-pressed"), "false");
          await button.click();
          assert.equal(await button.getAttribute("aria-pressed"), "true");
          assert.equal(
            await page
              .locator("html")
              .evaluate((element) => getComputedStyle(element).scrollBehavior),
            "auto",
          );
          await page.reload();
          assert.equal(await button.getAttribute("aria-pressed"), "true");
          await button.click();
          assert.equal(await button.getAttribute("aria-pressed"), "false");
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.waitForFunction(() =>
            document.documentElement.classList.contains("motion-off"),
          );
          assert.equal(await button.isDisabled(), true);
          await page.reload();
          assert.equal(await button.getAttribute("aria-pressed"), "true");
          assert.equal(await button.isDisabled(), true);
          await page.emulateMedia({ reducedMotion: "no-preference" });
          await page.waitForFunction(
            () => !document.documentElement.classList.contains("motion-off"),
          );
          assert.equal(await button.isEnabled(), true);
        } finally {
          await context.close();
        }
      },
    );
    for (const width of [1440, 375]) {
      await t.test(
        `${width}: documentation matches the site and serves its downloads`,
        async () => {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            reducedMotion: "reduce",
          });
          try {
            const page = await context.newPage();
            await page.goto(origin, { waitUntil: "networkidle" });
            const canvas = await page
              .locator("body")
              .evaluate((element) => getComputedStyle(element).backgroundColor);
            await page.goto(origin + "/docs.html", {
              waitUntil: "networkidle",
            });
            assert.equal(
              await page
                .locator("body")
                .evaluate(
                  (element) => getComputedStyle(element).backgroundColor,
                ),
              canvas,
            );
            assert.equal(
              await page
                .locator("html")
                .evaluate((element) => getComputedStyle(element).colorScheme),
              "dark",
            );
            assert.ok(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth + 1,
              ),
              "Documentation overflows horizontally",
            );
            assert.equal(
              await page.locator("a.brand").getAttribute("href"),
              "index.html",
            );
            const archive = await context.request.get(
              origin + "/downloads/whatsap-automat-docs.zip",
            );
            assert.equal(archive.status(), 200);
            assert.equal(
              (await archive.body()).subarray(0, 2).toString(),
              "PK",
            );
            const contract = await context.request.get(
              origin + "/downloads/openapi.v1.json",
            );
            assert.equal(contract.status(), 200);
            assert.match((await contract.json()).openapi, /^3\.1\./);
            await page.screenshot({
              path: path.join(output, `docs-${width}.png`),
              fullPage: true,
            });
            await page.locator("a.brand").click();
            await page.waitForURL(origin + "/index.html");
            assert.equal(await page.locator("#hero-title").isVisible(), true);
          } finally {
            await context.close();
          }
        },
      );
    }

    await t.test(
      "copy remains usable when clipboard access is unavailable",
      async () => {
        const context = await browser.newContext({
          viewport: { width: 390, height: 900 },
          reducedMotion: "reduce",
        });
        try {
          await context.addInitScript(() => {
            Object.defineProperty(navigator, "clipboard", {
              value: {
                writeText: async () => {
                  throw new Error(
                    "Clipboard unavailable in this browser context",
                  );
                },
              },
            });
          });
          const page = await context.newPage();
          await page.goto(origin, { waitUntil: "networkidle" });
          await page.locator(".copy-code").click();
          await page
            .locator(".copy-feedback")
            .filter({ hasText: /Ctrl\+C/ })
            .waitFor();
          assert.equal(
            await page.evaluate(() => window.getSelection().toString()),
            await page.locator("#code-example").textContent(),
          );
        } finally {
          await context.close();
        }
      },
    );
    t.diagnostic(`Screenshots: ${output}`);
  },
);
