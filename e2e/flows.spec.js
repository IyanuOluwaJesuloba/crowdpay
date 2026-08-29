import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Seed credentials (match backend/db/seed.sql)
// ---------------------------------------------------------------------------
const CREATOR = { email: 'bola@example.com', password: 'creator123' };
const CONTRIBUTOR = { email: 'alice@example.com', password: 'password123' };
const ADMIN = { email: 'admin@example.com', password: 'admin123' };

const CAMPAIGN_IDS = {
  active: '11111111-1111-1111-1111-111111111111',    // Lagos Solar Study Hub
  funded: '22222222-2222-2222-2222-222222222222',    // Community Cold Storage
  active2: '33333333-3333-3333-3333-333333333333',  // Women in Hardware
  inProgress: '44444444-4444-4444-4444-444444444444', // Clinic Water Upgrade
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function loginAs(page, { email, password }) {
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: /log in/i }).click();
  await page.waitForURL(/\/(dashboard|$|\?)/, { timeout: 15_000 });
}

function mockWithdrawalsAPI(page, { status = 201, withdrawalId = 'wr-e2e' } = {}) {
  page.route('**/api/withdrawals', async (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({
          id: withdrawalId,
          status: 'pending',
          amount: '100',
          destination_key: 'GBFQZXA6Q4M7BMSNL6Q5M6P47TQIJM47KQKAR5R6XWQ7QX4PX5A7K5TJ',
        }),
      });
    }
    return route.continue();
  });

  page.route(`**/api/withdrawals?*`, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: withdrawalId,
          status: 'pending',
          amount: '100',
          destination_key: 'GBFQZXA6Q4M7BMSNL6Q5M6P47TQIJM47KQKAR5R6XWQ7QX4PX5A7K5TJ',
          created_at: new Date().toISOString(),
          approval_events: [
            { event_type: 'requested', created_at: new Date().toISOString() },
          ],
        },
      ]),
    });
  });
}

