class EmptyStreamError(RuntimeError):
    """Raised when a provider closes a stream without yielding a response."""
