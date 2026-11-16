const API_BASE_URL = "https://api.cinetpay.net/v1";
const REQUEST_TIMEOUT_MS = 10000;

export class CinetPayConfigurationError extends Error {
  constructor() {
    super("La configuration CinetPay Sandbox est indisponible.");
    this.name = "CinetPayConfigurationError";
  }
}

export class CinetPayProviderError extends Error {
  constructor() {
    super("CinetPay n’a pas pu répondre à la demande de test.");
    this.name = "CinetPayProviderError";
  }
}

function parseHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function getSandboxCredentials(env) {
  if (env.CINETPAY_MODE !== "sandbox"
    || typeof env.CINETPAY_SANDBOX_API_KEY !== "string"
    || !env.CINETPAY_SANDBOX_API_KEY.startsWith("sk_test_")
    || typeof env.CINETPAY_SANDBOX_API_PASSWORD !== "string"
    || env.CINETPAY_SANDBOX_API_PASSWORD.length === 0) {
    throw new CinetPayConfigurationError();
  }

  const allowedOrigin = parseHttpsUrl(env.ALLOWED_ORIGIN);
  const successUrl = parseHttpsUrl(env.CINETPAY_SUCCESS_URL);
  const failedUrl = parseHttpsUrl(env.CINETPAY_FAILED_URL);
  const notifyUrl = parseHttpsUrl(env.CINETPAY_NOTIFY_URL);
  if (!allowedOrigin || !successUrl || !failedUrl || !notifyUrl
    || successUrl.href.length > 120 || failedUrl.href.length > 120
    || notifyUrl.href.length > 120
    || successUrl.origin !== allowedOrigin.origin
    || failedUrl.origin !== allowedOrigin.origin) {
    throw new CinetPayConfigurationError();
  }

  return {
    apiKey: env.CINETPAY_SANDBOX_API_KEY,
    apiPassword: env.CINETPAY_SANDBOX_API_PASSWORD,
    successUrl: successUrl.href,
    failedUrl: failedUrl.href,
    notifyUrl: notifyUrl.href,
  };
}

async function requestJson(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CinetPayProviderError();
  }

  if (!response.ok) throw new CinetPayProviderError();

  try {
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError();
    }
    return result;
  } catch {
    throw new CinetPayProviderError();
  }
}

function postJson(fetchImpl, url, body, headers = {}) {
  return requestJson(fetchImpl, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function getAccessToken(fetchImpl, credentials) {
  const auth = await postJson(fetchImpl, `${API_BASE_URL}/oauth/login`, {
    api_key: credentials.apiKey,
    api_password: credentials.apiPassword,
  });
  if (typeof auth.access_token !== "string"
    || auth.access_token.length < 1 || auth.access_token.length > 4096) {
    throw new CinetPayProviderError();
  }
  return auth.access_token;
}

function getPaymentResult(response, expectedMerchantTransactionId) {
  const paymentToken = response?.payment_token
    ?? response?.paymentToken
    ?? response?.data?.payment_token
    ?? response?.data?.paymentToken;
  const paymentUrl = response?.payment_url
    ?? response?.paymentUrl
    ?? response?.data?.payment_url
    ?? response?.data?.paymentUrl;
  const notifyToken = response?.notify_token ?? response?.data?.notify_token;
  const transactionId = response?.transaction_id ?? response?.data?.transaction_id;
  const merchantTransactionId = response?.merchant_transaction_id
    ?? response?.data?.merchant_transaction_id;

  if (typeof paymentToken !== "string" || paymentToken.length < 1 || paymentToken.length > 2048
    || typeof paymentUrl !== "string" || paymentUrl.length < 1 || paymentUrl.length > 2048
    || typeof notifyToken !== "string" || notifyToken.length < 1 || notifyToken.length > 512
    || typeof transactionId !== "string" || transactionId.length < 1 || transactionId.length > 128
    || typeof merchantTransactionId !== "string"
    || !/^[a-zA-Z0-9_-]{1,30}$/.test(merchantTransactionId)
    || merchantTransactionId !== expectedMerchantTransactionId
    || response.merchant_transaction_id === undefined && response?.data?.merchant_transaction_id === undefined
    || response.code !== undefined && response.code !== 200
    || response.status !== undefined && response.status !== "OK") {
    throw new CinetPayProviderError();
  }

  let url;
  try {
    url = new URL(paymentUrl);
  } catch {
    throw new CinetPayProviderError();
  }

  const trustedHost = url.hostname === "cinetpay.net"
    || url.hostname.endsWith(".cinetpay.net");
  if (url.protocol !== "https:" || !trustedHost || url.username || url.password) {
    throw new CinetPayProviderError();
  }

  return {
    paymentToken,
    paymentUrl: url.href,
    notifyToken,
    transactionId,
    merchantTransactionId,
  };
}

export async function initializeCinetPaySandboxPayment(
  { orderId, merchantTransactionId, amountXof, customer },
  env,
  fetchImpl = fetch,
) {
  const credentials = getSandboxCredentials(env);
  if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)
    || typeof merchantTransactionId !== "string"
    || !/^[a-zA-Z0-9_-]{1,30}$/.test(merchantTransactionId)
    || !Number.isSafeInteger(amountXof) || amountXof < 100 || amountXof > 2_500_000
    || !customer || typeof customer !== "object" || Array.isArray(customer)
    || typeof customer.email !== "string"
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)
    || customer.email.length > 254
    || typeof customer.firstName !== "string"
    || customer.firstName.length < 2 || customer.firstName.length > 255
    || typeof customer.lastName !== "string"
    || customer.lastName.length < 2 || customer.lastName.length > 255) {
    throw new TypeError("La demande de paiement Sandbox est invalide.");
  }

  const accessToken = await getAccessToken(fetchImpl, credentials);

  const result = await postJson(fetchImpl, `${API_BASE_URL}/payment`, {
    currency: "XOF",
    merchant_transaction_id: merchantTransactionId,
    amount: amountXof,
    lang: "fr",
    designation: `Commande de test ${orderId}`,
    client_email: customer.email,
    client_first_name: customer.firstName,
    client_last_name: customer.lastName,
    success_url: credentials.successUrl,
    failed_url: credentials.failedUrl,
    notify_url: credentials.notifyUrl,
    channel: "PUSH",
    direct_pay: false,
  }, {
    Authorization: `Bearer ${accessToken}`,
  });

  return getPaymentResult(result, merchantTransactionId);
}

