#!/usr/bin/env bash
# Opens the host firewall (iptables) on an Oracle Cloud Ubuntu VM for LiveKit.
# Oracle's Ubuntu images ship with a restrictive default INPUT chain that REJECTs
# traffic; we insert ACCEPT rules ABOVE that reject and persist them.
#
# Run on the VM:  sudo bash open-ports.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo bash open-ports.sh" >&2
  exit 1
fi

open_tcp() { iptables -I INPUT -p tcp --dport "$1" -j ACCEPT; echo "opened TCP $1"; }
open_udp() { iptables -I INPUT -p udp --dport "$1" -j ACCEPT; echo "opened UDP $1"; }

# LiveKit required ports
open_tcp 443
open_tcp 80
open_tcp 7881
open_udp 3478
iptables -I INPUT -p udp --dport 50000:60000 -j ACCEPT
echo "opened UDP 50000-60000"

# Persist across reboots
if ! command -v netfilter-persistent >/dev/null 2>&1; then
  echo "Installing iptables-persistent to save rules..."
  DEBIAN_FRONTEND=noninteractive apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
fi
netfilter-persistent save
echo "Firewall rules saved. Done."
echo
echo "Reminder: you must ALSO open these ports in the Oracle Cloud Security List"
echo "(Networking -> VCN -> Security Lists -> Add Ingress Rules), or they stay blocked."
