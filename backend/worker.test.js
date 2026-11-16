import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  CinetPayConfigurationError,
  CinetPayProviderError,
  initializeCinetPaySandboxPayment,
} from "./cinetpay.js";
import worker from "./worker.js";

const origin = "https://kiffi27.github.io";
const migrations = readdirSync(new URL("./migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8"));

class TestStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new TestStatement(this.database, this.sql, values);
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new TestStatement(this.database, sql);
  }

  batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createStore() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) database.exec(migration);
  const rateLimitCalls = [];
  const env = {
    DB: new TestD1Database(database),
    ALLOWED_ORIGIN: origin,
    STORE_ENABLED: "true",
    ORDERS_ENABLED: "true",
    API_RATE_LIMITER: {
      limit: async (request) => {
        rateLimitCalls.push(request);
        return { success: true };
      },
    },
  };
  return {
    env,
    rateLimitCalls,
    close: () => database.close(),
    seedProduct: (id, name, priceXof, stock, isActive = 1, shopName = "Boutique du test") => env.DB.prepare(
      "INSERT INTO products (id, name, price_xof, stock, is_active, shop_name) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, name, priceXof, stock, isActive, shopName).run(),
  };
}

function sandboxEnv(overrides = {}) {
  return {
    ALLOWED_ORIGIN: "https://kiffi27.github.io",
    CINETPAY_MODE: "sandbox",
    CINETPAY_SANDBOX_API_KEY: "sk_test_example_only",
    CINETPAY_SANDBOX_API_PASSWORD: "test-password-placeholder",
    CINETPAY_SUCCESS_URL: "https://kiffi27.github.io/petits-prix-pages/aide/",
    CINETPAY_FAILED_URL: "https://kiffi27.github.io/petits-prix-pages/aide/",
    CINETPAY_NOTIFY_URL: "https://orders.example/api/payments/cinetpay/notify",
    ...overrides,
  };
}

