"""
Typed RFC 7807 / RFC 9457 Problem Details Exception hierarchy for Whatsap-Automat.
Maps HTTP status codes to strongly typed domain exceptions.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional


class AutomatError(Exception):
    """Base exception for all Whatsap-Automat SDK errors."""
    pass


class ProblemDetailsError(AutomatError):
    """
    Standard RFC 7807 / RFC 9457 Problem Details Exception.
    Captures structured API error details including correlation ID and invalid params.
    """

    def __init__(
        self,
        status: int,
        title: str,
        detail: str,
        type_: str = "about:blank",
        instance: Optional[str] = None,
        code: Optional[str] = None,
        correlation_id: Optional[str] = None,
        invalid_params: Optional[List[Dict[str, str]]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(f"[{status}] {title}: {detail}")
        self.status = status
        self.title = title
        self.detail = detail
        self.type = type_
        self.instance = instance
        self.code = code
        self.correlation_id = correlation_id
        self.invalid_params = invalid_params or []
        self.metadata = metadata or {}


class UnauthorizedError(ProblemDetailsError):
    """HTTP 401 Unauthorized: Authentication credentials missing or invalid."""
    def __init__(self, detail: str = "Authentication required", **kwargs: Any):
        super().__init__(status=401, title=kwargs.pop("title", "Unauthorized"), detail=detail, **kwargs)


class PolicyDeniedError(ProblemDetailsError):
    """HTTP 403 Forbidden: Action denied by workspace policy or permissions."""
    def __init__(self, detail: str = "Action denied by policy", **kwargs: Any):
        super().__init__(status=403, title=kwargs.pop("title", "Policy Denied"), detail=detail, **kwargs)


class NotFoundError(ProblemDetailsError):
    """HTTP 404 Not Found: Target resource does not exist."""
    def __init__(self, detail: str = "Resource not found", **kwargs: Any):
        super().__init__(status=404, title=kwargs.pop("title", "Not Found"), detail=detail, **kwargs)


class ConflictError(ProblemDetailsError):
    """HTTP 409 Conflict: Optimistic concurrency CAS version mismatch or state conflict."""
    def __init__(self, detail: str = "Resource conflict or stale state version", **kwargs: Any):
        super().__init__(status=409, title=kwargs.pop("title", "Conflict"), detail=detail, **kwargs)


class ValidationError(ProblemDetailsError):
    """HTTP 422 Unprocessable Entity: Payload schema validation failed."""
    def __init__(self, detail: str = "Validation failed for request payload", **kwargs: Any):
        super().__init__(status=422, title=kwargs.pop("title", "Validation Error"), detail=detail, **kwargs)


class ApprovalRequiredError(ProblemDetailsError):
    """HTTP 428 Precondition Required: High-risk action requires human approval before proceeding."""
    def __init__(self, detail: str = "Human approval required", **kwargs: Any):
        super().__init__(status=428, title=kwargs.pop("title", "Approval Required"), detail=detail, **kwargs)


class RateLimitedError(ProblemDetailsError):
    """HTTP 429 Too Many Requests: Rate limit quota exceeded."""
    def __init__(
        self,
        detail: str = "Rate limit exceeded",
        retry_after_seconds: Optional[int] = None,
        **kwargs: Any,
    ):
        super().__init__(status=429, title=kwargs.pop("title", "Rate Limited"), detail=detail, **kwargs)
        self.retry_after_seconds = retry_after_seconds


class UnknownDeliveryError(ProblemDetailsError):
    """HTTP 502 Bad Gateway: Upstream provider delivery status could not be verified."""
    def __init__(self, detail: str = "Unknown delivery status from upstream", **kwargs: Any):
        super().__init__(status=502, title=kwargs.pop("title", "Unknown Delivery"), detail=detail, **kwargs)


class ServiceUnavailableError(ProblemDetailsError):
    """HTTP 503 Service Unavailable: Downstream service temporarily degraded or unavailable."""
    def __init__(self, detail: str = "Service temporarily unavailable", **kwargs: Any):
        super().__init__(status=503, title=kwargs.pop("title", "Service Unavailable"), detail=detail, **kwargs)


def create_error_from_response(
    status: int,
    body: Any,
    headers: Optional[Mapping[str, str]] = None,
) -> ProblemDetailsError:
    """
    Factory creating appropriate typed ProblemDetailsError subclass from HTTP status,
    parsed JSON problem details body, and response headers.
    """
    headers = headers or {}
    prob = body if isinstance(body, dict) else {}
    title = prob.get("title") or f"HTTP {status}"
    detail = prob.get("detail") or str(body) or "An error occurred"
    type_ = prob.get("type", "about:blank")
    instance = prob.get("instance")
    code = prob.get("code")
    correlation_id = prob.get("correlationId")
    invalid_params = prob.get("invalidParams")
    metadata = prob.get("metadata")

    retry_after_str = headers.get("retry-after") or headers.get("Retry-After")
    retry_after_seconds: Optional[int] = None
    if retry_after_str and retry_after_str.isdigit():
        retry_after_seconds = int(retry_after_str)

    kwargs = {
        "title": title,
        "detail": detail,
        "type_": type_,
        "instance": instance,
        "code": code,
        "correlation_id": correlation_id,
        "invalid_params": invalid_params,
        "metadata": metadata,
    }

    if status == 401:
        return UnauthorizedError(**kwargs)
    elif status == 403:
        return PolicyDeniedError(**kwargs)
    elif status == 404:
        return NotFoundError(**kwargs)
    elif status == 409:
        return ConflictError(**kwargs)
    elif status == 422:
        return ValidationError(**kwargs)
    elif status == 428:
        return ApprovalRequiredError(**kwargs)
    elif status == 429:
        return RateLimitedError(retry_after_seconds=retry_after_seconds, **kwargs)
    elif status == 502:
        return UnknownDeliveryError(**kwargs)
    elif status == 503:
        return ServiceUnavailableError(**kwargs)
    else:
        return ProblemDetailsError(status=status, **kwargs)


_STANDARD_ERROR_CODES = frozenset((
    "UNAUTHORIZED", "POLICY_DENIED", "APPROVAL_REQUIRED", "NOT_FOUND", "CONFLICT",
    "VALIDATION_ERROR", "RATE_LIMITED", "UNKNOWN_DELIVERY", "RETRYABLE", "INTERNAL_ERROR",
))
_APPROVAL_REAUTH_REASONS = {
    "POLICY_DENIED": ("APPROVAL_REAUTH_REQUIRED", "APPROVAL_REAUTH_INVALID"),
    "RATE_LIMITED": ("APPROVAL_REAUTH_LIMITED",),
    "VALIDATION_ERROR": ("VALIDATION_ERROR",),
}


def _sensitive_problem_details(body: Any) -> Dict[str, Any]:
    problem: Dict[str, Any] = {"detail": "The server rejected the request."}
    if not isinstance(body, dict):
        return problem
    code = body.get("code")
    if not isinstance(code, str) or code not in _STANDARD_ERROR_CODES:
        return problem
    problem["code"] = code
    metadata = body.get("metadata")
    reason = metadata.get("reason") if isinstance(metadata, dict) else None
    if isinstance(reason, str) and reason in _APPROVAL_REAUTH_REASONS.get(code, ()):
        problem["metadata"] = {"reason": reason}
    return problem
