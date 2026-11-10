"""
Comprehensive test suite for whatsap-automat-sdk.
Verifies all operations, error mapping, pagination, retries, and headers using httpx.MockTransport.
Compatible with pytest and unittest.
"""

from __future__ import annotations

import json
import unittest
from typing import Any, Dict
import httpx

from whatsap_automat_sdk import (
    ApprovalRequiredError,
    AsyncAutomatClient,
    AutomatClient,
    ConflictError,
    Conversation,
    NotFoundError,
    PolicyDeniedError,
    ProblemDetailsError,
    RateLimitedError,
    ServiceUnavailableError,
    UnauthorizedError,
    ValidationError,
)


_APPROVAL_PASSWORD = "fixture-current-password"
_APPROVAL_KEY = "fixture-approval-key"
_APPROVAL_CAPABILITIES = ["approvals.review", "approvals.reauthenticate"]
_APPROVAL_FAILURES = (
    (403, "POLICY_DENIED", "APPROVAL_REAUTH_INVALID"),
    (429, "RATE_LIMITED", "APPROVAL_REAUTH_LIMITED"),
    (503, "RETRYABLE", _APPROVAL_PASSWORD),
    (307, None, None),
    (500, None, None),
    (201, None, None),
    (202, None, None),
)


def _approval_transport(case, capabilities, status, code=None, reason=None):
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path))
        if request.method == "GET":
            case.assertEqual(request.url.path, "/api/v1/workspaces/current")
            case.assertEqual(request.headers["Cache-Control"], "no-cache, no-store")
            case.assertEqual(request.content, b"")
            return httpx.Response(200, json={"capabilities": capabilities})
        case.assertEqual(request.url.path, "/api/v1/approvals/app_99/decision")
        case.assertEqual(request.headers["idempotency-key"], _APPROVAL_KEY)
        case.assertEqual(json.loads(request.content), {
            "decision": "approved", "expectedVersion": 3, "reason": "Reviewed refund",
            "password": _APPROVAL_PASSWORD,
        })
        if status == 200:
            return httpx.Response(200, json={
                "approvalId": "app_99", "status": "approved",
                "decidedAt": "2026-11-05T01:00:00Z", "decidedBy": "usr_mgr_1",
            })
        if status == 201:
            return httpx.Response(status, text=_APPROVAL_PASSWORD)
        if status == 202:
            return httpx.Response(status, json=_APPROVAL_PASSWORD)
        if status == 500:
            raise httpx.ReadError(_APPROVAL_PASSWORD, request=request)
        if status == 307:
            return httpx.Response(status, headers={"location": "https://other.example/redirect"})
        return httpx.Response(status, headers={"retry-after": "0"}, json={
            "code": code, "detail": _APPROVAL_PASSWORD, "title": _APPROVAL_PASSWORD,
            "metadata": {"reason": reason, "reflected": _APPROVAL_PASSWORD},
        })

    return httpx.MockTransport(handler), requests


def _assert_approval_failure(case, error, requests, status, code, reason):
    case.assertEqual(error.status, 502 if status in (201, 202) else status)
    case.assertEqual(error.code, code)
    case.assertEqual(error.metadata, {"reason": reason} if status in (403, 429) else {})
    case.assertNotIn(_APPROVAL_PASSWORD, str(error))
    case.assertNotIn(_APPROVAL_PASSWORD, repr(vars(error)))
    case.assertIsNone(error.__context__)
    case.assertEqual(requests, [
        ("GET", "/api/v1/workspaces/current"), ("POST", "/api/v1/approvals/app_99/decision"),
    ])


