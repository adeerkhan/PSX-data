"""Type stubs for pypsx.core.errors — custom exception hierarchy."""


class PSXError(Exception):
    """Base exception for all pypsx errors."""
    ...


class PSXHTTPError(PSXError):
    """
    Raised when the PSX server returns an unexpected HTTP status code.

    Attributes:
        status_code: The HTTP status code received.
        url: The URL that triggered the error.
    """
    status_code: int
    url: str
    ...


class PSXTimeoutError(PSXError):
    """Raised when an HTTP request to PSX exceeds the configured timeout."""
    ...


class PSXNotFoundError(PSXError):
    """Raised when a requested symbol, sector, or index does not exist on PSX."""
    ...


class PSXScopeError(PSXError):
    """
    Raised when a method is called on the wrong ticker type.

    Example: calling .constituents() on an equity ticker instead of an index ticker.
    """
    ...
