#!/usr/bin/env python3
"""
AT-SPI2 helper for the Appium Linux driver.
Called as a subprocess with JSON input/output.
"""
import sys
import json
import base64
import time
import re
import subprocess
import pyatspi


class ApplicationGroup:
    """One process can register multiple independent AT-SPI providers."""
    name = "Application"
    description = ""

    def __init__(self, applications):
        self.children = applications
        self.childCount = len(applications)

    def getRoleName(self):
        return "application"

    def getChildAtIndex(self, index):
        return self.children[index]


def get_app(app_pid):
    desktop = pyatspi.Registry.getDesktop(0)
    providers = [app for app in desktop if app]
    applications = [app for app in providers if app.get_process_id() == app_pid]
    if not applications:
        return None
    # XDG choosers live in a separate, shared portal process. Admit only an
    # unambiguous top-level window with a native transient owner in this app.
    dialog_pids = owned_dialog_processes(app_pid)
    for app in providers:
        if app.get_process_id() not in dialog_pids:
            continue
        dialogs = [child for child in app if child and
                   child.getState().contains(pyatspi.STATE_SHOWING)]
        if len(dialogs) == 1:
            applications.append(dialogs[0])
    return applications[0] if len(applications) == 1 else ApplicationGroup(applications)


def read_windows():
    result = subprocess.run(['xprop', '-root', '_NET_CLIENT_LIST'],
                            capture_output=True, text=True, check=True)
    windows = []
    for xid in re.findall(r'0x[0-9a-fA-F]+', result.stdout):
        properties = subprocess.run(
            ['xprop', '-id', xid, '_NET_WM_PID', 'WM_TRANSIENT_FOR'],
            capture_output=True, text=True, check=True).stdout
        pid = re.search(r'_NET_WM_PID\(CARDINAL\) = (\d+)', properties)
        parent = re.search(r'WM_TRANSIENT_FOR\(WINDOW\): window id # (0x[0-9a-fA-F]+)', properties)
        if pid:
            windows.append((int(xid, 16), int(pid[1]), int(parent[1], 16) if parent else None))
    return windows


def owned_dialog_processes(app_pid):
    try:
        windows = read_windows()
    except (OSError, subprocess.SubprocessError):
        return set()
    owners = {xid for xid, pid, _ in windows if pid == app_pid}
    candidates = {pid for _, pid, parent in windows if pid != app_pid and parent in owners}
    # A shared portal with other windows is ambiguous; never expose their UI.
    return {pid for pid in candidates if sum(owner == pid for _, owner, _ in windows) == 1}


def node_identity(node):
    # Object paths are unique only within one D-Bus connection, not one PID.
    return node.app.bus_name + node.path


