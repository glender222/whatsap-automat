# Whatsap-Automat Python SDK (`whatsap-automat-sdk`)

Official typed Python client library for the **Whatsap-Automat v0.4 REST API**.

## Features

- **Full Typing**: Comprehensive Pydantic v2 data models for Conversations, Messages, Channels, Agent Traces, and Approvals.
- **Dual Client Support**: Both synchronous (`AutomatClient`) and asynchronous (`AsyncAutomatClient`) interfaces powered by `httpx`.
- **Automatic Resilience**: Transparent retry logic with exponential backoff and `Retry-After` header parsing for HTTP 429 (Rate Limited) and HTTP 503 (Service Unavailable).
- **Pythonic Pagination**: Native cursor-based iteration supporting `for conv in client.conversations.list():` and `async for conv in client.conversations.list():`.
- **RFC 7807 / RFC 9457 Errors**: Strongly-typed exceptions mapping HTTP status codes (`UnauthorizedError`, `ConflictError`, `PolicyDeniedError`, `ValidationError`).

## Installation

```bash
pip install whatsap-automat-sdk
```

## Quick Start

### Synchronous Usage

```python
from whatsap_automat_sdk import AutomatClient

client = AutomatClient(
    base_url="https://api.whatsap-automat.com",
    api_key="your-api-key",
    tenant_id="tenant-101",
)

# Iterate across all conversations via cursor pagination
for conv in client.conversations.list():
    print(f"Conversation {conv.id} on channel {conv.channel}: status={conv.status}")

# Perform optimistic CAS takeover
conv = client.conversations.takeover(
    conversation_id="conv_123",
    expected_version=2,
    user_id="usr_agent_01",
    reason="Customer escalated issue",
)
```

### Asynchronous Usage (FastAPI, asyncio)

```python
import asyncio
from whatsap_automat_sdk import AsyncAutomatClient

async def main():
    async with AsyncAutomatClient(
        base_url="https://api.whatsap-automat.com",
        token="jwt-token",
        tenant_id="tenant-101",
    ) as client:
        # Async cursor iteration
        async for msg in client.conversations.list_messages("conv_123"):
            print(f"Message {msg.id}: {msg.body}")

asyncio.run(main())
```

## License

MIT
