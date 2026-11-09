"""
Whatsap-Automat Python SDK
Official typed client for Whatsap-Automat REST API v0.4
"""

from .client import (
    AutomatClient,
    AsyncAutomatClient,
    ClientConfig,
)
from .exceptions import (
    AutomatError,
    ProblemDetailsError,
    UnauthorizedError,
    PolicyDeniedError,
    NotFoundError,
    ConflictError,
    ValidationError,
    ApprovalRequiredError,
    RateLimitedError,
    UnknownDeliveryError,
    ServiceUnavailableError,
    create_error_from_response,
)
from .models import (
    ChannelKind,
    ChannelCapability,
    CommercialStage,
    ConversationStatus,
    DeliveryState,
    AgentRunState,
    RiskLevel,
    ApprovalStatus,
    StandardErrorCode,
    MessageAttachment,
    MessageCausedBy,
    ConversationMessage,
    Conversation,
    ChannelConnectionHealth,
    ChannelConnection,
    AgentTimelineStep,
    AgentRunTrace,
    ApprovalActionDetails,
    ApprovalRequest,
    PagedResponse,
    TakeoverRequest,
    PauseAiRequest,
    ResumeAiRequest,
    SendMessageResult,
    ApprovalDecisionRequest,
    ApprovalDecisionResult,
)
from .pagination import (
    CursorPager,
    AsyncCursorPager,
)

__version__ = "0.4.0"

__all__ = [
    # Clients
    "AutomatClient",
    "AsyncAutomatClient",
    "ClientConfig",
    # Pagination
    "CursorPager",
    "AsyncCursorPager",
    # Exceptions
    "AutomatError",
    "ProblemDetailsError",
    "UnauthorizedError",
    "PolicyDeniedError",
    "NotFoundError",
    "ConflictError",
    "ValidationError",
    "ApprovalRequiredError",
    "RateLimitedError",
    "UnknownDeliveryError",
    "ServiceUnavailableError",
    "create_error_from_response",
    # Enums
    "ChannelKind",
    "ChannelCapability",
    "CommercialStage",
    "ConversationStatus",
    "DeliveryState",
    "AgentRunState",
    "RiskLevel",
    "ApprovalStatus",
    "StandardErrorCode",
    # Models
    "MessageAttachment",
    "MessageCausedBy",
    "ConversationMessage",
    "Conversation",
    "ChannelConnectionHealth",
    "ChannelConnection",
    "AgentTimelineStep",
    "AgentRunTrace",
    "ApprovalActionDetails",
    "ApprovalRequest",
    "PagedResponse",
    "TakeoverRequest",
    "PauseAiRequest",
    "ResumeAiRequest",
    "SendMessageResult",
    "ApprovalDecisionRequest",
    "ApprovalDecisionResult",
]