function request(path, env, { method = "GET", body, originHeader = origin, contentType } = {}) {
  const headers = { "CF-Connecting-IP": "203.0.113.1" };
  if (originHeader) headers.Origin = originHeader;
  if (body !== undefined) headers["Content-Type"] = contentType || "application/json";

  return worker.fetch(new Request(`https://orders.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

async function withStore(run) {
  const store = createStore();
  try {
    store.seedProduct("lamp", "Lampe d’exemple", 12500, 5);
    store.seedProduct("basket", "Panier d’exemple", 8000, 3);
    store.seedProduct("hidden", "Article indisponible", 5000, 2, 0);
    store.seedProduct("sold", "Article épuisé", 5000, 0);
    await run(store);
  } finally {
    store.close();
  }
}

test("refuses CinetPay payment initialization unless Sandbox is explicitly configured", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("Sandbox configuration must be checked before outbound requests.");
  };

  await assert.rejects(
    initializeCinetPaySandboxPayment(
      { orderId: "12345678-1234-1234-1234-123456789012", amountXof: 1000 },
      sandboxEnv({ CINETPAY_MODE: "production" }),
      fetchImpl,
    ),
    CinetPayConfigurationError,
  );
  await assert.rejects(
    initializeCinetPaySandboxPayment(
      { orderId: "12345678-1234-1234-1234-123456789012", amountXof: 1000 },
      sandboxEnv({ CINETPAY_SANDBOX_API_KEY: "production-key" }),
      fetchImpl,
    ),
    CinetPayConfigurationError,
  );
  assert.equal(calls, 0);
});

test("refuses CinetPay without a test API password or HTTPS callback URLs", async () => {
  const order = { orderId: "12345678-1234-1234-1234-123456789012", amountXof: 1000 };
  await assert.rejects(
    initializeCinetPaySandboxPayment(order, sandboxEnv({ CINETPAY_SANDBOX_API_PASSWORD: "" })),
    CinetPayConfigurationError,
  );
  await assert.rejects(
    initializeCinetPaySandboxPayment(order, sandboxEnv({ CINETPAY_NOTIFY_URL: "http://orders.example/notify" })),
    CinetPayConfigurationError,
  );
  await assert.rejects(
    initializeCinetPaySandboxPayment(order, sandboxEnv({ CINETPAY_SUCCESS_URL: "https://attacker.example/redirect" })),
    CinetPayConfigurationError,
  );
});

test("rejects invalid payment amounts and transaction IDs before making provider requests", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({});
  };
  const env = sandboxEnv();

  await assert.rejects(
    initializeCinetPaySandboxPayment(
      { orderId: "order-from-client", amountXof: 1000 },
      env,
      fetchImpl,
    ),
    TypeError,
  );
  await assert.rejects(
    initializeCinetPaySandboxPayment(
      { orderId: "12345678-1234-1234-1234-123456789012", amountXof: 0 },
      env,
      fetchImpl,
    ),
    TypeError,
  );
  assert.equal(calls, 0);
});

test("initializes a test payment with the server-supplied amount and returns only a CinetPay URL", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth/login")) {
      return Response.json({ access_token: "mock-access-token" });
    }
    return Response.json({
      payment_token: "mock-payment-token",
      payment_url: "https://checkout.cinetpay.com/pay/mock-payment-token",
    });
  };

  const result = await initializeCinetPaySandboxPayment({
    orderId: "12345678-1234-1234-1234-123456789012",
    amountXof: 12500,
  }, sandboxEnv(), fetchImpl);

  assert.deepEqual(result, {
    paymentToken: "mock-payment-token",
    paymentUrl: "https://checkout.cinetpay.com/pay/mock-payment-token",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.cinetpay.net/v1/oauth/login");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    api_key: "sk_test_example_only",
    api_password: "test-password-placeholder",
  });
  assert.equal(calls[1].url, "https://api.cinetpay.net/v1/payment");
  assert.equal(calls[1].options.headers.Authorization, "Bearer mock-access-token");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    currency: "XOF",
    merchant_transaction_id: "12345678-1234-1234-1234-123456789012",
    amount: 12500,
    lang: "fr",
    designation: "Commande de test 12345678-1234-1234-1234-123456789012",
    success_url: "https://kiffi27.github.io/petits-prix-pages/aide/",
    failed_url: "https://kiffi27.github.io/petits-prix-pages/aide/",
    notify_url: "https://orders.example/api/payments/cinetpay/notify",
    channel: "PUSH",
    direct_pay: false,
  });
});

test("rejects malformed or non-CinetPay redirects from provider responses", async () => {
  const fetchImpl = async (url) => (url.endsWith("/oauth/login")
    ? Response.json({ access_token: "mock-access-token" })
    : Response.json({
      payment_token: "mock-payment-token",
      payment_url: "https://checkout.attacker.example/steal",
    }));

  await assert.rejects(
    initializeCinetPaySandboxPayment({
      orderId: "12345678-1234-1234-1234-123456789012",
      amountXof: 12500,
    }, sandboxEnv(), fetchImpl),
    CinetPayProviderError,
  );
});

test("does not include a provider error response or credential in thrown errors", async () => {
  const fetchImpl = async (url) => (url.endsWith("/oauth/login")
    ? new Response(JSON.stringify({ error: "sensitive provider diagnostics" }), { status: 401 })
    : Response.json({}));
  const apiPassword = "test-password-placeholder";

  await assert.rejects(
    initializeCinetPaySandboxPayment({
      orderId: "12345678-1234-1234-1234-123456789012",
      amountXof: 1000,
    }, sandboxEnv({ CINETPAY_SANDBOX_API_PASSWORD: apiPassword }), fetchImpl),
    (error) => {
      assert.equal(error instanceof CinetPayProviderError, true);
      assert.equal(error.message.includes(apiPassword), false);
      assert.equal(error.message.includes("sensitive provider diagnostics"), false);
      return true;
    },
  );
});

test("only lists active products in stock with their shop name", () => withStore(async ({ env }) => {
    const response = await request("/api/products", env);
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(result.products.map((product) => product.id), ["lamp", "basket"]);
    assert.equal(result.products[0].shopName, "Boutique du test");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }));

test("requires a non-empty shop name for catalog entries", () => withStore(async ({ env }) => {
    assert.throws(() => env.DB.prepare(
      "INSERT INTO products (id, name, price_xof, stock, is_active, shop_name) "
        + "VALUES ('missing-shop', 'Produit', 1000, 1, 1, '   ')",
    ).run(), /product shop name is required/);
  }));

test("keeps catalogue and order APIs closed unless the store is explicitly enabled", () => withStore(async ({ env }) => {
    const disabledEnv = { ...env, STORE_ENABLED: "false" };
    const catalogueResponse = await request("/api/products", disabledEnv);
    const orderResponse = await request("/api/orders", disabledEnv, {
      method: "POST",
      body: { items: [{ productId: "lamp", quantity: 1 }] },
    });

    assert.equal(catalogueResponse.status, 503);
    assert.equal(orderResponse.status, 503);
    assert.equal((await env.DB.prepare("SELECT stock FROM products WHERE id = 'lamp'").first()).stock, 5);
    assert.equal((await env.DB.prepare("SELECT count(*) AS count FROM orders").first()).count, 0);
  }));

test("keeps order creation disabled when the catalog is enabled", () => withStore(async ({ env }) => {
    const response = await request("/api/orders", { ...env, ORDERS_ENABLED: "false" }, {
      method: "POST",
      body: { items: [{ productId: "lamp", quantity: 1 }] },
    });

    assert.equal(response.status, 503);
    assert.equal((await env.DB.prepare("SELECT count(*) AS count FROM orders").first()).count, 0);
  }));

test("requires the Cloudflare rate-limit binding and client address", () => withStore(async ({ env }) => {
    const missingBinding = { ...env };
    delete missingBinding.API_RATE_LIMITER;
    const missingAddress = worker.fetch(new Request("https://orders.example/api/products", {
      headers: { Origin: origin },
    }), env);

    assert.equal((await request("/api/products", missingBinding)).status, 503);
    assert.equal((await missingAddress).status, 503);
  }));

test("returns a retry hint when the Cloudflare rate limit is exceeded", () => withStore(async ({ env }) => {
    const limitedEnv = {
      ...env,
      API_RATE_LIMITER: { limit: async () => ({ success: false }) },
    };
    const response = await request("/api/orders", limitedEnv, {
      method: "POST",
      body: { items: [{ productId: "lamp", quantity: 1 }] },
    });

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal((await env.DB.prepare("SELECT count(*) AS count FROM orders").first()).count, 0);
  }));

test("weights order submissions more heavily than catalog reads", () => withStore(async ({ env, rateLimitCalls }) => {
    await request("/api/products", env);
    await request("/api/orders", env, {
      method: "POST",
      body: { items: [{ productId: "lamp", quantity: 1 }] },
    });

    assert.deepEqual(rateLimitCalls, [
      { key: "203.0.113.1", delta: 1 },
      { key: "203.0.113.1", delta: 10 },
    ]);
  }));

test("creates a pending order using current server prices and reserves stock atomically", () => withStore(async ({ env }) => {
    const response = await request("/api/orders", env, {
      method: "POST",
      body: { items: [{ productId: "lamp", quantity: 2 }, { productId: "basket", quantity: 1 }] },
    });
    const { order } = await response.json();
    const rows = await env.DB.prepare(
        "SELECT product_id, shop_name, unit_price_xof, quantity, line_total_xof FROM order_items "
        + "WHERE order_id = ? ORDER BY product_id",
    ).bind(order.id).all();
    const stock = await env.DB.prepare(
      "SELECT id, stock FROM products WHERE id IN ('lamp', 'basket') ORDER BY id",
    ).all();

    assert.equal(response.status, 201);
    assert.deepEqual(order, {
      id: order.id,
      status: "pending",
      totalXof: 33000,
      payment: "not_enabled",
    });
    assert.match(order.id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(rows.results.map((row) => ({ ...row })), [
      { product_id: "basket", shop_name: "Boutique du test", unit_price_xof: 8000, quantity: 1, line_total_xof: 8000 },
      { product_id: "lamp", shop_name: "Boutique du test", unit_price_xof: 12500, quantity: 2, line_total_xof: 25000 },
    ]);
    assert.deepEqual(stock.results.map((row) => ({ ...row })), [
      { id: "basket", stock: 2 },
      { id: "lamp", stock: 3 },
    ]);
  }));

test("rejects orders combining products from different shops", () => withStore(async ({ env }) => {
    await env.DB.prepare(
      "INSERT INTO products (id, name, price_xof, stock, is_active, shop_name) "
        + "VALUES ('other', 'Produit de l’autre boutique', 2000, 3, 1, 'Autre boutique')",
    ).run();

    const response = await request("/api/orders", env, {
      method: "POST",
      body: { items: [{ productId: "lamp", quantity: 1 }, { productId: "other", quantity: 1 }] },
    });

    assert.equal(response.status, 409);
    assert.equal((await env.DB.prepare("SELECT stock FROM products WHERE id = 'lamp'").first()).stock, 5);
    assert.equal((await env.DB.prepare("SELECT count(*) AS count FROM orders").first()).count, 0);
  }));

test("rejects orders from an unapproved origin", () => withStore(async ({ env }) => {
    const response = await request("/api/orders", env, {
      method: "POST",
      originHeader: "https://not-the-store.example",
      body: { items: [{ productId: "lamp", quantity: 1 }] },
    });

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }));

test("does not expose a CinetPay route before account approval and deployment", () => withStore(async ({ env }) => {
    const response = await request("/api/payments/cinetpay/sandbox", env, {
      method: "POST",
      body: { orderId: "12345678-1234-1234-1234-123456789012" },
    });

    assert.equal(response.status, 404);
  }));

test("rejects client-supplied prices and duplicate product ids", () => withStore(async ({ env }) => {
    const priceResponse = await request("/api/orders", env, {
      method: "POST",
      body: { items: [{ productId: "lamp", quantity: 1, priceXof: 1 }] },
    });
    const duplicateResponse = await request("/api/orders", env, {
      method: "POST",
      body: { items: [{ productId: "lamp", quantity: 1 }, { productId: "lamp", quantity: 1 }] },
    });

    assert.equal(priceResponse.status, 400);
    assert.equal(duplicateResponse.status, 400);
    assert.equal((await env.DB.prepare("SELECT count(*) AS count FROM orders").first()).count, 0);
  }));

test("rejects unavailable products without partially reserving other items", () => withStore(async ({ env }) => {
    const response = await request("/api/orders", env, {
      method: "POST",
      body: { items: [{ productId: "lamp", quantity: 1 }, { productId: "sold", quantity: 1 }] },
    });
    const lamp = await env.DB.prepare("SELECT stock FROM products WHERE id = 'lamp'").first();
    const orders = await env.DB.prepare("SELECT count(*) AS count FROM orders").first();

    assert.equal(response.status, 409);
    assert.equal(lamp.stock, 5);
    assert.equal(orders.count, 0);
  }));

test("allows only one order to reserve the last unit", () => withStore(async ({ env }) => {
    await env.DB.prepare("UPDATE products SET stock = 1 WHERE id = 'lamp'").run();

    const responses = await Promise.all([
      request("/api/orders", env, {
        method: "POST",
        body: { items: [{ productId: "lamp", quantity: 1 }] },
      }),
      request("/api/orders", env, {
        method: "POST",
        body: { items: [{ productId: "lamp", quantity: 1 }] },
      }),
    ]);
    const stock = await env.DB.prepare("SELECT stock FROM products WHERE id = 'lamp'").first();

    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    assert.equal(stock.stock, 0);
    assert.equal((await env.DB.prepare("SELECT count(*) AS count FROM orders").first()).count, 1);
  }));

test("rejects oversized requests and non-JSON payloads", () => withStore(async ({ env }) => {
    const largeResponse = await worker.fetch(new Request("https://orders.example/api/orders", {
      method: "POST",
      headers: {
        Origin: origin,
        "CF-Connecting-IP": "203.0.113.1",
        "Content-Type": "application/json",
        "Content-Length": "9000",
      },
      body: JSON.stringify({ items: [] }),
    }), env);
    const typeResponse = await request("/api/orders", env, {
      method: "POST",
      body: {},
      contentType: "text/plain",
    });

    assert.equal(largeResponse.status, 413);
    assert.equal(typeResponse.status, 415);
  }));
