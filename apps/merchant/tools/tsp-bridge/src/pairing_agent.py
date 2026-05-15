"""BlueZ pairing agent that auto-accepts incoming pair requests.

Implements org.bluez.Agent1 and registers as the system default.
BlueZ calls into it for every pairing event.
"""
import asyncio
import logging

from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, method
from dbus_next import BusType

log = logging.getLogger("btprint.agent")

AGENT_PATH = "/com/demo/btprint/agent"
CAPABILITY = "NoInputNoOutput"  # → Just Works


class Agent(ServiceInterface):
    def __init__(self):
        super().__init__("org.bluez.Agent1")

    @method()
    def Release(self):
        log.info("agent released by bluez")

    @method()
    def AuthorizeService(self, device: "o", uuid: "s"):  # noqa: F722
        log.info("authorize_service device=%s uuid=%s", device, uuid)
        return

    @method()
    def RequestPinCode(self, device: "o") -> "s":  # noqa: F722
        log.info("pin requested for %s → returning '0000'", device)
        return "0000"

    @method()
    def RequestPasskey(self, device: "o") -> "u":  # noqa: F722
        log.info("passkey requested for %s → returning 0", device)
        return 0

    @method()
    def DisplayPasskey(self, device: "o", passkey: "u", entered: "q"):  # noqa: F722
        log.info("display passkey %s for %s (%s entered)", passkey, device, entered)

    @method()
    def DisplayPinCode(self, device: "o", pincode: "s"):  # noqa: F722
        log.info("display pincode %s for %s", pincode, device)

    @method()
    def RequestConfirmation(self, device: "o", passkey: "u"):  # noqa: F722
        log.info("auto-confirming passkey %s for %s", passkey, device)
        return

    @method()
    def RequestAuthorization(self, device: "o"):  # noqa: F722
        log.info("auto-authorizing %s", device)
        return

    @method()
    def Cancel(self):
        log.info("pairing cancelled by bluez")


async def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(message)s")
    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
    agent = Agent()
    bus.export(AGENT_PATH, agent)

    introspection = await bus.introspect("org.bluez", "/org/bluez")
    obj = bus.get_proxy_object("org.bluez", "/org/bluez", introspection)
    mgr = obj.get_interface("org.bluez.AgentManager1")

    await mgr.call_register_agent(AGENT_PATH, CAPABILITY)
    await mgr.call_request_default_agent(AGENT_PATH)
    log.info("pairing agent registered and set as default")

    await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
