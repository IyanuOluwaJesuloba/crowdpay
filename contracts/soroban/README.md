# CrowdPay Soroban Contracts

This workspace contains the Soroban smart contracts that drive CrowdPay's
on-chain behaviour: per-campaign fund custody and milestone-based fund release.
Three contracts live under `contracts/`; only two of them are wired into the
backend today. This document describes what each contract does, how they
relate, how to build and deploy them, and how to recover when something goes
wrong.

> **TL;DR** — `escrow` and `milestones` are the active contracts. `crowdpay`
> is a legacy single-campaign bundle that is **not** deployed or invoked by the
> backend; its source is kept for reference only.

---

## 1. Contract map

| Contract   | Path                                   | Purpose                                                          | Used by backend? | Status      |
|------------|----------------------------------------|------------------------------------------------------------------|------------------|-------------|
| `escrow`     | `contracts/escrow`                     | Per-campaign fund custody, fee config, withdrawals, refunds.      | ✅ yes            | active      |
| `milestones` | `contracts/milestones`                 | Milestone submission/approval; calls into escrow for releases.   | ✅ yes            | active      |
| `crowdpay`   | `contracts/crowdpay`                   | Self-contained campaign contract (funding + escrow + milestones). | ❌ no             | **deprecated** — see §6 |

The backend deploys one `escrow` instance and one `milestones` instance per
campaign via `backend/src/services/sorobanService.js::deployCampaignContracts`
(see §3). The `crowdpay` contract is not part of that flow.

---

## 2. Active architecture (escrow ↔ milestones)

A campaign is modelled on-chain as two paired contract instances:

```
                         CrowdPay backend
                         (sorobanService.js)
                                │
                                │ deployCampaignContracts()
                                ▼
   ┌────────────────────────────────────────────────────────────┐
   │                   Per-campaign instances                   │
   │                                                            │
   │   milestones instance ───────► escrow instance             │
   │   ─ initialized with the      ─ initialized with the        │
   │     milestones contract        admin (see §3.4 note)        │
   │     address set as the escrow's target                       │
   │   ─ submit_milestone()       ─ deposit(from, amount)         │
   │   ─ approve_milestone()      ─ approve_withdrawal(to, amount)│
   │       │                      ─ execute_withdrawal(to, amount)│
   │       └── cross-contract ─►                                  │
   │           approve_withdrawal + execute_withdrawal           │
   │   ─ reject_milestone()       ─ refund(contributor)           │
   │                              ─ propose/confirm/cancel        │
   │                                fee_change                    │
   └────────────────────────────────────────────────────────────┘
                                │
                                ▼
                   Stellar SAC token (USDC / XLM)
```

### 2.1 Lifecycle

1. **Campaign creation** — backend deploys a fresh `escrow` then a fresh
   `milestones` instance; both are initialized with campaign-specific
   parameters (creator, target, deadline, asset, fee config, milestone
   definitions). The resulting contract IDs are stored on the campaign row.
2. **Contribution phase** — backend calls `escrow.deposit(from, amount)`. The
   escrow pulls the token from the contributor, credits the contributor's
   in-contract balance, and emits a `deposit` event.
3. **Milestone phase** — creator submits evidence via
   `milestones.submit_milestone(index, evidence_hash)`; a platform approver
   calls `milestones.approve_milestone(index)`. Inside `approve_milestone`
   the milestones contract issues cross-contract calls to escrow's
   `approve_withdrawal` and `execute_withdrawal`; funds are released to the
   creator with the platform fee deducted.
4. **Refund phase (campaign failed)** — after the deadline passes, if the
   target was not met, any contributor can call `escrow.refund(contributor)`
   to reclaim their deposit. The escrow enforces `total_raised < target` and
   `now > deadline`.

### 2.2 Events emitted

The backend's ledger monitor (`backend/src/services/ledgerMonitor.js`)
subscribes to these events to update off-chain state and trigger notifications.

