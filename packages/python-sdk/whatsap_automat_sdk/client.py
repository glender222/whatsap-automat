"""
Official Whatsap-Automat Sync & Async Clients.
Features automatic retries with exponential backoff on 429/503 and full resource sub-clients.
"""

from __future__ import annotations

import asyncio
import random
import time
from urllib.parse import quote
from uuid import uuid4
from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Mapping, Optional, TypeVar, Union
import httpx

from .exceptions import (
    ProblemDetailsError,
    create_error_from_response,
)
from .models import (
    AgentGraphVersion,
    AgentRunTrace,
    ApprovalDecisionRequest,
    ApprovalDecisionResult,
    ApprovalRequest,
    ChannelConnection,
    ChannelConnectionHealth,
    Conversation,
    ConversationMessage,
    PagedResponse,
    PauseAiRequest,
    ResumeAiRequest,
    SimulatedNodeExecution,
    TakeoverRequest,
)
from .pagination import AsyncCursorPager, CursorPager

T = TypeVar("T")


@dataclass
class ClientConfig:
    base_url: str
    api_key: Optional[str] = None
    token: Optional[str] = None
    tenant_id: Optional[str] = None
    timeout: float = 30.0
    max_retries: int = 3
    custom_headers: Optional[Dict[str, str]] = None


# ---------------------------------------------------------------------------
# Synchronous Sub-Resources
# ---------------------------------------------------------------------------

