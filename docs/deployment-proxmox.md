# Deploying on a home Proxmox server

A step-by-step path from this repository on the development PC to the whole platform running in a virtual machine on a home Proxmox VE server. The general production notes (backups, updates, retention, security) are in [deployment.md](deployment.md); this page adds the Proxmox, home-network and "how does the code get there" parts.

The result: one Debian VM with Docker running collector, engine, API, dashboard, PostgreSQL and Redis. The code arrives through git; secrets (`.env`) are copied separately and never go into git.

## 0. Choose how you will open the dashboard

| Option | Good for | Needs |
| --- | --- | --- |
| **A. SSH tunnel** | Only you, from your PC; nothing exposed | Nothing extra |
| **B. Home network (LAN)** | Any device at home | A one-file port override (§6.2) |
| **C. Tailscale** | You, from anywhere, with HTTPS; no open ports | A free Tailscale account |
| **D. Public HTTPS (Caddy)** | A real domain on the internet | A domain, ports 80/443 forwarded on the router, no CGNAT |

A, B and C use the base `docker-compose.yml`. D uses the production override `docker-compose.prod.yml` exactly as in [deployment.md](deployment.md). Start with A or B; you can switch later without losing data.

## 1. Before you start

1. **Stop the stack on the development PC once the server takes over.** Two running engines would send every Telegram message twice and double the load on the exchanges' rate limits. On the PC: `docker compose --profile app down` (the data volume stays).
2. **Commit and push your current changes** so the server gets them (§4).
3. **Check that the home network reaches all seven exchanges without a VPN.** Run this on any Linux machine at home (or later on the VM). Every line should print `200` (`302` for Telegram):

   ```bash
   for u in https://api.bybit.com/v5/market/time https://fapi.binance.com/fapi/v1/time \
     https://api.mexc.com/api/v1/contract/ping https://contract.mexc.com/api/v1/contract/ping \
     https://api.bitget.com/api/v2/public/time https://open-api.bingx.com/openApi/swap/v2/server/time \
     https://api.gateio.ws/api/v4/spot/time https://api.coingecko.com/api/v3/ping https://api.telegram.org/; do
     printf '%-58s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u")"
   done
   curl -s -o /dev/null -w 'hyperliquid %{http_code}\n' -X POST -H 'content-type: application/json' \
     -d '{"type":"allMids"}' https://api.hyperliquid.xyz/info
   ```

   A `403` or `451` means that exchange refuses your country or IP; the platform then shows it as down with the reason. Do not route the server through Cloudflare WARP or a shared VPN (Binance bans shared exits with HTTP 418).

## 2. Create the VM in Proxmox

1. **ISO:** in the Proxmox web UI open *local (pve) → ISO Images → Download from URL* and download the current Debian stable "netinst" image (Debian 13) from debian.org.
2. **Create VM** (top right). Values that matter:

   | Tab | Setting |
   | --- | --- |
   | General | Name `mip`; tick **Start at boot** |
   | OS | The Debian ISO; type Linux 6.x |
   | System | Machine q35; tick **QEMU Agent** |
   | Disks | 40 GB, bus VirtIO SCSI single, tick **Discard** (and SSD emulation on SSD storage) |
   | CPU | 2 cores, type **host** |
   | Memory | 4096 MB |
   | Network | Bridge `vmbr0`, model VirtIO |

   Measured use is about 1 GB of RAM and under one core for all containers; the database stays near 1.1 GB with the default 7-day snapshot retention. 2 vCPU / 4 GB / 40 GB leaves room for image builds and backups.
3. **Install Debian:** start the VM, open its console, choose the plain installer. At *Software selection* untick the desktop and tick only **SSH server** and **standard system utilities**. Create a normal user (below: `mip`).
4. **Fixed address:** give the VM a DHCP reservation on your router (simplest), so its IP never changes. Below it is `192.168.1.50`; use yours.
5. In the VM console, as root:

   ```bash
   apt update && apt install -y qemu-guest-agent sudo git curl ufw unattended-upgrades
   systemctl enable --now qemu-guest-agent
   usermod -aG sudo mip
   timedatectl            # "System clock synchronized: yes"
   ```

Docker inside an LXC container also works on Proxmox (with `nesting=1`), but a VM avoids the storage-driver and AppArmor quirks and is what this guide assumes.

## 3. Prepare the VM

From the PC (PowerShell; OpenSSH is built into Windows):

