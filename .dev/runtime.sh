#!/usr/bin/env bash
set -euo pipefail
cd /workspace

unit_tests() {
  # Unit suites supply their own fixtures; do not inherit the running demo's keys.
  env -i PATH="$PATH" DOTENV_CONFIG_PATH=/dev/null \
    NODE_OPTIONS=--require=/workspace/.dev/no-dotenv.cjs \
    PUPPETEER_SKIP_DOWNLOAD=true npm_config_cache=/npm-cache \
    CI="${CI:-}" "$@"
}

install_dependencies() {
  for package in packages/contracts packages/sdk packages/cli WhatsaapWeb-JS Frontend_py_whatsaapweb; do
    npm --prefix "$package" ci --no-fund --no-audit
    if [[ "$package" == packages/contracts ]]; then npm --prefix "$package" run build; fi
  done
  python3 -m venv /opt/venv
  python -m pip install -r .dev/python-requirements.lock
  python -m pip install --no-build-isolation --no-deps -e packages/python-sdk
  (cd Frontend_py_whatsaapweb && npx --no-install playwright install chromium)
}

case "${1:-}" in
  install) install_dependencies ;;
  prepare)
    npm --prefix WhatsaapWeb-JS run db:migrate
    (cd WhatsaapWeb-JS && node --import tsx ../.dev/seed.ts)
    ;;
  check)
    (cd WhatsaapWeb-JS && ./node_modules/.bin/tsc -p ../.dev/tsconfig.json && node --import tsx --test ../.dev/demo.test.ts)
    python3 -m unittest discover -s docs-site -p 'test_*.py'
    unit_tests npm --prefix packages/contracts test
    for package in packages/contracts packages/sdk packages/cli; do
      npm --prefix "$package" run build
      if [[ "$package" != packages/contracts ]]; then unit_tests npm --prefix "$package" test; fi
    done
    npm --prefix WhatsaapWeb-JS run typecheck
    npm --prefix WhatsaapWeb-JS run typecheck:scripts
    npm --prefix WhatsaapWeb-JS run build
    unit_tests npm --prefix WhatsaapWeb-JS test
    npm --prefix WhatsaapWeb-JS run db:status
    npm --prefix Frontend_py_whatsaapweb run build
    unit_tests npm --prefix Frontend_py_whatsaapweb test
    (cd packages/python-sdk && python -m pytest)
    ;;
  doctor)
    node .dev/doctor.cjs
    npm --prefix WhatsaapWeb-JS run db:status
    ;;
  mobile)
    shift
    if [[ ! -f apps/mobile/node_modules/expo/package.json ]]; then npm --prefix apps/mobile ci --no-fund --no-audit; fi
    if [[ "${1:-web}" == check ]]; then
      npm --prefix apps/mobile run typecheck
      npm --prefix apps/mobile test
    else
      exec npm --prefix apps/mobile run "${1:-web}" -- --host lan
    fi
    ;;
  *) printf 'Comando interno no reconocido\n' >&2; exit 2 ;;
esac
