"""Lightweight in-process agent runtime to replace uagents."""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import Any, Awaitable, Callable, Dict, Optional, Type


Handler = Callable[..., Awaitable[None] | None]


def _attach_sender(msg: Any, sender: str | None) -> None:
    if sender is None:
        return
    try:
        setattr(msg, "sender", sender)
    except Exception:
        # Best-effort: if the message is immutable, skip attaching sender.
        return


class Context:
    def __init__(self, bureau: "Bureau", agent: "Agent", sender: str | None):
        self._bureau = bureau
        self._agent = agent
        self._sender = sender
        self.logger = logging.getLogger(agent.name)

    async def send(self, recipient: str | "Agent", message: Any) -> None:
        await self._bureau.send(self._agent.address, recipient, message)


class Agent:
    def __init__(self, name: str, seed: Optional[str] = None, endpoint: Optional[str] = None):
        self.name = name
        self.seed = seed
        self.endpoint = endpoint
        self.address = name
        self._handlers: Dict[Type[Any], Handler] = {}

    def on_message(self, model: Type[Any]) -> Callable[[Handler], Handler]:
        def decorator(handler: Handler) -> Handler:
            self._handlers[model] = handler
            return handler

        return decorator

    def _find_handler(self, msg: Any) -> Optional[Handler]:
        for model, handler in self._handlers.items():
            if isinstance(msg, model):
                return handler
        return None


class Bureau:
    def __init__(self) -> None:
        self._agents: Dict[str, Agent] = {}

    def add(self, agent: Agent) -> None:
        self._agents[agent.address] = agent

    async def send(self, sender: str | None, recipient: str | Agent, msg: Any) -> None:
        address = recipient.address if isinstance(recipient, Agent) else recipient
        agent = self._agents.get(address)
        if not agent:
            raise ValueError(f"Unknown agent address: {address}")

        _attach_sender(msg, sender)
        handler = agent._find_handler(msg)
        if not handler:
            raise ValueError(
                f"No handler for message type {type(msg).__name__} on agent {agent.name}"
            )

        ctx = Context(self, agent, sender)
        params = list(inspect.signature(handler).parameters)
        if len(params) == 3:
            result = handler(ctx, sender, msg)
        else:
            result = handler(ctx, msg)

        if inspect.isawaitable(result):
            await result

    def run(self) -> None:
        async def _idle() -> None:
            await asyncio.Event().wait()

        try:
            asyncio.run(_idle())
        except KeyboardInterrupt:
            return