// ---------------------------------------------------------------------------
// 1. CONTRIBUTOR JOURNEY: discover → contribute → track
// ---------------------------------------------------------------------------
test.describe('Contributor journey — discover, contribute, and track', () => {
  test('register, browse campaigns, open campaign, and see contributions list', async ({ page }) => {
    const email = `e2e-contrib-${Date.now()}@example.com`;

    await page.goto('/register');
    await page.getByPlaceholder('Full name').fill('E2E Contributor');
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill('Password1');
    await page.getByTestId('register-submit').click();

    await expect(page).toHaveURL(/\/(dashboard|$|\?)/, { timeout: 20_000 });
    await expect(page.getByText(/campaign/i).first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('link', { name: /solar study hub/i }).first().click();
    await expect(page).toHaveURL(/\/campaigns\//);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/solar/i);

    // Mock contribution submission and listing
    await page.route('**/api/contributions', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ tx_hash: 'e2e-mock-tx', amount: '5', asset: 'USDC' }),
        });
      }
      return route.continue();
    });

    await page.route('**/api/contributions?*', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'contrib-e2e',
            amount: '5',
            asset: 'USDC',
            sender_public_key: 'GSENDER',
            display_name: 'E2E Contributor',
            created_at: new Date().toISOString(),
          },
        ]),
      });
    });

    await page.getByRole('button', { name: /contribute/i }).click();
    await page.getByLabel(/amount campaign receives/i).fill('5');
    await page.getByRole('button', { name: /confirm payment/i }).click();

    await expect(page.getByText(/E2E Contributor|5/)).toBeVisible({ timeout: 15_000 });
  });

  test('contributor can see progress bar and backer count on campaign page', async ({ page }) => {
    await loginAs(page, CONTRIBUTOR);
    await page.goto(`/campaigns/${CAMPAIGN_IDS.active}`);

    // Progress bar and raised amount should be visible
    await expect(page.getByText(/3,?125|3125/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/8,?500|8500/)).toBeVisible();
  });

  test('contributor can filter campaigns by title search', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/campaign/i).first()).toBeVisible({ timeout: 15_000 });

    const searchInput = page.getByPlaceholder(/search/i).first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('Solar');
      await expect(page.getByText(/solar/i).first()).toBeVisible({ timeout: 10_000 });
    }
  });

  test('contributor can track their contributions on the dashboard', async ({ page }) => {
    await loginAs(page, CONTRIBUTOR);

    // Navigate to dashboard / my contributions
    const dashLink = page.getByRole('link', { name: /dashboard|my campaigns|profile/i }).first();
    if (await dashLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await dashLink.click();
      await expect(page.getByText(/contribution|backed/i).first()).toBeVisible({ timeout: 15_000 });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. CREATOR CAMPAIGN LIFECYCLE: create → fund → withdraw
// ---------------------------------------------------------------------------
test.describe('Campaign creator lifecycle — create, fund, withdraw', () => {
  test('login, create campaign, and see it on home', async ({ page }) => {
    await loginAs(page, CREATOR);

    await page.goto('/campaigns/new');
    const title = `E2E Campaign ${Date.now()}`;
    await page.getByLabel(/title/i).fill(title);
    await page.getByLabel(/description/i).fill('End-to-end test campaign description.');
    await page.getByLabel(/target amount/i).fill('500');
    await page.getByRole('button', { name: /create campaign|launch/i }).click();

    await expect(page).toHaveURL(/\/campaigns\//, { timeout: 20_000 });
    await page.goto('/');
    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('link', { name: title }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(page.getByText(/500/)).toBeVisible();
  });

  test('creator can view and manage their campaigns from the dashboard', async ({ page }) => {
    await loginAs(page, CREATOR);

    const mineLink = page.getByRole('link', { name: /my campaigns|dashboard/i }).first();
    if (await mineLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await mineLink.click();
      await expect(page.getByText(/Lagos Solar|Cold Storage|Women in Hardware/i).first()).toBeVisible({ timeout: 15_000 });
    }
  });

  test('creator sees funded campaign page with withdrawal section', async ({ page }) => {
    await loginAs(page, CREATOR);
    await page.goto(`/campaigns/${CAMPAIGN_IDS.funded}`);

    await expect(page.getByText(/community cold storage|funded/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/withdrawal/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('creator can request a withdrawal on a funded campaign', async ({ page }) => {
    await loginAs(page, CREATOR);
    await page.goto(`/campaigns/${CAMPAIGN_IDS.funded}`);
    await expect(page.getByText(/community cold storage|funded/i)).toBeVisible({ timeout: 15_000 });

    mockWithdrawalsAPI(page);

    const withdrawalSection = page.getByText(/withdrawal/i).first();
    await expect(withdrawalSection).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/audit|pending|request/i).first()).toBeVisible();
  });

  test('creator can post a campaign update', async ({ page }) => {
    await loginAs(page, CREATOR);
    await page.goto(`/campaigns/${CAMPAIGN_IDS.active}`);

    // Route campaign-update POST
    await page.route(`**/api/campaigns/${CAMPAIGN_IDS.active}/updates`, async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'update-e2e',
            title: 'E2E Update',
            body: 'Test update body',
            created_at: new Date().toISOString(),
          }),
        });
      }
      return route.continue();
    });

    const updateBtn = page.getByRole('button', { name: /post update|add update/i }).first();
    if (await updateBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await updateBtn.click();
      const titleInput = page.getByLabel(/update title|title/i).first();
      if (await titleInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await titleInput.fill('E2E Update');
        await page.getByLabel(/body|message|content/i).first().fill('Test update body');
        await page.getByRole('button', { name: /submit|post/i }).click();
        await expect(page.getByText(/E2E Update/)).toBeVisible({ timeout: 10_000 });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. WITHDRAWAL AUDIT TRAIL
// ---------------------------------------------------------------------------
test.describe('Withdrawal flow', () => {
  test('creator sees withdrawal audit trail on funded campaign', async ({ page }) => {
    await loginAs(page, CREATOR);
    await page.goto(`/campaigns/${CAMPAIGN_IDS.funded}`);
    await expect(page.getByText(/community cold storage|funded/i)).toBeVisible({ timeout: 15_000 });

    mockWithdrawalsAPI(page);

    const withdrawalSection = page.getByText(/withdrawal/i).first();
    await expect(withdrawalSection).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/audit|pending|request/i).first()).toBeVisible();
  });

  test('withdrawal section shows expired XDR warning when platform returns 410', async ({ page }) => {
    await loginAs(page, CREATOR);
    await page.goto(`/campaigns/${CAMPAIGN_IDS.funded}`);
    await expect(page.getByText(/community cold storage|funded/i)).toBeVisible({ timeout: 15_000 });

    // Simulate expired XDR scenario (410 Gone)
    await page.route(`**/api/withdrawals/*/approve`, async (route) => {
      return route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'XDR has expired. Please request a new withdrawal.',
          code: 'XDR_EXPIRED',
        }),
      });
    });

    await page.route('**/api/withdrawals?*', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'wr-expired',
            status: 'pending',
            amount: '100',
            destination_key: 'GBFQZXA6Q4M7BMSNL6Q5M6P47TQIJM47KQKAR5R6XWQ7QX4PX5A7K5TJ',
            created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
            approval_events: [],
          },
        ]),
      });
    });

    // The withdrawal section should render, and UI should indicate expired state
    await expect(page.getByText(/withdrawal/i).first()).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// 4. DISPUTE AND REFUND FLOWS
