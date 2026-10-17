#!/usr/bin/env bash
# Prepara um Ubuntu 22.04/24.04 (Oracle Cloud ou outra VPS) para rodar
# Evolution API (Docker) + backend Node.js (PM2).
# Uso:  sudo bash setup-vps.sh
set -euo pipefail
# Sem perguntas interativas do apt/needrestart (Ubuntu 22.04+)
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

echo ">> Atualizando pacotes"
apt-get update -y && apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg git ufw openssl

echo ">> Instalando Docker + Compose plugin"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
TARGET_USER="${SUDO_USER:-ubuntu}"
if id "$TARGET_USER" >/dev/null 2>&1 && [ "$TARGET_USER" != root ]; then
  usermod -aG docker "$TARGET_USER"
fi
systemctl enable --now docker

echo ">> Instalando Node.js 22 LTS + PM2"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

echo ">> Liberando portas no firewall do SO (iptables da imagem Oracle)"
# A imagem Ubuntu da Oracle vem com regras iptables que bloqueiam tudo
# exceto a 22. Inserimos as regras ANTES do REJECT e persistimos.
for PORT in 80 443 8080 3000; do
  iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then
  netfilter-persistent save
else
  DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
  netfilter-persistent save
fi

echo ">> Swap de 2GB (útil em VMs pequenas)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile
  mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo ""
echo "Pronto. Saia e entre de novo no SSH para usar 'docker' sem sudo."
echo "Versões:"; docker --version; docker compose version; node -v; pm2 -v
