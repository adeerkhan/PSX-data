"""Type stubs for pypsx.core.stream — real-time PSX data streaming."""

from typing import Any, Callable, Dict, List, Union


class PSXStream:
    """
    Real-time PSX market data stream using polling (15-second interval by default).

    Fetches live price ticks for one or more symbols and delivers them via a
    callback function.

    Example:
        >>> import pypsx
        >>>
        >>> def on_tick(data: dict):
        ...     print(f"{data['symbol']}: {data['price']} ({data['change_pct']:+.2f}%)")
        >>>
        >>> stream = pypsx.PSXStream(["ENGRO", "HBL", "SYS"])
        >>> stream.subscribe(on_tick)
        >>> # Stream runs until stream.stop() is called or KeyboardInterrupt
    """

    symbols: List[str]
    interval: int

    def __init__(
        self,
        symbols: Union[str, List[str]],
        interval: int = 15,
    ) -> None:
        """
        Create a real-time stream for one or more PSX symbols.

        Args:
            symbols: Single symbol string or list of symbols to monitor.
            interval: Polling interval in seconds (minimum 15 to respect PSX rate limits).
        """
        ...

    def subscribe(self, callback: Callable[[Dict[str, Any]], None]) -> None:
        """
        Start the stream and deliver ticks to the callback function.

        The callback receives a dict with keys:
            symbol (str), price (float), change (float), change_pct (float),
            volume (int), high (float), low (float), timestamp (str).

        This method blocks until stop() is called or an exception occurs.

        Args:
            callback: Function called with each price tick dict.

        Example:
            >>> stream = pypsx.PSXStream("OGDC", interval=30)
            >>> stream.subscribe(lambda d: print(d["price"]))
        """
        ...

    def stop(self) -> None:
        """
        Stop the stream gracefully.

        Safe to call from within the callback or from another thread.
        """
        ...
