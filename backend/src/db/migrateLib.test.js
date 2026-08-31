'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isUpMigration,
  downFilenameFor,
  sha256,
} = require('../../db/migrateLib');

test('isUpMigration excludes .down.sql rollback scripts', () => {
  assert.equal(isUpMigration('20260401_users.sql'), true);
  assert.equal(isUpMigration('002_20260402_wallets.up.sql'), true);
  assert.equal(isUpMigration('20260401_users.down.sql'), false);
  assert.equal(isUpMigration('notes.txt'), false);
});

test('downFilenameFor derives the rollback filename from an up migration', () => {
  assert.equal(downFilenameFor('20260401_users.sql'), '20260401_users.down.sql');
  assert.equal(downFilenameFor('002_20260402_wallets.up.sql'), '002_20260402_wallets.up.down.sql');
});

test('sha256 is deterministic and matches the node crypto implementation', () => {
  const expected = sha256('select 1;');
  assert.equal(expected, sha256('select 1;'));
  assert.equal(expected.length, 64);
  assert.notEqual(sha256('select 1;'), sha256('select 2;'));
});