| Contract   | Event           | Topic symbol        | Emitted by public fn       | Payload                                          |
|------------|-----------------|---------------------|----------------------------|--------------------------------------------------|
| `escrow`     | `deposit`       | `Symbol::new("deposit")`     | `deposit`               | `i128` amount                                     |
| `escrow`     | `withdrawal`    | `Symbol::new("withdrawal")`  | `execute_withdrawal`    | `(release_amount, net_amount, fee_amount)`        |
| `escrow`     | `refund`        | `Symbol::new("refund")`       | `refund`                | `i128` amount                                     |
| `escrow`     | `fee_proposed`  | `Symbol::new("fee_proposed")` | `propose_fee_change`    | `u32` new_fee_bps                                  |
| `escrow`     | `fee_changed`   | `Symbol::new("fee_changed")`  | `confirm_fee_change`    | `u32` new_fee_bps                                  |
| `escrow`     | `fee_cancelled` | `Symbol::new("fee_cancelled")`| `cancel_fee_change`     | `()`                                               |
| `milestones` | `submit`        | `symbol_short!("submit")`    | `submit_milestone`     | `BytesN<32>` evidence_hash                        |
| `milestones` | `release`       | `symbol_short!("release")`   | `approve_milestone`    | `(Address creator, i128 release_amount)`          |
| `milestones` | `approve`       | `symbol_short!("approve")`   | `approve_milestone`    | `()`                                              |
| `milestones` | `reject`        | `symbol_short!("reject")`    | `reject_milestone`     | `BytesN<32>` reason_hash                          |

---

## 3. Initialization parameters

### 3.1 `escrow.initialize`

```rust
pub fn initialize(
    env: Env,
    admin: Address,              // caller authorised for approve_withdrawal / fee changes
    campaign_id: u64,           // off-chain campaign row id (informational)
    target: i128,                // funding goal in token's smallest unit
    deadline: u64,              // unix seconds after which refunds are allowed
    asset: Address,             // Stellar SAC token contract address
    platform_fee_bps: u32,      // fee in basis points, 0..=1000 (10%)
    platform_fee_recipient: Address, // platform account (must authorize initialize)
)
```

| Parameter                | Type      | Constraint                                   | Notes |
|--------------------------|-----------|----------------------------------------------|-------|
| `admin`                  | `Address` | must be authorised to call `approve_withdrawal`, `execute_withdrawal`, `propose_fee_change`, `confirm_fee_change`, `cancel_fee_change` | In production **set the milestones contract address as `admin`** and have it authorise the platform's release calls (see §3.4). |
| `campaign_id`           | `u64`     | any value                                    | Stored but not enforced on-chain. Backend ghosts it back to the campaign row. |
| `target`                | `i128`    | > 0                                          | Compared against `total_raised` to enable `refund`. |
| `deadline`              | `u64`     | future unix timestamp                        | `deposit` rejects contributions after the deadline; `refund` requires `now > deadline`. |
| `asset`                 | `Address` | Stellar SAC token                            | Token transferred on `deposit`/`execute_withdrawal`/`refund`. |
| `platform_fee_bps`      | `u32`     | `0..=MAX_FEE_BPS` (1000 = 10%)               | Above this the contract panics at init. Two-step change only (`propose_fee_change` → `confirm_fee_change`). |
| `platform_fee_recipient`| `Address` | valid Stellar account                        | Must authorize initialization (`require_auth`). Receives the fee portion on `execute_withdrawal`. |

#### Events / invariants enforced
- `platform_fee_recipient.require_auth()` enforced at initialization to ensure only authorized platform accounts initialize contracts.
- `MAX_FEE_BPS` constant (1000) lives in `escrow/src/lib.rs`; any fee change above it is rejected both at `initialize` *and* at `propose_fee_change` *and* at `confirm_fee_change` (defense-in-depth).
- Calling `initialize` twice panics with `Contract is already initialized`.
- `approve_withdrawal(to, amount)` binds the approved release amount explicitly to the `to` address and emits `(Symbol::new("approve_withdrawal"), to)`.
- `execute_withdrawal(to, amount)` requires `admin.require_auth()`, verifies `approved_withdrawal_for(to) >= amount`, and deducts from the destination-specific approval.

### 3.2 `milestones.initialize`

```rust
pub fn initialize(
    env: Env,
    creator: Address,
    platform: Address,           // approver authorised to call approve_milestone / reject_milestone
    escrow: Address,             // paired escrow instance this contract will call into
    milestones: Vec<Milestone>,
)
```

