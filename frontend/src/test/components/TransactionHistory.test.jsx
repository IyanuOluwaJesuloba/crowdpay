import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../renderWithProviders';
import TransactionHistory from '../../components/TransactionHistory';

vi.mock('../../services/api', () => ({
  api: {
    getStellarTransactions: vi.fn(),
  },
}));

import { api } from '../../services/api';

describe('TransactionHistory', () => {
  it('loads transaction records and supports loading more', async () => {
    const transactions = Array.from({ length: 11 }, (_, index) => ({
      id: `tx-${index}`,
      kind: 'contribution',
      status: 'indexed',
      created_at: '2026-07-25T00:00:00.000Z',
      tx_hash: `HASH00000${index}`,
    }));

    api.getStellarTransactions.mockResolvedValue(transactions);

    renderWithProviders(<TransactionHistory campaignId="campaign-1" isCreator />);

    await screen.findByText(/HASH0000…000000/i);
    expect(api.getStellarTransactions).toHaveBeenCalledWith({ campaignId: 'campaign-1', limit: 11 });

    await userEvent.click(screen.getByRole('button', { name: /Load more/i }));
    await waitFor(() => expect(api.getStellarTransactions).toHaveBeenCalledTimes(2));
    expect(api.getStellarTransactions).toHaveBeenLastCalledWith({ campaignId: 'campaign-1', limit: 21 });
  });
});
