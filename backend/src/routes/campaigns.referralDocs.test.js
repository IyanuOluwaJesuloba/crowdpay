const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const swaggerJsdoc = require('swagger-jsdoc');

// The OpenAPI spec is assembled from @openapi JSDoc blocks in the route files
// (see the swaggerJsdoc call in src/index.js). These assertions pin the referral
// endpoints so the annotations are not dropped by a future merge.
const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'CrowdPay API', version: '1.0.0' },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  },
  apis: [path.join(__dirname, '*.js').replace(/\\/g, '/')],
});

test('the campaign referral endpoints are documented in the OpenAPI spec', () => {
  const documented = {
    '/api/campaigns/{id}/referrals': 'post',
    '/api/campaigns/{id}/referrals/program': 'get',
    '/api/campaigns/{id}/referrals/links': 'post',
    '/api/campaigns/{id}/referrals/commissions': 'get',
  };

  for (const [route, method] of Object.entries(documented)) {
    const operation = spec.paths?.[route]?.[method];
    assert.ok(operation, `${method.toUpperCase()} ${route} is missing from the OpenAPI spec`);
    assert.ok(operation.summary, `${method.toUpperCase()} ${route} has no summary`);
    assert.ok(operation.responses, `${method.toUpperCase()} ${route} documents no responses`);
  }
});

test('the authenticated referral endpoints declare bearer auth', () => {
  const authenticated = [
    ['/api/campaigns/{id}/referrals', 'post'],
    ['/api/campaigns/{id}/referrals/links', 'post'],
    ['/api/campaigns/{id}/referrals/commissions', 'get'],
  ];

  for (const [route, method] of authenticated) {
    const { security } = spec.paths[route][method];
    assert.ok(
      Array.isArray(security) && security.some((s) => 'bearerAuth' in s),
      `${method.toUpperCase()} ${route} should require bearerAuth`
    );
  }
});

test('the public program endpoint is not marked as requiring auth', () => {
  const operation = spec.paths['/api/campaigns/{id}/referrals/program'].get;
  assert.equal(operation.security, undefined);
});

test('claiming a referral link documents the cap and missing-program failures', () => {
  const { responses } = spec.paths['/api/campaigns/{id}/referrals/links'].post;
  // 409 is REFERRER_LIMIT_REACHED, 404 is a campaign without a referral program.
  assert.ok(responses['409'], 'the maxReferrers cap response is undocumented');
  assert.ok(responses['404'], 'the missing-program response is undocumented');
  assert.ok(responses['201'], 'the created response is undocumented');
  assert.ok(responses['200'], 'the idempotent re-claim response is undocumented');
});