| Parameter    | Type              | Constraint                                    | Notes |
|--------------|-------------------|----------------------------------------------|-------|
| `creator`   | `Address`         | valid Stellar account (distinct from platform)| `submit_milestone` calls `creator.require_auth()`. |
| `platform`  | `Address`         | valid Stellar account                          | Must authorize initialization (`require_auth`). `approve_milestone` / `reject_milestone` call `platform.require_auth()`. |
| `escrow`    | `Address`         | paired escrow instance                         | Used as cross-contract call target. |
| `milestones`| `Vec<Milestone>`  | **sum of `release_bps` must equal 10000**      | Enforced at init; otherwise panics with `Total BPS must be 10000`. |

`Milestone` struct:

```rust
pub struct Milestone {
    pub title_hash: BytesN<32>,            // arbitrary content hash for the milestone title/description
    pub release_bps: u32,                  // share of total raised to release at this milestone; whole set sums to 10000
    pub status: MilestoneStatus,           // Pending | Submitted | Approved | Rejected
    pub evidence_hash: Option<BytesN<32>>,  // set by submit_milestone
}
```

Calling `initialize` twice panics with `Already initialized`.

### 3.3 Cross-contract call flow (`milestones.approve_milestone` → `escrow`)

1. `approve_milestone(index)` requires `platform.require_auth()`.
2. The milestone's status must currently be `Submitted`; otherwise panics with `Milestone not submitted`.
3. Status is set to `Approved` and the milestone vector is persisted.
4. The contract reads the escrow address from storage and the creator address.
5. **Cross-contract calls in this order:**
   1. `escrow.get_total_raised()` — read-only; not whitelisted but does not call `require_auth`.
   2. `release_amount = total_raised * release_bps / 10000`.
   3. If `release_amount > 0`:
      - `escrow.approve_withdrawal(creator, release_amount)` — **requires escrow admin auth** (see §3.4) and binds approved amount to `creator`.
      - `escrow.execute_withdrawal(creator, release_amount)` — **requires escrow admin auth**, verifies destination approval, performs the token transfer, deducts platform fee.
      - proceeds `release` event.
6. An `approve` event is emitted regardless of whether funds moved.

### 3.4 ⚠️ Critical auth requirement: escrow admin must be the milestones contract

`escrow.approve_withdrawal` and `escrow.execute_withdrawal` call
`admin.require_auth()`. When `milestones.approve_milestone` invokes
`approve_withdrawal` and `execute_withdrawal` cross-contract, the **escrow's `admin` must therefore be
the milestones contract's own address**, otherwise the cross-contract call will
fail with an authorization error.

> **When deploying a campaign**, set `escrow.initialize(admin = <milestones contract address>, …)`. The backend's `deployCampaignContracts` is responsible for wiring this correctly; verify it before mainnet campaigns (see §7 checklist).

### 3.5 Fee governance (`escrow.propose_fee_change` / `confirm_fee_change` / `cancel_fee_change`)

To prevent an accidental one-step fee hike, fee changes use a two-step process:

```
propose_fee_change(new_fee_bps)   // admin only; stores pending fee; emits fee_proposed
   │
   ├── confirm_fee_change()       // admin only; applies pending fee; emits fee_changed
   │
   └── cancel_fee_change()        // admin only; discards pending fee; emits fee_cancelled
```

Both `propose_fee_change` and `confirm_fee_change` re-check the pending value
against `MAX_FEE_BPS` as a defense-in-depth measure; setting a value above the
cap is rejected at both steps. `get_pending_fee()` returns the current pending
proposal as `Option<u32>`.

---

## 4. Local development

