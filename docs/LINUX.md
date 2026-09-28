# Linux 服务器部署

这是单用户网页服务。Node 后端在服务器上只监听 `127.0.0.1:3001`；Caddy 把域名或 IP 的 HTTPS 请求转发给它。浏览器通过 Basic 登录（用户 `english`），密码由首次启动生成并保存在服务器上。主/辅助模型 API Key 仍只保存在服务器 SQLite 中。不要直接把 3001 端口映射到公网。

## 1. 启动后端

服务器需要 Linux、Node.js 24+、npm。克隆本分支并启动：

```bash
git clone -b linux https://github.com/qzqzqzqzqzq/english-agent.git
cd english-agent
npm run linux
```

首次运行自动安装依赖、构建前端、生成随机访问密码。服务在前台运行，Ctrl+C 退出。密码文件默认位于 `${XDG_DATA_HOME:-$HOME/.local/share}/english-agent/access-password`，查看时在服务器终端运行：

```bash
cat "${XDG_DATA_HOME:-$HOME/.local/share}/english-agent/access-password"
```

数据库在同一目录的 `english-agent.db`。数据目录权限 0700，密码和数据库文件权限 0600。`DATA_DIR` 可指定新的私有数据目录，`PORT` 可改后端端口；改端口时同步改 Caddy 反向代理目标。不要把密码文件或数据库提交到 Git。

## 2. 用域名访问（推荐）

将域名的 DNS A/AAAA 记录指向服务器，安装 Caddy，开放入站 80 和 443。复制 `deploy/Caddyfile.domain` 到 Caddy 配置路径，将 `english.example.com` 改为自己的域名，然后验证并重载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

用 `https://你的域名` 打开网页；浏览器要求登录时用户名填 `english`，密码从服务器上的 `access-password` 文件读取。Caddy 会为可公开验证的域名申请并续期 HTTPS 证书。具体安装和 DNS/防火墙设置依发行版而异。

## 3. 通过 IP 访问

复制 `deploy/Caddyfile.ip`，将 `192.0.2.10` 改为服务器实际可到达的 IP，按上面的命令验证、重载 Caddy；访问 `https://IP`。该示例使用 Caddy 内部 CA 签发证书。**每台访问设备都须先信任这台服务器生成的 CA 根证书**，否则浏览器会报告证书不受信任。只分发根证书 `root.crt`，绝不分发 CA 私钥；证书通常在运行 Caddy 的用户数据目录 `pki/authorities/local/root.crt`。IP 若在内网，访问设备需处于同一可达网络或 VPN。也可给服务器配置域名，省去手动信任 CA 的步骤。

## 4. 后台常驻（可选）

在普通用户的家目录将仓库放到 `~/english-agent`，先在终端成功运行一次 `npm run linux`，然后把 `deploy/english-agent.service` 放在 `~/.config/systemd/user/english-agent.service`，执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now english-agent
systemctl --user status english-agent
```

该 unit 假设 Node/npm 在 systemd 用户服务的 `PATH` 中。如果用 nvm 等 shell 专用安装方式，请在 unit 中设置 Node/npm 所在目录的绝对 `PATH`。需要退出 SSH 后仍运行时，可在服务器上对该用户启用 linger（需管理员权限）：`sudo loginctl enable-linger "$USER"`。Caddy 作为系统服务独立运行。

## 5. 验证与维护

服务器本机可用 `curl -I http://127.0.0.1:3001/` 检查登录保护，应得到 401。浏览器登录后在设置页分别配置主、辅助模型并主动测试连接。`npm test` 使用模拟 API，不需要真实 Key。备份或迁移时先关闭服务，再复制整个数据目录。要更换网页登录密码，可关闭后替换 `access-password` 内容（至少 16 个字符、权限 0600）再启动。

当前运行环境仅能完成本机测试，没有可供用户访问的公网 IP 或域名。候选中转站的 Responses / compact 兼容性仍未验证。
