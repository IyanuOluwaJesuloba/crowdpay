const PDFDocument = require('pdfkit');

function generateContributionReceiptPdf(receiptData, streamOrBufferCallback) {
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];

  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => {
    const result = Buffer.concat(chunks);
    streamOrBufferCallback(null, result);
  });
  doc.on('error', (err) => {
    streamOrBufferCallback(err);
  });

  // Header / Brand
  doc.fontSize(22).fillColor('#0f1f3d').text('CrowdPay Contribution Receipt', { align: 'left' });
  doc.fontSize(10).fillColor('#666666').text(`Generated on ${new Date().toUTCString()}`, { align: 'left' });
  doc.moveDown(1.5);

  // Certificate / Tax notice
  doc.fontSize(12).fillColor('#1a1a1a').text('CONTRIBUTION CERTIFICATE', { bold: true });
  doc.fontSize(10).fillColor('#444444').text(
    'This document certifies that the individual or entity named below has made a financial contribution to the crowdfunding campaign detailed herein. Please retain this receipt for your accounting and tax reporting records.',
    { lineGap: 4 }
  );
  doc.moveDown(1);

  // Details table / section
  doc.fontSize(12).fillColor('#0f1f3d').text('Transaction Details', { bold: true });
  doc.moveDown(0.5);

  const details = [
    ['Campaign Name', receiptData.campaignTitle || 'N/A'],
    ['Contributor Name', receiptData.contributorName || 'N/A'],
    ['Contributor Email', receiptData.contributorEmail || 'N/A'],
    ['Contribution Amount', `${receiptData.amount} ${receiptData.asset}`],
    ['Date', receiptData.date ? new Date(receiptData.date).toUTCString() : 'N/A'],
    ['Stellar Transaction Hash', receiptData.txHash || 'N/A'],
    ['Stellar Memo', receiptData.memo || 'None']
  ];

  details.forEach(([label, value]) => {
    doc.fontSize(10).fillColor('#555555').text(`${label}: `, { continued: true, bold: true });
    doc.fillColor('#1a1a1a').text(value);
    doc.moveDown(0.3);
  });

  doc.moveDown(1);
  doc.fontSize(12).fillColor('#0f1f3d').text('Fee Breakdown', { bold: true });
  doc.moveDown(0.5);

  const fees = [
    ['Network Fee', `${receiptData.networkFee || '0'} ${receiptData.asset}`],
    ['Platform Fee', `${receiptData.platformFee || '0'} ${receiptData.asset}`],
    ['Total Charged', `${receiptData.totalCharged || receiptData.amount} ${receiptData.asset}`]
  ];

  fees.forEach(([label, value]) => {
    doc.fontSize(10).fillColor('#555555').text(`${label}: `, { continued: true, bold: true });
    doc.fillColor('#1a1a1a').text(value);
    doc.moveDown(0.3);
  });

  doc.moveDown(2);
  doc.fontSize(9).fillColor('#888888').text(
    'CrowdPay is a blockchain-powered crowdfunding platform. Contributions are recorded immutably on the Stellar network.',
    { align: 'center' }
  );

  doc.end();
}

module.exports = {
  generateContributionReceiptPdf,
};