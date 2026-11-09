# Backend infra module - setup
1. Copy files into the backend repo (same paths). Changed existing files: src/routes/admin.routes.js (1 line), src/app.js (1 line).
2. On the VPS (once):  sudo install -o root -g root -m 755 deployment/sixstar-ops.sh /usr/local/bin/sixstar-ops
3. Add to the Blue/Green/worker env files (shared/env/*.env):
     INFRA_OPERATORS=your-super-admin-email@example.com     # who may use Controls. Empty = view-only for everyone
     INFRA_GITHUB_ACTIONS_URL=https://github.com/<you>/<repo>/actions   # optional, shows "Review in GitHub"
4. Make sure user 'sixstar' can read shared/logs and write shared/ (bootstrap.sh already does this).
5. Deploy through the normal pipeline (staging first).