### 4.1 Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- the `wasm32v1-none` target: `rustup target add wasm32v1-none`
- [Stellar CLI](https://developers.stellar.org/docs/build/sdks-and-libraries/cli) (`stellar`)
- A working Stellar testnet account (see §5)

### 4.2 Build a single contract

Each contract has a `Makefile` exposing the same convenience targets:

```
make build    # stellar contract build -> target/wasm32v1-none/release/<name>.wasm
make test     # cargo test
make fmt      # cargo fmt --all
make clean    # cargo clean
```

```bash
cd contracts/soroban/contracts/escrow
make build
make test
```

The `milestones` contract has a Makefile with the same targets. The legacy
`crowdpay` Makefile builds in `--target wasm32v1-none` mode and writes to a
shared `target/` directory; see §6 before using it.

### 4.3 Build the whole workspace

```bash
cd contracts/soroban
stellar contract build
```

### 4.4 Run all tests

```bash
cd contracts/soroban
cargo test --all
```

---

## 5. Testnet deployment

The canonical deployment path used by CrowdPay is the backend script
`backend/src/scripts/deployContracts.js`, which:

1. Loads `backend/.env` (`PLATFORM_SECRET_KEY` and `STELLAR_NETWORK`).
2. Validates both WASMs exist under `contracts/soroban/target/wasm32v1-none/release/`.
3. Deploys `escrow.wasm` and `milestones.wasm` with `stellar contract deploy` using the platform keypair as `--source`.
4. Prints the resulting contract IDs to stdout.

### 5.1 Canonical deploy (recommended)

```bash
# 1. Build WASM
cd contracts/soroban
stellar contract build

# 2. Configure backend/.env with PLATFORM_SECRET_KEY + STELLAR_NETWORK=testnet
#    and fund the platform account on testnet (friendbot or dashboard).

# 3. Deploy
cd ../../backend
node src/scripts/deployContracts.js
```

Record the printed contract IDs into `backend/.env`:

```
ESCROW_WASM_HASH=<hash from `stellar contract deploy` output / inspect via CLI>
MILESTONES_WASM_HASH=<same for milestones>
ESCROW_CONTRACT_ID=<optional pre-deployed instance>
MILESTONES_CONTRACT_ID=<optional pre-deployed instance>
```

At campaign-create time, `deployCampaignContracts` reuses these hashes if
present, or deploys fresh per-campaign instances otherwise.

### 5.2 Manual per-contract deploy (advanced)

If you need to deploy a contract directly with `stellar` CLI:

```bash
# Configure once per machine
stellar network add --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" testnet

# Generate + fund a deployer key (testnet only)
stellar keys generate --network testnet crowdpay-dev
stellar keys fund --network testnet crowdpay-dev

# Build, then deploy each contract
cd contracts/soroban/contracts/escrow
make build
ESCROW_ID=$(stellar contract deploy \
  --wasm ../../target/wasm32v1-none/release/escrow.wasm \
  --source crowdpay-dev \
  --network testnet)
echo "escrow: $ESCROW_ID"

cd ../milestones
make build
MILESTONES_ID=$(stellar contract deploy \
  --wasm ../../target/wasm32v1-none/release/milestones.wasm \
  --source crowdpay-dev \
  --network testnet)
echo "milestones: $MILESTONES_ID"
```

Initialize escrow for a campaign (replace placeholder values):

```bash
stellar contract invoke \
  --id "$ESCROW_ID" \
  --source crowdpay-dev \
  --network testnet \
  -- \
  initialize \
  --admin       "$MILESTONES_ID" \
  --campaign_id 12345 \
  --target      1000000000 \
  --deadline    1767225600 \
  --asset       <USDC_SAC_CONTRACT_ADDRESS> \
  --platform_fee_bps        500 \
  --platform_fee_recipient  <PLATFORM_ADDRESS>
```

Initialize milestones (the milestones vector must sum to exactly 10000 BPS):

```bash
stellar contract invoke \
  --id "$MILESTONES_ID" \
  --source crowdpay-dev \
  --network testnet \
  -- \
  initialize \
  --creator  <CREATOR_ADDRESS> \
  --platform <PLATFORM_ADDRESS> \
  --escrow   "$ESCROW_ID" \
  --milestones '[{"title_hash":"...","release_bps":5000,"status":0,"evidence_hash":null},
                 {"title_hash":"...","release_bps":5000,"status":0,"evidence_hash":null}]'
```

> **Wire order**: deploy escrow first (you need its ID), then milestones
> (escrow is one of its init args). Set escrow's `admin` to the milestones
> contract's address so that cross-contract `approve_withdrawal` calls
> succeed — see §3.4.

---

## 6. Legacy `crowdpay` contract

`contracts/crowdpay/` is a single-campaign contract that bundles funding,
escrow, and milestone management into one instance. It is **not** wired into
the backend in any form:

- The backend deploys only `escrow` and `milestones` (`deployContracts.js` lists just those two).
- No backend route, service, or test references a `crowdpayContractId`.
- `deploy_crowdpay.sh` at the workspace root references a `deployer` key and
  `target/wasm32-unknown-unknown/release/crowdpay.wasm`; neither is consumed
  anywhere else in the repo.

### 6.1 Public entry points (for reference)

- `initialize(campaign_id, creator, token, goal, deadline, milestones)`
- `contribute(contributor, amount)`
- `release_milestone(index)` — direct release within the same contract
- `refund(contributor)` — refund a single contributor if status is `Failed`
- `set_failed()` — mark campaign failed after deadline if goal not met
- `get_status()`, `get_total_raised()`

### 6.2 Why it is not used

The escrow + milestones split allows independent contract lifecycles per
campaign and supports the cross-contract approval flow that the platform's
business model requires (platform verifies evidence → milestones contract
authorises escrow release). The bundle contract would require an entirely
separate deploy/initialize pathway, lacks the cross-contract approval flow,
and would need continuous parallel maintenance.

### 6.3 If you want to revive it

Before reintroducing `crowdpay`:

1. Decide whether to keep the `escrow ↔ milestones` split or migrate
   entirely. Mixing both flows on the same campaign is **not** supported and
   will confuse the ledger monitor's event-consumer logic.
2. Update `escrow::MAX_FEE_BPS` parity and fee-change governance if relevant.
3. Add a backend deployment path: extend `deployContracts.js` and
   `deployCampaignContracts`, add a `CROWDPAY_WASM_HASH` env var, and write
   a route that records a `crowdpay_contract_id` on the campaign row.
4. Add event consumers in `ledgerMonitor.js` for any events the bundle
   contract emits that are not already produced by escrow/milestones.

Until all of the above are addressed, treat `crowdpay/` as read-only
reference code.

---

## 7. Mainnet deployment checklist

> Mainnet contracts are **immutable** once deployed — there is no
> `update_wasm` admin handle on either active contract (see §9). A
> botched mainnet deployment cannot be undone; funds already in a deployed
> escrow contract remain under the WASM hash they were deployed with.
> Proceed deliberately, with placeholder values replaced and reviewed.

### 7.1 Pre-deploy

- [ ] Confirm `STELLAR_NETWORK=mainnet` and the publishing key (`PLATFORM_SECRET_KEY`) is the platform's mainnet custody key, held in a hardware-backed keystore — never in a `.env` file checked into anyone's machine.
- [ ] Confirm `STELLAR_HORIZON_URL=https://horizon.stellar.org`.
- [ ] Confirm the Stellar network passphrase is exactly
      `Public Global Stellar Network ; September 2015` — set automatically by `stellar network add` when configuring mainnet.
- [ ] Account funding: only your platform custody account. Friendbot and other testnet faucets are unavailable on mainnet.
- [ ] Build artifacts: `cd contracts/soroban && stellar contract build`. The expected outputs are
      `contracts/soroban/target/wasm32v1-none/release/escrow.wasm` and
      `contracts/soroban/target/wasm32v1-none/release/milestones.wasm`.
- [ ] Capture the SHA-256 hash of each WASM file (`shasum -a 256 *.wasm`) and store it with the deployment manifest for later audit.
- [ ] Run the full test suite: `cargo test --all`. Any failure blocks the deploy.
- [ ] Audit `MAX_FEE_BPS` and the platform fee value to be used:
      `PLATFORM_FEE_BPS` from `.env` must be ≤ `1000` (10%). Initial fees
      above 10% will panic at `escrow.initialize`.

### 7.2 Deploy

```bash
# All REPLACE_ME values are private; do not commit them anywhere.
cd backend
node src/scripts/deployContracts.js \
  # reads STELLAR_NETWORK=mainnet and PLATFORM_SECRET_KEY from backend/.env
```

Capture the deployed contract IDs and WASM hashes:

```
ESCROW_WASM_HASH=REPLACE_ME
MILESTONES_WASM_HASH=REPLACE_ME
ESCROW_CONTRACT_ID=REPLACE_ME
MILESTONES_CONTRACT_ID=REPLACE_ME
```

### 7.3 Post-deploy verification

- [ ] Verify each contract ID exists on the public Horizon: `stellar contract read --id REPLACE_ME --network mainnet -- get_total_raised` (escrow) etc.
- [ ] Run a small **canary campaign** end-to-end (deposit → submit_milestone →
      approve_milestone → refund/release) with a non-customer account first.
- [ ] Confirm the backend ledger monitor ingests the call traces correctly
      (`backend/src/services/ledgerMonitor.js`).
- [ ] Save the deploy manifest, including contract IDs, WASM hashes, deployer
      key fingerprint (not the key), network, timestamp, and PR hash into
      version control or a write-once audit log.

### 7.4 Roll-forward safety

There is no rollback on-chain for an active escrow. If a contract is later found buggy, the only path is:

1. Stop the backend from creating new campaigns that reference the buggy contract.
2. For each affected campaign: trigger `escrow.refund` for contributors (requires deadline passed + target not met); for completed campaigns contact the creator off-platform to coordinate a manual settlement.

This process is documented honestly here precisely because Soroban contract
instances are not upgradeable in the form shipped by these contracts. Adding
an admin-gated `update_wasm` handle is a separate, non-trivial change that
is **out of scope** for this documentation PR; see §9 for the upgrade story.

---

## 8. Deployment checklist (general)

Use as a once-over before any environment (testnet or mainnet):

- [ ] `cargo test --all —all-features` passes for the workspace.
- [ ] WASMs built (`stellar contract build`).
- [ ] `STELLAR_NETWORK`, `STELLAR_HORIZON_URL`, and `PLATFORM_SECRET_KEY` set
      appropriately for the target environment.
- [ ] Platform account on the target network has enough native XLM to cover
      minimum reserve + transaction fee buffer for the deploy.
- [ ] `ESCROW_WASM_HASH` / `MILESTONES_WASM_HASH` match the built WASM (compare hashes).
- [ ] `escrow.initialize`'s `admin` will be set to the milestones contract's
      address (see §3.4) — this is checked in the backend's
      `deployCampaignContracts`, but verify manually on mainnet.
- [ ] Deployed contract IDs added to `.env` (or your secrets manager) for the
      lifetime of that campaign batch.
- [ ] Deploy manifest stored: contract IDs, WASM hashes, network passphrase,
      deploy timestamp, deployer key fingerprint.

---

## 9. Upgrade / rollback procedure

### 9.1 On-chain immutability (current contracts)

Neither `escrow` nor `milestones` exposes an admin-gated `update_wasm` or
similar handle. Once a contract is instantiated at an address, that
instance's WASM hash cannot be changed on-chain. This applies to:

- `escrow` — public fns are `initialize`, `deposit`, `approve_withdrawal`,
  `execute_withdrawal`, `refund`, `propose_fee_change`, `confirm_fee_change`,
  `cancel_fee_change`, `get_pending_fee`, `get_total_raised`, `get_asset`,
  `get_platform_fee_config`. No `set_wasm` / `update` equivalent.
- `milestones` — public fns are `initialize`, `submit_milestone`,
  `approve_milestone`, `reject_milestone`, `get_milestone`, `get_all_milestones`.
  No `set_wasm` / `update` equivalent.

### 9.2 What "rollback" means in practice

There is no on-chain revert. The operational meaning of "rollback" is:

1. **Stop the bleeding** — pause campaign creation in the backend (e.g.
   `SOROBAN_ENABLED=false` or a feature flag) so no new campaign is wired to
   the affected contract code.
2. **Recover stuck funds** — for campaigns whose escrow holds balances:
   - If eligible (`now > deadline` and `total_raised < target`), call
     `escrow.refund(contributor)` for each contributor. The contract supports
     this independently of the backend; it can be triggered from a CLI session.
   - If the campaign already passed its `execute_withdrawal` for all
     milestones, funds have already moved to the creator — there is no
     on-chain return path. Coordinate off-platform with the creator.
3. **Redeploy** — once the bug is fixed, rebuild WASMs, redeploy *new* contract
   instances, and configure the backend to use the new IDs/hashes. Existing
   campaign rows continue to reference the old (immutable) instances until
   they are intentionally wound down as above.

### 9.3 Future direction (not yet implemented)

Adding an admin-gated `wasm_update` handle (typical Soroban pattern: store
the admin address at init; expose a `set_wasm`/`update_wasm` function that
replaces the contract's installed WASM hash in instance storage) would let
future contracts be patched without redeployment. This is a follow-up design
task — **no code change in this PR** — and would itself require a hardening
review (admin auth model, two-step proposal/confirmation like the fee
governance flow, and auditing what state must cross-migrate).

---

## 10. Troubleshooting

| Symptom                                         | Likely cause                                                                                                            | Resolution |
|-------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|------------|
| `Error: Wasm file not found`                    | Build step skipped or wrong path.                                                                                       | Run `stellar contract build` from `contracts/soroban`. Verify the WASM exists at `target/wasm32v1-none/release/<name>.wasm`. |
| `Platform fee BPS must not exceed MAX_FEE_BPS`  | `platform_fee_bps > 1000` passed to `escrow.initialize` (or `propose_fee_change`).                                     | Lower the fee to ≤ 10% (1000 BPS). |
| `Contract is already initialized`                | `initialize` called twice on the same instance.                                                                          | This is by design — deploy a new instance per campaign. |
| `Total BPS must be 10000`                          | `milestones.initialize` received a vector whose `release_bps` does not sum to 10000 (100%).                            | Recheck your milestone definitions. Verify both contracts see the same milestone set (no rounding). |
| `Milestone not submitted`                         | `approve_milestone` / `reject_milestone` called before `submit_milestone`.                                              | Submit first. |
| `Insufficient approved amount`                  | `execute_withdrawal` requested more than was approved via `approve_withdrawal`.                                         | Re-issue `approve_withdrawal` for the missing amount (or lower the requested release). |
| `Deadline has not passed`                        | `escrow.refund` called before the deadline.                                                                              | Refunds require `now > deadline`. |
| `Campaign succeeded, refunds unavailable`        | `total_raised >= target` at refund time.                                                                                | The campaign cannot be refunded once funded; coordinate off-platform with the creator. |
| `No pending fee change to confirm` / `to cancel`| `confirm_fee_change` / `cancel_fee_change` called without any `propose_fee_change` in flight.                            | Issue a `propose_fee_change` first. |
| Cross-contract `approve_withdrawal` fails          | Escrow's `admin` was not set to the milestones contract address.                                                        | Re-deploy both contracts with the correct `admin = <milestones contract id>` (see §3.4). The escrow instance cannot have its admin updated post-init. |
| Backend ledger monitor does not ingest events    | Event topic names don't match `ledgerMonitor.js` expectations.                                                          | Cross-reference the events table in §2.2 with the monitor and adjust the consumer, not the contract. |

---

## 11. Environment variables consumed by the backend

| Variable                  | Used for                                                                       | Required |
|---------------------------|--------------------------------------------------------------------------------|----------|
| `SOROBAN_ENABLED`           | Gate Soroban contract interactions. Set to `true` to enable.                   | optional |
| `ESCROW_WASM_HASH`          | Runtime WASM hash for `escrow`. Used by `deployCampaignContracts`.               | required if `SOROBAN_ENABLED=true` |
| `MILESTONES_WASM_HASH`      | Runtime WASM hash for `milestones`. Used by `deployCampaignContracts`.           | required if `SOROBAN_ENABLED=true` |
| `ESCROW_CONTRACT_ID`        | Pre-deployed `escrow` instance ID — skips a fresh deploy when set.              | optional |
| `MILESTONES_CONTRACT_ID`    | Pre-deployed `milestones` instance ID — skips a fresh deploy when set.           | optional |
| `PLATFORM_SECRET_KEY`       | Stellar secret key for the platform custody account (also used as deploy signer). | required (see `backend/.env.example`) |
| `STELLAR_NETWORK`           | `testnet` or `mainnet` only. Validated at backend startup.                       | required (validated at startup since the env-hardening change). |
| `STELLAR_HORIZON_URL`       | Horizon base URL.                                                                | required |
| `PLATFORM_FEE_BPS`          | Default platform fee in BPS for new campaigns (must be ≤ 1000).                   | optional |

> The `crowdpay` contract exposes no env var. There is no `CROWDPAY_WASM_HASH` or
> `CROWDPAY_CONTRACT_ID`.

---

## 12. Repository layout

```
contracts/soroban/
├── Cargo.toml                       # workspace, members = contracts/*
├── Cargo.lock
├── README.md                        # this file
├── deploy_crowdpay.sh               # legacy helper; not wired into the backend
└── contracts/
    ├── crowdpay/                    # legacy bundle contract (deprecated; see §6)
    │   ├── Cargo.toml
    │   ├── Makefile
    │   └── src/
    │       ├── lib.rs
    │       └── test.rs
    ├── escrow/                      # active — per-campaign fund custody
    │   ├── Cargo.toml
    │   ├── Makefile
    │   └── src/
    │       └── lib.rs
    └── milestones/                  # active — milestone submission/approval
        ├── Cargo.toml
        ├── Makefile
        └── src/
            ├── lib.rs
            └── tests/
```
