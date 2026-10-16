'use strict';
const crypto = require('crypto');

function config() {
  const baseUrl = String(process.env.OPAY_BASE_URL || 'https://sandbox-cashierapi.opayweb.com').replace(/\/$/, '');
  const merchantId = String(process.env.OPAY_MERCHANT_ID || '').trim();
  const privateKey = String(process.env.OPAY_PRIVATE_KEY || '').trim();
  const enabled = process.env.OPAY_PAYOUT_ENABLED === 'true' && Boolean(merchantId && privateKey && baseUrl.startsWith('https://'));
  return { baseUrl, merchantId, privateKey, enabled };
}
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortDeep(value[k])]));
  return value;
}
function phpJson(value) {
  // Match PHP json_encode defaults used by OPay's published merchant-transfer SDK:
  // recursively sorted object keys, escaped slashes and escaped non-ASCII characters.
  return JSON.stringify(value).replace(/\//g, '\\/').replace(/[\u007f-\uffff]/g, ch => {
    const code = ch.charCodeAt(0);
    if (code >= 0xD800 && code <= 0xDBFF) return '\\u' + code.toString(16).padStart(4, '0');
    return '\\u' + code.toString(16).padStart(4, '0');
  });
}
function sign(payload, privateKey) {
  const body = phpJson(sortDeep(payload));
  return crypto.createHmac('sha512', privateKey).update(body).digest('hex');
}
async function request(path, payload) {
  const c = config();
  if (!c.enabled) throw new Error('OPay payout integration is not enabled or configured.');
  const body = sortDeep(payload);
  const response = await fetch(c.baseUrl + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + sign(body, c.privateKey),
      'MerchantId': c.merchantId
    },
    body: phpJson(body),
    signal: AbortSignal.timeout(20000)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`OPay returned a non-JSON response (HTTP ${response.status}).`); }
  if (!response.ok) {
    const e = new Error(`OPay HTTP ${response.status}: ${String(data.message || 'request failed').slice(0,180)}`);
    e.providerResponse = data; e.definiteFailure = response.status >= 400 && response.status < 500;
    throw e;
  }
  return data;
}
function createTransfer({ reference, amountNaira, recipientType, recipientName, phoneNumber, bankCode, bankAccountNumber, reason }) {
  if (recipientType === 'opay_wallet') {
    return request('/api/v3/transfer/toWallet', {
      amount: String(amountNaira), country: 'NG', currency: 'NGN', reason,
      receiver: { name: recipientName, phoneNumber, type: 'USER' }, reference
    });
  }
  return request('/api/v3/transfer/toBank', {
    amount: String(amountNaira), country: 'NG', currency: 'NGN', reason,
    receiver: { bankCode, bankAccountNumber, name: recipientName }, reference
  });
}
function queryTransfer({ reference, orderNo, recipientType }) {
  if (!orderNo) throw new Error('OPay order number is not available yet; reconcile this transfer with OPay before retrying.');
  return request(recipientType === 'opay_wallet' ? '/api/v3/transfer/status/toWallet' : '/api/v3/transfer/status/toBank', { orderNo, reference });
}
module.exports = { config, createTransfer, queryTransfer };