class TestAutomatClient(unittest.TestCase):
    """Test suite for synchronous AutomatClient and core functionality."""

    def test_unkeyed_mutation_does_not_retry_a_service_failure(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            self.assertEqual(request.method, "POST")
            return httpx.Response(503, text="Proxy unavailable")

        with AutomatClient(base_url="https://api.example.com", transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(ServiceUnavailableError):
                client.conversations.takeover("conv_1", expected_version=1)
        self.assertEqual(attempts, 1)

    def test_keyed_send_reuses_key_and_body(self) -> None:
        attempts: list[tuple[str, bytes]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append((request.headers["idempotency-key"], request.content))
            if len(attempts) == 1:
                return httpx.Response(503, headers={"retry-after": "0"})
            return httpx.Response(200, json={
                "providerMessageId": "wamid.fixture", "accepted": True,
                "rawStatus": "accepted", "deliveryState": "provider_accepted",
            })

        with AutomatClient(base_url="https://api.example.com", transport=httpx.MockTransport(handler)) as client:
            self.assertTrue(client.conversations.send_text("conv_1", "hola", 1, "effect-key").accepted)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0], attempts[1])
        self.assertEqual(attempts[0][0], "effect-key")

    def test_client_initialization_and_headers(self) -> None:
        captured_headers: Dict[str, str] = {}
        captured_url: str = ""

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal captured_headers, captured_url
            captured_url = str(request.url)
            captured_headers = dict(request.headers)
            return httpx.Response(
                200,
                json={
                    "id": "conv_01",
                    "tenantId": "t_99",
                    "connectionId": "conn_01",
                    "channel": "whatsapp-cloud",
                    "externalConversationId": "+1555123456",
                    "status": "open",
                    "stage": "new",
                    "stateVersion": 1,
                    "aiPaused": False,
                    "createdAt": "2026-11-05T00:00:00Z",
                    "updatedAt": "2026-11-05T00:00:00Z",
                },
            )

        client = AutomatClient(
            base_url="https://api.whatsap-automat.internal",
            api_key="secret-key-123",
            tenant_id="tenant-42",
            transport=httpx.MockTransport(handler),
        )

        conv = client.conversations.get("conv_01")
        self.assertIsInstance(conv, Conversation)
        self.assertEqual(conv.id, "conv_01")
        self.assertEqual(conv.tenant_id, "t_99")
        self.assertEqual(conv.state_version, 1)

        self.assertEqual(captured_headers.get("authorization"), "Bearer secret-key-123")
        self.assertEqual(captured_headers.get("x-tenant-id"), "tenant-42")
        self.assertIn("whatsap-automat-sdk/0.4.0", captured_headers.get("user-agent", ""))
        self.assertTrue(captured_url.endswith("/api/v1/conversations/conv_01"))

    def test_simulation_projects_envelope_to_node_list(self) -> None:
        nodes = [{"nodeId": "finish", "kind": "end", "output": {}, "durationMs": 1}]
        payload = {"graphId": "demo", "graphVersion": 2, "mockInput": "fixture"}

        for response in ({"executedNodes": nodes, "mode": "fixture"}, nodes):
            def handler(request: httpx.Request) -> httpx.Response:
                self.assertEqual(request.url.path, "/api/v1/agent-runs/simulate")
                self.assertEqual(json.loads(request.content), payload)
                return httpx.Response(200, json=response)

            with AutomatClient(base_url="https://api.example.com", transport=httpx.MockTransport(handler)) as client:
                self.assertEqual([node.node_id for node in client.agents.simulate(payload)], ["finish"])

    def test_optimistic_concurrency_takeover(self) -> None:
        captured_body: Dict[str, Any] = {}
        captured_method: str = ""

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal captured_body, captured_method
            captured_method = request.method
            captured_body = json.loads(request.content.decode("utf-8"))
            return httpx.Response(
                200,
                json={
                    "id": "conv_01",
                    "tenantId": "t_99",
                    "connectionId": "conn_01",
                    "channel": "whatsapp-cloud",
                    "externalConversationId": "+1555123456",
                    "status": "open",
                    "stage": "handoff",
                    "stateVersion": 2,
                    "aiPaused": True,
                    "assignedUserId": "usr_human_01",
                    "createdAt": "2026-11-05T00:00:00Z",
                    "updatedAt": "2026-11-05T00:01:00Z",
                },
            )

        client = AutomatClient(
            base_url="https://api.whatsap-automat.internal",
            transport=httpx.MockTransport(handler),
        )

        result = client.conversations.takeover(
            conversation_id="conv_01",
            expected_version=1,
            user_id="usr_human_01",
            reason="Escalation requested",
        )

        self.assertEqual(captured_method, "POST")
        self.assertEqual(captured_body["expectedVersion"], 1)
        self.assertEqual(captured_body["userId"], "usr_human_01")
        self.assertEqual(captured_body["reason"], "Escalation requested")
        self.assertEqual(result.state_version, 2)
        self.assertEqual(result.assigned_user_id, "usr_human_01")

    def test_sync_cursor_pagination_iteration(self) -> None:
        pages = {
            None: {
                "items": [
                    {
                        "id": "conv_1",
                        "tenantId": "t1",
                        "connectionId": "c1",
                        "channel": "telegram",
                        "externalConversationId": "tg_1",
                        "status": "open",
                        "stage": "new",
                        "stateVersion": 1,
                        "createdAt": "2026-11-05T00:00:00Z",
                        "updatedAt": "2026-11-05T00:00:00Z",
                    },
                    {
                        "id": "conv_2",
                        "tenantId": "t1",
                        "connectionId": "c1",
                        "channel": "telegram",
                        "externalConversationId": "tg_2",
                        "status": "open",
                        "stage": "new",
                        "stateVersion": 1,
                        "createdAt": "2026-11-05T00:00:00Z",
                        "updatedAt": "2026-11-05T00:00:00Z",
                    },
                ],
                "nextCursor": "cur_page_2",
                "hasMore": True,
            },
            "cur_page_2": {
                "items": [
                    {
                        "id": "conv_3",
                        "tenantId": "t1",
                        "connectionId": "c1",
                        "channel": "telegram",
                        "externalConversationId": "tg_3",
                        "status": "closed",
                        "stage": "closed",
                        "stateVersion": 2,
                        "createdAt": "2026-11-05T00:00:00Z",
                        "updatedAt": "2026-11-05T00:00:00Z",
                    }
                ],
                "nextCursor": None,
                "hasMore": False,
            },
        }

        def handler(request: httpx.Request) -> httpx.Response:
            cursor = request.url.params.get("cursor")
            page_data = pages.get(cursor, {"items": [], "nextCursor": None, "hasMore": False})
            return httpx.Response(200, json=page_data)

        client = AutomatClient(
            base_url="https://api.whatsap-automat.internal",
            transport=httpx.MockTransport(handler),
        )

        pager = client.conversations.list()
        items = list(pager)

        self.assertEqual(len(items), 3)
        self.assertEqual([x.id for x in items], ["conv_1", "conv_2", "conv_3"])

    def test_cursor_pagination_all_with_max_items(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            cursor = int(request.url.params.get("cursor", 0))
            items = [
                {
                    "id": f"conv_{i}",
                    "tenantId": "t1",
                    "connectionId": "c1",
                    "channel": "whatsapp-cloud",
                    "externalConversationId": f"+100{i}",
                    "status": "open",
                    "stage": "new",
                    "stateVersion": 1,
                    "createdAt": "2026-11-05T00:00:00Z",
                    "updatedAt": "2026-11-05T00:00:00Z",
                }
                for i in range(cursor, cursor + 5)
            ]
            has_more = cursor + 5 < 20
            return httpx.Response(
                200,
                json={
                    "items": items,
                    "nextCursor": str(cursor + 5) if has_more else None,
                    "hasMore": has_more,
                },
            )

        client = AutomatClient(
            base_url="https://api.whatsap-automat.internal",
            transport=httpx.MockTransport(handler),
        )

        pager = client.conversations.list()
        collected = pager.all(max_items=7)

        self.assertEqual(len(collected), 7)
        self.assertEqual(collected[0].id, "conv_0")
        self.assertEqual(collected[6].id, "conv_6")

    def test_retry_on_429_rate_limited_with_recovery(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(
                    429,
                    headers={"retry-after": "0"},
                    json={
                        "type": "https://api.whatsap-automat.internal/errors/rate-limited",
                        "title": "Rate Limit Exceeded",
                        "status": 429,
                        "detail": "Too many requests. Please slow down.",
                    },
                )
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": "conn_1",
                            "tenantId": "t1",
                            "channel": "whatsapp-cloud",
                            "name": "Main Number",
                            "externalAccountId": "acc_01",
                            "status": "active",
                            "capabilities": ["text", "interactive"],
                            "health": {
                                "configured": True,
                                "authorized": True,
                                "lastCheckedAt": "2026-11-05T00:00:00Z",
                            },
                            "createdAt": "2026-11-05T00:00:00Z",
                            "updatedAt": "2026-11-05T00:00:00Z",
                        }
                    ]
                },
            )

        client = AutomatClient(
            base_url="https://api.whatsap-automat.internal",
            max_retries=2,
            transport=httpx.MockTransport(handler),
        )

        channels = client.channels.list()
        self.assertEqual(len(channels), 1)
        self.assertEqual(channels[0].id, "conn_1")
        self.assertEqual(attempts, 2)

    def test_retry_exhaustion_raises_typed_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                503,
                headers={"retry-after": "0"},
                json={
                    "type": "https://api.whatsap-automat.internal/errors/retryable",
                    "title": "Service Unavailable",
                    "status": 503,
                    "detail": "Database failover in progress",
                },
            )

        client = AutomatClient(
            base_url="https://api.whatsap-automat.internal",
            max_retries=1,
            transport=httpx.MockTransport(handler),
        )

        with self.assertRaises(ServiceUnavailableError) as ctx:
            client.channels.list()

        self.assertEqual(ctx.exception.status, 503)
        self.assertEqual(ctx.exception.detail, "Database failover in progress")

    def test_rfc7807_error_mapping_battery(self) -> None:
        error_cases = [
            (401, "UNAUTHORIZED", UnauthorizedError, "Invalid API key"),
            (403, "POLICY_DENIED", PolicyDeniedError, "Scope messages:send denied"),
            (404, "NOT_FOUND", NotFoundError, "Conversation not found"),
            (409, "CONFLICT", ConflictError, "CAS expected version 2 but is 3"),
            (422, "VALIDATION_ERROR", ValidationError, "Invalid phone number"),
            (428, "APPROVAL_REQUIRED", ApprovalRequiredError, "Action requires manager approval"),
            (429, "RATE_LIMITED", RateLimitedError, "Quota exceeded"),
        ]

        for status_code, err_code, exc_class, detail_msg in error_cases:
            def handler(request: httpx.Request) -> httpx.Response:
                return httpx.Response(
                    status_code,
                    json={
                        "type": f"https://api.whatsap-automat.internal/errors/{err_code.lower()}",
                        "title": err_code,
                        "status": status_code,
                        "detail": detail_msg,
                        "code": err_code,
                        "correlationId": "corr_abc_123",
                    },
                )

            client = AutomatClient(
                base_url="https://api.whatsap-automat.internal",
                max_retries=0,
                transport=httpx.MockTransport(handler),
            )

            with self.subTest(status=status_code, expected_class=exc_class):
                with self.assertRaises(exc_class) as ctx:
                    client.conversations.get("dummy")

                self.assertEqual(ctx.exception.status, status_code)
                self.assertEqual(ctx.exception.detail, detail_msg)
                self.assertEqual(ctx.exception.correlation_id, "corr_abc_123")

    def test_approvals_resource_decide(self) -> None:
        captured_body: Dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal captured_body
            captured_body = json.loads(request.content.decode("utf-8"))
            return httpx.Response(
                200,
                json={
                    "approvalId": "app_99",
                    "status": "approved",
                    "decidedAt": "2026-11-05T01:00:00Z",
                    "decidedBy": "usr_mgr_1",
                },
            )

        client = AutomatClient(
            base_url="https://api.whatsap-automat.internal",
            transport=httpx.MockTransport(handler),
        )

        res = client.approvals.decide(
            approval_id="app_99",
            decision="approved",
            expected_version=3,
            reason="Approved refund",
        )

        self.assertEqual(captured_body["decision"], "approved")
        self.assertEqual(captured_body["expectedVersion"], 3)
        self.assertEqual(captured_body["reason"], "Approved refund")
        self.assertNotIn("password", captured_body)
        self.assertEqual(res.status, "approved")
        self.assertEqual(res.decided_by, "usr_mgr_1")

    def test_sensitive_approval_success(self) -> None:
        transport, requests = _approval_transport(self, _APPROVAL_CAPABILITIES, 200)
        with AutomatClient(base_url="http://127.0.0.1:3000", transport=transport) as client:
            result = client.approvals.decide(
                "app_99", "approved", 3, "Reviewed refund", _APPROVAL_KEY, password=_APPROVAL_PASSWORD,
            )
        self.assertEqual(result.status, "approved")
        self.assertEqual([method for method, _ in requests], ["GET", "POST"])

    def test_sensitive_approval_errors_are_redacted_and_never_retried(self) -> None:
        for status, code, reason in _APPROVAL_FAILURES:
            with self.subTest(status=status):
                transport, requests = _approval_transport(self, _APPROVAL_CAPABILITIES, status, code, reason)
                with AutomatClient(base_url="https://api.example.com", transport=transport) as client:
                    with self.assertRaises(ProblemDetailsError) as caught:
                        client.approvals.decide(
                            "app_99", "approved", 3, "Reviewed refund", _APPROVAL_KEY, password=_APPROVAL_PASSWORD,
                        )
                _assert_approval_failure(self, caught.exception, requests, status, code, reason)

    def test_sensitive_approval_blocks_old_server_and_unprotected_transport(self) -> None:
        transport, requests = _approval_transport(self, ["approvals.review"], 200)
        with AutomatClient(base_url="https://api.example.com", transport=transport) as client:
            with self.assertRaises(PolicyDeniedError):
                client.approvals.decide("app_99", "approved", 3, password=_APPROVAL_PASSWORD)
        self.assertEqual(requests, [("GET", "/api/v1/workspaces/current")])
        requests.clear()
        with AutomatClient(base_url="http://api.example.com", transport=transport) as client:
            with self.assertRaises(ValidationError):
                client.approvals.decide("app_99", "approved", 3, password=_APPROVAL_PASSWORD)
        self.assertEqual(requests, [])


