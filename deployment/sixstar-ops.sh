#!/usr/bin/env bash
# Install: sudo install -o root -g root -m 755 sixstar-ops.sh /usr/local/bin/sixstar-ops
# The ONLY thing the POS API may execute. Fixed verbs, validated args, one action at a time (flock).
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
B=/var/www/sixstar-pos
verb=${1:-}; arg=${2:-}
exec 9>/var/lock/sixstar-ops.lock; flock -n 9 || { echo "busy" >&2; exit 3; }
case "$verb" in
  status)
    { pm2 jlist 2>/dev/null || echo '[]'; } | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const j=JSON.parse(s.slice(s.indexOf("[")||0)||"[]");
        const services=j.filter(p=>/^sixstar-/.test(p.name)).map(p=>({name:p.name,status:p.pm2_env.status,
          memMb:Math.round((p.monit.memory||0)/1048576),restarts:p.pm2_env.restart_time||0,
          uptimeSec:p.pm2_env.status==="online"?Math.round((Date.now()-p.pm2_env.pm_uptime)/1000):0,
          release:p.pm2_env.RELEASE_ID||null}));
        const {execSync}=require("child_process");let nginx="unknown";
        try{nginx=execSync("systemctl is-active nginx",{encoding:"utf8"}).trim()}catch(e){nginx="inactive"}
        console.log(JSON.stringify({services,nginx}))})' ;;
  rollback) bash $B/deployment/rollback.sh ;;
  restart)
    case "$arg" in
      sixstar-blue|sixstar-green|sixstar-worker|sixstar-staging) ;;
      *) echo "bad service" >&2; exit 2 ;;
    esac
    active=$(cat $B/deployment/state/active_slot 2>/dev/null || echo blue)
    [ "$arg" = "sixstar-$active" ] && { echo "refusing: live slot" >&2; exit 2; }
    pm2 restart "$arg" ;;
  backup)
    [ -x $B/deployment/backup.sh ] || { echo "backup.sh not installed yet" >&2; exit 4; }
    nohup bash $B/deployment/backup.sh >> $B/shared/logs/backup.log 2>&1 9>&- & echo started ;;
  maintenance)
    case "$arg" in on) touch $B/shared/maintenance.flag ;; off) rm -f $B/shared/maintenance.flag ;; *) echo "bad arg" >&2; exit 2 ;; esac ;;
  *) echo "unknown verb" >&2; exit 2 ;;
esac