class ConversationsResource:
    def __init__(self, client: AutomatClient):
        self._client = client

    def list(
        self,
        cursor: Optional[str] = None,
        limit: int = 20,
        status: Optional[str] = None,
        channel: Optional[str] = None,
        stage: Optional[str] = None,
    ) -> CursorPager[Conversation]:
        params: Dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        if channel:
            params["channel"] = channel
        if stage:
            params["stage"] = stage

        def fetcher(c: Optional[str]) -> PagedResponse[Conversation]:
            q = {**params}
            if c:
                q["cursor"] = c
            res = self._client._request("GET", "/conversations", params=q)
            return PagedResponse[Conversation](
                items=[Conversation.model_validate(x) for x in res.get("items", [])],
                next_cursor=res.get("nextCursor"),
                has_more=res.get("hasMore", False),
            )

        return CursorPager(fetcher, initial_cursor=cursor)

    def get(self, conversation_id: str) -> Conversation:
        data = self._client._request("GET", f"/conversations/{conversation_id}")
        return Conversation.model_validate(data)

    def list_messages(
        self,
        conversation_id: str,
        cursor: Optional[str] = None,
        limit: int = 50,
    ) -> CursorPager[ConversationMessage]:
        def fetcher(c: Optional[str]) -> PagedResponse[ConversationMessage]:
            q: Dict[str, Any] = {"limit": limit}
            if c:
                q["cursor"] = c
            res = self._client._request("GET", f"/conversations/{conversation_id}/messages", params=q)
            return PagedResponse[ConversationMessage](
                items=[ConversationMessage.model_validate(x) for x in res.get("items", [])],
                next_cursor=res.get("nextCursor"),
                has_more=res.get("hasMore", False),
            )

        return CursorPager(fetcher, initial_cursor=cursor)

    def takeover(
        self,
        conversation_id: str,
        expected_version: int,
        user_id: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> Conversation:
        cmd = TakeoverRequest(expected_version=expected_version, user_id=user_id, reason=reason)
        data = self._client._request(
            "POST",
            f"/conversations/{conversation_id}/takeover",
            json_body=cmd.model_dump(by_alias=True, exclude_none=True),
        )
        return Conversation.model_validate(data)

    def pause_ai(
        self,
        conversation_id: str,
        expected_version: int,
        duration_seconds: Optional[int] = None,
        reason: Optional[str] = None,
    ) -> Conversation:
        cmd = PauseAiRequest(
            expected_version=expected_version,
            duration_seconds=duration_seconds,
            reason=reason,
        )
        data = self._client._request(
            "POST",
            f"/conversations/{conversation_id}/pause-ai",
            json_body=cmd.model_dump(by_alias=True, exclude_none=True),
        )
        return Conversation.model_validate(data)

    def resume_ai(
        self,
        conversation_id: str,
        expected_version: int,
        reason: Optional[str] = None,
    ) -> Conversation:
        cmd = ResumeAiRequest(expected_version=expected_version, reason=reason)
        data = self._client._request(
            "POST",
            f"/conversations/{conversation_id}/resume-ai",
            json_body=cmd.model_dump(by_alias=True, exclude_none=True),
        )
        return Conversation.model_validate(data)


class ChannelsResource:
    def __init__(self, client: AutomatClient):
        self._client = client

    def list(self, after: Optional[str] = None, limit: int = 50) -> List[ChannelConnection]:
        params: Dict[str, Any] = {"limit": limit}
        if after is not None:
            params["after"] = after
        res = self._client._request("GET", "/channel-connections", params=params)
        items = res.get("items", []) if isinstance(res, dict) else res
        return [ChannelConnection.model_validate(x) for x in items]

    def get(self, connection_id: str) -> ChannelConnection:
        data = self._client._request("GET", f"/channel-connections/{quote(connection_id, safe='')}")
        return ChannelConnection.model_validate(data)

    def validate(self, connection_id: str) -> ChannelConnectionHealth:
        data = self._client._request("POST", f"/channel-connections/{quote(connection_id, safe='')}/validate")
        return ChannelConnectionHealth.model_validate(data)


class AgentsResource:
    def __init__(self, client: AutomatClient):
        self._client = client

    def list_graphs(self) -> List[AgentGraphVersion]:
        res = self._client._request("GET", "/agent-graphs")
        items = res.get("items", []) if isinstance(res, dict) else res
        return [AgentGraphVersion.model_validate(x) for x in items]

    def get_graph(self, graph_id: str) -> AgentGraphVersion:
        data = self._client._request("GET", f"/agent-graphs/{graph_id}")
        return AgentGraphVersion.model_validate(data)

    def validate_graph(self, graph_id: str) -> Dict[str, Any]:
        return self._client._request("POST", f"/agent-graphs/{graph_id}/validate")

    def publish_graph(self, graph_id: str) -> AgentGraphVersion:
        data = self._client._request("POST", f"/agent-graphs/{graph_id}/publish")
        return AgentGraphVersion.model_validate(data)

    def simulate(self, request: Dict[str, Any]) -> List[SimulatedNodeExecution]:
        data = self._client._request("POST", "/agent-runs/simulate", json_body=request)
        return [SimulatedNodeExecution.model_validate(x) for x in data]

    def get_trace(self, run_id: str) -> AgentRunTrace:
        data = self._client._request("GET", f"/agent-runs/{run_id}/trace")
        return AgentRunTrace.model_validate(data)


class WorkflowsResource:
    def __init__(self, client: AutomatClient):
        self._client = client

    def publish(self, workflow_id: str, revision_id: str) -> Dict[str, Any]:
        response = self._client._request(
            "POST", f"/workflows/{workflow_id}/publish", json_body={"revisionId": revision_id},
        )
        return response["data"]

    def rollback(self, workflow_id: str, target_revision_number: int, reason: str) -> Dict[str, Any]:
        return self._client._request(
            "POST",
            f"/workflows/{workflow_id}/rollback",
            json_body={"targetRevisionNumber": target_revision_number, "reason": reason},
        )


class ApprovalsResource:
    def __init__(self, client: AutomatClient):
        self._client = client

    def list(self, status: Optional[str] = None, limit: int = 50) -> List[ApprovalRequest]:
        params: Dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        res = self._client._request("GET", "/approvals", params=params)
        items = res.get("items", []) if isinstance(res, dict) else res
        return [ApprovalRequest.model_validate(x) for x in items]

    def get(self, approval_id: str) -> ApprovalRequest:
        data = self._client._request("GET", f"/approvals/{approval_id}")
        return ApprovalRequest.model_validate(data)

    def decide(
        self,
        approval_id: str,
        decision: Literal["approved", "rejected"],
        expected_version: int,
        reason: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> ApprovalDecisionResult:
        cmd = ApprovalDecisionRequest(
            decision=decision,
            expected_version=expected_version,
            reason=reason,
        )
        data = self._client._request(
            "POST",
            f"/approvals/{approval_id}/decision",
            json_body=cmd.model_dump(by_alias=True, exclude_none=True),
            headers={"Idempotency-Key": idempotency_key if idempotency_key is not None else uuid4().hex},
        )
        return ApprovalDecisionResult.model_validate(data)


# ---------------------------------------------------------------------------
# Synchronous AutomatClient
# ---------------------------------------------------------------------------

class AutomatClient:
    """Synchronous Whatsap-Automat client powered by httpx.Client."""

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        token: Optional[str] = None,
        tenant_id: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 3,
        custom_headers: Optional[Dict[str, str]] = None,
        transport: Optional[httpx.BaseTransport] = None,
    ):
        clean_base = base_url.rstrip("/")
        if not clean_base.endswith("/api/v1"):
            clean_base = f"{clean_base}/api/v1"

        self.base_url = clean_base
        self.api_key = api_key
        self.token = token
        self.tenant_id = tenant_id
        self.max_retries = max_retries

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "whatsap-automat-sdk/0.4.0",
        }
        auth_token = self.api_key or self.token
        if auth_token:
            headers["Authorization"] = f"Bearer {auth_token}"
        if self.tenant_id:
            headers["X-Tenant-Id"] = self.tenant_id
        if custom_headers:
            headers.update(custom_headers)

        self._http = httpx.Client(
            base_url=self.base_url,
            headers=headers,
            timeout=timeout,
            transport=transport,
        )

        self.conversations = ConversationsResource(self)
        self.channels = ChannelsResource(self)
        self.agents = AgentsResource(self)
        self.workflows = WorkflowsResource(self)
        self.approvals = ApprovalsResource(self)

    def __enter__(self) -> AutomatClient:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Mapping[str, Any]] = None,
        json_body: Optional[Any] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Any:
        clean_path = path if path.startswith("/") else f"/{path}"
        attempt = 0

        while True:
            attempt += 1
            try:
                response = self._http.request(
                    method=method,
                    url=clean_path,
                    params=params,
                    json=json_body,
                    headers=headers,
                )

                if response.is_success:
                    if response.status_code == 204 or not response.content:
                        return None
                    return response.json()

                # Retry logic for 429 and 503
                if response.status_code in (429, 503) and attempt <= self.max_retries:
                    retry_after = response.headers.get("retry-after")
                    if retry_after and retry_after.isdigit():
                        delay = float(retry_after)
                    else:
                        delay = min(0.1 * (2 ** attempt) + random.uniform(0, 0.05), 2.0)
                    time.sleep(delay)
                    continue

                try:
                    error_body = response.json()
                except Exception:
                    error_body = {"detail": response.text}

                raise create_error_from_response(response.status_code, error_body, response.headers)

            except httpx.RequestError as exc:
                if attempt <= self.max_retries:
                    time.sleep(0.1 * (2 ** attempt))
                    continue
                raise ProblemDetailsError(
                    status=500,
                    title="Network Error",
                    detail=f"Network request failed: {exc}",
                ) from exc


