const test = require("node:test");
const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

function buildWorkerTestHarness(mockQuery) {
  const queryLogs = [];
  const wrappedQuery = async (text, params) => {
    queryLogs.push({ text, params });
    if (mockQuery) return mockQuery(text, params);
    return { rows: [] };
  };

  const mockDb = {
    query: wrappedQuery,
  };

  const mockStellar = {
    server: {
      payments: () => ({
        forAccount: () => ({
          cursor: () => ({
            order: () => ({
              limit: () => ({
                call: async () => ({ records: [] }),
              }),
            }),
            stream: (callbacks) => {
              return () => {};
            },
          }),
        }),
      }),
    },
  };

  const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const { HorizonIngestionWorker, defaultIngestionWorker } = proxyquire(
    "./horizonIngestionWorker",
    {
      "../config/database": mockDb,
      "../config/stellar": mockStellar,
      "../config/logger": mockLogger,
    },
  );

  return { HorizonIngestionWorker, defaultIngestionWorker, queryLogs, mockDb };
}

test("HorizonIngestionWorker initializes with default configuration and stopped state", () => {
  const { HorizonIngestionWorker } = buildWorkerTestHarness();
  const worker = new HorizonIngestionWorker({ concurrency: 5, maxQueueSize: 100 });

  assert.equal(worker.status, "stopped");
  assert.equal(worker.concurrency, 5);
  assert.equal(worker.maxQueueSize, 100);
  assert.equal(worker.watchedWallets.size, 0);

  const metrics = worker.getMetrics();
  assert.equal(metrics.status, "stopped");
  assert.equal(metrics.ingested_count, 0);
  assert.equal(metrics.processed_count, 0);
  assert.equal(metrics.failed_count, 0);
  assert.equal(metrics.duplicate_count, 0);
});

test("registerWallet and unregisterWallet manage in-memory wallet indexes", async () => {
  const { HorizonIngestionWorker } = buildWorkerTestHarness();
  const worker = new HorizonIngestionWorker();

  await worker.registerWallet("camp-101", "GABC123", "cursor-0");

  assert.equal(worker.watchedWallets.get("GABC123"), "camp-101");
  assert.equal(worker.campaignWallets.get("camp-101"), "GABC123");
  assert.equal(worker.cursors.get("camp-101"), "cursor-0");

  worker.unregisterWallet("GABC123");

  assert.equal(worker.watchedWallets.has("GABC123"), false);
  assert.equal(worker.campaignWallets.has("camp-101"), false);
  assert.equal(worker.cursors.has("camp-101"), false);
});

test("enqueuePaymentRecord deduplicates events based on paging token or tx_hash", async () => {
  const { HorizonIngestionWorker } = buildWorkerTestHarness();
  const worker = new HorizonIngestionWorker({ concurrency: 2 });
  const processed = [];

  worker.setPaymentHandler(async (campaignId, walletPublicKey, record) => {
    processed.push(record);
  });
  worker.status = "running";

  const record1 = { transaction_hash: "tx-1", paging_token: "token-1" };
  const recordDuplicate = { transaction_hash: "tx-1", paging_token: "token-1" };

  await worker.enqueuePaymentRecord("camp-101", "GABC123", record1);
  await worker.enqueuePaymentRecord("camp-101", "GABC123", recordDuplicate);

  assert.equal(processed.length, 1);
  assert.equal(worker.metrics.ingested_count, 1);
  assert.equal(worker.metrics.duplicate_count, 1);
});

test("processQueue executes jobs concurrently up to concurrency limit", async () => {
  const { HorizonIngestionWorker } = buildWorkerTestHarness();
  const worker = new HorizonIngestionWorker({ concurrency: 2 });
  const processed = [];

  worker.setPaymentHandler(async (campaignId, walletPublicKey, record) => {
    processed.push(record.id);
  });
  worker.status = "running";

  await worker.enqueuePaymentRecord("camp-1", "GWALLET1", { id: "p1", transaction_hash: "tx1" });
  await worker.enqueuePaymentRecord("camp-1", "GWALLET1", { id: "p2", transaction_hash: "tx2" });
  await worker.enqueuePaymentRecord("camp-1", "GWALLET1", { id: "p3", transaction_hash: "tx3" });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(processed.length, 3);
  assert.deepEqual(processed, ["p1", "p2", "p3"]);
  assert.equal(worker.metrics.processed_count, 3);
});