def wait_for_app(app_pid, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        app = get_app(app_pid)
        if app is not None:
            return app
        time.sleep(0.5)
    return None


def node_to_dict(node, depth=0, max_depth=20):
    if node is None or depth > max_depth:
        return None
    try:
        role = node.getRoleName()
        name = node.name or ""
        desc = node.description or ""
        try:
            component = node.queryComponent()
            # Compose popup/scroll descendants can report DESKTOP_COORDS with an ancestor offset applied twice.
            # Example: a "Subscription" menu row was exposed around (448,594) here, while the in-process
            # Java accessibility dump placed the same row around (200,424) inside the window. Coordinate
            # fallback clicks derived from these bounds can land below the real clickable row.
            bbox = component.getExtents(pyatspi.DESKTOP_COORDS)
            bounds = {"x": bbox.x, "y": bbox.y, "w": bbox.width, "h": bbox.height}
        except Exception:
            bounds = None
        try:
            text_iface = node.queryText()
            value = text_iface.getText(0, -1)
        except Exception:
            value = None
        children = []
        for i in range(node.childCount):
            child = node.getChildAtIndex(i)
            child_dict = node_to_dict(child, depth + 1, max_depth)
            if child_dict:
                children.append(child_dict)
        return {
            "role": role,
            "name": name,
            "desc": desc,
            "value": value,
            "bounds": bounds,
            "children": children,
        }
    except Exception as e:
        return {"role": "error", "name": str(e), "children": []}


def matches_label(value, expected):
    # Compose can expose the same semantic label more than once.
    return value == expected or any(part.strip() == expected for part in value.split(","))


def find_nodes(node, strategy, selector, results, max_results=10):
    if node is None or len(results) >= max_results:
        return

    try:
        role = node.getRoleName()
    except Exception:
        role = ""
    try:
        name = node.name or ""
    except Exception:
        name = ""
    try:
        desc = node.description or ""
    except Exception:
        desc = ""
    try:
        text_iface = node.queryText()
        value = text_iface.getText(0, -1)
    except Exception:
        value = ""

    matched = False
    if strategy == "name":
        matched = any(matches_label(label, selector) for label in (name, desc, value))
    elif strategy == "name_contains":
        matched = selector in name or selector in desc or selector in value
    elif strategy == "xpath":
        # simplified: treat xpath like //*/[@name='X'] or //*[contains(@name,'X')]
        import re
        m = re.search(r"@name='([^']+)'", selector)
        mc = re.search(r"contains\(@(?:name|value),'([^']+)'\)", selector)
        if selector == "//text-field":
            try:
                state = node.getState()
                matched = role in ("text", "entry", "password text") and state.contains(pyatspi.STATE_EDITABLE)
            except Exception:
                matched = False
        elif m:
            matched = any(matches_label(label, m.group(1)) for label in (name, desc, value))
        elif mc:
            needle = mc.group(1)
            matched = needle in name or needle in desc or needle in value
    if matched:
        results.append(node)

    try:
        child_count = node.childCount
    except Exception:
        return
    for i in range(child_count):
        if len(results) >= max_results:
            break
        try:
            find_nodes(node.getChildAtIndex(i), strategy, selector, results, max_results)
        except Exception:
            continue


def wait_for_elements(app_pid, strategy, selector, timeout=15, max_results=10):
    deadline = time.monotonic() + timeout
    last_results = []
    while time.monotonic() < deadline:
        app = get_app(app_pid)
        if app:
            results = []
            find_nodes(app, strategy, selector, results, max_results)
            if results:
                return results
            last_results = results
        time.sleep(0.2)
    return last_results


def get_center(node):
    try:
        component = node.queryComponent()
        # See node_to_dict: DESKTOP_COORDS is only a fallback coordinate source for Appium.
        # Prefer AT-SPI actions or stable semantic selectors when a Compose node exposes them.
        bbox = component.getExtents(pyatspi.DESKTOP_COORDS)
        return bbox.x + bbox.width // 2, bbox.y + bbox.height // 2
    except Exception:
        return None, None


def perform_action(node, preferred=("click", "press", "activate")):
    try:
        action = node.queryAction()
        for name in preferred:
            for i in range(action.nActions):
                if action.getName(i) == name:
                    return action.doAction(i), name
        if action.nActions > 0:
            return action.doAction(0), action.getName(0)
    except Exception:
        pass
    return False, None


def find_focusable(node):
    """Find first focusable/editable child."""
    try:
        state = node.getState()
        if state.contains(pyatspi.STATE_EDITABLE) or state.contains(pyatspi.STATE_FOCUSABLE):
            return node
        for i in range(node.childCount):
            result = find_focusable(node.getChildAtIndex(i))
            if result:
                return result
    except Exception:
        pass
    return None


def find_by_path(node, object_path):
    """Resolve only the saved identity, regardless of label or result order."""
    if node is None or not object_path:
        return None
    try:
        if not isinstance(node, ApplicationGroup) and node_identity(node) == object_path:
            if node.getState().contains(pyatspi.STATE_DEFUNCT):
                return None
            return node
        child_count = node.childCount
    except Exception:
        return None
    for index in range(child_count):
        try:
            target = find_by_path(node.getChildAtIndex(index), object_path)
            if target is not None:
                return target
        except Exception:
            continue
    return None


def main():
    cmd = json.loads(sys.stdin.read())
    action = cmd["action"]

    if action == "screenshot":
        try:
            import gi
            gi.require_version("Gdk", "3.0")
            from gi.repository import Gdk
            window = Gdk.get_default_root_window()
            if window is None:
                raise RuntimeError("No desktop window is available")
            pixels = Gdk.pixbuf_get_from_window(window, 0, 0, window.get_width(), window.get_height())
            if pixels is None:
                raise RuntimeError("Desktop pixels are unavailable")
            success, data = pixels.save_to_bufferv("png", [], [])
            if not success:
                raise RuntimeError("Desktop PNG encoding failed")
            print(json.dumps({"ok": True, "data": base64.b64encode(bytes(data)).decode("ascii")}))
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}))
        return

    if action == "wait_for_app":
        app = wait_for_app(cmd["pid"], cmd.get("timeout", 30))
        if app:
            print(json.dumps({"ok": True, "name": app.name}))
        else:
            print(json.dumps({"ok": False, "error": "app not found"}))

    elif action == "page_source":
        app = get_app(cmd["pid"])
        if not app:
            print(json.dumps({"ok": False, "error": "app not found"}))
            return
        tree = node_to_dict(app)
        print(json.dumps({"ok": True, "tree": tree}))

    elif action in ("find_elements", "find_elements_once"):
        app = wait_for_app(cmd["pid"], cmd.get("timeout", 15))
        if not app:
            print(json.dumps({"ok": False, "error": "app not found"}))
            return
        if action == "find_elements_once":
            results = []
            find_nodes(
                app,
                cmd["strategy"],
                cmd["selector"],
                results,
                cmd.get("max_results", 10),
            )
        else:
            results = wait_for_elements(
                cmd["pid"],
                cmd["strategy"],
                cmd["selector"],
                cmd.get("timeout", 15),
                cmd.get("max_results", 10),
            )
        elements = []
        for i, node in enumerate(results):
            cx, cy = get_center(node)
            elements.append({
                "id": i,
                "path": node_identity(node),
                "name": node.name or "",
                "role": node.getRoleName(),
                "cx": cx,
                "cy": cy,
            })
        print(json.dumps({"ok": True, "elements": elements}))

    elif action == "find_input":
        app = wait_for_app(cmd["pid"], cmd.get("timeout", 15))
        if not app:
            print(json.dumps({"ok": False, "error": "app not found"}))
            return
        results = []
        find_nodes(app, "name", cmd.get("selector", ""), results)
        target = results[0] if results else app
        focusable = find_focusable(target) or target
        cx, cy = get_center(focusable)
        print(json.dumps({"ok": True, "cx": cx, "cy": cy}))

    elif action == "click_element":
        app = wait_for_app(cmd["pid"], cmd.get("timeout", 15))
        if not app:
            print(json.dumps({"ok": False, "error": "app not found"}))
            return
        results = wait_for_elements(
            cmd["pid"],
            cmd.get("strategy", "name"),
            cmd["selector"],
            cmd.get("timeout", 15),
        )
        if not results:
            print(json.dumps({"ok": False, "stale": True, "error": "element no longer exists"}))
            return
        index = cmd.get("index", 0)
        object_path = cmd.get("path")
        target = next((node for node in results if node_identity(node) == object_path), None) if object_path else (
            results[index] if len(results) > index else None
        )
        if not target:
            print(json.dumps({"ok": False, "stale": True, "error": "element no longer exists"}))
            return
        ok, action_name = perform_action(target)
        cx, cy = get_center(target)
        print(json.dumps({"ok": ok, "action": action_name, "cx": cx, "cy": cy}))

    elif action == "element_geometry":
        app = get_app(cmd["pid"])
        target = find_by_path(app, cmd.get("path"))
        if target is None:
            print(json.dumps({"ok": False, "stale": True, "error": "element no longer exists"}))
            return
        try:
            state = target.getState()
            try:
                component = target.queryComponent()
            except NotImplementedError:
                # Nonvisual/transient AT-SPI objects have no Component interface.
                print(json.dumps({"ok": True, "rect": {"x": 0, "y": 0, "width": 0, "height": 0},
                                  "visible": False, "enabled": state.contains(pyatspi.STATE_ENABLED)}))
                return
            bounds = component.getExtents(pyatspi.DESKTOP_COORDS)
            print(json.dumps({
                "ok": True,
                "rect": {"x": bounds.x, "y": bounds.y, "width": bounds.width, "height": bounds.height},
                "visible": state.contains(pyatspi.STATE_SHOWING) and bounds.width > 0 and bounds.height > 0,
                "enabled": state.contains(pyatspi.STATE_ENABLED),
            }))
        except Exception as error:
            stale = find_by_path(get_app(cmd["pid"]), cmd.get("path")) is None
            print(json.dumps({"ok": False, "stale": stale,
                              "error": "element no longer exists" if stale else str(error) or type(error).__name__}))

    elif action == "set_text":
        app = wait_for_app(cmd["pid"], cmd.get("timeout", 15))
        if not app:
            print(json.dumps({"ok": False, "error": "app not found"}))
            return
        target = find_by_path(app, cmd.get("path"))
        if target is None:
            print(json.dumps({"ok": False, "stale": True, "error": "element no longer exists"}))
            return
        perform_action(target)
        try:
            editable = target.queryEditableText()
            expected_text = cmd.get("text", "")
            editable.setTextContents(expected_text)
            deadline = time.time() + 2
            stable_reads = 0
            while time.time() < deadline:
                try:
                    actual_text = target.queryText().getText(0, -1)
                except Exception:
                    actual_text = None
                stable_reads = stable_reads + 1 if actual_text == expected_text else 0
                if stable_reads >= 2:
                    break
                time.sleep(0.05)
            if stable_reads < 2:
                stale = find_by_path(app, cmd.get("path")) is None
                error = "element no longer exists" if stale else "editable text did not reach the requested value"
                print(json.dumps({"ok": False, "stale": stale, "error": error}))
                return
            cx, cy = get_center(target)
            print(json.dumps({"ok": True, "cx": cx, "cy": cy}))
        except Exception as e:
            stale = find_by_path(app, cmd.get("path")) is None
            print(json.dumps({"ok": False, "stale": stale,
                              "error": "element no longer exists" if stale else str(e)}))


if __name__ == "__main__":
    main()