export async function getCinetPaySandboxPaymentStatus(
  merchantTransactionId,
  env,
  fetchImpl = fetch,
) {
  const credentials = getSandboxCredentials(env);
  if (typeof merchantTransactionId !== "string"
    || !/^[a-zA-Z0-9_-]{1,30}$/.test(merchantTransactionId)) {
    throw new TypeError("L’identifiant de transaction Sandbox est invalide.");
  }

  const accessToken = await getAccessToken(fetchImpl, credentials);
  const result = await requestJson(
    fetchImpl,
    `${API_BASE_URL}/payment/${encodeURIComponent(merchantTransactionId)}`,
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const status = result.status;
  const transactionId = result.transaction_id;
  const expectedCode = {
    SUCCESS: 100,
    FAILED: 2010,
    PENDING: 2002,
    INITIATED: 2001,
    EXPIRED: 2003,
  }[status];
  if (!Number.isSafeInteger(result.code)
    || typeof status !== "string"
    || expectedCode === undefined || result.code !== expectedCode
    || result.merchant_transaction_id !== merchantTransactionId
    || typeof transactionId !== "string" || transactionId.length < 1 || transactionId.length > 128) {
    throw new CinetPayProviderError();
  }

  return {
    code: result.code,
    status,
    merchantTransactionId,
    transactionId,
  };
}

export function parseCinetPayNotification(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.notify_token !== "string"
    || body.notify_token.length < 1 || body.notify_token.length > 512
    || typeof body.transaction_id !== "string"
    || body.transaction_id.length < 1 || body.transaction_id.length > 128
    || typeof body.merchant_transaction_id !== "string"
    || !/^[a-zA-Z0-9_-]{1,30}$/.test(body.merchant_transaction_id)) {
    throw new TypeError("La notification CinetPay est invalide.");
  }

  return {
    notifyToken: body.notify_token,
    transactionId: body.transaction_id,
    merchantTransactionId: body.merchant_transaction_id,
  };
}

export async function verifyCinetPayNotification(expectedToken, receivedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length < 1
    || expectedToken.length > 512 || typeof receivedToken !== "string"
    || receivedToken.length < 1 || receivedToken.length > 512) {
    return false;
  }

  const encoder = new TextEncoder();
  const [expectedDigest, receivedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
    crypto.subtle.digest("SHA-256", encoder.encode(receivedToken)),
  ]);
  const expectedBytes = new Uint8Array(expectedDigest);
  const receivedBytes = new Uint8Array(receivedDigest);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= expectedBytes[index] ^ receivedBytes[index];
  }
  return difference === 0;
}

export async function verifyCinetPayNotificationAndStatus(
  body,
  attempt,
  env,
  fetchImpl = fetch,
) {
  const notification = parseCinetPayNotification(body);
  if (!attempt || typeof attempt !== "object"
    || typeof attempt.notifyToken !== "string"
    || notification.merchantTransactionId !== attempt.merchantTransactionId
    || notification.transactionId !== attempt.transactionId
    || !await verifyCinetPayNotification(attempt.notifyToken, notification.notifyToken)) {
    throw new CinetPayProviderError();
  }

  const status = await getCinetPaySandboxPaymentStatus(
    notification.merchantTransactionId,
    env,
    fetchImpl,
  );
  if (status.transactionId !== notification.transactionId
    || status.transactionId !== attempt.transactionId) {
    throw new CinetPayProviderError();
  }

  return status;
}
