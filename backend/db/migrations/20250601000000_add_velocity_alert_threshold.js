exports.up = async function (db) {
  await db.query(`
    ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS velocity_alert_threshold NUMERIC(18, 7) DEFAULT 0;
  `);
};

exports.down = async function (db) {
  await db.query(`
    ALTER TABLE campaigns
    DROP COLUMN IF NOT EXISTS velocity_alert_threshold;
  `);
};