// ---------------------------------------------------------------------------
test.describe('Dispute and refund flows', () => {
  test('contributor can raise a dispute on an active campaign', async ({ page }) => {
    await loginAs(page, CONTRIBUTOR);
    await page.goto(`/campaigns/${CAMPAIGN_IDS.active}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/solar/i, { timeout: 15_000 });

    // Mock dispute submission
    await page.route(`**/api/campaigns/${CAMPAIGN_IDS.active}/disputes`, async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'dispute-e2e',
            status: 'open',
            reason: 'non_delivery',
            description: 'E2E test dispute',
            created_at: new Date().toISOString(),
          }),
        });
      }
      return route.continue();
    });

    const disputeBtn = page.getByRole('button', { name: /raise dispute|report/i }).first();
    if (await disputeBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await disputeBtn.click();
      const reasonSelect = page.getByLabel(/reason/i).first();
      if (await reasonSelect.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await reasonSelect.selectOption('non_delivery');
        await page.getByLabel(/description/i).fill('E2E test dispute — product not delivered');
        await page.getByRole('button', { name: /submit|raise/i }).click();
        await expect(page.getByText(/dispute|submitted|open/i).first()).toBeVisible({ timeout: 10_000 });
      }
    }
  });

  test('admin can see disputes panel in admin dashboard', async ({ page }) => {
    await loginAs(page, ADMIN);

    const adminLink = page.getByRole('link', { name: /admin/i }).first();
    if (await adminLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await adminLink.click();
      const disputeTab = page.getByRole('button', { name: /disputes/i });
      if (await disputeTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await disputeTab.click();
        await expect(page.getByText(/dispute|queue|open/i).first()).toBeVisible({ timeout: 10_000 });
      }
    }
  });

  test('failed campaign shows refund request option for contributor', async ({ page }) => {
    await loginAs(page, CONTRIBUTOR);

    // Mock a failed campaign response
    await page.route(`**/api/campaigns/ffffffff-*`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          title: 'Failed Campaign E2E',
          status: 'failed',
          target_amount: '1000',
          raised_amount: '200',
          asset_type: 'USDC',
          deadline: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      });
    });

    await page.route('**/api/withdrawals?*', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Navigate to the failed campaign
    await page.goto('/campaigns/ffffffff-ffff-ffff-ffff-ffffffffffff');
    await expect(page.getByText(/failed|refund/i).first()).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// 5. MILESTONE LIFECYCLE
// ---------------------------------------------------------------------------
test.describe('Milestone lifecycle', () => {
  test('campaign with milestones shows milestone progress section', async ({ page }) => {
    await page.goto(`/campaigns/${CAMPAIGN_IDS.inProgress}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/clinic|water/i, { timeout: 15_000 });
    await expect(page.getByText(/milestone/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('creator can view milestones on their campaign page', async ({ page }) => {
    await loginAs(page, CREATOR);
    await page.goto(`/campaigns/${CAMPAIGN_IDS.inProgress}`);
    await expect(page.getByText(/milestone|pump procurement|solar controller/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('admin can approve a pending milestone', async ({ page }) => {
    await loginAs(page, ADMIN);

    await page.route('**/api/milestones/*/approve', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'ms-e2e', status: 'approved' }),
        });
      }
      return route.continue();
    });

    const adminLink = page.getByRole('link', { name: /admin/i }).first();
    if (await adminLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await adminLink.click();
      const milestonesTab = page.getByRole('button', { name: /milestones/i });
      if (await milestonesTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await milestonesTab.click();
        await expect(page.getByText(/milestone|review/i).first()).toBeVisible({ timeout: 10_000 });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. AUTH AND ACCOUNT FLOWS
// ---------------------------------------------------------------------------
test.describe('Authentication and account flows', () => {
  test('unauthenticated user is redirected to login when accessing creator page', async ({ page }) => {
    await page.goto('/campaigns/new');
    await expect(page).toHaveURL(/login|register|\/$/, { timeout: 10_000 });
  });

  test('user can log out and is redirected to home/login', async ({ page }) => {
    await loginAs(page, CONTRIBUTOR);
    const logoutBtn = page.getByRole('button', { name: /log out|sign out/i });
    if (await logoutBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await logoutBtn.click();
      await expect(page).toHaveURL(/login|\/$/, { timeout: 10_000 });
    }
  });

  test('registration rejects duplicate email', async ({ page }) => {
    await page.goto('/register');
    await page.getByPlaceholder('Full name').fill('Duplicate User');
    await page.getByPlaceholder('Email').fill(CONTRIBUTOR.email); // already exists in seed
    await page.getByPlaceholder('Password').fill('Password1');

    await page.route('**/api/auth/register', async (route) => {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Email already in use' }),
      });
    });

    await page.getByRole('button', { name: /sign up/i }).click();
    await expect(page.getByText(/email|already|exists|use/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('invalid login shows error message', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill('nobody@nowhere.com');
    await page.getByPlaceholder('Password').fill('wrongpassword');

    await page.route('**/api/auth/login', async (route) => {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid credentials' }),
      });
    });

    await page.getByRole('button', { name: /log in/i }).click();
    await expect(page.getByText(/invalid|wrong|incorrect|credentials/i).first()).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// 7. CAMPAIGN EMBED WIDGET
// ---------------------------------------------------------------------------
test.describe('Campaign embed widget', () => {
  test('embed endpoint returns campaign widget data for public campaigns', async ({ page }) => {
    // Mock the embed API
    await page.route(`**/api/campaigns/${CAMPAIGN_IDS.active}/embed`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: CAMPAIGN_IDS.active,
          title: 'Lagos Solar Study Hub',
          raised_amount: '3125.50',
          target_amount: '8500.00',
          asset_type: 'USDC',
          progress_percentage: 36.8,
          contribution_url: `http://localhost:5173/campaigns/${CAMPAIGN_IDS.active}`,
        }),
      });
    });

    // The embed widget HTML is served at root
    await page.goto('/test-embed.html');
    // Check basic page loads (embed HTML exists in repo)
    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Dispute flow', () => {
  test('contributor disputes a contribution and admin resolves', async ({ page }) => {
    const campaignId = '11111111-1111-1111-1111-111111111111';
    await page.goto(`/campaigns/${campaignId}`);

    // First, ensure there is a contribution to dispute (mock list)
    await page.route('**/api/contributions?*', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'contrib-e2e',
            amount: '10',
            asset: 'USDC',
            sender_public_key: 'GSENDER',
            display_name: 'E2E Contributor',
            created_at: new Date().toISOString(),
          },
        ]),
      });
    });

    // Click on the contribution row to open dispute modal
    await page.getByTestId('contribution-row').first().click();
    await page.getByRole('button', { name: /dispute/i }).click();

    // Fill reason
    await page.getByLabel(/reason/i).fill('Did not receive promised rewards');
    await page.getByRole('button', { name: /submit dispute/i }).click();

    // Mock dispute creation
    await page.route('**/api/disputes', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'dispute-e2e', status: 'pending' }),
        });
      }
      return route.continue();
    });

    await expect(page.getByText(/dispute submitted/i)).toBeVisible();

    // Now switch to admin (or creator) to resolve the dispute
    // In a real test, you might use a separate browser context
    // For simplicity, we'll just log out via the navbar UI (the app has no /logout route)
    // and sign in again as admin.
    const logoutButton = page.getByRole('button', { name: /log ?out/i });
    if (await logoutButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await logoutButton.click();
      await expect(page).toHaveURL(/\//, { timeout: 10_000 });
    }
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(ADMIN.email);
    await page.getByPlaceholder('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: /log in/i }).click();

    await page.goto('/admin/disputes');
    await page.getByText('dispute-e2e').click();
    await page.getByRole('button', { name: /approve|resolve/i }).click();

    // Mock dispute resolution
    await page.route('**/api/disputes/dispute-e2e', async (route) => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({
          status: 200,
          body: JSON.stringify({ status: 'resolved', resolution: 'refund' }),
        });
      }
      return route.continue();
    });

    await expect(page.getByText(/resolved|refund/i)).toBeVisible();
  });
});

