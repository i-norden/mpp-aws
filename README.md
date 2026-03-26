# mmp-aws

Pay-per-use AWS compute marketplace powered by [MPP](https://github.com/tempoxyz/mpp) (Machine Payments Protocol). Clients pay for Lambda invocations and EC2 leases with USDC via the HTTP 402 flow.

## Features

- **Lambda invocation** -- pay-per-call with automatic refunds for overpayment
- **EC2 leasing** -- rent instances for 1/7/30 days with SSH access, public IP, and load balancer add-ons
- **MPP payments** -- 402 challenge-credential-receipt flow with on-chain USDC settlement
- **Refund system** -- on-chain USDC refunds with credit fallback for small amounts
- **Rate limiting** -- per-IP and per-address with optional Redis backend
- **Async jobs** -- submit long-running Lambda invocations and poll for results
- **Budgets** -- pre-authorized spending limits for automated agents
- **Batch invocations** -- invoke multiple functions in a single request
- **Earnings** -- function owners earn revenue from invocations with on-chain withdrawal
- **Admin API** -- function/lease/billing management with EIP-191 or API key auth

## Quick Start

```bash
cp .env.example .env
# edit .env -- at minimum set PAY_TO_ADDRESS

docker compose up
```

Or without Docker:

```bash
npm install
npm run migrate    # requires DATABASE_URL
npm run dev
```

## Configuration

All configuration is via environment variables. See [.env.example](.env.example) for the full list.

**Required:**
- `PAY_TO_ADDRESS` -- Ethereum address that receives payments
- `DATABASE_URL` -- PostgreSQL connection string
- `FACILITATOR_URL` -- MPP settlement service endpoint

**Optional (enable features):**
- `REFUND_ENABLED=true` + `REFUND_PRIVATE_KEY` -- automatic overpayment refunds
- `LEASE_ENABLED=true` + `LEASE_SUBNET_IDS`, `LEASE_SECURITY_GROUP_ID`, `LEASE_VPC_ID` -- EC2 leasing
- `ASYNC_JOBS_ENABLED=true` -- async job submission
- `ALLOW_OPEN_REGISTER=true` -- public function registration (with fee)

## API

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/functions` | List registered functions |
| GET | `/functions/search?q=...` | Full-text search |
| GET | `/pricing` | Pricing info |

### Payment Required (402 flow)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/invoke/:function` | Invoke a Lambda function |
| POST | `/invoke/:function/batch` | Batch invocation |
| POST | `/register` | Register a function (if open registration enabled) |
| POST | `/jobs/:function` | Submit async job |
| POST | `/budgets` | Create pre-authorized budget |
| POST | `/lease/:resourceId` | Create EC2 lease |

### Authenticated (EIP-191 signature)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/credits/:address` | Credit balance |
| POST | `/credits/:address/redeem` | Redeem credits on-chain |
| GET | `/earnings/:address` | Earnings balance |
| POST | `/earnings/:address/withdraw` | Withdraw earnings on-chain |
| PATCH | `/functions/:name` | Update owned function |

### Admin (API key or EIP-191)

All endpoints under `/admin/*` -- function management, lease management, billing reports, wallet operations, audit log.

## Payment Flow

1. Client sends request without payment
2. Server returns `402` with `WWW-Authenticate: Payment` and payment requirements
3. Client signs payment and retries with `Authorization: Payment <credential>`
4. Server verifies and settles payment on-chain, then processes the request
5. If overpaid, server issues an automatic USDC refund or credits the difference

## Architecture

```
src/
  config/          -- environment-based configuration
  db/              -- kysely database layer with 33 SQL migrations
  api/
    handlers/      -- route handlers (invoke, lease, credits, admin, etc.)
    middleware/     -- CORS, Payment auth, request IDs, logging, rate limiting
    router.ts      -- route assembly
  mpp/             -- MPP client with circuit breaker
  pricing/         -- lambda cost calculation
  billing/         -- billing orchestration, refund/credit logic
  refund/          -- on-chain USDC transfers via viem
  lambda/          -- AWS Lambda invocation with SSRF protection
  ec2/             -- EC2 instance management
  lease/           -- lease lifecycle + provisioning/expiry/bandwidth workers
  aws-pricing/     -- dynamic pricing from AWS Pricing API
  ssh-crypto/      -- ED25519 keygen + X25519 NaCl box encryption
  auth/            -- EIP-191 signature verification
  ratelimit/       -- token bucket + redis rate limiting
  server.ts        -- dependency wiring and graceful shutdown
```

## Tech Stack

- **Hono** -- web framework
- **Kysely** -- type-safe SQL query builder
- **viem** -- Ethereum interactions (refunds, signature verification)
- **PostgreSQL** -- persistence
- **Redis** -- distributed rate limiting (optional)
- **AWS SDK v3** -- Lambda, EC2, CloudWatch, Pricing

## License

MIT
