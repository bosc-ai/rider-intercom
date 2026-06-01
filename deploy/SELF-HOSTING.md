# Self-hosting LiveKit — free forever, unlimited, with TURN

This runs your **own** LiveKit media server (SFU + TURN relay) on a free-forever cloud
VM. Cost: **$0/month, no usage cap**. The TURN relay is what makes it work reliably for
riders on cellular/mobile networks.

You'll set up four things:

1. A free VM (Oracle Cloud "Always Free")
2. A free domain (DuckDNS) → two subdomains pointing at the VM
3. Open the required network ports (cloud firewall + host firewall)
4. Generate + run LiveKit, then point this app at it

Budget ~30–45 minutes the first time. Once it's up, it just runs.

---

## 1. Create the free VM (Oracle Cloud Always Free)

> Oracle's "Always Free" tier gives a real always-on VM with a public IP and generous
> bandwidth — the only mainstream free tier that suits a media/TURN server. Signup asks
> for a card **for identity verification only**; Always Free resources are never charged.
> Alternatives: any always-on Linux VM with a public IP works (a cheap $4–6/mo VPS is the
> no-friction option if you'd rather skip Oracle's signup).

1. Sign up at https://www.oracle.com/cloud/free/ and verify your account.
2. **Compute → Instances → Create Instance:**
   - **Image:** Ubuntu 22.04 (or 24.04).
   - **Shape:** `VM.Standard.A1.Flex` (Ampere/ARM) with 1–2 OCPU + 6 GB RAM is plenty and
     fully free. (If A1 capacity is unavailable in your region, the `VM.Standard.E2.1.Micro`
     AMD shape is also Always Free and works.)
   - **Add your SSH public key** (so you can log in).
   - Create. Note the **public IP address** (e.g. `140.x.x.x`).

---

## 2. Free domain via DuckDNS

LiveKit needs TLS, and browsers require a secure `wss://` connection — so we need a real
domain name (a bare IP can't get a certificate). DuckDNS gives free subdomains.

1. Go to https://www.duckdns.org, sign in (GitHub/Google), and create **two** subdomains,
   both pointing to your VM's public IP, e.g.:
   - `myintercom.duckdns.org`        ← main server
   - `myintercom-turn.duckdns.org`   ← TURN
2. Set the **current ip** field for both to your VM's public IP and click "update ip".

(You can pick any names; just keep the two domains handy for the next step.)

---

## 3. Open the required ports

LiveKit needs these ports reachable from the internet:

| Port | Proto | Purpose |
|------|-------|---------|
| 443  | TCP   | HTTPS + TURN over TLS |
| 80   | TCP   | TLS certificate issuance (Let's Encrypt) |
| 7881 | TCP   | WebRTC over TCP (fallback) |
| 3478 | UDP   | TURN/UDP |
| 50000–60000 | UDP | WebRTC media |

**a) Cloud firewall (Oracle Security List)** — in the console:
`Networking → Virtual Cloud Networks → your VCN → Security Lists → Default → Add Ingress Rules`.
Add ingress rules (Source `0.0.0.0/0`) for each row above (TCP 443, 80, 7881; UDP 3478,
UDP 50000–60000).

**b) Host firewall** — Oracle's Ubuntu images ship with restrictive iptables rules. SSH in
and run the helper in this folder:

```bash
scp deploy/open-ports.sh ubuntu@<VM_IP>:~
ssh ubuntu@<VM_IP>
sudo bash open-ports.sh
```

---

## 4. Generate LiveKit config and deploy

On your **local machine** (needs Docker), generate the server config:

```bash
docker pull livekit/generate
docker run --rm -it -v "$PWD/livekit-config:/output" livekit/generate
```

Answer the prompts:
- **Primary domain:** `myintercom.duckdns.org`
- **TURN domain:** `myintercom-turn.duckdns.org`
- **Enable TURN:** yes

It creates a `livekit-config/` folder with `docker-compose.yaml`, `caddy.yaml`,
`livekit.yaml`, `redis.conf`, and an `init_script.sh`.

> 🔑 **Save the API key + secret** it prints (also stored under `keys:` in
> `livekit.yaml`). You'll put these in the app's `.env.local`.

Deploy it to the VM:

```bash
scp -r livekit-config ubuntu@<VM_IP>:~
ssh ubuntu@<VM_IP>
cd livekit-config
sudo ./init_script.sh
```

This installs Docker and starts LiveKit + Caddy + Redis as a systemd service. Caddy
auto-provisions TLS certificates (give it a minute on first boot).

**Verify** from your laptop:

```bash
curl https://myintercom.duckdns.org   # should return a LiveKit "OK"-ish response, not a cert error
```

---

## 5. Point the app at your server

Edit [`.env.local`](../.env.local) in this repo with the values from your generated
`livekit.yaml` (NOT your old LiveKit Cloud keys):

```
LIVEKIT_API_KEY=<key from livekit.yaml>
LIVEKIT_API_SECRET=<secret from livekit.yaml>
NEXT_PUBLIC_LIVEKIT_URL=wss://myintercom.duckdns.org
```

Restart the app (`npm run dev`, or redeploy on Vercel). That's it — no code changes. Your
6 riders now connect through your own free, uncapped server.

---

## Notes & troubleshooting

- **No code changes ever needed** to switch servers — only `NEXT_PUBLIC_LIVEKIT_URL` +
  the key/secret.
- **Cert errors / can't connect:** DNS for both subdomains must point to the VM **and**
  ports 80/443 must be open in *both* the Oracle Security List and the host firewall.
  Check Caddy logs: `sudo docker compose logs caddy` inside `~/livekit-config`.
- **Riders can't hear each other on cellular:** confirm UDP 3478 + UDP 50000–60000 are
  open in the Oracle Security List (the most common miss).
- **Restart the server:** `cd ~/livekit-config && sudo docker compose restart`.
- **Bandwidth:** audio for 6 people is tiny (a few GB/month even with heavy use) — far
  under Oracle's free egress allowance.
