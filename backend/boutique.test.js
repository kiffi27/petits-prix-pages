import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import worker from "./worker.js";

const siteOrigin = "https://kiffi27.github.io";
const script = readFileSync(new URL("../boutique.js", import.meta.url), "utf8");

function createElement(tagName = "div") {
  return {
    tagName: tagName.toUpperCase(),
    className: "",
    dataset: {},
    children: [],
    attributes: {},
    textContent: "",
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = [...children];
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    closest(selector) {
      return selector === "button" && this.tagName === "BUTTON" ? this : null;
    },
  };
}

function createPage(apiBaseUrl, fetchImpl) {
  const elements = {
    "[data-product-grid]": createElement(),
    "[data-cart-items]": createElement(),
    "[data-cart-total]": createElement(),
    "[data-cart-feedback]": createElement(),
  };
  const cartCounts = [createElement("span"), createElement("span")];
  const listeners = new Map();
  const fetchCalls = [];
  const document = {
    querySelector(selector) {
      if (selector === 'meta[name="store-api-url"]') return { content: apiBaseUrl };
      return elements[selector] || null;
    },
    querySelectorAll(selector) {
      return selector === "[data-cart-count]" ? cartCounts : [];
    },
    createElement,
    addEventListener(eventName, listener) {
      listeners.set(eventName, listener);
    },
  };

  runInNewContext(script, {
    document,
    fetch: (...args) => {
      fetchCalls.push(args);
      return fetchImpl(...args);
    },
    Intl,
    URL,
    Map,
  });

  return {
    elements,
    cartCounts,
    fetchCalls,
    listeners,
    tick: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("keeps the catalog empty and makes no request when the API URL is unset", async () => {
  const page = createPage("", async () => {
    throw new Error("Fetch must not run without an API URL.");
  });
  await page.tick();

  assert.equal(page.fetchCalls.length, 0);
  assert.match(page.elements["[data-product-grid]"].children[0].textContent, /API sécurisée/);
  assert.equal(page.cartCounts[0].textContent, 0);
});

test("loads only validated API products and keeps cart actions local", async () => {
  const page = createPage("https://orders.example", async (url, options) => ({
    ok: true,
    json: async () => ({
      products: [{
        id: "product-1",
        shopName: "Boutique confirmée",
        name: "<img src=x onerror=alert(1)>",
        variantLabel: "Pointure 45",
        priceXof: 2500,
        available: 2,
      }],
    }),
  }));
  await page.tick();

  const grid = page.elements["[data-product-grid]"];
  assert.equal(page.fetchCalls.length, 1);
  assert.equal(page.fetchCalls[0][0].toString(), "https://orders.example/api/products");
  assert.equal(page.fetchCalls[0][1].credentials, "omit");
  assert.equal(grid.children.length, 1);
  assert.equal(grid.children[0].children.some((child) => child.tagName === "IMG"), false);
  assert.match(grid.children[0].children[1].textContent, /<img/);
  assert.equal(grid.children[0].children[2].textContent, "Pointure 45");

  const addButton = grid.children[0].children.find((child) => child.dataset.addToCart);
  const click = page.listeners.get("click");
  click({ target: addButton });
  click({ target: addButton });
  click({ target: addButton });

  assert.equal(page.cartCounts[0].textContent, 2);
  assert.equal(page.fetchCalls.length, 1);
  assert.match(
    page.elements["[data-cart-items]"].children[0].children[0].children[0].children[1].textContent,
    /Pointure 45/,
  );
  assert.match(page.elements["[data-cart-feedback]"].textContent, /disponibilité/);
});

test("renders the Worker catalog response without opening order submission", async () => {
  const rateLimitCalls = [];
  const env = {
    ALLOWED_ORIGIN: siteOrigin,
    STORE_ENABLED: "true",
    ORDERS_ENABLED: "false",
    API_RATE_LIMITER: {
      limit: async (request) => {
        rateLimitCalls.push(request);
        return { success: true };
      },
    },
    DB: {
      prepare: () => ({
        all: async () => ({
          results: [{
            id: "real-catalog-fixture",
            shopName: "Boutique test",
            name: "Article de test",
            variantLabel: "",
            priceXof: 2500,
            available: 2,
          }],
        }),
      }),
    },
  };
  const page = createPage("https://orders.example", (url, options) => worker.fetch(
    new Request(url, {
      method: options.method,
      headers: { Origin: siteOrigin, "CF-Connecting-IP": "203.0.113.1" },
    }),
    env,
  ));
  await page.tick();

  assert.equal(page.elements["[data-product-grid]"].children.length, 1);
  assert.match(page.elements["[data-product-grid]"].children[0].children[1].textContent, /Article de test/);
  assert.deepEqual(rateLimitCalls, [{ key: "203.0.113.1", delta: 1 }]);
  assert.equal(page.fetchCalls.length, 1);
  assert.equal(page.fetchCalls[0][1].credentials, "omit");
});

test("rejects insecure API URLs and malformed catalog responses", async () => {
  const insecure = createPage("http://orders.example", async () => {
    throw new Error("Fetch must not run for an insecure API URL.");
  });
  await insecure.tick();
  assert.equal(insecure.fetchCalls.length, 0);
  assert.match(insecure.elements["[data-product-grid]"].children[0].textContent, /configuration de l’API est invalide/);

  const malformed = createPage("https://orders.example", async () => ({
    ok: true,
    json: async () => ({
      products: [{
        id: "bad",
        shopName: "",
        name: "Produit sans vendeur",
        priceXof: 1000,
        available: 1,
      }],
    }),
  }));
  await malformed.tick();
  assert.match(malformed.elements["[data-product-grid]"].children[0].textContent, /format valide/);
});