class TestAsyncAutomatClient(unittest.IsolatedAsyncioTestCase):
    """Test suite for asynchronous AsyncAutomatClient."""

    async def test_sensitive_approval_success(self) -> None:
        transport, requests = _approval_transport(self, _APPROVAL_CAPABILITIES, 200)
        async with AsyncAutomatClient(base_url="https://api.example.com", transport=transport) as client:
            result = await client.approvals.decide(
                "app_99", "approved", 3, "Reviewed refund", _APPROVAL_KEY, password=_APPROVAL_PASSWORD,
            )
        self.assertEqual(result.status, "approved")
        self.assertEqual([method for method, _ in requests], ["GET", "POST"])

    async def test_sensitive_approval_errors_are_redacted_and_never_retried(self) -> None:
        for status, code, reason in _APPROVAL_FAILURES:
            with self.subTest(status=status):
                transport, requests = _approval_transport(self, _APPROVAL_CAPABILITIES, status, code, reason)
                async with AsyncAutomatClient(base_url="https://api.example.com", transport=transport) as client:
                    with self.assertRaises(ProblemDetailsError) as caught:
                        await client.approvals.decide(
                            "app_99", "approved", 3, "Reviewed refund", _APPROVAL_KEY, password=_APPROVAL_PASSWORD,
                        )
                _assert_approval_failure(self, caught.exception, requests, status, code, reason)

    async def test_sensitive_approval_blocks_old_server_and_unprotected_transport(self) -> None:
        transport, requests = _approval_transport(self, ["approvals.reauthenticate"], 200)
        async with AsyncAutomatClient(base_url="https://api.example.com", transport=transport) as client:
            with self.assertRaises(PolicyDeniedError):
                await client.approvals.decide("app_99", "approved", 3, password=_APPROVAL_PASSWORD)
        self.assertEqual(requests, [("GET", "/api/v1/workspaces/current")])
        requests.clear()
        async with AsyncAutomatClient(base_url="http://api.example.com", transport=transport) as client:
            with self.assertRaises(ValidationError):
                await client.approvals.decide("app_99", "approved", 3, password=_APPROVAL_PASSWORD)
        self.assertEqual(requests, [])

    async def test_unkeyed_mutation_does_not_retry_a_transport_failure(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            raise httpx.ReadError("Network closed before the response", request=request)

        async with AsyncAutomatClient(base_url="https://api.example.com", transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(ProblemDetailsError):
                await client.conversations.takeover("conv_1", expected_version=1)
        self.assertEqual(attempts, 1)

    async def test_async_simulation_projects_envelope_to_node_list(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/api/v1/agent-runs/simulate")
            return httpx.Response(200, json={"executedNodes": [
                {"nodeId": "finish", "kind": "end", "output": {}, "durationMs": 1}
            ]})

        async with AsyncAutomatClient(base_url="https://api.example.com", transport=httpx.MockTransport(handler)) as client:
            result = await client.agents.simulate({"graphId": "demo", "mockInput": "fixture"})
            self.assertEqual([node.node_id for node in result], ["finish"])

    async def test_async_client_context_and_pagination(self) -> None:
        pages = {
            None: {
                "items": [
                    {
                        "id": "conv_async_1",
                        "tenantId": "t1",
                        "connectionId": "c1",
                        "channel": "tiktok",
                        "externalConversationId": "tt_1",
                        "status": "open",
                        "stage": "new",
                        "stateVersion": 1,
                        "createdAt": "2026-11-05T00:00:00Z",
                        "updatedAt": "2026-11-05T00:00:00Z",
                    }
                ],
                "nextCursor": "cursor_2",
                "hasMore": True,
            },
            "cursor_2": {
                "items": [
                    {
                        "id": "conv_async_2",
                        "tenantId": "t1",
                        "connectionId": "c1",
                        "channel": "line",
                        "externalConversationId": "line_1",
                        "status": "open",
                        "stage": "new",
                        "stateVersion": 1,
                        "createdAt": "2026-11-05T00:00:00Z",
                        "updatedAt": "2026-11-05T00:00:00Z",
                    }
                ],
                "nextCursor": None,
                "hasMore": False,
            },
        }

        def handler(request: httpx.Request) -> httpx.Response:
            c = request.url.params.get("cursor")
            return httpx.Response(200, json=pages.get(c, {"items": [], "hasMore": False}))

        async with AsyncAutomatClient(
            base_url="https://api.whatsap-automat.internal",
            token="bearer-jwt-token",
            transport=httpx.MockTransport(handler),
        ) as client:
            pager = client.conversations.list()
            items = []
            async for conv in pager:
                items.append(conv)

            self.assertEqual(len(items), 2)
            self.assertEqual(items[0].channel, "tiktok")
            self.assertEqual(items[1].channel, "line")


if __name__ == "__main__":
    unittest.main()