test("flushCursors batch updates database cursors", async () => {
  let dbFlushes = 0;
  const mockQuery = async (text, params) => {
    if (text.includes("INSERT INTO ledger_stream_cursors")) {
      dbFlushes++;
      return { rows: [] };
    }
    return { rows: [] };
  };

  const { HorizonIngestionWorker } = buildWorkerTestHarness(mockQuery);
  const worker = new HorizonIngestionWorker();

  worker.setPaymentHandler(async () => {});
  worker.status = "running";

  await worker.enqueuePaymentRecord("camp-1", "GWALLET1", { id: "p1", paging_token: "pt-1" });
  await worker.enqueuePaymentRecord("camp-2", "GWALLET2", { id: "p2", paging_token: "pt-2" });

  assert.equal(worker.pendingCursors.size, 2);

  await worker.flushCursors();

  assert.equal(dbFlushes, 2);
  assert.equal(worker.pendingCursors.size, 0);
});

test("worker records failure and logs to failed_payment_records on payment error", async () => {
  let failedInserts = 0;
  const mockQuery = async (text) => {
    if (text.includes("INSERT INTO failed_payment_records")) {
      failedInserts++;
      return { rows: [] };
    }
    return { rows: [] };
  };

  const { HorizonIngestionWorker } = buildWorkerTestHarness(mockQuery);
  const worker = new HorizonIngestionWorker();

  worker.setPaymentHandler(async () => {
    throw new Error("Simulated payment indexing error");
  });
  worker.status = "running";

  await worker.enqueuePaymentRecord("camp-1", "GWALLET1", {
    transaction_hash: "tx-err-1",
    paging_token: "pt-err-1",
  });

  assert.equal(worker.metrics.failed_count, 1);
  assert.equal(failedInserts, 1);
  assert.equal(worker.metrics.last_error, "Simulated payment indexing error");
});

test("pause and resume control queue processing execution", async () => {
  const { HorizonIngestionWorker } = buildWorkerTestHarness();
  const worker = new HorizonIngestionWorker({ concurrency: 1 });
  const processed = [];

  worker.setPaymentHandler(async (campaignId, walletPublicKey, record) => {
    processed.push(record.id);
  });
  worker.status = "running";

  worker.pause();
  assert.equal(worker.status, "paused");

  await worker.enqueuePaymentRecord("camp-1", "GWALLET1", { id: "paused-1", transaction_hash: "tx-p1" });
  assert.equal(processed.length, 0);
  assert.equal(worker.queue.length, 1);

  worker.resume();
  assert.equal(worker.status, "running");
  assert.equal(processed.length, 1);
  assert.equal(worker.queue.length, 0);
});

test("getHealth returns detailed status snapshot for ops monitoring", async () => {
  const { HorizonIngestionWorker } = buildWorkerTestHarness();
  const worker = new HorizonIngestionWorker();

  await worker.registerWallet("camp-alpha", "GWALLETALPHA", "cursor-alpha");

  const health = worker.getHealth();

  assert.equal(health.worker_status, "stopped");
  assert.equal(health.active_campaigns, 1);
  assert.equal(health.queue_depth, 0);
  assert.equal(health.streams.length, 1);
  assert.equal(health.streams[0].campaign_id, "camp-alpha");
  assert.equal(health.streams[0].wallet_public_key, "GWALLETALPHA");
  assert.equal(health.streams[0].last_cursor, "cursor-alpha");
});

test("loadCampaignWallets loads active and funded campaigns into memory", async () => {
  const mockQuery = async (text) => {
    if (text.includes("FROM campaigns")) {
      return {
        rows: [
          { id: "c1", wallet_public_key: "G1", last_cursor: "cursor-1" },
          { id: "c2", wallet_public_key: "G2", last_cursor: "cursor-2" },
        ],
      };
    }
    return { rows: [] };
  };

  const { HorizonIngestionWorker } = buildWorkerTestHarness(mockQuery);
  const worker = new HorizonIngestionWorker();

  const loaded = await worker.loadCampaignWallets();

  assert.equal(loaded.length, 2);
  assert.equal(worker.watchedWallets.get("G1"), "c1");
  assert.equal(worker.watchedWallets.get("G2"), "c2");
  assert.equal(worker.cursors.get("c1"), "cursor-1");
  assert.equal(worker.cursors.get("c2"), "cursor-2");
});