# ---------------------------------------------------------------------------
# Asynchronous Sub-Resources
# ---------------------------------------------------------------------------

class AsyncConversationsResource:
    def __init__(self, client: AsyncAutomatClient):
        self._client = client

    def list(
        self,
        cursor: Optional[str] = None,
        limit: int = 20,
        status: Optional[str] = None,
        channel: Optional[str] = None,
        stage: Optional[str] = None,
    ) -> AsyncCursorPager[Conversation]:
        params: Dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        if channel:
            params["channel"] = channel
        if stage:
            params["stage"] = stage

        async def fetcher(c: Optional[str]) -> PagedResponse[Conversation]:
            q = {**params}
            if c:
                q["cursor"] = c
            res = await self._client._request("GET", "/conversations", params=q)
            return PagedResponse[Conversation](
                items=[Conversation.model_validate(x) for x in res.get("items", [])],
                next_cursor=res.get("nextCursor"),
                has_more=res.get("hasMore", False),
            )

        return AsyncCursorPager(fetcher, initial_cursor=cursor)

    async def get(self, conversation_id: str) -> Conversation:
        data = await self._client._request("GET", f"/conversations/{conversation_id}")
        return Conversation.model_validate(data)

    def list_messages(
        self,
        conversation_id: str,
        cursor: Optional[str] = None,
        limit: int = 50,
    ) -> AsyncCursorPager[ConversationMessage]:
        async def fetcher(c: Optional[str]) -> PagedResponse[ConversationMessage]:
            q: Dict[str, Any] = {"limit": limit}
            if c:
                q["cursor"] = c
            res = await self._client._request("GET", f"/conversations/{conversation_id}/messages", params=q)
            return PagedResponse[ConversationMessage](
                items=[ConversationMessage.model_validate(x) for x in res.get("items", [])],
                next_cursor=res.get("nextCursor"),
                has_more=res.get("hasMore", False),
            )

        return AsyncCursorPager(fetcher, initial_cursor=cursor)

    async def takeover(
        self,
        conversation_id: str,
        expected_version: int,
        user_id: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> Conversation:
        cmd = TakeoverRequest(expected_version=expected_version, user_id=user_id, reason=reason)
        data = await self._client._request(
            "POST",
            f"/conversations/{conversation_id}/takeover",
            json_body=cmd.model_dump(by_alias=True, exclude_none=True),
        )
        return Conversation.model_validate(data)

    async def pause_ai(
        self,
        conversation_id: str,
        expected_version: int,
        duration_seconds: Optional[int] = None,
        reason: Optional[str] = None,
    ) -> Conversation:
        cmd = PauseAiRequest(
            expected_version=expected_version,
            duration_seconds=duration_seconds,
            reason=reason,
        )
        data = await self._client._request(
            "POST",
            f"/conversations/{conversation_id}/pause-ai",
            json_body=cmd.model_dump(by_alias=True, exclude_none=True),
        )
        return Conversation.model_validate(data)

    async def resume_ai(
        self,
        conversation_id: str,
        expected_version: int,
        reason: Optional[str] = None,
    ) -> Conversation:
        cmd = ResumeAiRequest(expected_version=expected_version, reason=reason)
        data = await self._client._request(
            "POST",
            f"/conversations/{conversation_id}/resume-ai",
            json_body=cmd.model_dump(by_alias=True, exclude_none=True),
        )
        return Conversation.model_validate(data)


class AsyncChannelsResource:
    def __init__(self, client: AsyncAutomatClient):
        self._client = client

    async def list(self, after: Optional[str] = None, limit: int = 50) -> List[ChannelConnection]:
        params: Dict[str, Any] = {"limit": limit}
        if after is not None:
            params["after"] = after
        res = await self._client._request("GET", "/channel-connections", params=params)
        items = res.get("items", []) if isinstance(res, dict) else res
        return [ChannelConnection.model_validate(x) for x in items]

    async def get(self, connection_id: str) -> ChannelConnection:
        data = await self._client._request("GET", f"/channel-connections/{quote(connection_id, safe='')}")
        return ChannelConnection.model_validate(data)

    async def validate(self, connection_id: str) -> ChannelConnectionHealth:
        data = await self._client._request("POST", f"/channel-connections/{quote(connection_id, safe='')}/validate")
        return ChannelConnectionHealth.model_validate(data)


class AsyncAgentsResource:
    def __init__(self, client: AsyncAutomatClient):
        self._client = client

    async def list_graphs(self) -> List[AgentGraphVersion]:
        res = await self._client._request("GET", "/agent-graphs")
        items = res.get("items", []) if isinstance(res, dict) else res
        return [AgentGraphVersion.model_validate(x) for x in items]

    async def get_graph(self, graph_id: str) -> AgentGraphVersion:
        data = await self._client._request("GET", f"/agent-graphs/{graph_id}")
        return AgentGraphVersion.model_validate(data)

    async def validate_graph(self, graph_id: str) -> Dict[str, Any]:
        return await self._client._request("POST", f"/agent-graphs/{graph_id}/validate")

    async def publish_graph(self, graph_id: str) -> AgentGraphVersion:
        data = await self._client._request("POST", f"/agent-graphs/{graph_id}/publish")
        return AgentGraphVersion.model_validate(data)

    async def simulate(self, request: Dict[str, Any]) -> List[SimulatedNodeExecution]:
        data = await self._client._request("POST", "/agent-runs/simulate", json_body=request)
        return [SimulatedNodeExecution.model_validate(x) for x in data]

    async def get_trace(self, run_id: str) -> AgentRunTrace:
        data = await self._client._request("GET", f"/agent-runs/{run_id}/trace")
        return AgentRunTrace.model_validate(data)


class AsyncWorkflowsResource:
    def __init__(self, client: AsyncAutomatClient):
        self._client = client

    async def publish(self, workflow_id: str, revision_id: str) -> Dict[str, Any]:
        response = await self._client._request(
            "POST", f"/workflows/{workflow_id}/publish", json_body={"revisionId": revision_id},
        )
        return response["data"]

    async def rollback(self, workflow_id: str, target_revision_number: int, reason: str) -> Dict[str, Any]:
        return await self._client._request(
            "POST",
            f"/workflows/{workflow_id}/rollback",
            json_body={"targetRevisionNumber": target_revision_number, "reason": reason},
        )


class AsyncApprovalsResource:
    def __init__(self, client: AsyncAutomatClient):
        self._client = client

    async def list(self, status: Optional[str] = None, limit: int = 50) -> List[ApprovalRequest]:
        params: Dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        res = await self._client._request("GET", "/approvals", params=params)
        items = res.get("items", []) if isinstance(res, dict) else res
        return [ApprovalRequest.model_validate(x) for x in items]

    async def get(self, approval_id: str) -> ApprovalRequest:
        data = await self._client._request("GET", f"/approvals/{approval_id}")
        return ApprovalRequest.model_validate(data)

    async def decide(
        self,
        approval_id: str,
        decision: Literal["approved", "rejected"],
        expected_version: int,
        reason: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> ApprovalDecisionResult:
        cmd = ApprovalDecisionRequest(
            decision=decision,
            expected_version=expected_version,
            reason=reason,
        )
        data = await self._client._request(
            "POST",
            f"/approvals/{approval_id}/decision",
            json_body=cmd.model_dump(by_alias=True, exclude_none=True),
            headers={"Idempotency-Key": idempotency_key if idempotency_key is not None else uuid4().hex},
        )
        return ApprovalDecisionResult.model_validate(data)


# ---------------------------------------------------------------------------
# Asynchronous AsyncAutomatClient
# ---------------------------------------------------------------------------

class AsyncAutomatClient:
    """Asynchronous Whatsap-Automat client powered by httpx.AsyncClient."""

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        token: Optional[str] = None,
        tenant_id: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 3,
        custom_headers: Optional[Dict[str, str]] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        clean_base = base_url.rstrip("/")
        if not clean_base.endswith("/api/v1"):
            clean_base = f"{clean_base}/api/v1"

        self.base_url = clean_base
        self.api_key = api_key
        self.token = token
        self.tenant_id = tenant_id
        self.max_retries = max_retries

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "whatsap-automat-sdk/0.4.0",
        }
        auth_token = self.api_key or self.token
        if auth_token:
            headers["Authorization"] = f"Bearer {auth_token}"
        if self.tenant_id:
            headers["X-Tenant-Id"] = self.tenant_id
        if custom_headers:
            headers.update(custom_headers)

        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=timeout,
            transport=transport,
        )

        self.conversations = AsyncConversationsResource(self)
        self.channels = AsyncChannelsResource(self)
        self.agents = AsyncAgentsResource(self)
        self.workflows = AsyncWorkflowsResource(self)
        self.approvals = AsyncApprovalsResource(self)

    async def __aenter__(self) -> AsyncAutomatClient:
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        params: Optional[Mapping[str, Any]] = None,
        json_body: Optional[Any] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Any:
        clean_path = path if path.startswith("/") else f"/{path}"
        attempt = 0

        while True:
            attempt += 1
            try:
                response = await self._http.request(
                    method=method,
                    url=clean_path,
                    params=params,
                    json=json_body,
                    headers=headers,
                )

                if response.is_success:
                    if response.status_code == 204 or not response.content:
                        return None
                    return response.json()

                # Retry logic for 429 and 503
                if response.status_code in (429, 503) and attempt <= self.max_retries:
                    retry_after = response.headers.get("retry-after")
                    if retry_after and retry_after.isdigit():
                        delay = float(retry_after)
                    else:
                        delay = min(0.1 * (2 ** attempt) + random.uniform(0, 0.05), 2.0)
                    await asyncio.sleep(delay)
                    continue

                try:
                    error_body = response.json()
                except Exception:
                    error_body = {"detail": response.text}

                raise create_error_from_response(response.status_code, error_body, response.headers)

            except httpx.RequestError as exc:
                if attempt <= self.max_retries:
                    await asyncio.sleep(0.1 * (2 ** attempt))
                    continue
                raise ProblemDetailsError(
                    status=500,
                    title="Network Error",
                    detail=f"Network request failed: {exc}",
                ) from exc
