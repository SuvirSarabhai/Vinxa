"""Authentication ownership and transport lifetime, independent of UI state."""

from dataclasses import dataclass, field
from collections import deque

from .protocol import ProtocolError


@dataclass
class Session:
    session_id: str
    generation: int
    enabled_sources: tuple[str, ...]
    # Transport admission precedes model readiness.
    status: str = "starting"
    closed: bool = False
    persistent: bool = False
    _request_order: deque = field(default_factory=deque, repr=False)
    _requests: set[str] = field(default_factory=set, repr=False)

    @classmethod
    def from_config(cls, config):
        return cls(config["sessionId"], config["generation"], tuple(config["enabledSources"]),
                   persistent=config.get("keepAlive", False))

    def accept_control(self, control):
        if self.closed:
            raise ProtocolError("SESSION_CLOSED", "Session is closed")
        if (control["sessionId"], control["generation"]) != (self.session_id, self.generation):
            raise ProtocolError("STALE_SESSION", "Control belongs to an inactive session")
        if control["requestId"] in self._requests:
            raise ProtocolError("DUPLICATE_REQUEST", "Control request was already received")
        if len(self._requests) >= 4096:
            if not self.persistent:
                raise ProtocolError("CONTROL_LIMIT", "Session control limit reached")
            self._requests.remove(self._request_order.popleft())
        if "source" in control and control["source"] not in self.enabled_sources:
            raise ProtocolError("SOURCE_DISABLED", "Audio source is disabled")
        self._requests.add(control["requestId"])
        if self.persistent:
            self._request_order.append(control["requestId"])

    def status_event(self, request_id=None):
        event = {"type": "status", "sessionId": self.session_id,
                 "generation": self.generation, "status": self.status}
        if request_id is not None:
            event["requestId"] = request_id
        return event

    def close(self):
        self.closed = True
        self.status = "stopped"
        self._requests.clear()
        self._request_order.clear()
