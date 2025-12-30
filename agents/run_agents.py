"""Run interpreter and navigator agents together."""

from __future__ import annotations

from agents.shared.local_agents import Bureau

from agents.interpreter_agent import interpreter_agent
from agents.orchestrator_agent import orchestrator_agent
from agents.navigator_agent import navigator_agent


def run():
    bureau = Bureau()
    bureau.add(orchestrator_agent)
    bureau.add(interpreter_agent)
    bureau.add(navigator_agent)
    bureau.run()


if __name__ == "__main__":
    run()