```powershell
ssh-keygen -t ed25519
```

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh mip@192.168.1.50 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Then log in with `ssh mip@192.168.1.50` and run:

```bash
# Key-only SSH logins
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# Firewall: SSH only (add 80/443 for option D, 8080 for option B)
sudo ufw allow OpenSSH && sudo ufw --force enable

# Automatic security updates
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

# Docker Engine and the Compose plugin from Docker's repository
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker mip
```

Log out and in again so the `docker` group applies, then check `docker compose version` (2.24 or later is needed).

Note: Docker publishes container ports past `ufw`. That is why every port in this project's compose files is bound to `127.0.0.1` unless you change it on purpose (§6.2).

## 4. Get the code onto the server

The repository already has a GitHub remote (`origin`). The simplest flow is PC → GitHub → server.

**On the PC** (whenever you want to deploy):

```powershell
git add -A
```

```powershell
git commit -m "Describe the change"
```

```powershell
git push origin main
```

`.env` is in `.gitignore` and never leaves the PC this way.

**On the server, once:** if the GitHub repository is private, give the server a read-only deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/mip_deploy -N ""
cat ~/.ssh/mip_deploy.pub
```

Add that public key in GitHub under the repository's *Settings → Deploy keys* (leave "Allow write access" off), then:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-mip
  HostName github.com
  User git
  IdentityFile ~/.ssh/mip_deploy
EOF
git clone github-mip:<owner>/<repository>.git ~/mip
```

(For a public repository: `git clone https://github.com/<owner>/<repository>.git ~/mip`.)

**Without GitHub** you can push straight to the server over SSH instead:

```bash
# server, once
git init --bare ~/mip.git
```

```powershell
# PC, once; then deploy with: git push home main
git remote add home ssh://mip@192.168.1.50/home/mip/mip.git
```

```powershell
git push home main
```

```bash
# server, after the first push
git clone ~/mip.git ~/mip
```

## 5. Configure `.env` on the server

Copy the PC's `.env` as a starting point (it holds the Telegram tokens and topic IDs you already set up), from PowerShell in the repository folder:

```powershell
scp .env mip@192.168.1.50:/home/mip/mip/.env
```

Then on the server `chmod 600 ~/mip/.env` and edit it (`nano ~/mip/.env`):

| Variable | Server value |
| --- | --- |
| `NODE_ENV` | `production` |
| `LOG_PRETTY` | `false` |
| `POSTGRES_PASSWORD` | a new strong password, **before the first start** (`openssl rand -base64 24`); PostgreSQL stores it when the volume is created |
| `DATABASE_URL` | same password: `postgresql://mip:<password>@localhost:5433/mip` (used by `npm run verify` / `soak` on the host; containers build their own URL) |
| `DASHBOARD_PASSWORD` | 12+ characters |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `COOKIE_SECURE` | `false` for options A and B (plain HTTP); `true` for C; D forces it |
| `MEXC_REST_URL`, `MEXC_WS_URL` | empty (they were only for the WARP network on the PC) |
| `DOMAIN` | only for option D |

Everything else (Telegram, universe size, retention, terminal refresh rates) can stay as on the PC.

### Optional: bring the PC's data along

Without this the server starts empty: scanner settings return to their defaults and signal history starts over. To keep them, on the **PC** (PowerShell, stack running):

```powershell
docker compose exec -T postgres pg_dump -U mip -Fc --exclude-table-data=market_snapshots -f /tmp/mip.dump mip
```

```powershell
docker compose cp postgres:/tmp/mip.dump .\mip.dump
```

```powershell
scp .\mip.dump mip@192.168.1.50:/home/mip/mip/mip.dump
```

(The dump goes through a file inside the container because PowerShell 5.1 would corrupt binary output redirected with `>`.) Restore it on the server in §6 step 2. Per-minute snapshots are left out: they refill by themselves (the 4 h open-interest window works again after 4 h).

## 6. Start

### 6.1 First start (options A, B, C)

```bash
cd ~/mip
docker compose --profile app build
docker compose up -d postgres redis
docker compose --profile app run --rm migrate
```

Only if you copied a dump in §5:

```bash
docker compose exec -T postgres pg_restore -U mip -d mip --clean --if-exists < mip.dump && rm mip.dump
```

Then start everything:

```bash
docker compose --profile app up -d
docker compose ps        # api "healthy", migrate "exited (0)"
docker compose logs -f collector engine   # Ctrl+C to stop following
```

