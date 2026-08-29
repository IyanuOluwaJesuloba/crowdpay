import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import Pricing from '../../pages/Pricing';
import { renderWithProviders } from '../renderWithProviders';

const apiMocks = vi.hoisted(() => ({
  getPlatformConfig: vi.fn().mockResolvedValue({ platform_fee_bps: 250 }),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

describe('Pricing page', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the pricing heading and fee details', async () => {
    renderWithProviders(<Pricing />);

    expect(await screen.findByRole('heading', { name: /Pricing/i })).toBeInTheDocument();
    expect(await screen.findByText(/2.50% of each contribution/i)).toBeInTheDocument();
  });
});
