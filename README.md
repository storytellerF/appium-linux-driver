# appium-linux-driver

An Appium driver for Linux desktop applications, including Compose Desktop,
using open-source AT-SPI2 accessibility APIs. The npm package is
`appium-linux-compose-driver`; the Appium driver and automation name are `linux`.

## Requirements

- Linux with a working X11 display and desktop session D-Bus. For unattended use,
  provide a nonzero-size virtual display and a window manager.
- Node.js 22.12+ (22.x), or 24+, npm 10+, and Appium 2 or 3.
- Python 3 with pyatspi and GDK 3, plus xdotool, xdpyinfo and gdbus.
- An application that exposes an AT-SPI accessibility tree.

On Ubuntu/Debian, install the desktop dependencies with:

```sh
sudo apt-get update
sudo apt-get install -y python3-pyatspi python3-gi gir1.2-gtk-3.0 \
  at-spi2-core xdotool x11-utils libglib2.0-bin dbus-x11
```

The driver invokes `python3` from PATH. Use the system Python containing these
packages. Run Appium in the same graphical and D-Bus session as the application.
Native Wayland-only sessions are not supported by the X11 window/input helpers.

## Installation

After the package has been published to npm:

```sh
appium driver install --source=npm appium-linux-compose-driver
```

To install this checkout before the first release:

```sh
npm ci
appium driver install --source=local "$PWD"
```

## Session capabilities

Start Appium, then create a session with capabilities such as:

```json
{
  "platformName": "linux",
  "appium:automationName": "linux",
  "appium:app": "/absolute/path/to/java",
  "appium:appArguments": ["-jar", "/absolute/path/to/application.jar"],
  "appium:appWorkingDir": "/absolute/path/to/application",
  "appium:appEnv": { "EXAMPLE_SETTING": "value" }
}
```

`app` must be the executable that owns the accessible application process, rather
than a launcher that forks a different process. Prefer an argument array to
preserve spaces. Closing the session terminates the launched process.

The driver supports name and a limited XPath locator subset, text entry,
clicking, live element geometry/state, window resizing/movement, page source and
PNG screenshots. Text and attributes are read from the current accessible
object. Supported attributes are `name`, `description`, `role`, `value` and
`enabled`; unsupported attributes return null. `class name` currently uses the
same matching as `name`.
Element identities include their D-Bus connection and object path; disappeared
elements report a stale-element error. Window commands require exactly one
visible window owned by the launched process.

The execute command `linux: dismissDialog` sends Escape; the WebDriver back
command sends Alt+Left. Keyboard commands act on the current desktop focus, so
use an isolated desktop for unattended automation.

See [DEVELOPMENT.md](https://github.com/storytellerF/appium-linux-driver/blob/main/DEVELOPMENT.md) for tests and npm releases.
