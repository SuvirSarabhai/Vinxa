"""Application-level loopback policy for the speech runtime, not an OS firewall."""
import ipaddress
import os
import sys

_installed = False

def _local(host):
    if host in ("localhost", b"localhost", None):
        return True
    try:
        if isinstance(host, bytes):
            host = host.decode("ascii")
        address = ipaddress.ip_address(host)
        return address.is_loopback or bool(getattr(address, "ipv4_mapped", None) and address.ipv4_mapped.is_loopback)
    except (ValueError, TypeError, UnicodeError):
        return False

def audit(event, args):
    if event == "socket.getaddrinfo":
        host = args[0]
        if not _local(host):
            raise PermissionError("Speech runtime permits loopback networking only")
    elif event in ("socket.connect", "socket.sendto"):
        address = args[-1]
        if isinstance(address, tuple) and not _local(address[0]):
            raise PermissionError("Speech runtime permits loopback networking only")

def install():
    global _installed
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    if not _installed:
        sys.addaudithook(audit)
        _installed = True
