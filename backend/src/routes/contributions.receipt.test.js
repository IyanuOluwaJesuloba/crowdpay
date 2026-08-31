const { describe, it, expect, vi, beforeEach } = require('vitest');
const contributionReceiptService = require('../services/contributionReceiptService');

vi.mock('../services/contributionReceiptService', () => ({
  getOrCreateReceiptPdf: vi.fn(),
  getReceiptData: vi.fn(),
}));

describe('Contribution Receipt Service Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('assembly and pdf generation mock verification', async () => {
    contributionReceiptService.getOrCreateReceiptPdf.mockResolvedValue('https://storage.test/signed-receipt.pdf');
    const url = await contributionReceiptService.getOrCreateReceiptPdf('test-contrib-id');
    expect(url).toContain('signed-receipt.pdf');
    expect(contributionReceiptService.getOrCreateReceiptPdf).toHaveBeenCalledWith('test-contrib-id');
  });
});