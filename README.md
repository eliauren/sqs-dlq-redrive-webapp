## SQS DLQ Redrive Web App

[![CI](https://github.com/eliauren/sqs-dlq-redrive-webapp/actions/workflows/ci.yml/badge.svg)](https://github.com/eliauren/sqs-dlq-redrive-webapp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/eliauren/sqs-dlq-redrive-webapp/actions/workflows/codeql.yml/badge.svg)](https://github.com/eliauren/sqs-dlq-redrive-webapp/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/eliauren/sqs-dlq-redrive-webapp/branch/main/graph/badge.svg)](https://codecov.io/gh/eliauren/sqs-dlq-redrive-webapp)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://github.com/eliauren/sqs-dlq-redrive-webapp/pkgs/container/sqs-dlq-redrive-webapp)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025e8c?logo=dependabot)](https://github.com/eliauren/sqs-dlq-redrive-webapp/security/dependabot)

Web application to preview, filter, and redrive AWS SQS Dead Letter Queue messages to a target queue, using AWS SSO for authentication.

### Features

- **SSO authentication** — connect via AWS SSO device flow directly from the browser, no static credentials needed.
- **Environment discovery** — automatically lists all AWS accounts and roles accessible with your SSO session.
- **Queue browsing** — lists all SQS queues in the selected account/region.
- **Message preview** — fetches messages from a DLQ with deduplication (handles visibility timeout cycling).
- **Attribute filtering** — optionally filter (include or exclude) messages by a JSON body attribute path and value.
- **Message inspection** — click any message row to view the full JSON body in a modal.
- **Redrive** — send selected messages to a target queue, with optional deletion from the DLQ.

### Prerequisites

- Node.js 20+
- AWS CLI configured on the host with at least one SSO profile (`aws configure sso`).

### Install and run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in your browser, select your SSO profile, and click **Connect with SSO**.

### Run from GitHub Container Registry

```bash
docker pull ghcr.io/eliauren/sqs-dlq-redrive-webapp:latest

docker run --rm -p 3000:3000 \
  -v ~/.aws:/root/.aws:ro \
  ghcr.io/eliauren/sqs-dlq-redrive-webapp:latest
```

### Build and run locally with Docker

```bash
docker build -t sqs-dlq-redrive .

docker run --rm -p 3000:3000 \
  -v ~/.aws:/root/.aws:ro \
  sqs-dlq-redrive
```

The `~/.aws` mount gives the container read-only access to your SSO profile definitions in `~/.aws/config`.

### Usage

1. **SSO Connection** — select an SSO profile and authenticate via the device flow link.
2. **Environment & Region** — pick an account/role and AWS region from the discovered environments.
3. **Queue** — click "Load queues" to list all SQS queues, then select the DLQ.
4. **Filter & Preview** — optionally enter an attribute path (e.g. `payload.orderId`) and value to filter messages, then click "Load messages from DLQ".
5. **Redrive** — select a target queue, check the messages to redrive, and click "Redrive selected messages".

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |

### Testing

```bash
npm test              # run tests once
npm run test:watch    # run in watch mode
npm run test:coverage # run with coverage report
```