The first start builds the instrument universe (about 90 s without a CoinGecko key). All containers restart by themselves after a crash or a VM reboot (`restart: unless-stopped`).

### 6.2 Open the dashboard

**A. SSH tunnel.** On the PC:

```powershell
ssh -N -L 8080:127.0.0.1:8080 mip@192.168.1.50
```

and open `http://localhost:8080` while that window stays open.

**B. Home network.** Create `~/mip/docker-compose.override.yml` on the server (it is in `.gitignore`; Compose reads it automatically next to `docker-compose.yml`):

```yaml
services:
  web:
    ports: !override
      - '192.168.1.50:8080:80'
```

Then `sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp`, `docker compose --profile app up -d web`, and open `http://192.168.1.50:8080` from any device at home. Do not forward this port on the router: it is plain HTTP.

**C. Tailscale** (remote access with HTTPS, no open ports). On the server:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 8080
```

In the Tailscale admin console enable MagicDNS and HTTPS certificates. Install Tailscale on your PC or phone and open the `https://<vm-name>.<tailnet>.ts.net` address that `tailscale serve status` prints. Set `COOKIE_SECURE=true` in `.env` and recreate the API: `docker compose --profile app up -d api`. If the top bar shows **polling** instead of **live**, the proxy did not pass the original host name and the WebSocket is refused; the dashboard still works by polling.

**D. Public HTTPS.** Requirements: a domain whose DNS record points to your home IP (use a dynamic-DNS service if the IP changes), ports 80 and 443 forwarded from the router to `192.168.1.50`, and an ISP that gives you a public IPv4 address (with CGNAT, port forwarding cannot work; use option C). Then set `DOMAIN` in `.env`, `sudo ufw allow 80,443/tcp`, and start with both files as in [deployment.md](deployment.md):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build
```

The login page is then on the public internet; consider limiting it to your IPs (deployment.md §8).

### 6.3 Check

1. Log in. The top bar shows **live** and three green process badges.
2. All seven exchanges reach `ok` within a minute or two (Exchange connections panel).
3. Each scanner window: `running`, Telegram `ok`.
4. Open **Terminal**: the chart, order book and trades fill in.
5. Optional, the read-only verification and the 24 h soak that are still pending (HANDOFF.md). They need Node.js 22 on the host:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs tmux
   cd ~/mip && npm ci
   npm run verify
   tmux new -s soak 'npm run soak -- --minutes 1440'   # detach: Ctrl+B then D; summary in soak/
   ```

## 7. Updating

PC: commit and `git push origin main` (§4). Server:

```bash
cd ~/mip && git pull && docker compose --profile app up -d --build
```

(Option D: add `-f docker-compose.yml -f docker-compose.prod.yml`.) Migrations run before the app containers start. Restarts never re-send Telegram messages. Avoid restarting the collector while an exchange has banned the IP (deployment.md §6). After editing `.env`, recreate the affected service with `up -d <service>`; `restart` keeps the old environment.

## 8. Backups

- **Proxmox:** *Datacenter → Backup → Add*: a daily backup of the VM to a different disk, NAS or Proxmox Backup Server. Snapshot mode works with the VM running. This covers everything, `.env` included.
- **Database dumps:** option D runs the `backup` service automatically. For options A–C add a daily dump with `crontab -e`:

  ```cron
  30 3 * * * cd /home/mip/mip && mkdir -p backups && docker compose exec -T postgres pg_dump -U mip -Fc --exclude-table-data=market_snapshots mip > backups/mip-$(date +\%F).dump && find backups -name 'mip-*.dump' -mtime +14 -delete
  ```

  Restore as in deployment.md §5. Copy backups off the VM's disk; a backup on the same disk does not survive a disk failure.

## 9. Troubleshooting

- **An exchange stays down:** run the check in §1 on the VM. `403` / `451`: the exchange refuses this IP or country. `418` from Binance: an IP ban; the collector waits for it to end on its own.
- **`docker compose` says `!override` is unknown:** Compose is older than 2.24; install it from Docker's repository as in §3, not from Debian's `docker.io` package.
- **The dashboard opens but stays on "Loading…" or logs out at once:** with `COOKIE_SECURE=true` the browser only keeps the session over HTTPS; use `false` for options A and B.
- **Telegram messages arrive twice:** the PC's stack is still running (§1).
- **Times look off:** `timedatectl` on the VM must show a synchronised clock.
