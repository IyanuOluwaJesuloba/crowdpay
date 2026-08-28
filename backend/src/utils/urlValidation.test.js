const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRenderUrl, requireValidRenderUrl } = require('./urlValidation');

test('validateRenderUrl rejects empty/null/undefined input', () => {
  assert.equal(validateRenderUrl(null).safe, false);
  assert.equal(validateRenderUrl('').safe, false);
  assert.equal(validateRenderUrl(undefined).safe, false);
  assert.equal(validateRenderUrl('   ').safe, false);
});

test('validateRenderUrl rejects invalid URL format', () => {
  assert.equal(validateRenderUrl('not-a-url').safe, false);
  assert.equal(validateRenderUrl('://bad').safe, false);
});

test('validateRenderUrl rejects javascript: scheme', () => {
  const result = validateRenderUrl('javascript:alert(1)');
  assert.equal(result.safe, false);
  assert.match(result.reason, /not allowed/i);
});

test('validateRenderUrl rejects data: scheme', () => {
  const result = validateRenderUrl('data:text/html,<script>alert(1)</script>');
  assert.equal(result.safe, false);
  assert.match(result.reason, /not allowed/i);
});

test('validateRenderUrl rejects vbscript: scheme', () => {
  const result = validateRenderUrl('vbscript:MsgBox("XSS")');
  assert.equal(result.safe, false);
  assert.match(result.reason, /not allowed/i);
});

test('validateRenderUrl rejects blob: scheme', () => {
  const result = validateRenderUrl('blob:https://example.com/id');
  assert.equal(result.safe, false);
  assert.match(result.reason, /not allowed/i);
});

test('validateRenderUrl rejects file: scheme', () => {
  const result = validateRenderUrl('file:///etc/passwd');
  assert.equal(result.safe, false);
  assert.match(result.reason, /not allowed/i);
});

test('validateRenderUrl allows https: URLs', () => {
  const result = validateRenderUrl('https://example.com/image.png');
  assert.equal(result.safe, true);
  assert.equal(result.normalized, 'https://example.com/image.png');
});

test('validateRenderUrl allows https: with complex paths and query params', () => {
  const url = 'https://cdn.example.com/path/to/file.pdf?token=abc123&sig=xyz';
  const result = validateRenderUrl(url);
  assert.equal(result.safe, true);
  assert.equal(result.normalized, url);
});

test('validateRenderUrl rejects http: non-localhost URLs', () => {
  const result = validateRenderUrl('http://example.com/image.png');
  assert.equal(result.safe, false);
  assert.match(result.reason, /HTTP is only allowed for localhost/i);
});

test('validateRenderUrl allows http: localhost in development', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const result = validateRenderUrl('http://localhost:3000/image.png');
  process.env.NODE_ENV = prev;
  assert.equal(result.safe, true);
});

test('validateRenderUrl allows http: 127.0.0.1 in development', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const result = validateRenderUrl('http://127.0.0.1:3000/image.png');
  process.env.NODE_ENV = prev;
  assert.equal(result.safe, true);
});

test('validateRenderUrl allows http: [::1] in development', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const result = validateRenderUrl('http://[::1]:3000/image.png');
  process.env.NODE_ENV = prev;
  assert.equal(result.safe, true);
});

test('validateRenderUrl rejects http: localhost in production', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const result = validateRenderUrl('http://localhost:3000/image.png');
  process.env.NODE_ENV = prev;
  assert.equal(result.safe, false);
});

test('validateRenderUrl normalizes URLs correctly', () => {
  const result = validateRenderUrl('https://Example.COM/Path');
  assert.equal(result.safe, true);
  assert.equal(result.normalized, 'https://example.com/Path');
});

test('requireValidRenderUrl middleware passes through when field is missing and not required', () => {
  const middleware = requireValidRenderUrl('evidence_url');
  const req = { body: {} };
  const res = { status: () => res, json: () => res };
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('requireValidRenderUrl middleware returns 400 when field is missing and required', () => {
  const middleware = requireValidRenderUrl('evidence_url', { required: true });
  const req = { body: {} };
  let statusCode;
  let body;
  const res = {
    status: (code) => { statusCode = code; return res; },
    json: (data) => { body = data; return res; },
  };
  middleware(req, res, () => {});
  assert.equal(statusCode, 400);
  assert.match(body.error, /required/i);
});

test('requireValidRenderUrl middleware returns 422 for dangerous URL scheme', () => {
  const middleware = requireValidRenderUrl('evidence_url');
  const req = { body: { evidence_url: 'javascript:alert(1)' } };
  let statusCode;
  let body;
  const res = {
    status: (code) => { statusCode = code; return res; },
    json: (data) => { body = data; return res; },
  };
  middleware(req, res, () => {});
  assert.equal(statusCode, 422);
  assert.match(body.error, /not valid/i);
});

test('requireValidRenderUrl middleware normalizes valid URL on req.body', () => {
  const middleware = requireValidRenderUrl('evidence_url');
  const req = { body: { evidence_url: 'https://Example.COM/Path' } };
  let called = false;
  const res = { status: () => res, json: () => res };
  middleware(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.body.evidence_url, 'https://example.com/Path');
});
