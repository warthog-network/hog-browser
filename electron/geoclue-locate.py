#!/usr/bin/env python3
"""One location fix from GeoClue (the desktop's location service).

Prints {"ok": true, "latitude": .., "longitude": .., "accuracy": .., ...} or
{"ok": false, "error": ".."} as one JSON line. GNOME's Settings -> Privacy ->
Location Services decides whether the app may know the location; the fix
comes from Wi-Fi / GPS / IP sources GeoClue is set up with.
"""
import json
import sys

TIMEOUT_S = 20


def main():
    try:
        import gi
        gi.require_version("Gio", "2.0")
        from gi.repository import Gio, GLib
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"python3-gi is missing ({exc})"}
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
        name = "org.freedesktop.GeoClue2"

        def proxy(path, iface):
            return Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.NONE, None, name, path, iface, None)

        manager = proxy("/org/freedesktop/GeoClue2/Manager", "org.freedesktop.GeoClue2.Manager")
        try:
            client_path = manager.call_sync("CreateClient", None, Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
        except GLib.Error:
            client_path = manager.call_sync("GetClient", None, Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
        client = proxy(client_path, "org.freedesktop.GeoClue2.Client")
        props = proxy(client_path, "org.freedesktop.DBus.Properties")
        iface = "org.freedesktop.GeoClue2.Client"
        props.call_sync("Set", GLib.Variant("(ssv)", (iface, "DesktopId", GLib.Variant("s", "hog-chromium-preview"))), Gio.DBusCallFlags.NONE, 5000, None)
        level = 8 if "--high" in sys.argv else 6  # EXACT / STREET
        props.call_sync("Set", GLib.Variant("(ssv)", (iface, "RequestedAccuracyLevel", GLib.Variant("u", level))), Gio.DBusCallFlags.NONE, 5000, None)
        loop = GLib.MainLoop()
        result = {"ok": False, "error": "GeoClue gave no location in time (is Location Services on?)"}

        def on_signal(_proxy, _sender, signal, params):
            nonlocal result
            if signal != "LocationUpdated":
                return
            new_path = params.unpack()[1]
            loc = proxy(new_path, "org.freedesktop.GeoClue2.Location")

            def get(prop):
                value = loc.get_cached_property(prop)
                return value.unpack() if value is not None else None

            ts = get("Timestamp")
            result = {
                "ok": True,
                "latitude": get("Latitude"),
                "longitude": get("Longitude"),
                "accuracy": get("Accuracy"),
                "altitude": get("Altitude"),
                "speed": get("Speed"),
                "heading": get("Heading"),
                "timestamp": int(ts[0] * 1000 + ts[1] / 1000) if ts else None,
            }
            loop.quit()

        client.connect("g-signal", on_signal)
        client.call_sync("Start", None, Gio.DBusCallFlags.NONE, 10000, None)
        GLib.timeout_add_seconds(TIMEOUT_S, loop.quit)
        loop.run()
        try:
            client.call_sync("Stop", None, Gio.DBusCallFlags.NONE, 3000, None)
        except GLib.Error:
            pass
        return result
    except Exception as exc:  # noqa: BLE001
        message = getattr(exc, "message", None) or str(exc)
        if "AccessDenied" in message or "not allowed" in message.lower():
            message = "Location access was denied (Settings -> Privacy -> Location Services)."
        return {"ok": False, "error": f"GeoClue: {message}"[:240]}


if __name__ == "__main__":
    print(json.dumps(main()))
