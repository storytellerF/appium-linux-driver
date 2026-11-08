# appium-linux-driver

面向 Linux 桌面应用（包括 Compose Desktop）的 Appium 驱动，使用开源 AT-SPI2 无障碍 API。npm 包名为 `appium-linux-compose-driver`；Appium 驱动名和 automation name 均为 `linux`。

<a id="requirements"></a>

## 环境要求

- Linux，具备可用的 X11 显示和桌面会话 D-Bus。无人值守运行时，需要非零尺寸的虚拟显示和窗口管理器。
- Node.js 22.12+（22.x）或 24+，npm 10+，以及 Appium 2 或 3。
- Python 3，安装 pyatspi 和 GDK 3，以及 xdotool、xdpyinfo 和 gdbus。
- 应用需要暴露 AT-SPI 无障碍树。

Ubuntu/Debian 可通过以下命令安装桌面依赖：

```sh
sudo apt-get update
sudo apt-get install -y python3-pyatspi python3-gi gir1.2-gtk-3.0 \
  at-spi2-core xdotool x11-utils libglib2.0-bin dbus-x11
```

驱动调用 PATH 中的 `python3`，应使用安装了上述包的系统 Python。Appium 应与应用运行在同一图形和 D-Bus 会话中。X11 窗口和输入辅助程序不支持纯原生 Wayland 会话。

<a id="installation"></a>

## 安装

包发布到 npm 后：

```sh
appium driver install --source=npm appium-linux-compose-driver
```

首次发布前，可安装当前检出版本：

```sh
npm ci
appium driver install --source=local "$PWD"
```

<a id="session-capabilities"></a>

## 会话 capabilities

启动 Appium，再使用如下 capabilities 创建会话：

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

`app` 必须是拥有应用无障碍进程的可执行文件，而不能是派生另一个进程的启动器。优先使用参数数组，以保留空格。关闭会话会终止启动的进程。

驱动支持 name 定位和有限的 XPath 定位子集、文本输入、点击、实时元素几何信息和状态、窗口缩放与移动、页面源码和 PNG 截图。文本和属性从当前无障碍对象读取。支持的属性为 `name`、`description`、`role`、`value` 和 `enabled`；不支持的属性返回 null。`class name` 当前采用与 `name` 相同的匹配方式。元素标识包括 D-Bus 连接和对象路径；元素消失时报告 stale-element 错误。窗口命令要求启动的进程恰好拥有一个可见窗口。

execute 命令 `linux: dismissDialog` 发送 Escape；WebDriver back 命令发送 Alt+Left。键盘命令作用于当前桌面焦点，因此无人值守自动化应使用隔离桌面。

测试与 npm 发布说明见 [DEVELOPMENT.md](https://github.com/storytellerF/appium-linux-driver/blob/main/DEVELOPMENT.md)。
