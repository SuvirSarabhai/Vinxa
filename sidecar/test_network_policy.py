import pytest
from sidecar.network_policy import audit

@pytest.mark.parametrize("host", ["example.com", "8.8.8.8", "::ffff:8.8.8.8"])
def test_remote_rejected(host):
    with pytest.raises(PermissionError):
        audit("socket.connect", (None, (host, 443)))
    with pytest.raises(PermissionError):
        audit("socket.getaddrinfo", (host, 443, 0, 0, 0))

@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"])
def test_loopback_allowed(host):
    audit("socket.connect", (None, (host, 11434)))
    audit("socket.getaddrinfo", (host, 11434, 0, 0, 0))
