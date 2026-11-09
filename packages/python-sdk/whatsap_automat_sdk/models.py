"""
Pydantic v2 data models for Whatsap-Automat API v0.4 entities.
Matches canonical OpenAPI v1 and @whatsap-automat/contracts.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, Generic, List, Literal, Optional, TypeVar, Union
from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class ChannelKind(str, Enum):
    WHATSAPP_CLOUD = "whatsapp-cloud"
    INSTAGRAM = "instagram"
    MESSENGER = "messenger"
    TELEGRAM = "telegram"
    WEBCHAT = "webchat"
    EMAIL = "email"
    TIKTOK = "tiktok"
    LINE = "line"


class ChannelCapability(str, Enum):
    TEXT = "text"
    IMAGE = "image"
    AUDIO = "audio"
    VIDEO = "video"
    DOCUMENT = "document"
    TEMPLATE = "template"
    INTERACTIVE = "interactive"
    READ_RECEIPT = "read-receipt"
    TYPING = "typing"


class CommercialStage(str, Enum):
    NEW = "new"
    AI_ASSISTING = "ai_assisting"
    CATALOG = "catalog"
    PREORDER = "preorder"
    HANDOFF = "handoff"
    PAYMENT = "payment"
    CLOSED = "closed"


class ConversationStatus(str, Enum):
    OPEN = "open"
    CLOSED = "closed"
    ARCHIVED = "archived"


class DeliveryState(str, Enum):
    PENDING = "pending"
    DISPATCHED = "dispatched"
    PROVIDER_ACCEPTED = "provider_accepted"
    DELIVERED = "delivered"
    READ = "read"
    FAILED = "failed"
    UNKNOWN_DELIVERY = "unknown_delivery"
    CANCELLED = "cancelled"


class AgentRunState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    AWAITING_APPROVAL = "awaiting_approval"
    WAITING = "waiting"
    HANDED_OFF = "handed_off"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    BUDGET_EXHAUSTED = "budget_exhausted"


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    REVOKED = "revoked"


class StandardErrorCode(str, Enum):
    UNAUTHORIZED = "UNAUTHORIZED"
    POLICY_DENIED = "POLICY_DENIED"
    APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
    NOT_FOUND = "NOT_FOUND"
    CONFLICT = "CONFLICT"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    RATE_LIMITED = "RATE_LIMITED"
    UNKNOWN_DELIVERY = "UNKNOWN_DELIVERY"
    RETRYABLE = "RETRYABLE"
    INTERNAL_ERROR = "INTERNAL_ERROR"


# ---------------------------------------------------------------------------
# Base Model Configuration
# ---------------------------------------------------------------------------

class AutomatBaseModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True,
        extra="ignore",
        use_enum_values=True,
    )


# ---------------------------------------------------------------------------
# Conversation & Message Models
# ---------------------------------------------------------------------------

class MessageAttachment(AutomatBaseModel):
    id: Optional[str] = None
    filename: Optional[str] = None
    mime_type: str = Field(alias="mimeType")
    size_bytes: Optional[int] = Field(default=None, alias="sizeBytes")
    url: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class MessageCausedBy(AutomatBaseModel):
    type: Literal["human", "workflow", "agent", "customer", "system"]
    id: str


class ConversationMessage(AutomatBaseModel):
    id: str
    conversation_id: str = Field(alias="conversationId")
    tenant_id: str = Field(alias="tenantId")
    connection_id: str = Field(alias="connectionId")
    channel: Union[ChannelKind, str]
    direction: Literal["inbound", "outbound"]
    delivery_state: Union[DeliveryState, str] = Field(alias="deliveryState")
    origin_event_id: Optional[str] = Field(default=None, alias="originEventId")
    client_request_id: Optional[str] = Field(default=None, alias="clientRequestId")
    correlation_id: Optional[str] = Field(default=None, alias="correlationId")
    body: Optional[str] = None
    attachments: List[MessageAttachment] = Field(default_factory=list)
    caused_by: MessageCausedBy = Field(alias="causedBy")
    created_at: Union[datetime, str] = Field(alias="createdAt")


class Conversation(AutomatBaseModel):
    id: str
    tenant_id: str = Field(alias="tenantId")
    connection_id: str = Field(alias="connectionId")
    channel: Union[ChannelKind, str]
    external_conversation_id: str = Field(alias="externalConversationId")
    contact_identity_id: Optional[str] = Field(default=None, alias="contactIdentityId")
    title: Optional[str] = None
    status: Union[ConversationStatus, str]
    stage: Union[CommercialStage, str]
    state_version: int = Field(alias="stateVersion")
    ai_paused: bool = Field(default=False, alias="aiPaused")
    ai_paused_until: Optional[Union[datetime, str]] = Field(default=None, alias="aiPausedUntil")
    assigned_user_id: Optional[str] = Field(default=None, alias="assignedUserId")
    assigned_agent_id: Optional[str] = Field(default=None, alias="assignedAgentId")
    last_message_at: Optional[Union[datetime, str]] = Field(default=None, alias="lastMessageAt")
    service_window_expires_at: Optional[Union[datetime, str]] = Field(default=None, alias="serviceWindowExpiresAt")
    created_at: Union[datetime, str] = Field(alias="createdAt")
    updated_at: Union[datetime, str] = Field(alias="updatedAt")


# ---------------------------------------------------------------------------
# Channel Connection Models
# ---------------------------------------------------------------------------

class ChannelConnectionHealth(AutomatBaseModel):
    configured: bool
    authorized: bool
    last_error_code: Optional[str] = Field(default=None, alias="lastErrorCode")
    last_checked_at: Optional[Union[datetime, str]] = Field(alias="lastCheckedAt")


class ChannelConnection(AutomatBaseModel):
    id: str
    tenant_id: str = Field(alias="tenantId")
    channel: Union[ChannelKind, str]
    name: str
    external_account_id: str = Field(alias="externalAccountId")
    status: Literal["active", "inactive", "needs_reauthorization", "error"]
    capabilities: List[Union[ChannelCapability, str]] = Field(default_factory=list)
    health: ChannelConnectionHealth
    created_at: Union[datetime, str] = Field(alias="createdAt")
    updated_at: Union[datetime, str] = Field(alias="updatedAt")


# ---------------------------------------------------------------------------
# Agent Graph & Run Models
# ---------------------------------------------------------------------------

class AgentTimelineStep(AutomatBaseModel):
    timestamp: Union[datetime, str]
    step: int
    node_id: str = Field(alias="nodeId")
    event: str
    details_redacted: Optional[Dict[str, Any]] = Field(default=None, alias="detailsRedacted")


class AgentRunTrace(AutomatBaseModel):
    run_id: str = Field(alias="runId")
    tenant_id: str = Field(alias="tenantId")
    graph_id: str = Field(alias="graphId")
    graph_version: int = Field(alias="graphVersion")
    state: Union[AgentRunState, str]
    timeline: List[AgentTimelineStep] = Field(default_factory=list)
    total_steps: int = Field(alias="totalSteps")
    total_tokens_used: Optional[int] = Field(default=None, alias="totalTokensUsed")
    total_cost_micro_usd: Optional[int] = Field(default=None, alias="totalCostMicroUsd")


class AgentGraphVersion(AutomatBaseModel):
    graph_id: str = Field(alias="graphId")
    version: int
    tenant_id: str = Field(alias="tenantId")
    entry_node_id: str = Field(alias="entryNodeId")
    nodes: List[Dict[str, Any]] = Field(default_factory=list)
    edges: List[Dict[str, Any]] = Field(default_factory=list)
    policy_ref: Optional[str] = Field(default=None, alias="policyRef")
    status: str = "draft"
    spec_hash: Optional[str] = Field(default=None, alias="specHash")


class SimulatedNodeExecution(AutomatBaseModel):
    node_id: str = Field(alias="nodeId")
    kind: str
    output: Dict[str, Any] = Field(default_factory=dict)
    duration_ms: int = Field(alias="durationMs")


# ---------------------------------------------------------------------------
# Approvals Models
# ---------------------------------------------------------------------------

class ApprovalActionDetails(AutomatBaseModel):
    tool_name: str = Field(alias="toolName")
    summary: str
    parameters_redacted: Dict[str, Any] = Field(default_factory=dict, alias="parametersRedacted")
    required_role: Optional[str] = Field(default=None, alias="requiredRole")


class ApprovalRequest(AutomatBaseModel):
    id: str
    tenant_id: str = Field(alias="tenantId")
    run_id: str = Field(alias="runId")
    node_id: str = Field(alias="nodeId")
    effect_key: str = Field(alias="effectKey")
    proposed_action_hash: str = Field(alias="proposedActionHash")
    policy_version: int = Field(alias="policyVersion")
    risk: Union[RiskLevel, str]
    status: Union[ApprovalStatus, str]
    expires_at: Union[datetime, str] = Field(alias="expiresAt")
    details: Optional[ApprovalActionDetails] = None
    created_at: Union[datetime, str] = Field(alias="createdAt")
    decided_at: Optional[Union[datetime, str]] = Field(default=None, alias="decidedAt")
    decided_by: Optional[str] = Field(default=None, alias="decidedBy")


class ApprovalDecisionRequest(AutomatBaseModel):
    decision: Literal["approved", "rejected"]
    expected_version: int = Field(alias="expectedVersion")
    reason: Optional[str] = None


class ApprovalDecisionResult(AutomatBaseModel):
    approval_id: str = Field(alias="approvalId")
    status: Union[ApprovalStatus, str]
    decided_at: Union[datetime, str] = Field(alias="decidedAt")
    decided_by: str = Field(alias="decidedBy")


# ---------------------------------------------------------------------------
# Command / Request Models
# ---------------------------------------------------------------------------

class TakeoverRequest(AutomatBaseModel):
    expected_version: int = Field(alias="expectedVersion")
    user_id: Optional[str] = Field(default=None, alias="userId")
    reason: Optional[str] = None


class PauseAiRequest(AutomatBaseModel):
    expected_version: int = Field(alias="expectedVersion")
    duration_seconds: Optional[int] = Field(default=None, alias="durationSeconds")
    reason: Optional[str] = None


class ResumeAiRequest(AutomatBaseModel):
    expected_version: int = Field(alias="expectedVersion")
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Generic Pagination Wrapper
# ---------------------------------------------------------------------------

T = TypeVar("T")


class PagedResponse(AutomatBaseModel, Generic[T]):
    items: List[T]
    next_cursor: Optional[str] = Field(default=None, alias="nextCursor")
    has_more: bool = Field(default=False, alias="hasMore")
