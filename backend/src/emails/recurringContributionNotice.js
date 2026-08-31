// Recurring monthly automated-billing notices (#738). Rendered by
// emailService.sendRecurringContributionNoticeEmail.
const { renderLayout, heading, paragraph, table } = require("./layout");

function buildUpcoming({ name, campaignTitle, amount, asset, scheduledAt, manageUrl }) {
  const recipientName = name || "there";
  const subject = `Your monthly contribution to "${campaignTitle}" is scheduled`;
  const text = [
    `Hi ${recipientName},`,
    "",
    `Your recurring contribution of ${amount} ${asset} to "${campaignTitle}" will be processed shortly. We'll confirm once it clears on the Stellar network.`,
    "",
    `Scheduled for: ${new Date(scheduledAt).toUTCString()}`,
    `You can pause or cancel it any time: ${manageUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `Your monthly ${amount} ${asset} contribution is scheduled.`,
    bodyHtml: [
      heading("Recurring contribution scheduled"),
      paragraph(
        `Hi ${recipientName}, your recurring contribution of ${amount} ${asset} to "${campaignTitle}" will be processed shortly. We'll confirm once it clears on the Stellar network.`
      ),
      table([
        ["Campaign", campaignTitle],
        ["Amount", `${amount} ${asset}`],
        ["Date", new Date(scheduledAt).toUTCString()],
      ]),
      paragraph(`You can pause or cancel this recurring contribution any time: ${manageUrl}`),
    ].join(""),
  });

  return { subject, text, html };
}

function buildCharged({ name, campaignTitle, amount, asset, txHash, campaignUrl }) {
  const recipientName = name || "there";
  const subject = `Your monthly contribution to "${campaignTitle}" was processed`;
  const text = `Hi ${recipientName}, your recurring contribution of ${amount} ${asset} to "${campaignTitle}" was processed successfully on the Stellar network. Transaction: ${txHash} — ${campaignUrl}`;

  const html = renderLayout({
    previewText: `Your monthly ${amount} ${asset} contribution was processed.`,
    bodyHtml: [
      heading("Recurring contribution processed"),
      paragraph(
        `Hi ${recipientName}, your recurring contribution of ${amount} ${asset} to "${campaignTitle}" was processed successfully on the Stellar network.`
      ),
      table([
        ["Campaign", campaignTitle],
        ["Amount", `${amount} ${asset}`],
      ]),
    ].join(""),
  });

  return { subject, text, html };
}

function buildFailed({ name, campaignTitle, amount, asset, manageUrl }) {
  const recipientName = name || "there";
  const subject = `Your monthly contribution to "${campaignTitle}" couldn't be processed`;
  const text = [
    `Hi ${recipientName},`,
    "",
    `We weren't able to process your recurring contribution of ${amount} ${asset} to "${campaignTitle}".`,
    "",
    `This is usually a temporary Stellar network issue. We'll automatically retry shortly`,
    `and we'll let you know as soon as it goes through.`,
    "",
    `Manage your recurring contribution: ${manageUrl}`,
  ].join("\n");

  const html = renderLayout({
    previewText: `We couldn't process your recurring ${amount} ${asset} contribution.`,
    bodyHtml: [
      heading("Recurring contribution couldn't be processed"),
      paragraph(
        `Hi ${recipientName}, we weren't able to process your recurring contribution of ${amount} ${asset} to "${campaignTitle}".`
      ),
      paragraph(
        "This is usually a temporary Stellar network issue. We'll automatically retry and let you know as soon as it goes through."
      ),
      paragraph(`Manage your recurring contribution: ${manageUrl}`),
    ].join(""),
  });

  return { subject, text, html };
}

module.exports = { buildUpcoming, buildCharged, buildFailed };