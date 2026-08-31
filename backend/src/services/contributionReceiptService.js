const db = require('../config/database');
const storage = require('./storage');
const { generateContributionReceiptPdf } = require('./taxReceiptPdf');

async function getReceiptData(contributionId) {
  const query = `
    SELECT c.*, camp.title AS campaign_title, camp.status AS campaign_status, u.name AS contributor_name, u.email AS contributor_email
    FROM contributions c
    JOIN campaigns camp ON camp.id = c.campaign_id
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.id = $1
  `;
  const { rows } = await db.query(query, [contributionId]);
  if (rows.length === 0) {
    throw new Error('Contribution not found');
  }
  return rows[0];
}

async function getOrCreateReceiptPdf(contributionId, forceRegenerate = false) {
  const row = await getReceiptData(contributionId);
  const storageKey = `receipts/${contributionId}.pdf`;

  if (!forceRegenerate) {
    const exists = await storage.exists(storageKey);
    if (exists) {
      return await storage.getSignedUrl(storageKey);
    }
  }

  const receiptData = {
    campaignTitle: row.campaign_title,
    contributorName: row.contributor_name || 'Contributor',
    contributorEmail: row.contributor_email || '',
    amount: row.amount,
    asset: row.asset,
    date: row.created_at,
    txHash: row.tx_hash,
    memo: row.memo,
    networkFee: row.network_fee || '0',
    platformFee: row.platform_fee || '0',
    totalCharged: row.total_charged || row.amount
  };

  const pdfBuffer = await new Promise((resolve, reject) => {
    generateContributionReceiptPdf(receiptData, (err, buffer) => {
      if (err) reject(err);
      else resolve(buffer);
    });
  });

  await storage.upload(storageKey, pdfBuffer, 'application/pdf');
  return await storage.getSignedUrl(storageKey);
}

module.exports = {
  getReceiptData,
  getOrCreateReceiptPdf,
};