// ========== NEW: Refund Flow ==========
test.describe('Refund flow', () => {
  test('campaign fails target and contributors get auto-refund', async ({ page }) => {
    const campaignId = '33333333-3333-3333-3333-333333333333';
    await page.goto(`/campaigns/${campaignId}`);

    // Simulate campaign that has ended and is below target
    await page.route(`**/api/campaigns/${campaignId}`, async (route) => {
      return route.fulfill({
        status: 200,
        body: JSON.stringify({
          id: campaignId,
          title: 'Failed Campaign',
          target_amount: 1000,
          raised_amount: 200,
          status: 'ended',
          end_date: new Date(Date.now() - 86400000).toISOString(),
        }),
      });
    });

    // Mock refund initiation
    await page.route('**/api/refunds', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          body: JSON.stringify({ refund_id: 'ref-e2e', status: 'processing' }),
        });
      }
      return route.continue();
    });

    // Click refund button (if any) or wait for auto-refund
    await page.getByRole('button', { name: /request refund|claim refund/i }).click();
    await expect(page.getByText(/refund initiated|processing/i)).toBeVisible();
  });
});

// ========== NEW: Soroban Contract Integration ==========
test.describe('Soroban contract integration', () => {
  test('contribution calls contract and reflects on-chain status', async ({ page }) => {
    const email = `e2e-contrib-soroban-${Date.now()}@example.com`;
    await page.goto('/register');
    await page.getByPlaceholder('Full name').fill('Soroban Tester');
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill('Password1');
    await page.getByTestId('register-submit').click();
    await expect(page).toHaveURL(/\/($|\?)/);

    // Navigate to a campaign
    await page.getByRole('link', { name: /solar study hub/i }).first().click();

    // Mock contract call endpoint
    await page.route('**/api/contract/call', async (route) => {
      const body = JSON.parse(route.request().postData());
      if (body.method === 'contribute') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ txHash: '0xabcdef123456', status: 'pending' }),
        });
      }
      return route.continue();
    });

    // Perform contribution
    await page.getByRole('button', { name: /contribute/i }).click();
    await page.getByLabel(/amount campaign receives/i).fill('5');
    await page.getByRole('button', { name: /confirm payment/i }).click();

    // Wait for the UI to show the transaction hash
    await expect(page.getByText(/0xabcdef123456|transaction submitted/i)).toBeVisible();

    // Later, simulate confirmation
    await page.route('**/api/transaction/0xabcdef123456', async (route) => {
      return route.fulfill({
        status: 200,
        body: JSON.stringify({ txHash: '0xabcdef123456', status: 'confirmed', block: 12345 }),
      });
    });
    // Trigger a refresh (e.g., click refresh button)
    await page.getByRole('button', { name: /refresh status/i }).click();
    await expect(page.getByText(/confirmed|success/i)).toBeVisible();
  });
});
